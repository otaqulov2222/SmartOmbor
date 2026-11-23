import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { dataFile } from "../lib/data-dir";
import { addCatalogProduct, applyReceiptStock, canonicalFactoryCode, catalogForRead, compactCode, findProductsByLabel, lastNumericToken, listWaybillProducts, loadCatalog, loadCatalogForSupply, matchWaybillProduct, parseBordoName, peekCatalog, peekOrRecallCatalog, productBelongsToFactory, productCodeMatches, sameBordoColor, sameProductCode } from "../lib/catalog";
import { buildSupplyPositions, ensurePachka, packSizeOf, pieceCount, productPackSize, receiptParts, stampWaybillCardPrices } from "../lib/supply-assortment";
import { moysklad, moyskladAll, moyskladSend, MoySkladError, moyskladConfigured, permissionDenied, releaseMoySkladSlots, reserveMoySkladSlots, writeDropped } from "../lib/moysklad";
import { logger } from "../lib/logger";
import { recordAudit } from "../lib/audit";
import { notifyAdmin } from "../lib/telegram";
import { readWatchdogState, writeWatchdogState } from "../lib/supply-watchdog-state";
import {
  accountFromToken,
  createAccount,
  createShipment,
  getAccount,
  linkExactShipmentLines,
  linkShipmentLine,
  listAccounts,
  listShipments,
  loginFactory,
  markShipmentPosted,
  clearShipmentPosted,
  beginSupplyInflight,
  endSupplyInflight,
  isSupplyInflight,
  moyskladDateTime,
  partnerRevision,
  flushPartners,
  refreshPartnersIfNeeded,
  tashkentDay,
  deleteAccount,
  deleteShipment,
  resetPassword,
  setShipmentStatus,
  reviseShipment,
  updateShipment,
  updateAccount,
  suggestPassword,
  type PostedUnitSnapshot,
} from "../lib/partners";

const router: IRouter = Router();

function fail(res: Response, error: unknown) {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 500;
  const message = error instanceof Error ? error.message : "error";
  const detail = typeof error === "object" && error && "detail" in error ? String((error as { detail: unknown }).detail ?? "") : "";
  res.status(status || 500).json(detail ? { error: message, detail } : { error: message });
}

/** Juft (qadoqda) odatda pachka bilan bir xil; 5×+ farq — chalkashlik (0044-007: 6 o‘rniga 60). */
function pairsLooksInflated(line: { pairs: number; pachka: number; boxes: number }) {
  const pairs = Math.round(Number(line.pairs) || 0);
  const pachka = Math.round(Number(line.pachka) || 0);
  if (!(pairs > 0)) return false;
  if (pachka > 1 && pairs >= pachka * 5) return true;
  if (!(pachka > 1) && pairs >= 30 && Number(line.boxes) > 0) return true;
  return false;
}

