import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { dataFile } from "../lib/data-dir";
import { addCatalogProduct, applyReceiptStock, canonicalFactoryCode, compactCode, findProductsByLabel, lastNumericToken, loadCatalog, matchWaybillProduct, parseBordoName, peekCatalog, productBelongsToFactory, productCodeMatches, sameBordoColor, sameProductCode } from "../lib/catalog";
import { buildSupplyPositions, pieceCount, receiptParts, stampWaybillCardPrices } from "../lib/supply-assortment";
import { moysklad, moyskladAll, moyskladSend, MoySkladError, permissionDenied, writeDropped } from "../lib/moysklad";
import { logger } from "../lib/logger";
import { recordAudit } from "../lib/audit";
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
  moyskladDateTime,
  partnerRevision,
  tashkentDay,
  deleteAccount,
  deleteShipment,
  resetPassword,
  setShipmentStatus,
  reviseShipment,
  updateShipment,
  updateAccount,
  suggestPassword,
} from "../lib/partners";

const router: IRouter = Router();

function fail(res: Response, error: unknown) {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 500;
  const message = error instanceof Error ? error.message : "error";
  res.status(status || 500).json({ error: message });
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

router.get("/partner-alerts", (_req, res) => {
  const pending = listShipments().filter((item) => item.status === "sent").length;
  res.json({ pending, revision: partnerRevision() });
});

router.get("/partner-factories", async (_req, res, next) => {
  try {
    const catalog = peekCatalog();
    const grouped = new Map<string, { name: string; productCount: number; stock: number }>();
    for (const product of catalog?.products ?? []) {
      const name = product.factory?.trim();
      if (!name) continue;
      const current = grouped.get(name) || { name, productCount: 0, stock: 0 };
      current.productCount += 1;
      current.stock += product.stock;
      grouped.set(name, current);
    }
    const accounts = listAccounts();
    const shipments = listShipments();
    const used = new Set<string>();
    const sameFactory = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();
    const catalogRowFor = (account: { name: string; catalogName: string }) =>
      grouped.get(account.catalogName)
      || grouped.get(account.name)
      || [...grouped.values()].find((row) => sameFactory(row.name, account.catalogName) || sameFactory(row.name, account.name))
      || null;
    const rows = accounts.map((account) => {
      const own = shipments.filter((item) => item.factoryId === account.id);
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
    const extras = [...grouped.values()]
      .filter((row) => !used.has(row.name) && !rows.some((item) => sameFactory(item.name, row.name)))
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
  const matched = matchWaybillProduct(catalog, {
    factoryCode: account.code || line.factoryCode || "",
    factoryName: account.catalogName || account.name || "",
    groupCode: line.sectionCode,
    productCode: line.productCode,
    size: line.size,
  });
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
  if (parsed && productCodeMatches(parsed.productCode, code)) return true;
  const needle = compactCode(code);
  return Boolean(needle) && product.barcodes.some((value) => compactCode(value) === needle);
}

router.get("/partner-factories/:id", async (req, res, next) => {
  try {
    const account = getAccount(String(req.params.id));
    if (!account) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const catalog = peekCatalog();
    if (catalog) linkExactShipmentLines(account.id, (line) => exactCatalogProduct(catalog, line, account));
    const { passwordHash: _hash, salt: _salt, passwordPlain, ...safe } = account;
    res.json({ account: { ...safe, password: passwordPlain || null }, shipments: listShipments(account.id) });
  } catch (error) {
    next(error);
  }
});

function lineUnits(line: { pairs: number; boxes: number; quantity: number; colors: Array<{ name?: string; quantity: number }> }) {
  return pieceCount(line);
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

function sameSupply(row: SupplyHit, shipment: { id: string; number: string }) {
  return Boolean(row.externalCode && row.externalCode === shipment.id);
}

const supplyLookup = new Map<string, { at: number; hit: { id: string; name: string } | null }>();

async function findExistingSupply(shipment: { id: string; number: string; date?: string }): Promise<{ id: string; name: string } | null> {
  const cached = supplyLookup.get(shipment.id);
  if (cached && Date.now() - cached.at < 15_000) return cached.hit;
  const filters = [
    `externalCode=${shipment.id}`,
  ];
  const pages = await Promise.all(filters.map((filter) =>
    moysklad<{ rows: SupplyHit[] }>(`/entity/supply?limit=20&filter=${encodeURIComponent(filter)}`).catch(() => ({ rows: [] as SupplyHit[] })),
  ));
  const ranked = pages.flatMap((page) => page.rows).filter((row) => row.id && !row.deleted && sameSupply(row, shipment));
  ranked.sort((a, b) => Number(Boolean(b.applicable)) - Number(Boolean(a.applicable)));
  const hit = ranked[0]?.id ? { id: ranked[0].id, name: ranked[0].name || shipment.number } : null;
  supplyLookup.set(shipment.id, { at: Date.now(), hit });
  return hit;
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
    const codeOk = parsed ? productCodeMatches(parsed.productCode, line.productCode) : false;
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

async function postSupplyDocument(core: Record<string, unknown>, positions: Array<Record<string, unknown>>, shipment: { id: string; number: string; date?: string }): Promise<{ id: string; name?: string; reused: boolean }> {
  const existing = await findExistingSupply(shipment);
  if (existing) return { ...existing, reused: true };
  const names = [...new Set([chooseSupplyName(shipment), ...supplyNames(shipment).slice(1), `${shipment.number.trim()} ${shipment.id.slice(0, 6)}`])].filter(Boolean);
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
      const foundAgain = await findExistingSupply(shipment);
      if (foundAgain) return { ...foundAgain, reused: true };
      const text = `${error instanceof MoySkladError ? error.parameter || "" : ""} ${error instanceof Error ? error.message : ""}`;
      const retry = uniqueSupplyConflict(error) || permissionDenied(error) || writeDropped(error) || /applicable|проведен/i.test(text);
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
    const catalog = await loadCatalog();
    const account = getAccount(shipment.factoryId);
    const lines = shipment.lines.map((line) => {
      const matched = account ? matchWaybillProduct(catalog, { factoryCode: account.code || line.factoryCode, factoryName: account.catalogName || account.name, groupCode: line.sectionCode, productCode: line.productCode, size: line.size }) : null;
      const text = [line.productCode, line.model, line.size].filter(Boolean).join(" ");
      const found = new Map<string, { id: string; name: string; code: string | null; stock: number }>();
      if (matched) {
        const product = catalog.products.find((item) => item.id === matched.id);
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
    const catalog = await loadCatalog();
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
  return uniqueSupplyConflict(error)
    || writeDropped(error)
    || /уникал|unique|already exists|уже существ|MoySkladda bor|kartasi|yaratilmadi|javob bermadi|limiti|fetch failed/i.test(detail);
}

async function runSupplyJob(shipmentId: string, storeId: string, agent?: { id?: string; name?: string }) {
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
        const result = await writeShipmentSupply(shipmentId, storeId, agent?.id ? { id: agent.id, name: agent.name || "" } : undefined);
        setSupplyJob(shipmentId, { status: "done", result, storeId });
        return;
      } catch (error) {
        last = error;
        if (!supplyRetryable(error) || attempt === 2) throw error;
        logger.warn({ shipment: shipmentId, attempt, err: error instanceof Error ? error.message : error }, "MoySklad supply retry");
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
      }
    }
    throw last;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Kirim yozilmadi";
    logger.warn({
      shipment: shipmentId,
      detail,
      path: error instanceof MoySkladError ? error.path : undefined,
      moyCode: error instanceof MoySkladError ? error.moyCode : undefined,
      parameter: error instanceof MoySkladError ? error.parameter : undefined,
    }, "MoySklad supply failed");
    const code = detail === "store" || detail === "agent" || detail === "currency" || detail === "declined" ? detail : "rejected";
    setSupplyJob(shipmentId, { status: "error", error: code, detail, storeId });
  }
}

export function resumePendingSupplies() {
  loadSupplyJobs();
  for (const [id, job] of supplyJobs) {
    if (job.status !== "pending") continue;
    const shipment = listShipments().find((item) => item.id === id);
    if (!shipment || shipment.moyskladId) {
      if (shipment?.moyskladId) {
        setSupplyJob(id, { status: "done", result: { id: shipment.moyskladId, number: shipment.moyskladNumber || shipment.number, shipment, already: true } });
      } else {
        supplyJobs.delete(id);
        persistSupplyJobs();
      }
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

async function resolveFactoryAgent(
  account: { id: string; name: string; catalogName: string; code: string; login: string; counterpartyId: string | null; counterpartyName: string | null } | null,
  hint?: { id: string; name: string },
): Promise<SupplyAgent | null> {
  const hinted = hint?.id ? await loadCounterparty(hint.id) : null;
  const saved = account?.counterpartyId ? await loadCounterparty(account.counterpartyId) : null;
  const found = account ? await searchFactoryAgent(account) : null;
  const usable = (agent: SupplyAgent | null) => {
    if (!agent) return null;
    if (account && agentConflictsWithFactory(agent.name, account.code)) return null;
    return agent;
  };
  const chosen = usable(hinted) || usable(saved) || usable(found);
  if (!chosen) return null;
  if (account) rememberFactoryAgent(account, chosen);
  return chosen;
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

async function writeShipmentSupply(shipmentId: string, storeId: string, agentHint?: { id: string; name: string }): Promise<SupplyResult> {
  const unlock = await acquireSupplyLock(shipmentId);
  try {
    const shipment = listShipments().find((item) => item.id === shipmentId);
    if (!shipment) throw Object.assign(new Error("not_found"), { status: 404 });
    if (shipment.status === "declined") throw Object.assign(new Error("declined"), { status: 409 });
    if (shipment.moyskladId) {
      return { id: shipment.moyskladId, number: shipment.moyskladNumber || shipment.number, shipment, already: true };
    }
    const account = getAccount(shipment.factoryId);
    const agent = await resolveFactoryAgent(account, agentHint);
    const reused = await findExistingSupply(shipment);
    if (reused) {
      if (agent) await ensureSupplyAgent(reused.id, agent.meta);
      void fillZeroSupplyPrices(reused.id, shipment.lines).catch((error) => {
        if (!supplyGone(error)) {
          logger.warn({ supply: reused.id, err: error instanceof Error ? error.message : error }, "MoySklad supply price fill on reuse failed");
        }
      });
      const saved = markShipmentPosted(shipment.id, { id: reused.id, number: reused.name || shipment.number });
      void recordAudit({ action: "shipment.posted", entityType: "shipment", entityId: shipment.id, details: reused.name || shipment.number });
      return { id: reused.id, number: reused.name || shipment.number, shipment: saved, already: true };
    }
    const catalog = peekCatalog() ?? await loadCatalog();
    if (account) linkExactShipmentLines(account.id, (line) => exactCatalogProduct(catalog, line, account));
    const current = listShipments().find((item) => item.id === shipment.id) ?? shipment;
    let positions = current.lines.map((line) => ({ line, quantity: lineUnits(line) })).filter((item) => item.quantity > 0);
    if (!positions.length) throw Object.assign(new Error("Kirim qatorlari bo‘sh"), { status: 400 });
    const store = catalog.warehouses.find((item) => item.id === storeId) || (catalog.warehouses.length === 1 ? catalog.warehouses[0] : null);
    if (!store) throw Object.assign(new Error("store"), { status: 400 });
    const { organization, currencies } = await loadOrgCurrency();
    const currency = currencies.rows.find((row) => row.isoCode === "UZS");
    const company = organization.rows[0];
    const base = "https://api.moysklad.ru/api/remap/1.2";
    const meta = (href: string, type: string) => ({ href, type, mediaType: "application/json" });
    const agentMeta = agent?.meta ?? null;
    if (!agentMeta || !currency || !company) {
      throw Object.assign(new Error(agentMeta ? "currency" : "agent"), { status: 400 });
    }
    const planned = await buildSupplyPositions(positions.map((item) => ({
      ...item.line,
      factoryCode: account?.code || item.line.factoryCode,
    })), currency.meta, {
      factoryCode: account?.code || "",
      factoryName: account?.catalogName || account?.name || "",
      catalog,
      supplierMeta: agentMeta,
    });
    if (!planned.positions.length) throw Object.assign(new Error("Kirim qatorlari bo‘sh"), { status: 400 });
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
        packType: source && source.pachka > 1 ? "pachka" : null,
        packSize: source && source.pachka > 1 ? source.pachka : 1,
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
    const supplyPositions = planned.positions.map((item) => ({
      quantity: item.quantity,
      price: item.price,
      discount: 0,
      vat: 0,
      vatEnabled: false,
      assortment: item.assortment,
    }));
    const created = await postSupplyDocument(supplyCore, supplyPositions, shipment);
    await ensureSupplyAgent(created.id, agentMeta);
    const wanted = shipment.number.trim();
    const currentName = (created.name || "").trim();
    const aligned = currentName === wanted || currentName.startsWith(`${wanted} `)
      ? currentName
      : (await alignSupplyName(created.id, shipment) || currentName || wanted);
    const saved = markShipmentPosted(shipment.id, { id: created.id, number: aligned || wanted });
    void fillZeroSupplyPrices(created.id, shipment.lines).catch((error) => {
      logger.warn({ supply: created.id, err: error instanceof Error ? error.message : error }, "MoySklad supply price fill after create failed");
    });
    if (!created.reused) {
      applyReceiptStock(planned.positions.map((item) => ({ productId: item.stockId, warehouseId: store.id, quantity: item.quantity })));
    }
    void recordAudit({ action: "shipment.posted", entityType: "shipment", entityId: shipment.id, details: aligned || wanted });
    return { id: created.id, number: aligned || wanted, shipment: saved, already: created.reused };
  } finally {
    unlock();
  }
}

function supplyJobPayload(shipmentId: string) {
  const shipment = listShipments().find((item) => item.id === shipmentId);
  if (shipment?.moyskladId) {
    return { pending: false, already: true, id: shipment.moyskladId, number: shipment.moyskladNumber || shipment.number, shipment };
  }
  const job = supplyJobs.get(shipmentId);
  if (job?.status === "done" && job.result) return { pending: false, ...job.result };
  if (job?.status === "error") return { pending: false, error: job.error || "rejected", detail: job.detail || "Kirim yozilmadi" };
  if (job?.status === "pending") return { pending: true };
  return { pending: false, error: "idle" };
}

router.get("/partner-factories/shipments/:id/supply", (req, res) => {
  const payload = supplyJobPayload(String(req.params.id));
  if (payload.pending) {
    res.status(202).json(payload);
    return;
  }
  if ("error" in payload && payload.error === "idle") {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if ("error" in payload && payload.error) {
    res.status(payload.error === "store" || payload.error === "agent" || payload.error === "currency" ? 400 : 502).json(payload);
    return;
  }
  res.json(payload);
});

router.post("/partner-factories/shipments/:id/supply", (req, res) => {
  const shipmentId = String(req.params.id);
  const shipment = listShipments().find((item) => item.id === shipmentId);
  if (!shipment) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (shipment.status === "declined") {
    res.status(409).json({ error: "declined" });
    return;
  }
  if (shipment.moyskladId) {
    res.json({ pending: false, already: true, id: shipment.moyskladId, number: shipment.moyskladNumber || shipment.number, shipment });
    return;
  }
  const job = supplyJobs.get(shipmentId);
  if (job?.status === "pending") {
    res.status(202).json({ pending: true });
    return;
  }
  if (job?.status === "done" && job.result) {
    res.json({ pending: false, ...job.result });
    return;
  }
  const storeId = String(req.body?.storeId ?? "").trim();
  const counterpartyId = String(req.body?.counterpartyId ?? "").trim();
  const counterpartyName = String(req.body?.counterpartyName ?? "").trim();
  void runSupplyJob(shipmentId, storeId, counterpartyId ? { id: counterpartyId, name: counterpartyName } : undefined);
  res.status(202).json({ pending: true });
});

router.post("/partner-factories/shipments/:id/accept", (req, res) => {
  try {
    const accepted = setShipmentStatus(String(req.params.id), "accepted");
    void recordAudit({ action: "shipment.accepted", entityType: "shipment", entityId: String(req.params.id) });
    res.json(accepted);
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
    const catalog = peekCatalog() ?? await loadCatalog();
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
    const catalog = peekCatalog();
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
    const catalog = peekCatalog();
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

export default router;