function bearer(req: Request) {
  const header = req.header("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function requireFactory(req: Request, res: Response, next: NextFunction) {
  const account = accountFromToken(bearer(req));
  if (!account) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.locals.factory = account;
  next();
}

router.get("/partner-alerts", async (_req, res, next) => {
  try {
    void refreshPartnersIfNeeded();
    const pending = listShipments().filter((item) => item.status === "sent").length;
    res.json({ pending, revision: partnerRevision() });
  } catch (error) {
    next(error);
  }
});

router.get("/partner-factories", async (_req, res, next) => {
  try {
    void refreshPartnersIfNeeded();
    // Katalog xotirada bo‘lmasa diskdan — aks holda MoySkladdagi zavodlar “yo‘qolib” ko‘rinardi.
    const catalog = await catalogForRead();
    const grouped = new Map<string, { name: string; productCount: number; stock: number }>();
    const byLower = new Map<string, { name: string; productCount: number; stock: number }>();
    for (const product of catalog?.products ?? []) {
      const name = product.factory?.trim();
      if (!name) continue;
      const current = grouped.get(name) || { name, productCount: 0, stock: 0 };
      current.productCount += 1;
      current.stock += product.stock;
      grouped.set(name, current);
      byLower.set(name.toLowerCase(), current);
    }
    const accounts = listAccounts().filter((account) => account.active !== false);
    const shipmentsByFactory = new Map<string, ReturnType<typeof listShipments>>();
    for (const shipment of listShipments()) {
      const bucket = shipmentsByFactory.get(shipment.factoryId);
      if (bucket) bucket.push(shipment);
      else shipmentsByFactory.set(shipment.factoryId, [shipment]);
    }
    const used = new Set<string>();
    const catalogRowFor = (account: { name: string; catalogName: string }) =>
      grouped.get(account.catalogName)
      || grouped.get(account.name)
      || byLower.get(account.catalogName.trim().toLowerCase())
      || byLower.get(account.name.trim().toLowerCase())
      || null;
    const rows = accounts.map((account) => {
      const own = shipmentsByFactory.get(account.id) ?? [];
      const catalogRow = catalogRowFor(account);
      if (catalogRow) used.add(catalogRow.name);
      return {
        name: catalogRow?.name || account.name,
        productCount: catalogRow?.productCount ?? 0,
        stock: catalogRow?.stock ?? 0,
        account,
        shipmentCount: own.length,
        pendingCount: own.filter((item) => item.status === "sent").length,
        lastShipment: own[0]?.createdAt ?? null,
      };
    });
    const rowNames = new Set(rows.map((item) => item.name.trim().toLowerCase()));
    const extras = [...grouped.values()]
      .filter((row) => !used.has(row.name) && !rowNames.has(row.name.trim().toLowerCase()))
      .map((row) => ({
        ...row,
        account: null,
        shipmentCount: 0,
        pendingCount: 0,
        lastShipment: null as string | null,
      }));
    res.json({
      items: [...rows, ...extras].sort((a, b) => b.shipmentCount - a.shipmentCount || b.productCount - a.productCount || a.name.localeCompare(b.name)),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/partner-factories", (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const code = String(req.body?.code ?? "").trim();
    const login = String(req.body?.login ?? "").trim();
    const catalogName = String(req.body?.catalogName ?? name).trim();
    const password = String(req.body?.password ?? "").trim() || suggestPassword();
    if (!name || !code || !login) {
      res.status(400).json({ error: "required" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: "password_short" });
      return;
    }
    const created = createAccount({ name, code, catalogName, login, password });
    void recordAudit({ action: "partner.created", entityType: "partner", entityId: created.account?.id, details: name });
    res.status(201).json(created);
  } catch (error) {
    fail(res, error);
  }
});

router.patch("/partner-factories/:id", (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const code = String(req.body?.code ?? "").trim();
    const login = String(req.body?.login ?? "").trim();
    const password = String(req.body?.password ?? "").trim();
    const updated = updateAccount(String(req.params.id), {
      name,
      code,
      login,
      password,
      ...( "counterpartyId" in (req.body ?? {}) ? { counterpartyId: String(req.body?.counterpartyId ?? ""), counterpartyName: String(req.body?.counterpartyName ?? "") } : {}),
    });
    void recordAudit({ action: "partner.updated", entityType: "partner", entityId: String(req.params.id), details: name || String(req.params.id) });
    res.json(updated);
  } catch (error) {
    fail(res, error);
  }
});

router.delete("/partner-factories/:id", (req, res) => {
  try {
    const removed = deleteAccount(String(req.params.id));
    void recordAudit({ action: "partner.deleted", entityType: "partner", entityId: String(req.params.id) });
    res.json(removed);
  } catch (error) {
    fail(res, error);
  }
});

router.post("/partner-factories/:id/password", (req, res) => {
  try {
    const password = String(req.body?.password ?? "").trim() || suggestPassword();
    if (password.length < 6) {
      res.status(400).json({ error: "password_short" });
      return;
    }
    res.json(resetPassword(String(req.params.id), password));
  } catch (error) {
    fail(res, error);
  }
});

function exactCatalogProduct(
  catalog: Awaited<ReturnType<typeof loadCatalog>>,
  line: { factoryCode: string; sectionCode: string; productCode: string; size: string },
  account: { code?: string; name?: string; catalogName?: string },
) {
  const input = {
    factoryCode: account.code || line.factoryCode || "",
    factoryName: account.catalogName || account.name || "",
    groupCode: line.sectionCode,
    productCode: line.productCode,
    size: line.size,
  };
  const hits = listWaybillProducts(catalog, input);
  // Guruh bo‘sh bo‘lsa faqat bitta aniq kartochka bo‘lganda to‘ldiramiz — noto‘g‘ri guruh yopishtirmaymiz.
  if (!hits.length) return null;
  if (hits.length > 1 && !line.sectionCode.trim()) return null;
  const matched = hits.length === 1 ? { id: hits[0].id, name: hits[0].name } : matchWaybillProduct(catalog, input);
  if (!matched) return null;
  const parsed = parseBordoName(matched.name);
  if (line.sectionCode.trim() && parsed?.groupCode && compactCode(parsed.groupCode) !== compactCode(line.sectionCode)) return null;
  const groupCode = parsed?.groupCode || "";
  const packSize = catalog.products.find((product) => product.id === matched.id)?.packSize ?? 0;
  return { ...matched, groupCode, packSize: packSize > 1 ? packSize : 0 };
}

function lineMatchesCatalogProduct(
  product: { code?: string | null; article?: string | null; name: string; barcodes: string[] },
  typed: string,
) {
  const code = typed.trim();
  if (!code) return true;
  if (sameProductCode(product.code || "", code) || sameProductCode(product.article || "", code)) return true;
  const parsed = parseBordoName(product.name);
  if (parsed && productCodeMatches(parsed.productCode, code, parsed.model)) return true;
  const needle = compactCode(code);
  return Boolean(needle) && product.barcodes.some((value) => compactCode(value) === needle);
}

router.get("/partner-factories/:id", async (req, res, next) => {
  try {
    void refreshPartnersIfNeeded();
    const account = getAccount(String(req.params.id));
    if (!account) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Avval javob — keyin fon bog‘lash. Sync match nginx 504 va bo‘sh UI berardi.
    const { passwordHash: _hash, salt: _salt, passwordPlain, ...safe } = account;
    res.json({ account: { ...safe, password: passwordPlain || null }, shipments: listShipments(account.id) });
    const catalog = peekCatalog();
    if (catalog) {
      setImmediate(() => {
        try {
          linkExactShipmentLines(account.id, (line) => exactCatalogProduct(catalog, line, account));
        } catch (error) {
          logger.warn({ err: error instanceof Error ? error.message : error }, "Background waybill link failed");
        }
      });
    }
  } catch (error) {
    next(error);
  }
});

function lineUnits(line: { pairs: number; boxes: number; quantity: number; colors: Array<{ name?: string; quantity: number }> }) {
  return pieceCount({
    pairs: line.pairs,
    boxes: line.boxes,
    quantity: line.quantity,
    colors: (line.colors ?? []).map((color) => ({ name: color.name || "", quantity: color.quantity })),
  });
}

function kopecks(som: number) {
  return Math.round(som * 100);
}

function supplyGone(error: unknown) {
  if (!(error instanceof MoySkladError)) return false;
  const path = error.path || "";
  const onSupplyDoc = /\/entity\/supply\/[^/?]+$/i.test(path) && !/\/positions\//i.test(path);
  if (error.status === 404 && onSupplyDoc) return true;
  return /операция находится в корзине|находится в корзине/i.test(error.message);
}

const supplyTails = new Map<string, Promise<void>>();

function acquireSupplyLock(id: string): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = supplyTails.get(id) ?? Promise.resolve();
  const mine = previous.catch(() => undefined).then(() => held);
  supplyTails.set(id, mine);
  return previous.catch(() => undefined).then(() => () => {
    release();
    if (supplyTails.get(id) === mine) supplyTails.delete(id);
  });
}

type SupplyHit = { id: string; name?: string; deleted?: string; applicable?: boolean; externalCode?: string; incomingNumber?: string };

function nameMatchesShipment(row: SupplyHit, number: string) {
  if (!number) return false;
  const name = String(row.name || "").trim();
  if (name === number || name.startsWith(`${number} `)) return true;
  if (row.incomingNumber && String(row.incomingNumber).trim() === number) return true;
  return false;
}

/** Boshqa lokal yukka tegishli MS hujjatga tegilmasin. */
function claimedByOtherShipment(row: SupplyHit, shipmentId: string) {
  const others = listShipments().filter((item) => item.id !== shipmentId);
  if (row.externalCode && others.some((item) => item.id === row.externalCode)) return true;
  if (row.id && others.some((item) => item.moyskladId === row.id)) return true;
  return false;
}

/**
 * Shu yukning o‘z kirimi yoki yetim dublikat:
 * - externalCode = shipment.id → aniq o‘zimizniki
 * - nom/incoming mos + boshqa yuk da’vo qilmasa → yetim dublikat (tozalash mumkin)
 * - boshqa yukning externalCode/moyskladId → CHETga tegilmasin
 */
function isOwnOrOrphanDup(row: SupplyHit, shipment: { id: string; number: string }) {
  if (!row.id || row.deleted) return false;
  if (claimedByOtherShipment(row, shipment.id)) return false;
  if (row.externalCode === shipment.id) return true;
  return nameMatchesShipment(row, shipment.number.trim());
}

function supplyMatchScore(row: SupplyHit, shipment: { id: string; number: string }) {
  const number = shipment.number.trim();
  const name = String(row.name || "").trim();
  let score = 0;
  if (row.externalCode === shipment.id) score += 8;
  if (name === number) score += 4;
  else if (name.startsWith(`${number} `)) score += 2;
  if (row.incomingNumber && String(row.incomingNumber).trim() === number) score += 2;
  if (row.applicable) score += 1;
  return score;
}

const supplyLookup = new Map<string, { at: number; hit: { id: string; name: string } | null }>();

async function listSupplyCandidates(shipment: { id: string; number: string }): Promise<SupplyHit[]> {
  const number = shipment.number.trim();
  const filters = [
    `externalCode=${shipment.id}`,
    ...(number ? [`name=${number}`, `incomingNumber=${number}`] : []),
  ];
  const settled = await Promise.allSettled([
    ...filters.map((filter) =>
      moysklad<{ rows: SupplyHit[] }>(`/entity/supply?limit=50&filter=${encodeURIComponent(filter)}`),
    ),
    ...(number
      ? [moysklad<{ rows: SupplyHit[] }>(`/entity/supply?limit=50&search=${encodeURIComponent(number)}`)]
      : []),
  ]);
  const ok = settled.filter((item): item is PromiseFulfilledResult<{ rows: SupplyHit[] }> => item.status === "fulfilled");
  if (!ok.length) {
    const first = settled.find((item) => item.status === "rejected") as PromiseRejectedResult | undefined;
    throw first?.reason || Object.assign(new Error("ms_lookup_failed"), { status: 502 });
  }
  const byId = new Map<string, SupplyHit>();
  for (const page of ok) {
    for (const row of page.value.rows || []) {
      if (row.id && !row.deleted) byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

/** MoySkladda shu yuk xati uchun mavjud kirim — dublikat yaratmaslik uchun. */
async function findExistingSupply(shipment: { id: string; number: string; date?: string }): Promise<{ id: string; name: string } | null> {
  const cached = supplyLookup.get(shipment.id);
  if (cached && Date.now() - cached.at < 8_000) return cached.hit;
  const ranked = (await listSupplyCandidates(shipment))
    .filter((row) => isOwnOrOrphanDup(row, shipment))
    .sort((a, b) => supplyMatchScore(b, shipment) - supplyMatchScore(a, shipment));
  const hit = ranked[0]?.id ? { id: ranked[0].id, name: ranked[0].name || shipment.number } : null;
  supplyLookup.set(shipment.id, { at: Date.now(), hit });
  return hit;
}

/** Ortiqcha o‘z/yetim dublikatlarni o‘chirish. keepId majburiy — bo‘sh bo‘lsa no-op emas, xato. */
async function pruneDuplicateSupplies(shipment: { id: string; number: string }, keepId: string) {
  if (!keepId) {
    throw Object.assign(new Error("prune_requires_keep"), {
      status: 500,
      detail: "Dublikat tozalash uchun saqlanadigan kirim id kerak.",
    });
  }
  const rows = await listSupplyCandidates(shipment);
  let removed = 0;
  const failed: string[] = [];
  for (const row of rows) {
    if (row.id === keepId) continue;
    if (!isOwnOrOrphanDup(row, shipment)) continue;
    try {
      await deleteSupplyDocument(row.id);
      removed += 1;
      logger.warn({ shipment: shipment.id, supply: row.id, name: row.name }, "Pruned duplicate MoySklad supply");
    } catch (error) {
      failed.push(row.id);
      logger.warn({ shipment: shipment.id, supply: row.id, err: error instanceof Error ? error.message : error }, "Duplicate supply prune failed");
    }
  }
  if (failed.length) {
    throw Object.assign(new Error("dup_prune_failed"), {
      status: 502,
      detail: `Dublikat tozalanmadi (${failed.length}). Qayta urinib ko‘ring — aks holda ombor shishishi mumkin.`,
    });
  }
  return removed;
}

/** Barcha o‘z/yetim dublikatlarni o‘chirish (qayta yaratish oldidan). */
async function deleteOwnOrphanSupplies(shipment: { id: string; number: string }) {
  const rows = (await listSupplyCandidates(shipment)).filter((row) => isOwnOrOrphanDup(row, shipment));
  let removed = 0;
  for (const row of rows) {
    await deleteSupplyDocument(row.id);
    removed += 1;
    logger.warn({ shipment: shipment.id, supply: row.id, name: row.name }, "Removed own/orphan MoySklad supply before recreate");
  }
  supplyLookup.delete(shipment.id);
  return removed;
}

async function stampSupplyExternalCode(supplyId: string, shipmentId: string) {
  try {
    await moyskladSend(`/entity/supply/${encodeURIComponent(supplyId)}`, { externalCode: shipmentId }, "PUT");
  } catch (error) {
    logger.warn({ supply: supplyId, err: error instanceof Error ? error.message : error }, "Stamp supply externalCode skipped");
  }
}

function isTransientMsError(error: unknown) {
  if (writeDropped(error)) return true;
  if (error instanceof MoySkladError) {
    return error.status === 429 || error.status === 401 || error.status === 403 || error.status >= 500;
  }
  return false;
}

function chooseSupplyName(shipment: { id: string; number: string; date?: string }) {
  const names = supplyNames(shipment);
  return names[0] || shipment.number.trim();
}

function priceFromWaybill(name: string, lines: Array<{ factoryCode: string; sectionCode: string; productCode: string; size: string; price: number; colors: Array<{ name?: string }> }>) {
  const raw = name.trim();
  const parsed = parseBordoName(raw);
  const color = parsed?.color || raw.match(/\(([^)]+)\)\s*$/)?.[1]?.trim() || "";
  const base = raw.replace(/\s*\([^)]+\)\s*$/, "").trim().toLowerCase();
  let best: { score: number; price: number } | null = null;
  for (const line of lines) {
    if (!(line.price > 0)) continue;
    const identity = ["bordo", line.factoryCode, line.sectionCode, line.productCode, line.size].filter(Boolean).join(" ").trim().toLowerCase();
    let score = 0;
    const codeOk = parsed ? productCodeMatches(parsed.productCode, line.productCode, parsed.model) : false;
    const sizeOk = parsed ? compactCode(parsed.size) === compactCode(line.size) : false;
    const groupOk = !line.sectionCode.trim() || (parsed ? sameProductCode(parsed.groupCode, line.sectionCode) : false);
    if (base === identity || compactCode(base) === compactCode(identity)) score = 4;
    else if (color && (base === `${identity} ${color}`.toLowerCase() || compactCode(base) === compactCode(`${identity} ${color}`))) score = 4;
    else if (identity && (base.startsWith(identity) || compactCode(base).startsWith(compactCode(identity)))) score = 3;
    else if (codeOk && sizeOk && groupOk) score = 2;
    if (color && (line.colors ?? []).some((item) => sameBordoColor(item.name || "", color))) score += 2;
    else if (color && parsed?.color) score -= 1;
    if (score > (best?.score ?? 0)) best = { score, price: kopecks(line.price) };
  }
  return best && best.score > 0 ? best.price : 0;
}

async function fillZeroSupplyPrices(supplyId: string, lines: Array<{ factoryCode: string; sectionCode: string; productCode: string; size: string; price: number; colors: Array<{ name?: string }> }>) {
  const doc = await moysklad<{ applicable?: boolean; sum?: number; deleted?: string }>(`/entity/supply/${encodeURIComponent(supplyId)}`);
  if (doc.deleted) throw new MoySkladError("Операция находится в корзине. Обновление операции запрещено.", 400);
  const page = await moyskladAll<{ id: string; price?: number; assortment?: { name?: string; meta?: { href?: string; type?: string } } }>(
    `/entity/supply/${encodeURIComponent(supplyId)}/positions?expand=assortment`,
  );
  const zero = page.rows.filter((row) => !(row.price > 0));
  if (!zero.length) return (doc.sum ?? 0) > 0;
  if (doc.applicable) {
    await moyskladSend(`/entity/supply/${encodeURIComponent(supplyId)}`, { applicable: false }, "PUT");
  }
  let wrote = 0;
  for (const row of zero) {
    const price = priceFromWaybill(row.assortment?.name || "", lines);
    if (!(price > 0)) continue;
    await moyskladSend(`/entity/supply/${encodeURIComponent(supplyId)}/positions/${encodeURIComponent(row.id)}`, {
      price,
      vat: 0,
      vatEnabled: false,
    }, "PUT");
    wrote += 1;
  }
  if (doc.applicable) {
    await moyskladSend(`/entity/supply/${encodeURIComponent(supplyId)}`, { applicable: true }, "PUT");
  }
  logger.warn({ supplyId, wrote, total: zero.length }, "MoySklad supply prices filled");
  return wrote > 0;
}

/**
 * HARD GUARD: MoySklad kirim = yuk xati.
 * - jami dona + qator soni + miqdor multiset
 * - hujjat o‘chirilmagan / o‘tkazilgan (applicable)
 * - agent + store + organization majburiy
 */
async function verifySupplyQuantities(
  supplyId: string,
  expectedPositions: Array<{ quantity: number }>,
) {
  const expectedQty = expectedPositions.map((item) => Math.round(Number(item.quantity) || 0));
  if (!expectedQty.length || expectedQty.some((qty) => !(qty > 0))) {
    throw Object.assign(new Error("qty_mismatch"), {
      status: 500,
      detail: "Kirim rejasi bo‘sh yoki noldan miqdor bor. Kirim yozilmadi.",
    });
  }
  const expectedTotal = expectedQty.reduce((sum, qty) => sum + qty, 0);
  const page = await moyskladAll<{ id: string; quantity?: number }>(
    `/entity/supply/${encodeURIComponent(supplyId)}/positions`,
  );
  const actualQty = page.rows.map((row) => Math.round(Number(row.quantity) || 0));
  const actualTotal = actualQty.reduce((sum, qty) => sum + qty, 0);
  const sameCount = actualQty.length === expectedQty.length;
  const sameTotal = actualTotal === expectedTotal;
  const sortedExp = [...expectedQty].sort((a, b) => a - b);
  const sortedAct = [...actualQty].sort((a, b) => a - b);
  const sameBag = sameCount && sortedExp.every((qty, index) => qty === sortedAct[index]);
  if (!sameCount || !sameTotal || !sameBag) {
    logger.error({
      supplyId,
      expectedTotal,
      actualTotal,
      expectedCount: expectedQty.length,
      actualCount: actualQty.length,
      expectedQty: sortedExp,
      actualQty: sortedAct,
    }, "MoySklad kirim qty exact verify failed");
    throw Object.assign(
      new Error("qty_mismatch"),
      {
        status: 502,
        detail: `MoySklad ≠ yuk xati: yuborilgan ${expectedTotal} dona / ${expectedQty.length} qator, MS da ${actualTotal} dona / ${actualQty.length} qator. Kirim bekor qilindi.`,
        expected: expectedTotal,
        actual: actualTotal,
      },
    );
  }
  return actualTotal;
}

type SupplyDocMeta = {
  id: string;
  name?: string;
  deleted?: string | boolean;
  applicable?: boolean;
  externalCode?: string;
  agent?: { name?: string; meta?: unknown } | null;
  store?: { name?: string; meta?: unknown } | null;
  organization?: { name?: string; meta?: unknown } | null;
};

async function forceSupplyApplicable(supplyId: string) {
  await moyskladSend(`/entity/supply/${encodeURIComponent(supplyId)}`, { applicable: true }, "PUT");
}

async function verifySupplyIntegrity(
  supplyId: string,
  expectedPositions: Array<{ quantity: number }>,
) {
  let doc = await moysklad<SupplyDocMeta>(
    `/entity/supply/${encodeURIComponent(supplyId)}?expand=agent,organization,store`,
  );
  if (doc.deleted) {
    throw Object.assign(new Error("supply_deleted"), {
      status: 502,
      detail: "MoySklad kirim o‘chirilgan (korzina). Lokal bog‘lanish uziladi.",
    });
  }
  if (doc.applicable === false) {
    try {
      await forceSupplyApplicable(supplyId);
      doc = await moysklad<SupplyDocMeta>(
        `/entity/supply/${encodeURIComponent(supplyId)}?expand=agent,organization,store`,
      );
    } catch (error) {
      throw Object.assign(new Error("supply_not_applicable"), {
        status: 502,
        detail: `MoySklad kirim o‘tkazilmadi: ${error instanceof Error ? error.message : "applicable"}`,
      });
    }
  }
  if (doc.applicable === false) {
    throw Object.assign(new Error("supply_not_applicable"), {
      status: 502,
      detail: "MoySklad kirim hali o‘tkazilmagan (applicable=yo‘q). Kirim tasdiqlanmadi.",
    });
  }
  if (!doc.agent) {
    throw Object.assign(new Error("agent"), {
      status: 502,
      detail: "MoySklad kirimda kontragent (agent) yo‘q. Kirim tasdiqlanmadi.",
    });
  }
  if (!doc.store) {
    throw Object.assign(new Error("store"), {
      status: 502,
      detail: "MoySklad kirimda ombor (store) yo‘q. Kirim tasdiqlanmadi.",
    });
  }
  if (!doc.organization) {
    throw Object.assign(new Error("currency"), {
      status: 502,
      detail: "MoySklad kirimda tashkilot (organization) yo‘q. Kirim tasdiqlanmadi.",
    });
  }
  const total = await verifySupplyQuantities(supplyId, expectedPositions);
  return { total, doc };
}

async function assertSupplyMatchesOrRollback(
  supplyId: string,
  expectedPositions: Array<{ quantity: number }>,
  meta: { shipmentId: string; allowDelete: boolean },
) {
  try {
    return await verifySupplyIntegrity(supplyId, expectedPositions);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const deterministic = code === "qty_mismatch"
      || code === "supply_deleted"
      || code === "supply_not_applicable"
      || code === "agent"
      || code === "store"
      || code === "currency";
    logger.error({
      shipment: meta.shipmentId,
      supply: supplyId,
      err: error instanceof Error ? error.message : error,
      deterministic,
    }, "MoySklad kirim integrity verify failed — rolling back");
    // Transient (429/5xx/tarmoq) da to‘g‘ri hujjatni o‘chirmaymiz
    if (meta.allowDelete && deterministic && !isTransientMsError(error)) {
      await deleteSupplyDocument(supplyId);
    }
    throw error;
  }
}

/** Sticky moyskladId: MS o‘chirilgan/buzilgan bo‘lsa uziladi → qayta kirim mumkin. */
async function ensureLinkedSupplyOrClear(shipment: {
  id: string;
  number: string;
  moyskladId?: string | null;
  moyskladNumber?: string | null;
  lines: Array<{ pairs: number; boxes: number; quantity: number; colors?: Array<{ quantity: number }>; pachka?: number; productId?: string | null }>;
  postedUnitsTotal?: number | null;
}): Promise<{ id: string; name: string } | null> {
  const supplyId = String(shipment.moyskladId || "").trim();
  if (!supplyId) return null;
  // Kirim yozilayotganda sticky tekshiruv bog‘lanishni o‘chirib yubormasin
  if (isSupplyInflight(shipment.id)) {
    return { id: supplyId, name: shipment.moyskladNumber || shipment.number };
  }
  try {
    const doc = await moysklad<SupplyDocMeta>(
      `/entity/supply/${encodeURIComponent(supplyId)}?expand=agent,organization,store`,
    );
    if (doc.deleted) {
      logger.warn({ shipment: shipment.id, supply: supplyId }, "Linked MS supply deleted — clearing local post");
      clearShipmentPosted(shipment.id, {
        expectMoyskladId: supplyId,
        alert: {
          code: "ms_deleted",
          title: "MoySklad kirimi o‘chirilgan",
          detail: "MoySkladda bu hujjat korzinaga o‘tgan/o‘chirilgan. Bizda «yozilgan» qolib ketgan edi — bog‘lanish uzildi. Qayta «MoySkladga kirim» qiling.",
        },
      });
      supplyLookup.delete(shipment.id);
      return null;
    }
    const page = await moyskladAll<{ quantity?: number }>(
      `/entity/supply/${encodeURIComponent(supplyId)}/positions`,
    );
    const actualTotal = page.rows.reduce((sum, row) => sum + Math.round(Number(row.quantity) || 0), 0);
    const expectedTotal = shipment.postedUnitsTotal != null && shipment.postedUnitsTotal > 0
      ? Math.round(Number(shipment.postedUnitsTotal))
      : shipment.lines.reduce((sum, line) => sum + lineUnits({
        pairs: Number(line.pairs) || 0,
        boxes: Number(line.boxes) || 0,
        quantity: Number(line.quantity) || 0,
        colors: Array.isArray(line.colors) ? line.colors.map((c) => ({ quantity: Number(c.quantity) || 0 })) : [],
      }), 0);
    const reasons: string[] = [];
    if (!doc.agent) reasons.push("kontragent yo‘q");
    if (!doc.store) reasons.push("ombor yo‘q");
    if (!doc.organization) reasons.push("tashkilot yo‘q");
    if (page.rows.length === 0) reasons.push("pozitsiya bo‘sh");
    if (expectedTotal > 0 && actualTotal !== expectedTotal) {
      reasons.push(`dona mos emas (yuk ${expectedTotal}, MS ${actualTotal})`);
    }
    if (doc.applicable === false) reasons.push("o‘tkazilmagan");
    const broken = reasons.length > 0;
    if (broken) {
      if (doc.applicable === false && doc.agent && doc.store && doc.organization && actualTotal === expectedTotal && actualTotal > 0) {
        try {
          await forceSupplyApplicable(supplyId);
          const again = await moysklad<SupplyDocMeta>(`/entity/supply/${encodeURIComponent(supplyId)}`);
          if (again.applicable !== false && !again.deleted) {
            return { id: supplyId, name: doc.name || shipment.moyskladNumber || shipment.number };
          }
        } catch (error) {
          logger.warn({ shipment: shipment.id, supply: supplyId, err: error instanceof Error ? error.message : error }, "Linked supply applicable fix failed");
        }
      }
      logger.warn({
        shipment: shipment.id,
        supply: supplyId,
        actualTotal,
        expectedTotal,
        positions: page.rows.length,
        applicable: doc.applicable,
        reasons,
      }, "Linked MS supply unhealthy — clearing for repost");
      clearShipmentPosted(shipment.id, {
        expectMoyskladId: supplyId,
        alert: {
          code: "ms_unhealthy",
          title: "MoySklad kirimi buzilgan — qayta kirim qiling",
          detail: `Sabab: ${reasons.join("; ")}. Bog‘lanish uzildi. «Qayta kirim» dublikat yaratmaydi — buzilganlarini tozalab bitta to‘g‘ri kirim qiladi.`,
        },
      });
      supplyLookup.delete(shipment.id);
      return null;
    }
    return { id: supplyId, name: doc.name || shipment.moyskladNumber || shipment.number };
  } catch (error) {
    if (supplyGone(error) || (error instanceof MoySkladError && error.status === 404)) {
      logger.warn({ shipment: shipment.id, supply: supplyId }, "Linked MS supply gone — clearing local post");
      clearShipmentPosted(shipment.id, {
        expectMoyskladId: supplyId,
        alert: {
          code: "ms_gone",
          title: "MoySklad kirimi topilmadi",
          detail: "MoySkladda bog‘langan ID topilmadi. «Qayta kirim» qidiradi: bor bo‘lsa qayta bog‘laydi, yo‘q bo‘lsa bitta yangi yozadi (dublikat emas).",
        },
      });
      supplyLookup.delete(shipment.id);
      return null;
    }
    // 429/5xx/tarmoq — false alert bermaymiz, bog‘lanishni saqlaymiz
    logger.warn({
      shipment: shipment.id,
      supply: supplyId,
      err: error instanceof Error ? error.message : error,
      transient: isTransientMsError(error),
    }, "Linked MS supply health check failed — keeping link");
    return { id: supplyId, name: shipment.moyskladNumber || shipment.number };
  }
}

async function ensureLinePachkas(
  lines: Array<{ productId?: string | null; pachka?: number; pairs?: number; productCode?: string }>,
) {
  const issues: string[] = [];
  for (const line of lines) {
    const want = packSizeOf({ pachka: line.pachka, pairs: line.pairs });
    const productId = String(line.productId || "").trim();
    if (!(want > 1) || !productId) continue;
    try {
      await ensurePachka(productId, want);
      const actual = await productPackSize(productId);
      if (actual !== want) {
        issues.push(`${line.productCode || productId}: pachka ${want}≠${actual}`);
      }
    } catch (error) {
      issues.push(`${line.productCode || productId}: pachka yozilmadi`);
      logger.warn({ productId, want, err: error instanceof Error ? error.message : error }, "ensureLinePachkas failed");
    }
  }
  if (issues.length) {
    throw Object.assign(new Error("pachka_mismatch"), {
      status: 502,
      detail: `Pachka mos emas: ${issues.slice(0, 4).join("; ")}`,
    });
  }
}

async function deleteSupplyDocument(supplyId: string) {
  try {
    await moyskladSend(`/entity/supply/${encodeURIComponent(supplyId)}`, { applicable: false }, "PUT");
  } catch (error) {
    logger.warn({ supplyId, err: error instanceof Error ? error.message : error }, "MoySklad supply unconduct before delete skipped");
  }
  try {
    await moyskladSend(`/entity/supply/${encodeURIComponent(supplyId)}`, undefined, "DELETE");
  } catch (error) {
    logger.warn({ supplyId, err: error instanceof Error ? error.message : error }, "MoySklad supply delete failed");
    if (permissionDenied(error)) {
      throw Object.assign(new Error("ms_permission"), {
        status: 502,
        detail: "MoySklad API tokenida kirim o‘chirish/yaratish ruxsati yo‘q (kod 1018). Token huquqlarini oching yoki dublikatlarni MoySklad UI dan qo‘lda o‘chiring — aks holda avtomatik tozalash ishlamaydi.",
      });
    }
    throw error;
  }
}

async function replaceZeroSupply(supplyId: string) {
  try {
    await moyskladSend(`/entity/supply/${encodeURIComponent(supplyId)}`, { applicable: false }, "PUT");
  } catch (error) {
    logger.warn({ supplyId, err: error instanceof Error ? error.message : error }, "MoySklad supply unconduct skipped");
  }
  try {
    await moyskladSend(`/entity/supply/${encodeURIComponent(supplyId)}`, undefined, "DELETE");
  } catch (error) {
    logger.warn({ supplyId, err: error instanceof Error ? error.message : error }, "MoySklad zero supply delete skipped");
  }
}

function uniqueSupplyConflict(error: unknown) {
  if (!(error instanceof MoySkladError)) return false;
  return error.status === 409 || error.status === 412 || /уникал|unique|already exists|уже существ/i.test(error.message);
}

function printedDay(date?: string) {
  const day = tashkentDay(date);
  const [year, month, dayPart] = day.split("-");
  return year && month && dayPart ? `${dayPart}.${month}.${year}` : "";
}

function supplyNames(shipment: { number: string; date?: string }) {
  const number = shipment.number.trim();
  const day = printedDay(shipment.date);
  return [...new Set([number, day ? `${number} ${day}` : ""].filter(Boolean))];
}

const supplyNameTried = new Set<string>();

async function alignSupplyName(id: string, shipment: { number: string; date?: string }) {
  for (const name of supplyNames(shipment)) {
    try {
      await moyskladSend(`/entity/supply/${encodeURIComponent(id)}`, { name }, "PUT");
      return name;
    } catch (error) {
      if (!uniqueSupplyConflict(error) && !permissionDenied(error)) {
        logger.warn({ supply: id, name, err: error instanceof Error ? error.message : error }, "MoySklad supply rename skipped");
        return null;
      }
    }
  }
  return null;
}

function scheduleSupplyName(shipment: { id: string; number: string; date?: string; moyskladId?: string | null; moyskladNumber?: string | null }) {
  const current = (shipment.moyskladNumber || "").trim();
  const number = shipment.number.trim();
  if (!shipment.moyskladId || !number || current === number || current.startsWith(`${number} `) || supplyNameTried.has(shipment.id)) return;
  supplyNameTried.add(shipment.id);
  void alignSupplyName(shipment.moyskladId, shipment).then((name) => {
    if (name) markShipmentPosted(shipment.id, { id: shipment.moyskladId!, number: name });
  }).catch((error) => {
    logger.warn({ shipment: shipment.id, err: error instanceof Error ? error.message : error }, "MoySklad supply rename failed");
  });
}

async function postSupplyDocument(core: Record<string, unknown>, positions: Array<Record<string, unknown>>, shipment: { id: string; number: string; date?: string }, opts?: { skipExistingCheck?: boolean }): Promise<{ id: string; name?: string; reused: boolean }> {
  if (!opts?.skipExistingCheck) {
    const existing = await findExistingSupply(shipment);
    if (existing) return { ...existing, reused: true };
  }
  // Faqat asosiy nom — fallback nomlar dublikatni yashiradi
  const names = [...new Set([chooseSupplyName(shipment), ...supplyNames(shipment).slice(1)])].filter(Boolean);
  const payloads: Array<Record<string, unknown>> = [
    ...names.map((name) => ({ ...core, name, applicable: true, positions })),
    { ...core, name: names[0], applicable: false, positions },
  ];
  let last: unknown;
  for (const body of payloads) {
    try {
      const created = await moyskladSend<{ id: string; name?: string }>("/entity/supply", body);
      supplyLookup.set(shipment.id, { at: Date.now(), hit: { id: created.id, name: created.name || shipment.number } });
      return { id: created.id, name: created.name, reused: false };
    } catch (error) {
      last = error;
      supplyLookup.delete(shipment.id);
      // Timeout/502: POST allaqachon yaratgan bo‘lishi mumkin — qayta yaratmaymiz
      if (writeDropped(error) || isTransientMsError(error)) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
          const found = await findExistingSupply(shipment);
          if (found) return { ...found, reused: true };
        }
        throw Object.assign(new Error("post_ambiguous"), {
          status: 502,
          detail: "MoySklad javobi aniq emas. Dublikat xavfi uchun qayta yaratilmadi — birozdan keyin qayta urinib ko‘ring.",
        });
      }
      const foundAgain = await findExistingSupply(shipment);
      if (foundAgain) return { ...foundAgain, reused: true };
      const text = `${error instanceof MoySkladError ? error.parameter || "" : ""} ${error instanceof Error ? error.message : ""}`;
      const retry = uniqueSupplyConflict(error) || permissionDenied(error) || /applicable|проведен/i.test(text);
      if (!retry) throw error;
      logger.warn({ err: error instanceof Error ? error.message : error }, "MoySklad supply create retry");
    }
  }
  const leftover = await findExistingSupply(shipment);
  if (leftover) return { ...leftover, reused: true };
  throw last;
}

router.get("/counterparties", async (req, res, next) => {
  try {
    const search = String(req.query.search ?? "").trim();
    if (search.length < 2) {
      res.json({ items: [] });
      return;
    }
    const page = await moysklad<{ rows: Array<{ id?: string; name?: string }> }>(`/entity/counterparty?limit=15&search=${encodeURIComponent(search)}`);
    res.json({ items: page.rows.filter((row) => row.id && row.name).map((row) => ({ id: row.id, name: row.name })) });
  } catch (error) {
    next(error);
  }
});

router.get("/partner-factories/shipments/:id/matches", async (req, res, next) => {
  try {
    const shipment = listShipments().find((item) => item.id === String(req.params.id));
    if (!shipment) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const catalog = await catalogForRead();
    if (!catalog) {
      res.status(503).json({ error: "catalog_syncing" });
      return;
    }
    const account = getAccount(shipment.factoryId);
    const byId = new Map(catalog.products.map((product) => [product.id, product]));
    const lines = shipment.lines.map((line) => {
      const matched = account ? matchWaybillProduct(catalog, { factoryCode: account.code || line.factoryCode, factoryName: account.catalogName || account.name, groupCode: line.sectionCode, productCode: line.productCode, size: line.size }) : null;
      const text = [line.productCode, line.model, line.size].filter(Boolean).join(" ");
      const found = new Map<string, { id: string; name: string; code: string | null; stock: number }>();
      if (matched) {
        const product = byId.get(matched.id);
        if (product) found.set(product.id, { id: product.id, name: product.name, code: product.code, stock: product.stock });
      }
      for (const product of findProductsByLabel(catalog, text).products) {
        if (!account || !productBelongsToFactory(product, account.code, account.catalogName || account.name)) continue;
        found.set(product.id, { id: product.id, name: product.name, code: product.code, stock: product.stock });
      }
      return { id: line.id, products: found.size > 6 ? [] : [...found.values()] };
    });
    res.json({ lines });
  } catch (error) {
    next(error);
  }
});

router.post("/partner-factories/shipments/:id/lines/:lineId/link", async (req, res, next) => {
  try {
    const productId = String(req.body?.productId ?? "").trim();
    if (!productId) {
      res.json(linkShipmentLine(String(req.params.id), String(req.params.lineId), null));
      return;
    }
    const catalog = await catalogForRead();
    if (!catalog) {
      res.status(503).json({ error: "catalog_syncing" });
      return;
    }
    const product = catalog.products.find((item) => item.id === productId);
    if (!product) {
      res.status(400).json({ error: "product" });
      return;
    }
    res.json(linkShipmentLine(String(req.params.id), String(req.params.lineId), { id: product.id, name: product.name }));
  } catch (error) {
    fail(res, error);
  }
});

let orgCache: {
  at: number;
  organization: { rows: Array<{ meta: { href: string; type: string; mediaType: string } }> };
  currencies: { rows: Array<{ isoCode?: string; meta: { href: string; type: string; mediaType: string } }> };
} | null = null;

async function loadOrgCurrency() {
  if (orgCache && Date.now() - orgCache.at < 10 * 60_000) return orgCache;
  const [organization, currencies] = await Promise.all([
    moysklad<{ rows: Array<{ meta: { href: string; type: string; mediaType: string } }> }>("/entity/organization?limit=1"),
    moysklad<{ rows: Array<{ isoCode?: string; meta: { href: string; type: string; mediaType: string } }> }>("/entity/currency?limit=100"),
  ]);
  orgCache = { at: Date.now(), organization, currencies };
  return orgCache;
}

type SupplyResult = { id: string; number: string; shipment: unknown; already?: boolean };
type SupplyAgent = { id: string; name: string; meta: { href: string; type: string; mediaType: string } };
type SupplyJob = { status: "pending" | "done" | "error"; error?: string; detail?: string; result?: SupplyResult; storeId?: string; counterpartyId?: string; counterpartyName?: string };
const supplyJobs = new Map<string, SupplyJob>();
const JOB_FILE = dataFile("supply-jobs.json");

function persistSupplyJobs() {
  const pending: Record<string, SupplyJob> = {};
  for (const [id, job] of supplyJobs) {
    if (job.status === "pending") pending[id] = {
      status: "pending",
      storeId: job.storeId || "",
      counterpartyId: job.counterpartyId || "",
      counterpartyName: job.counterpartyName || "",
    };
  }
  mkdirSync(path.dirname(JOB_FILE), { recursive: true });
  const tmp = `${JOB_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(pending));
  renameSync(tmp, JOB_FILE);
}

function loadSupplyJobs() {
  try {
    const parsed = JSON.parse(readFileSync(JOB_FILE, "utf8")) as Record<string, SupplyJob>;
    for (const [id, job] of Object.entries(parsed)) {
      if (job?.status === "pending") {
        supplyJobs.set(id, {
          status: "pending",
          storeId: job.storeId || "",
          counterpartyId: job.counterpartyId || "",
          counterpartyName: job.counterpartyName || "",
        });
      }
    }
  } catch {
    /* first run */
  }
}

function setSupplyJob(id: string, job: SupplyJob) {
  supplyJobs.set(id, job);
  persistSupplyJobs();
}

function supplyRetryable(error: unknown) {
  const detail = error instanceof Error ? error.message : "";
  if (detail === "post_ambiguous" || detail === "dup_prune_failed" || detail === "prune_requires_keep") return false;
  return uniqueSupplyConflict(error)
    || writeDropped(error)
    || /уникал|unique|already exists|уже существ|MoySkladda bor|kartasi|yaratilmadi|javob bermadi|limiti|fetch failed/i.test(detail);
}

async function runSupplyJob(
  shipmentId: string,
  storeId: string,
  agent?: { id?: string; name?: string },
  opts?: { confirmPairs?: boolean },
) {
  setSupplyJob(shipmentId, {
    status: "pending",
    storeId,
    counterpartyId: agent?.id || "",
    counterpartyName: agent?.name || "",
  });
  try {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await writeShipmentSupply(
          shipmentId,
          storeId,
          agent?.id ? { id: agent.id, name: agent.name || "" } : undefined,
          opts,
        );
        setSupplyJob(shipmentId, { status: "done", result, storeId });
        return;
      } catch (error) {
        last = error;
        const code = error instanceof Error ? error.message : "";
        if (code === "pairs_suspect" || code === "qty_mismatch" || !supplyRetryable(error) || attempt === 2) throw error;
        logger.warn({ shipment: shipmentId, attempt, err: error instanceof Error ? error.message : error }, "MoySklad supply retry");
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
    throw last;
  } catch (error) {
    const codeRaw = error instanceof Error ? error.message : "rejected";
    const detail =
      (typeof error === "object" && error && "detail" in error && String((error as { detail?: unknown }).detail || "").trim())
      || (error instanceof Error ? error.message : "Kirim yozilmadi");
    logger.warn({
      shipment: shipmentId,
      detail,
      path: error instanceof MoySkladError ? error.path : undefined,
      moyCode: error instanceof MoySkladError ? error.moyCode : undefined,
      parameter: error instanceof MoySkladError ? error.parameter : undefined,
    }, "MoySklad supply failed");
    const code = codeRaw === "store" || codeRaw === "agent" || codeRaw === "currency" || codeRaw === "declined" || codeRaw === "pairs_suspect" || codeRaw === "qty_mismatch" || codeRaw === "pachka_mismatch" || codeRaw === "supply_deleted" || codeRaw === "supply_not_applicable" || codeRaw === "post_ambiguous" || codeRaw === "dup_prune_failed" || codeRaw === "ms_permission"
      ? codeRaw
      : "rejected";
    setSupplyJob(shipmentId, { status: "error", error: code, detail, storeId });
  }
}

export function resumePendingSupplies() {
  loadSupplyJobs();
  for (const [id, job] of supplyJobs) {
    if (job.status !== "pending") continue;
    const shipment = listShipments().find((item) => item.id === id);
    if (!shipment) {
      supplyJobs.delete(id);
      persistSupplyJobs();
      continue;
    }
    if (shipment.moyskladId) {
      void ensureLinkedSupplyOrClear(shipment).then((healthy) => {
        if (healthy) {
          const fresh = listShipments().find((item) => item.id === id) ?? shipment;
          setSupplyJob(id, { status: "done", result: { id: healthy.id, number: healthy.name, shipment: fresh, already: true } });
          return;
        }
        logger.info({ shipment: id }, "Resume pending MoySklad kirim after cleared sticky link");
        void runSupplyJob(id, job.storeId || "", job.counterpartyId ? { id: job.counterpartyId, name: job.counterpartyName || "" } : undefined);
      });
      continue;
    }
    logger.info({ shipment: id }, "Resume pending MoySklad kirim");
    void runSupplyJob(id, job.storeId || "", job.counterpartyId ? { id: job.counterpartyId, name: job.counterpartyName || "" } : undefined);
  }
}

loadSupplyJobs();

function sameAgentName(left: string, right: string) {
  const a = left.trim();
  const b = right.trim();
  if (!a || !b) return false;
  if (a.localeCompare(b, "ru", { sensitivity: "accent" }) === 0) return true;
  return compactCode(a) === compactCode(b);
}

function agentConflictsWithFactory(rowName: string, code: string) {
  const factory = canonicalFactoryCode(code);
  if (!factory || !/^\d{3,6}$/.test(factory)) return false;
  const token = lastNumericToken(rowName);
  return Boolean(token && /^\d{3,6}$/.test(token) && token !== factory);
}

function agentMatchScore(
  rowName: string,
  account: { name: string; catalogName: string; code: string; counterpartyName: string | null },
) {
  const labels = [account.counterpartyName, account.catalogName, account.name].filter((value): value is string => Boolean(value?.trim()));
  if (labels.some((label) => sameAgentName(rowName, label))) return 3;
  const code = canonicalFactoryCode(account.code);
  if (code && /^\d{3,6}$/.test(code) && lastNumericToken(rowName) === code) return 1;
  return 0;
}

async function loadCounterparty(id: string): Promise<SupplyAgent | null> {
  const wanted = id.trim();
  if (!wanted) return null;
  try {
    const row = await moysklad<{ id?: string; name?: string; meta: { href: string; type: string; mediaType: string } }>(`/entity/counterparty/${encodeURIComponent(wanted)}`);
    if (!row.meta?.href) return null;
    return { id: row.id || wanted, name: row.name || "", meta: row.meta };
  } catch {
    return null;
  }
}

async function searchFactoryAgent(account: { name: string; catalogName: string; code: string; counterpartyName: string | null }): Promise<SupplyAgent | null> {
  const queries = [...new Set([
    account.counterpartyName,
    account.catalogName,
    account.name,
    canonicalFactoryCode(account.code),
  ].map((value) => value?.trim()).filter((value): value is string => Boolean(value && value.length >= 2)))];
  const pages = await Promise.all(queries.map((query) =>
    moysklad<{ rows: Array<{ id?: string; name?: string; meta: { href: string; type: string; mediaType: string } }> }>(`/entity/counterparty?limit=25&search=${encodeURIComponent(query)}`).catch(() => ({ rows: [] })),
  ));
  const ranked = pages
    .flatMap((page) => page.rows)
    .filter((row) => row.id && row.name && row.meta && !agentConflictsWithFactory(row.name || "", account.code))
    .map((row) => ({ row, score: agentMatchScore(row.name || "", account) }))
    .filter((item) => item.score > 0);
  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best) return null;
  const unique = new Set(ranked.filter((item) => item.score === best.score).map((item) => item.row.id));
  if (unique.size !== 1) return null;
  return { id: best.row.id!, name: best.row.name || "", meta: best.row.meta };
}

function rememberFactoryAgent(
  account: { id: string; name: string; code: string; login: string; counterpartyId: string | null; counterpartyName: string | null },
  agent: SupplyAgent,
) {
  if (account.counterpartyId === agent.id && account.counterpartyName === agent.name) return;
  try {
    updateAccount(account.id, {
      name: account.name,
      code: account.code,
      login: account.login,
      counterpartyId: agent.id,
      counterpartyName: agent.name || account.counterpartyName,
    });
  } catch (error) {
    logger.warn({ factory: account.id, err: error instanceof Error ? error.message : error }, "Partner counterparty was not saved");
  }
}

function agentFromId(id: string, name = ""): SupplyAgent {
  const base = "https://api.moysklad.ru/api/remap/1.2";
  return {
    id,
    name,
    meta: { href: `${base}/entity/counterparty/${id}`, type: "counterparty", mediaType: "application/json" },
  };
}

async function resolveFactoryAgent(
  account: { id: string; name: string; catalogName: string; code: string; login: string; counterpartyId: string | null; counterpartyName: string | null } | null,
  hint?: { id: string; name: string },
): Promise<SupplyAgent | null> {
  const usable = (agent: SupplyAgent | null) => {
    if (!agent) return null;
    if (account && agentConflictsWithFactory(agent.name, account.code)) return null;
    return agent;
  };
  // Tez yo‘l: tanlangan/saqlangan kontragent ID yetarli — qidiruvsiz.
  if (hint?.id) {
    const hinted = usable(agentFromId(hint.id, hint.name || "")) || usable(await loadCounterparty(hint.id));
    if (hinted) {
      if (account) rememberFactoryAgent(account, hinted);
      return hinted;
    }
  }
  if (account?.counterpartyId) {
    const saved = usable(agentFromId(account.counterpartyId, account.counterpartyName || "")) || usable(await loadCounterparty(account.counterpartyId));
    if (saved) return saved;
  }
  const found = account ? usable(await searchFactoryAgent(account)) : null;
  if (!found) return null;
  if (account) rememberFactoryAgent(account, found);
  return found;
}

async function ensureSupplyAgent(supplyId: string, agentMeta: { href: string; type: string; mediaType: string }) {
  try {
    const doc = await moysklad<{ applicable?: boolean; agent?: { meta?: { href?: string } } }>(`/entity/supply/${encodeURIComponent(supplyId)}`);
    if (doc.agent?.meta?.href === agentMeta.href) return;
    const write = () => moyskladSend(`/entity/supply/${encodeURIComponent(supplyId)}`, { agent: { meta: agentMeta } }, "PUT");
    if (doc.applicable) {
      await moyskladSend(`/entity/supply/${encodeURIComponent(supplyId)}`, { applicable: false }, "PUT");
      try {
        await write();
      } finally {
        await moyskladSend(`/entity/supply/${encodeURIComponent(supplyId)}`, { applicable: true }, "PUT");
      }
      return;
    }
    await write();
  } catch (error) {
    logger.warn({ supply: supplyId, err: error instanceof Error ? error.message : error }, "MoySklad supply agent was not written");
  }
}

async function writeShipmentSupply(
  shipmentId: string,
  storeId: string,
  agentHint?: { id: string; name: string },
  opts?: { confirmPairs?: boolean },
): Promise<SupplyResult> {
  const unlock = await acquireSupplyLock(shipmentId);
  beginSupplyInflight(shipmentId);
  // Kam reserve — kirim o‘zi parallel qidiruv/create qilsin (8 bo‘lsa slotLimit=4, sekinlashardi).
  reserveMoySkladSlots(2);
  const t0 = Date.now();
  const mark = (step: string, started: number) => {
    logger.info({ shipment: shipmentId, step, ms: Date.now() - started, totalMs: Date.now() - t0 }, "MoySklad kirim timing");
  };
  try {
    let shipment = listShipments().find((item) => item.id === shipmentId);
    if (!shipment) throw Object.assign(new Error("not_found"), { status: 404 });
    if (shipment.status === "declined") throw Object.assign(new Error("declined"), { status: 409 });
    if (shipment.moyskladId) {
      const healthy = await ensureLinkedSupplyOrClear(shipment);
      if (healthy) {
        const freshPosted = listShipments().find((item) => item.id === shipmentId) ?? shipment;
        return { id: healthy.id, number: healthy.name, shipment: freshPosted, already: true };
      }
      shipment = listShipments().find((item) => item.id === shipmentId);
      if (!shipment) throw Object.assign(new Error("not_found"), { status: 404 });
      if (shipment.moyskladId) {
        return { id: shipment.moyskladId, number: shipment.moyskladNumber || shipment.number, shipment, already: true };
      }
    }
    const account = getAccount(shipment.factoryId);
    let stepAt = Date.now();
    // Parallel: agent + catalog + org. Existing supply — faqat conflict paytida (tez yo‘l).
    const [agent, catalog, orgBundle] = await Promise.all([
      resolveFactoryAgent(account, agentHint),
      loadCatalogForSupply(),
      loadOrgCurrency(),
    ]);
    mark("agent+catalog+org", stepAt);
    // To‘liq katalog yo‘q bo‘lsa linkExact’ni o‘tkazib yuborish (sekin disk scan yo‘q).
    if (account && catalog.products.length > 0) {
      linkExactShipmentLines(account.id, (line) => exactCatalogProduct(catalog, line, account));
    }
    const current = listShipments().find((item) => item.id === shipment.id) ?? shipment;
    // Freeze miqdor snapshot — tahrir/pachka chalkashuvi keyinroq "nima yuborilgan"ni yo‘qotmasin
    const unitSnapshot: PostedUnitSnapshot[] = current.lines.map((line) => ({
      lineId: line.id,
      productCode: line.productCode,
      size: line.size,
      pairs: line.pairs,
      boxes: line.boxes,
      pachka: line.pachka,
      units: lineUnits(line),
    })).filter((item) => item.units > 0);
    const waybillUnitsTotal = unitSnapshot.reduce((sum, item) => sum + item.units, 0);
    let positions = current.lines.map((line) => ({ line, quantity: lineUnits(line) })).filter((item) => item.quantity > 0);
    if (!positions.length) throw Object.assign(new Error("Kirim qatorlari bo‘sh"), { status: 400 });
    // Juft katta bo‘lsa avtomatik o‘zgartirmaymiz; faqat odam tasdiqlamaguncha to‘xtatamiz.
    const inflated = current.lines.filter((line) => pairsLooksInflated(line));
    if (inflated.length) {
      logger.warn({
        shipment: shipmentId,
        confirmPairs: Boolean(opts?.confirmPairs),
        sample: inflated.slice(0, 5).map((line) => `${line.productCode}/${line.size}: juft=${line.pairs}, pachka=${line.pachka || "—"}`),
      }, "Kirim juft qiymati katta — tasdiq kerak");
      if (!opts?.confirmPairs) {
        throw Object.assign(new Error("pairs_suspect"), {
          status: 400,
          detail: `Juft (qadoqda) shubhali (${inflated.length} qator). Qiymatni tekshirib tasdiqlang — avtomatik o‘zgartirilmaydi.`,
        });
      }
    }
    logger.info({
      shipment: shipmentId,
      number: current.number,
      waybillUnitsTotal,
      confirmPairs: Boolean(opts?.confirmPairs),
      lines: unitSnapshot.map((item) => `${item.productCode}/${item.size}: ${item.pairs}×${item.boxes}=${item.units}`),
    }, "MoySklad kirim qty snapshot");
    const store = catalog.warehouses.find((item) => item.id === storeId) || (catalog.warehouses.length === 1 ? catalog.warehouses[0] : null);
    if (!store) throw Object.assign(new Error("store"), { status: 400 });
    const { organization, currencies } = orgBundle;
    const currency = currencies.rows.find((row) => row.isoCode === "UZS");
    const company = organization.rows[0];
    const base = "https://api.moysklad.ru/api/remap/1.2";
    const meta = (href: string, type: string) => ({ href, type, mediaType: "application/json" });
    const agentMeta = agent?.meta ?? null;
    if (!agentMeta || !currency || !company) {
      throw Object.assign(new Error(agentMeta ? "currency" : "agent"), { status: 400 });
    }
    stepAt = Date.now();
    const planned = await buildSupplyPositions(positions.map((item) => ({
      ...item.line,
      factoryCode: account?.code || item.line.factoryCode,
    })), currency.meta, {
      factoryCode: account?.code || "",
      factoryName: account?.catalogName || account?.name || "",
      catalog,
      supplierMeta: agentMeta,
    });
    mark("positions", stepAt);
    if (!planned.positions.length) throw Object.assign(new Error("Kirim qatorlari bo‘sh"), { status: 400 });
    const plannedQty = planned.positions.map((item) => Math.round(Number(item.quantity) || 0));
    if (plannedQty.some((qty) => !(qty > 0))) {
      throw Object.assign(new Error("qty_mismatch"), {
        status: 500,
        detail: "Rejada noldan/manfiy miqdor bor. Kirim yozilmadi.",
      });
    }
    const plannedTotal = plannedQty.reduce((sum, qty) => sum + qty, 0);
    if (plannedTotal !== waybillUnitsTotal) {
      logger.error({ shipment: shipmentId, plannedTotal, waybillUnitsTotal, plannedQty }, "Kirim qty internal mismatch");
      throw Object.assign(new Error("qty_mismatch"), {
        status: 500,
        detail: `Ichki miqdor xato: yuk xati ${waybillUnitsTotal}, reja ${plannedTotal}. Kirim yozilmadi.`,
      });
    }
    // Tahrir poygasi: snapshot bilan hozirgi yuk xati yana bir xil bo‘lsin
    const fresh = listShipments().find((item) => item.id === shipmentId);
    if (!fresh || fresh.moyskladId) {
      throw Object.assign(new Error(fresh?.moyskladId ? "posted" : "not_found"), { status: fresh?.moyskladId ? 409 : 404 });
    }
    const freshTotal = fresh.lines.reduce((sum, line) => sum + lineUnits(line), 0);
    if (freshTotal !== waybillUnitsTotal) {
      throw Object.assign(new Error("qty_mismatch"), {
        status: 409,
        detail: `Yuk xati kirim paytida o‘zgardi (${waybillUnitsTotal} → ${freshTotal}). Qayta urinib ko‘ring.`,
      });
    }
    for (const link of planned.links) linkShipmentLine(shipment.id, link.lineId, link.product);
    for (const product of planned.created) {
      const linked = planned.links.find((item) => item.product.id === product.id);
      const source = current.lines.find((line) => line.id === linked?.lineId);
      addCatalogProduct({
        id: product.id,
        name: product.name || "",
        code: product.code || null,
        article: product.article || null,
        barcodes: product.barcodes ?? [],
        factory: agent?.name || account?.catalogName || account?.name || null,
        category: product.folderName || null,
        unit: "шт",
        packType: source && source.pachka > 1 && source.pachka <= 36 ? "pachka" : null,
        packSize: source && source.pachka > 1 && source.pachka <= 36 ? source.pachka : 1,
        imageUrl: null,
        stock: 0,
        available: 0,
        cost: source?.price ?? null,
        salePrice: source?.price ?? null,
        lastSale: null,
        lastReceipt: null,
        sales7: 0,
        sales30: 0,
        sales60: 0,
        sales90: 0,
        daysCover: null,
        stockStatus: "out",
        inTransit: 0,
      });
    }
    const postedAt = moyskladDateTime();
    const incomingDay = /^\d{4}-\d{2}-\d{2}/.test(shipment.date) ? shipment.date.slice(0, 10) : postedAt.slice(0, 10);
    const supplyCore: Record<string, unknown> = {
      name: shipment.number,
      moment: postedAt,
      incomingNumber: shipment.number,
      incomingDate: `${incomingDay} ${postedAt.slice(11)}`,
      vatEnabled: false,
      vatIncluded: false,
      externalCode: shipment.id,
      organization: { meta: company.meta },
      agent: { meta: agentMeta },
      store: { meta: meta(`${base}/entity/store/${store.id}`, "store") },
      rate: { currency: { meta: currency.meta } },
      ...(shipment.note.trim() ? { description: shipment.note.trim() } : { description: `Yuk xati ${shipment.number}` }),
    };
    const supplyPositions = planned.positions.map((item, index) => ({
      quantity: plannedQty[index],
      price: item.price,
      discount: 0,
      vat: 0,
      vatEnabled: false,
      assortment: item.assortment,
    }));
    const postedQtyCheck = supplyPositions.reduce((sum, item) => sum + item.quantity, 0);
    if (postedQtyCheck !== waybillUnitsTotal) {
      throw Object.assign(new Error("qty_mismatch"), {
        status: 500,
        detail: `Yuborish oldidan miqdor xato: ${postedQtyCheck} ≠ ${waybillUnitsTotal}. Kirim yozilmadi.`,
      });
    }
    stepAt = Date.now();
    // Dublikat himoya: avval MoySkladda shu yuk bor-yo‘qligini qidiramiz.
    const priorAlert = Boolean(shipment.msAlert);
    let created: { id: string; name?: string; reused: boolean } | null = null;
    const existing = await findExistingSupply(shipment);
    if (existing) {
      try {
        await assertSupplyMatchesOrRollback(
          existing.id,
          supplyPositions,
          { shipmentId, allowDelete: false },
        );
        created = { id: existing.id, name: existing.name, reused: true };
        await stampSupplyExternalCode(existing.id, shipment.id);
        logger.info({ shipment: shipmentId, supply: existing.id }, "Reusing healthy MoySklad supply — no duplicate create");
      } catch (error) {
        if (isTransientMsError(error)) throw error;
        logger.warn({
          shipment: shipmentId,
          supply: existing.id,
          err: error instanceof Error ? error.message : error,
        }, "Existing MoySklad supply unhealthy — deleting own/orphan then recreate once");
        await deleteOwnOrphanSupplies(shipment);
      }
    }
    if (!created) {
      created = await postSupplyDocument(supplyCore, supplyPositions, shipment, { skipExistingCheck: false });
    }
    mark("post-supply", stepAt);
    // HARD GUARD: qty + agent/store/org + applicable — aks holda rollback
    try {
      await assertSupplyMatchesOrRollback(
        created.id,
        supplyPositions,
        { shipmentId, allowDelete: !created.reused },
      );
    } catch (error) {
      if (isTransientMsError(error)) throw error;
      logger.warn({
        shipment: shipmentId,
        supply: created.id,
        reused: created.reused,
        err: error instanceof Error ? error.message : error,
      }, "MoySklad supply mismatched — recreating once");
      await deleteOwnOrphanSupplies(shipment);
      created = await postSupplyDocument(supplyCore, supplyPositions, shipment, { skipExistingCheck: false });
      await assertSupplyMatchesOrRollback(
        created.id,
        supplyPositions,
        { shipmentId, allowDelete: true },
      );
    }
    // Shu yukning ortiqcha dublikatlarini tozalash — muvaffaqiyatsiz bo‘lsa mark qilinmasin
    const pruned = await pruneDuplicateSupplies(shipment, created.id);
    if (pruned > 0) logger.info({ shipment: shipmentId, keep: created.id, pruned }, "Duplicate MoySklad supplies pruned");
    await stampSupplyExternalCode(created.id, shipment.id);
    // Agent majburiy — mark qilishdan OLDIN
    await ensureSupplyAgent(created.id, agentMeta);
    // Pachka kartada bo‘lsin (post verify)
    const linkedFresh = listShipments().find((item) => item.id === shipment.id) ?? current;
    try {
      await ensureLinePachkas(linkedFresh.lines.map((line) => ({
        productId: line.productId,
        pachka: line.pachka,
        pairs: line.pairs,
        productCode: line.productCode,
      })));
    } catch (error) {
      logger.error({ shipment: shipmentId, supply: created.id, err: error instanceof Error ? error.message : error }, "Pachka verify failed — rolling back");
      try { await deleteSupplyDocument(created.id); } catch { /* ignore */ }
      throw error;
    }
    // Yakuniy integrity (agent yozilgach)
    await assertSupplyMatchesOrRollback(
      created.id,
      supplyPositions,
      { shipmentId, allowDelete: true },
    );

    const wanted = shipment.number.trim();
    const currentName = (created.name || "").trim();
    const number = currentName || wanted;
    const saved = markShipmentPosted(shipment.id, {
      id: created.id,
      number,
      units: unitSnapshot,
      unitsTotal: waybillUnitsTotal,
    });
    if (!(currentName === wanted || currentName.startsWith(`${wanted} `))) {
      scheduleSupplyName({ ...saved, moyskladId: created.id, moyskladNumber: number });
    }
    // Lokal zaxira faqat birinchi muvaffaqiyatli kirimda. Qayta kirim / msAlert — MS tuzatadi, lokalni ikki marta oshirmaydi.
    if (!created.reused && !priorAlert) {
      applyReceiptStock(planned.positions.map((item) => ({ productId: item.stockId, warehouseId: store.id, quantity: item.quantity })));
    }
    void recordAudit({
      action: "shipment.posted",
      entityType: "shipment",
      entityId: shipment.id,
      details: `${number}; units=${waybillUnitsTotal}; integrity=ok`,
    });
    void fillZeroSupplyPrices(created.id, shipment.lines).catch((error) => {
      logger.warn({ supply: created.id, err: error instanceof Error ? error.message : error }, "MoySklad supply price fill after create failed");
    });
    mark("done", t0);
    return { id: created.id, number, shipment: saved, already: created.reused };
  } finally {
    endSupplyInflight(shipmentId);
    releaseMoySkladSlots();
    unlock();
  }
}

function supplyJobPayload(shipmentId: string) {
  const shipment = listShipments().find((item) => item.id === shipmentId);
  if (shipment?.moyskladId) {
    return { pending: false, already: true, id: shipment.moyskladId, number: shipment.moyskladNumber || shipment.number, shipment };
  }
  const job = supplyJobs.get(shipmentId);
  // Sticky uzilgan bo‘lsa eski "done" natija yolg‘on success bermasin
  if (job?.status === "done") {
    supplyJobs.delete(shipmentId);
    persistSupplyJobs();
    return { pending: false, error: "idle" };
  }
  if (job?.status === "error") return { pending: false, error: job.error || "rejected", detail: job.detail || "Kirim yozilmadi" };
  if (job?.status === "pending") return { pending: true };
  return { pending: false, error: "idle" };
}

function supplyClientError(code: string) {
  return code === "store" || code === "agent" || code === "currency" || code === "pairs_suspect" || code === "pachka_mismatch";
}

function foldWarehouseName(name: string) {
  return String(name || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

/** Default ombor: env → «Yangi katta sklad» → yagona ombor → birinchisi. */
function preferredSupplyStoreId(warehouses: Array<{ id: string; name: string }>) {
  const envId = (process.env.DEFAULT_SUPPLY_STORE_ID || "").trim();
  if (envId && warehouses.some((row) => row.id === envId)) return envId;
  const preferred = warehouses.find((row) => {
    const label = foldWarehouseName(row.name);
    return label.includes("янги катта склад") || label.includes("yangi katta sklad");
  });
  if (preferred) return preferred.id;
  if (warehouses.length === 1) return warehouses[0].id;
  return warehouses[0]?.id || "";
}

/**
 * Qabul qilingandan keyin odam qo‘shimcha bosmasin:
 * default ombor + zavod kontragent → MoySklad kirim avtomatik.
 */
async function startAutoSupplyAfterAccept(shipmentId: string) {
  const shipment = listShipments().find((item) => item.id === shipmentId);
  if (!shipment || shipment.status === "declined" || shipment.moyskladId) return;
  if (isSupplyInflight(shipmentId)) return;
  const existing = supplyJobs.get(shipmentId);
  if (existing?.status === "pending") return;

  try {
    const catalog = await loadCatalogForSupply();
    const storeId = preferredSupplyStoreId(catalog.warehouses || []);
    if (!storeId) {
      setSupplyJob(shipmentId, {
        status: "error",
        error: "store",
        detail: "Avtomatik kirim: ombor topilmadi. DEFAULT_SUPPLY_STORE_ID yoki katalog omborlarini tekshiring.",
        storeId: "",
      });
      return;
    }
    const account = getAccount(shipment.factoryId);
    const agent = account
      ? await resolveFactoryAgent({
        id: account.id,
        name: account.name,
        catalogName: account.catalogName,
        code: account.code,
        login: account.login,
        counterpartyId: account.counterpartyId,
        counterpartyName: account.counterpartyName,
      })
      : null;
    logger.info({
      shipment: shipmentId,
      number: shipment.number,
      storeId,
      agent: agent?.name || null,
    }, "Auto MoySklad kirim after accept");
    void runSupplyJob(
      shipmentId,
      storeId,
      agent ? { id: agent.id, name: agent.name } : undefined,
    );
  } catch (error) {
    logger.warn({
      shipment: shipmentId,
      err: error instanceof Error ? error.message : error,
    }, "Auto MoySklad kirim start failed");
    setSupplyJob(shipmentId, {
      status: "error",
      error: "rejected",
      detail: error instanceof Error ? error.message : "Avtomatik kirim boshlanmadi",
      storeId: "",
    });
  }
}

router.get("/partner-factories/shipments/:id/supply", async (req, res) => {
  const shipmentId = String(req.params.id);
  const shipment = listShipments().find((item) => item.id === shipmentId);
  if (shipment?.moyskladId) {
    const healthy = await ensureLinkedSupplyOrClear(shipment);
    if (healthy) {
      const fresh = listShipments().find((item) => item.id === shipmentId) ?? shipment;
      res.json({ pending: false, already: true, id: healthy.id, number: healthy.name, shipment: fresh });
      return;
    }
    const cleared = listShipments().find((item) => item.id === shipmentId);
    if (cleared?.msAlert) {
      res.json({
        pending: false,
        needsRepost: true,
        cleared: true,
        error: cleared.msAlert.code,
        detail: `${cleared.msAlert.title}. ${cleared.msAlert.detail}`,
        msAlert: cleared.msAlert,
        shipment: cleared,
      });
      return;
    }
  }
  const payload = supplyJobPayload(shipmentId);
  if (payload.pending) {
    res.status(202).json(payload);
    return;
  }
  if ("error" in payload && payload.error === "idle") {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if ("error" in payload && payload.error) {
    res.status(supplyClientError(String(payload.error)) ? 400 : 502).json(payload);
    return;
  }
  res.json(payload);
});

router.post("/partner-factories/shipments/:id/supply", async (req, res) => {
  const shipmentId = String(req.params.id);
  let shipment = listShipments().find((item) => item.id === shipmentId);
  if (!shipment) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (shipment.status === "declined") {
    res.status(409).json({ error: "declined" });
    return;
  }
  if (shipment.moyskladId) {
    const healthy = await ensureLinkedSupplyOrClear(shipment);
    if (healthy) {
      const fresh = listShipments().find((item) => item.id === shipmentId) ?? shipment;
      res.json({ pending: false, already: true, id: healthy.id, number: healthy.name, shipment: fresh });
      return;
    }
    shipment = listShipments().find((item) => item.id === shipmentId);
    if (!shipment) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Sticky uzildi — UI ogohlantirsin, keyin qayta kirim
    if (shipment.msAlert && !shipment.moyskladId) {
      // continue to new post below if storeId berilgan; aks holda alert qaytar
      const storeIdPeek = String(req.body?.storeId ?? "").trim();
      if (!storeIdPeek) {
        res.status(409).json({
          pending: false,
          needsRepost: true,
          cleared: true,
          error: shipment.msAlert.code,
          detail: `${shipment.msAlert.title}. ${shipment.msAlert.detail}`,
          msAlert: shipment.msAlert,
          shipment,
        });
        return;
      }
    }
  }
  const job = supplyJobs.get(shipmentId);
  if (job?.status === "done" && job.result && listShipments().find((item) => item.id === shipmentId)?.moyskladId) {
    res.json({ pending: false, ...job.result });
    return;
  }
  let storeId = String(req.body?.storeId ?? "").trim();
  const counterpartyId = String(req.body?.counterpartyId ?? "").trim();
  const counterpartyName = String(req.body?.counterpartyName ?? "").trim();
  const confirmPairs = Boolean(req.body?.confirmPairs);
  if (!storeId) {
    try {
      const catalog = await loadCatalogForSupply();
      storeId = preferredSupplyStoreId(catalog.warehouses || []);
    } catch {
      storeId = "";
    }
  }
  if (job?.status !== "pending") {
    void runSupplyJob(
      shipmentId,
      storeId,
      counterpartyId ? { id: counterpartyId, name: counterpartyName } : undefined,
      { confirmPairs },
    );
  }
  // Tez yo‘l: qisqa kutish; uzoq ish — 202 + poll (UI bloklanmasin).
  const started = Date.now();
  while (Date.now() - started < 4_000) {
    const payload = supplyJobPayload(shipmentId);
    if (!payload.pending) {
      if ("error" in payload && payload.error && payload.error !== "idle") {
        res.status(supplyClientError(String(payload.error)) ? 400 : 502).json(payload);
        return;
      }
      const { pending: _pending, ...rest } = payload as { pending?: boolean } & Record<string, unknown>;
      res.json({ pending: false, ...rest });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  res.status(202).json({ pending: true });
});

router.post("/partner-factories/shipments/:id/accept", async (req, res) => {
  try {
    const shipmentId = String(req.params.id);
    const accepted = setShipmentStatus(shipmentId, "accepted");
    void recordAudit({ action: "shipment.accepted", entityType: "shipment", entityId: shipmentId });
    // Professional: qabul = MoySkladga kirim ham (odam qayta bosmasin)
    if (!accepted.moyskladId && moyskladConfigured()) {
      void startAutoSupplyAfterAccept(shipmentId);
      res.json({ ...accepted, autoSupply: true, supplyPending: true });
      return;
    }
    res.json({ ...accepted, autoSupply: false, supplyPending: false });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/partner-factories/shipments/:id/decline", (req, res) => {
  try {
    const declined = setShipmentStatus(String(req.params.id), "declined");
    void recordAudit({ action: "shipment.declined", entityType: "shipment", entityId: String(req.params.id) });
    res.json(declined);
  } catch (error) {
    fail(res, error);
  }
});

router.post("/partner-factories/shipments/:id/reopen", (req, res) => {
  try {
    res.json(setShipmentStatus(String(req.params.id), "sent"));
  } catch (error) {
    fail(res, error);
  }
});

router.patch("/partner-factories/shipments/:id", (req, res) => {
  try {
    res.json(updateShipment(String(req.params.id), {
      date: req.body?.date,
      note: req.body?.note,
      lines: Array.isArray(req.body?.lines) ? req.body.lines : [],
    }));
  } catch (error) {
    fail(res, error);
  }
});

router.delete("/partner-factories/shipments/:id", (req, res) => {
  try {
    res.json(deleteShipment(String(req.params.id)));
  } catch (error) {
    fail(res, error);
  }
});

router.post("/factory/login", (req, res) => {
  try {
    res.json(loginFactory(String(req.body?.login ?? ""), String(req.body?.password ?? "")));
  } catch (error) {
    fail(res, error);
  }
});

router.get("/factory/me", requireFactory, (_req, res) => {
  const account = res.locals.factory;
  res.json({ account, shipments: listShipments(account.id) });
});

router.get("/factory/products", requireFactory, async (req, res, next) => {
  try {
    const query = String(req.query.q ?? "").trim();
    if (query.length < 2) {
      res.json({ items: [] });
      return;
    }
    const catalog = await catalogForRead();
    if (!catalog) {
      res.status(503).json({ error: "catalog_syncing", items: [] });
      return;
    }
    const account = res.locals.factory as { code?: string; name?: string; catalogName?: string };
    const compact = compactCode(query);
    const scored: Array<{ score: number; id: string; name: string; code: string | null; article: string | null; barcode: string | null }> = [];
    for (const product of catalog.products) {
      if (!productBelongsToFactory(product, account.code || "", account.catalogName || account.name || "")) continue;
      const code = product.code || "";
      const article = product.article || "";
      let score = 0;
      const token = new RegExp(`(^|\\D)${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\D|$)`, "i");
      if (compactCode(code) === compact || compactCode(article) === compact) score = 4;
      else if (token.test(product.name) || (compact.length >= 3 && compactCode(product.name).includes(compact))) score = 3;
      if (score) scored.push({ score, id: product.id, name: product.name, code: product.code, article: product.article, barcode: product.barcodes[0] ?? null });
    }
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    res.json({ items: scored.slice(0, 12).map(({ id, name, code, article, barcode }) => ({ id, name, code, article, barcode })) });
  } catch (error) {
    next(error);
  }
});

router.put("/factory/shipments/:id", requireFactory, async (req, res, next) => {
  try {
    const catalog = await peekOrRecallCatalog();
    const byId = new Map((catalog?.products ?? []).map((product) => [product.id, product]));
    const lines = (Array.isArray(req.body?.lines) ? req.body.lines : []).map((line: { productId?: string; productCode?: string }) => {
      const product = byId.get(String(line?.productId ?? "").trim());
      const matches = product ? lineMatchesCatalogProduct(product, String(line?.productCode ?? "")) : false;
      return matches && product ? { ...line, productId: product.id, productName: product.name } : { ...line, productId: null, productName: null };
    });
    const saved = reviseShipment(res.locals.factory.id, String(req.params.id), {
      date: req.body?.date,
      note: req.body?.note,
      lines,
    });
    void flushPartners().catch((error: unknown) => {
      logger.warn({ err: error instanceof Error ? error.message : error }, "Partner flush after revise failed");
    });
    if (catalog) linkExactShipmentLines(res.locals.factory.id, (line) => exactCatalogProduct(catalog, line, res.locals.factory));
    const shipment = listShipments(res.locals.factory.id).find((item) => item.id === saved.id) ?? saved;
    res.json(shipment);
  } catch (error) {
    if (typeof error === "object" && error && "status" in error) {
      fail(res, error);
      return;
    }
    next(error);
  }
});

router.post("/factory/shipments", requireFactory, async (req, res, next) => {
  try {
    const catalog = await peekOrRecallCatalog();
    const byId = new Map((catalog?.products ?? []).map((product) => [product.id, product]));
    const lines = (Array.isArray(req.body?.lines) ? req.body.lines : []).map((line: { productId?: string; productCode?: string }) => {
      const product = byId.get(String(line?.productId ?? "").trim());
      const matches = product ? lineMatchesCatalogProduct(product, String(line?.productCode ?? "")) : false;
      return matches && product ? { ...line, productId: product.id, productName: product.name } : { ...line, productId: null, productName: null };
    });
    const created = createShipment(res.locals.factory.id, {
      date: req.body?.date,
      note: req.body?.note,
      lines,
    });
    // Postgres sync fon rejimida — zavod yuk xati yuborishi kutmasin.
    void flushPartners().catch((error: unknown) => {
      logger.warn({ err: error instanceof Error ? error.message : error }, "Partner flush after create failed");
    });
    if (catalog) linkExactShipmentLines(res.locals.factory.id, (line) => exactCatalogProduct(catalog, line, res.locals.factory));
    const shipment = listShipments(res.locals.factory.id).find((item) => item.id === created.id) ?? created;
    res.status(201).json(shipment);
  } catch (error) {
    if (typeof error === "object" && error && "status" in error) {
      fail(res, error);
      return;
    }
    next(error);
  }
});

/* ── Doimiy kirim nazorati (JUDA KONSERVATIV) ──
 * Faqat o‘qitilgan qoidalar:
 *  ✅ Hisobot: har qanday shubha / farq
 *  ✅ Dublikat o‘chirish: faqat ANIQ 1 ta “to‘g‘ri dona” g‘olib bo‘lsa
 *  ✅ applicable=true: faqat dona+agent+store+org to‘liq mos, faqat o‘tkazilmagan
 *  ✅ Qayta bog‘lash: faqat 1 ta kandidat + dona aniq mos + (externalCode yoki sticky yo‘q)
 *  ✅ Sticky tozalash: faqat MS da hujjat 404/korzina (o‘chirilgan)
 *  ❌ Yangi kirim YARATMAYDI
 *  ❌ Dona noma’lum / 2+ g‘olib / farq — o‘chirmaydi, bog‘lamaydi
 *  ❌ qty_mismatch uchun sticky uzmaydi (buzib qo‘ymaslik)
 */

type WatchFinding = {
  key: string;
  number: string;
  severity: "critical" | "warn" | "fixed" | "info";
  title: string;
  detail: string;
};

function expectedShipmentUnits(shipment: {
  postedUnitsTotal?: number | null;
  lines: Array<{ pairs: number; boxes: number; quantity: number; colors?: Array<{ quantity: number }> }>;
}) {
  if (shipment.postedUnitsTotal != null && shipment.postedUnitsTotal > 0) {
    return Math.round(Number(shipment.postedUnitsTotal));
  }
  return shipment.lines.reduce((sum, line) => sum + lineUnits({
    pairs: Number(line.pairs) || 0,
    boxes: Number(line.boxes) || 0,
    quantity: Number(line.quantity) || 0,
    colors: Array.isArray(line.colors) ? line.colors.map((c) => ({ quantity: Number(c.quantity) || 0 })) : [],
  }), 0);
}

async function supplyQtyTotal(supplyId: string) {
  const page = await moyskladAll<{ quantity?: number }>(`/entity/supply/${encodeURIComponent(supplyId)}/positions`);
  return page.rows.reduce((sum, row) => sum + Math.round(Number(row.quantity) || 0), 0);
}

type ScoredSupply = { row: SupplyHit; qty: number; score: number; qtyOk: boolean };

async function scoreOwnSupplies(
  shipment: { id: string; number: string; moyskladId?: string | null },
  candidates: SupplyHit[],
  expected: number,
): Promise<ScoredSupply[]> {
  const out: ScoredSupply[] = [];
  for (const row of candidates) {
    let qty = -1;
    try {
      qty = await supplyQtyTotal(row.id);
    } catch {
      qty = -1;
    }
    const qtyOk = expected > 0 && qty === expected;
    const score = supplyMatchScore(row, shipment)
      + (qtyOk ? 50 : 0)
      + (row.externalCode === shipment.id ? 10 : 0)
      + (row.id === shipment.moyskladId ? 8 : 0);
    out.push({ row, qty, score, qtyOk });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Bitta yuk: avval ANIQLASH, keyin faqat qoida bo‘yicha xavfsiz tuzatish.
 * Shubhada — faqat Telegram hisobot, MS/lokalni buzmaydi.
 */
async function auditRepairOneShipment(shipment: ReturnType<typeof listShipments>[number]): Promise<WatchFinding[]> {
  const findings: WatchFinding[] = [];
  const number = shipment.number.trim();
  if (!number || shipment.status === "declined") return findings;
  if (isSupplyInflight(shipment.id)) return findings;

  const expected = expectedShipmentUnits(shipment);
  if (!(expected > 0) && !shipment.moyskladId && !shipment.msAlert) return findings;

  let candidates: SupplyHit[] = [];
  try {
    candidates = (await listSupplyCandidates(shipment)).filter((row) => isOwnOrOrphanDup(row, shipment));
  } catch (error) {
    if (isTransientMsError(error)) return findings;
    findings.push({
      key: `${number}:lookup`,
      number,
      severity: "warn",
      title: "MS qidiruv xatosi (tuzatilmadi)",
      detail: error instanceof Error ? error.message.slice(0, 180) : "lookup",
    });
    return findings;
  }

  const scored = await scoreOwnSupplies(shipment, candidates, expected);
  const exact = scored.filter((item) => item.qtyOk);
  const linkedId = String(shipment.moyskladId || "").trim();

  // ── 1) Dublikat: faqat ANIQ bitta to‘g‘ri-dona g‘olib bo‘lsa prune ──
  if (candidates.length > 1) {
    if (!(expected > 0)) {
      findings.push({
        key: `${number}:dups`,
        number,
        severity: "critical",
        title: "Dublikat — kutilyotgan dona yo‘q",
        detail: `${candidates.length} ta MS kirim. Avto-o‘chirish yoqilmadi (yuk donasi noma’lum).`,
      });
    } else if (exact.length !== 1) {
      findings.push({
        key: `${number}:dups`,
        number,
        severity: "critical",
        title: exact.length === 0 ? "Dublikat — to‘g‘ri dona yo‘q" : "Dublikat — bir nechta to‘g‘ri dona",
        detail: `${candidates.length} ta kirim, yuk ${expected} dona. Aniq g‘olib ${exact.length} ta — avto-o‘chirish YOQ (buzib qo‘ymaslik).`,
      });
    } else {
      const keep = exact[0];
      // Agar lokal bog‘ boshqa ID ga qaragan va u ham mavjud bo‘lsa — faqat keep=linked bo‘lsa o‘chiramiz,
      // yoki linked noto‘g‘ri donada va keep aniq to‘g‘ri.
      const linkedRow = linkedId ? scored.find((item) => item.row.id === linkedId) : undefined;
      const safeKeep = !linkedId
        || linkedId === keep.row.id
        || (linkedRow && !linkedRow.qtyOk);
      if (!safeKeep) {
        findings.push({
          key: `${number}:dups`,
          number,
          severity: "critical",
          title: "Dublikat — bog‘lanish chalkash",
          detail: `Lokal boshqa ID ga bog‘langan va u ham to‘g‘ri donali ko‘rinadi. Avto-o‘chirish yoqilmadi.`,
        });
      } else {
        try {
          const removed = await pruneDuplicateSupplies(shipment, keep.row.id);
          if (linkedId && linkedId !== keep.row.id) {
            clearShipmentPosted(shipment.id, { expectMoyskladId: linkedId, reopen: false });
            markShipmentPosted(shipment.id, { id: keep.row.id, number: keep.row.name || number });
          } else if (!linkedId) {
            markShipmentPosted(shipment.id, { id: keep.row.id, number: keep.row.name || number });
          }
          await stampSupplyExternalCode(keep.row.id, shipment.id);
          findings.push({
            key: `${number}:dups`,
            number,
            severity: "fixed",
            title: "Dublikat qoida bo‘yicha tozalandi",
            detail: `${candidates.length}→1. Saqlangan: ${keep.row.name || keep.row.id.slice(0, 8)} (${keep.qty} dona = yuk). O‘chirildi: ${removed}.`,
          });
          candidates = [keep.row];
          supplyLookup.delete(shipment.id);
        } catch (error) {
          const code = error instanceof Error ? error.message : "prune";
          findings.push({
            key: `${number}:dups`,
            number,
            severity: "critical",
            title: code === "ms_permission" ? "Dublikat: MS ruxsati yo‘q" : "Dublikat tozalanmadi",
            detail: `${candidates.length} ta. ${typeof error === "object" && error && "detail" in error ? String((error as { detail?: unknown }).detail || "") : code}`.slice(0, 280),
          });
        }
      }
    }
  }

  // ── 2) Sticky: faqat o‘chirilgan/404 — qty farqida UZMAYMIZ ──
  const freshLink = String((listShipments().find((item) => item.id === shipment.id) ?? shipment).moyskladId || "").trim() || linkedId;
  if (freshLink) {
    try {
      const doc = await moysklad<SupplyDocMeta>(
        `/entity/supply/${encodeURIComponent(freshLink)}?expand=agent,organization,store`,
      );
      if (doc.deleted) {
        clearShipmentPosted(shipment.id, {
          expectMoyskladId: freshLink,
          alert: {
            code: "ms_deleted",
            title: "MoySklad kirimi o‘chirilgan",
            detail: "Hujjat korzinada. Bog‘lanish uzildi (faqat o‘chirilgan holat).",
          },
        });
        findings.push({
          key: `${number}:gone`,
          number,
          severity: "fixed",
          title: "O‘chirilgan sticky uzildi",
          detail: "MS korzina/o‘chirilgan — lokal bog‘ tozalandi. Yangi kirim yaratilmadi.",
        });
      } else {
        const qty = await supplyQtyTotal(freshLink);
        const metaOk = Boolean(doc.agent && doc.store && doc.organization);
        const qtyOk = expected > 0 && qty === expected;

        // Faqat applicable=false + hamma narsa mos → o‘tkazish
        if (doc.applicable === false && metaOk && qtyOk) {
          try {
            await forceSupplyApplicable(freshLink);
            const again = await moysklad<SupplyDocMeta>(`/entity/supply/${encodeURIComponent(freshLink)}`);
            if (again.applicable !== false && !again.deleted) {
              findings.push({
                key: `${number}:applicable`,
                number,
                severity: "fixed",
                title: "Kirim o‘tkazildi (applicable)",
                detail: `Dona ${qty} = yuk ${expected}. Faqat o‘tkazish yoqildi.`,
              });
            } else {
              findings.push({
                key: `${number}:applicable`,
                number,
                severity: "warn",
                title: "O‘tkazish ishlamadi",
                detail: "applicable qolgan — o‘chirilmadi, qayta yozilmadi.",
              });
            }
          } catch (error) {
            findings.push({
              key: `${number}:applicable`,
              number,
              severity: "warn",
              title: "O‘tkazish rad etildi",
              detail: (error instanceof Error ? error.message : "applicable").slice(0, 180),
            });
          }
        } else if (!qtyOk && expected > 0) {
          findings.push({
            key: `${number}:qty`,
            number,
            severity: "critical",
            title: "Dona mos emas (qo‘lda)",
            detail: `Yuk ${expected} · MS ${qty}. Sticky saqlangan — avto-o‘chirish/qayta yaratish YOQ.`,
          });
        } else if (!metaOk) {
          findings.push({
            key: `${number}:meta`,
            number,
            severity: "warn",
            title: "MS meta to‘liq emas",
            detail: [
              !doc.agent ? "kontragent yo‘q" : "",
              !doc.store ? "ombor yo‘q" : "",
              !doc.organization ? "tashkilot yo‘q" : "",
            ].filter(Boolean).join("; ") + " — sticky saqlangan, buzilmadi.",
          });
        } else if (doc.externalCode !== shipment.id) {
          await stampSupplyExternalCode(freshLink, shipment.id);
        }
      }
    } catch (error) {
      if (supplyGone(error) || (error instanceof MoySkladError && error.status === 404)) {
        clearShipmentPosted(shipment.id, {
          expectMoyskladId: freshLink,
          alert: {
            code: "ms_gone",
            title: "MoySklad kirimi topilmadi",
            detail: "Bog‘langan ID MS da yo‘q. Sticky uzildi. Yangi kirim yaratilmadi.",
          },
        });
        findings.push({
          key: `${number}:gone`,
          number,
          severity: "fixed",
          title: "Yo‘qolgan sticky uzildi",
          detail: "404/korzina — faqat bog‘ tozalandi.",
        });
      } else if (!isTransientMsError(error)) {
        findings.push({
          key: `${number}:check`,
          number,
          severity: "warn",
          title: "Tekshiruv xatosi",
          detail: (error instanceof Error ? error.message : "check").slice(0, 180),
        });
      }
      // transient — hech narsa qilmaymiz
    }
  } else if (candidates.length === 1 && exact.length === 1 && expected > 0) {
    // ── 3) Qayta bog‘lash: faqat 1 kandidat + dona aniq + (externalCode o‘zimizniki yoki nom aniq) ──
    const hit = exact[0];
    const owned = hit.row.externalCode === shipment.id
      || String(hit.row.name || "").trim() === number;
    if (!owned) {
      findings.push({
        key: `${number}:orphan`,
        number,
        severity: "warn",
        title: "Yetim kirim — bog‘lanmadi",
        detail: `Dona mos (${hit.qty}), lekin ownership aniq emas — avto-bog‘lash yoqilmadi.`,
      });
    } else {
      try {
        markShipmentPosted(shipment.id, { id: hit.row.id, number: hit.row.name || number });
        await stampSupplyExternalCode(hit.row.id, shipment.id);
        findings.push({
          key: `${number}:relink`,
          number,
          severity: "fixed",
          title: "Qayta bog‘landi (qoida)",
          detail: `${hit.row.name || hit.row.id.slice(0, 8)} · ${hit.qty} dona = yuk. Yangi hujjat yaratilmadi.`,
        });
      } catch (error) {
        findings.push({
          key: `${number}:relink`,
          number,
          severity: "warn",
          title: "Bog‘lash rad",
          detail: (error instanceof Error ? error.message : "relink").slice(0, 160),
        });
      }
    }
  } else if (!freshLink && candidates.length > 0 && exact.length === 0 && expected > 0) {
    findings.push({
      key: `${number}:mismatch`,
      number,
      severity: "critical",
      title: "MS bor, dona mos emas",
      detail: `${candidates.length} ta kandidat, hech biri ${expected} dona emas. Avto-tuzatish yoqilmadi.`,
    });
  } else if (!freshLink && shipment.msAlert) {
    findings.push({
      key: `${number}:alert`,
      number,
      severity: "warn",
      title: shipment.msAlert.title,
      detail: `${shipment.msAlert.detail.slice(0, 200)} — avto-qayta-kirim yoqilmadi.`,
    });
  }

  return findings;
}

function tashkentWatchParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    stamp: `${pick("year")}-${pick("month")}-${pick("day")}`,
    hour: Number(pick("hour")),
    minute: Number(pick("minute")),
    label: `${pick("day")}.${pick("month")}.${pick("year")} ${pick("hour")}:${pick("minute")}`,
  };
}

function digestSlot(hour: number) {
  if (hour >= 9 && hour < 12) return "morning";
  if (hour >= 18 && hour < 22) return "evening";
  return null;
}

function formatWatchReport(when: string, findings: WatchFinding[], scanned: number, ok: boolean) {
  const fixed = findings.filter((f) => f.severity === "fixed");
  const critical = findings.filter((f) => f.severity === "critical");
  const warn = findings.filter((f) => f.severity === "warn");
  const lines = [
    "<b>Smart Ombor · Kirim nazorati</b>",
    when,
    "",
    `Tekshirildi: <b>${scanned}</b> ta yuk`,
  ];
  if (ok && !findings.length) {
    lines.push("Holat: <b>me’yorda</b> — dublikat/dona xatosi yo‘q.");
    lines.push("");
    lines.push("<i>Nazorat qoida: yangi kirim yaratilmaydi; shubhada faqat hisobot.</i>");
    return lines.join("\n");
  }
  if (fixed.length) lines.push(`Qoida bo‘yicha tuzatildi: <b>${fixed.length}</b>`);
  if (critical.length) lines.push(`Jiddiy (qo‘lda/ruxsat): <b>${critical.length}</b>`);
  if (warn.length) lines.push(`Ogohlantirish: <b>${warn.length}</b>`);
  lines.push("");
  const show = [...critical, ...warn, ...fixed].slice(0, 18);
  for (const item of show) {
    const mark = item.severity === "fixed" ? "✅" : item.severity === "critical" ? "🔴" : "⚠️";
    lines.push(`${mark} <b>${item.number}</b> — ${item.title}`);
    if (item.detail) lines.push(`<i>${item.detail.replace(/</g, "&lt;")}</i>`);
    lines.push("");
  }
  if (findings.length > show.length) {
    lines.push(`… yana ${findings.length - show.length} ta`);
  }
  lines.push("<i>Avto-tuzatish faqat aniq qoida; taxmin bilan o‘chirmaydi/yaratmaydi.</i>");
  return lines.join("\n").trim();
}

/** Yordamchi uchun HTML siz qisqa matn. */
function formatWatchReportPlain(when: string, findings: WatchFinding[], scanned: number) {
  const critical = findings.filter((f) => f.severity === "critical");
  const warn = findings.filter((f) => f.severity === "warn");
  const fixed = findings.filter((f) => f.severity === "fixed");
  const lines = [
    `Kirim nazorati · ${when}`,
    `Tekshirildi: ${scanned} ta yuk`,
    `Jiddiy: ${critical.length} · ogohlantirish: ${warn.length} · tuzatildi: ${fixed.length}`,
  ];
  if (!findings.length) {
    lines.push("Holat: me’yorda — dublikat/dona xatosi yo‘q.");
    return lines.join("\n");
  }
  for (const item of [...critical, ...warn, ...fixed].slice(0, 20)) {
    lines.push(`• ${item.number} — ${item.title}${item.detail ? `: ${item.detail}` : ""}`);
  }
  if (findings.length > 20) lines.push(`… yana ${findings.length - 20} ta`);
  lines.push("Bu — MoySklad kirim dublikat/dona tekshiruvi. Kunlik davomat/savdo brifingi emas.");
  return lines.join("\n");
}

let watchRunning = false;

export async function runSupplyIntegrityPass(opts?: { forceDigest?: boolean }): Promise<{
  scanned: number;
  findings: WatchFinding[];
  reported: boolean;
}> {
  if (watchRunning) return { scanned: 0, findings: [], reported: false };
  if (!moyskladConfigured()) return { scanned: 0, findings: [], reported: false };
  watchRunning = true;
  const when = tashkentWatchParts();
  const findings: WatchFinding[] = [];
  let scanned = 0;
  try {
    void refreshPartnersIfNeeded();
    const all = listShipments().filter((item) => item.status !== "declined");
    // Avval ogohlantirishli / yozilgan / so‘nggi 120 kun
    const cutoff = Date.now() - 120 * 24 * 60 * 60_000;
    const priority = all
      .filter((item) => {
        if (item.msAlert) return true;
        if (item.moyskladId) return true;
        if (item.status === "accepted") return true;
        const at = Date.parse(item.createdAt || item.date) || 0;
        return at >= cutoff;
      })
      .sort((a, b) => {
        const score = (s: typeof a) => (s.msAlert ? 100 : 0) + (s.moyskladId ? 10 : 0) + (s.status === "accepted" ? 5 : 0);
        return score(b) - score(a) || +new Date(b.createdAt) - +new Date(a.createdAt);
      })
      .slice(0, 40);

    for (const shipment of priority) {
      scanned += 1;
      try {
        const row = await auditRepairOneShipment(shipment);
        findings.push(...row);
      } catch (error) {
        logger.warn({ shipment: shipment.id, err: error instanceof Error ? error.message : error }, "Supply watchdog item failed");
      }
      // MS rate limit — yumshoq pauza
      await new Promise((resolve) => setTimeout(resolve, 180));
    }

    const state = readWatchdogState();
    state.lastPassAt = Date.now();
    state.lastReportWhen = when.label;
    state.lastScanned = scanned;
    state.lastFindingCount = findings.length;
    state.lastReportPlain = formatWatchReportPlain(when.label, findings, scanned);
    state.lastReportAt = Date.now();
    const fingerprint = findings
      .map((f) => `${f.key}:${f.severity}`)
      .sort()
      .join("|");
    const hasProblem = findings.some((f) => f.severity === "critical" || f.severity === "warn");
    const hasFixed = findings.some((f) => f.severity === "fixed");
    const slot = digestSlot(when.hour);
    const dueDigest = Boolean(slot) && (state.lastDigestStamp !== when.stamp || state.lastDigestSlot !== slot);
    const changed = fingerprint !== state.lastFingerprint && (hasProblem || hasFixed);
    const cooldownOk = Date.now() - (state.lastAlertAt || 0) > 8 * 60_000;
    const shouldReport = opts?.forceDigest
      || (changed && cooldownOk)
      || (dueDigest && (hasProblem || hasFixed || opts?.forceDigest))
      || (dueDigest && !hasProblem && !hasFixed);

    let reported = false;
    if (shouldReport) {
      const ok = !hasProblem && !hasFixed;
      const text = formatWatchReport(when.label, findings, scanned, ok);
      reported = await notifyAdmin(text);
      if (reported) {
        state.lastAlertAt = Date.now();
        state.lastFingerprint = fingerprint;
        if (ok) state.lastOkAt = Date.now();
        if (dueDigest && slot) {
          state.lastDigestStamp = when.stamp;
          state.lastDigestSlot = slot;
        }
        for (const f of findings) {
          if (f.severity === "critical" || f.severity === "warn") state.issueSeen[f.key] = Date.now();
        }
      }
      logger.info({ scanned, findings: findings.length, reported, dueDigest }, "Supply integrity watchdog report");
    } else {
      logger.info({ scanned, findings: findings.length, fingerprint: fingerprint.slice(0, 80) }, "Supply integrity watchdog pass");
    }
    writeWatchdogState(state);
    return { scanned, findings, reported };
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : error }, "Supply integrity watchdog failed");
    return { scanned, findings, reported: false };
  } finally {
    watchRunning = false;
  }
}

export function startSupplyIntegrityWatchdog() {
  if (process.env.SUPPLY_WATCHDOG === "0") return;
  // Birinchi skan — server isishi uchun kechiktiriladi
  setTimeout(() => {
    void runSupplyIntegrityPass({ forceDigest: true }).catch(() => undefined);
  }, 90_000);
  const timer = setInterval(() => {
    void runSupplyIntegrityPass().catch(() => undefined);
  }, 20 * 60_000);
  timer.unref?.();
  logger.info("Supply integrity watchdog started (20m + Telegram admin)");
}

export default router;

