import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { addCatalogProduct, applyReceiptStock, findProductsByLabel, loadCatalog, matchWaybillProduct, productBelongsToFactory } from "../lib/catalog";
import { buildSupplyPositions, receiptParts } from "../lib/supply-assortment";
import { moysklad, moyskladSend, MoySkladError, permissionDenied } from "../lib/moysklad";
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
  res.json({ pending });
});

router.get("/partner-factories", async (_req, res, next) => {
  try {
    const catalog = await loadCatalog();
    const grouped = new Map<string, { name: string; productCount: number; stock: number }>();
    for (const product of catalog.products) {
      const name = product.factory?.trim();
      if (!name) continue;
      const current = grouped.get(name) || { name, productCount: 0, stock: 0 };
      current.productCount += 1;
      current.stock += product.stock;
      grouped.set(name, current);
    }
    const accounts = listAccounts();
    const shipments = listShipments();
    const rows = [...grouped.values()]
      .map((row) => {
        const account = accounts.find((item) => item.catalogName === row.name || item.name === row.name) ?? null;
        const own = account ? shipments.filter((item) => item.factoryId === account.id) : [];
        return {
          ...row,
          account,
          shipmentCount: own.length,
          pendingCount: own.filter((item) => item.status === "sent").length,
          lastShipment: own[0]?.createdAt ?? null,
        };
      })
      .sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name));
    const extras = accounts
      .filter((account) => !rows.some((row) => row.account?.id === account.id))
      .map((account) => {
        const own = shipments.filter((item) => item.factoryId === account.id);
        return {
          name: account.name,
          productCount: 0,
          stock: 0,
          account,
          shipmentCount: own.length,
          pendingCount: own.filter((item) => item.status === "sent").length,
          lastShipment: own[0]?.createdAt ?? null,
        };
      });
    res.json({ items: [...rows, ...extras] });
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

function exactCatalogProduct(_catalog: Awaited<ReturnType<typeof loadCatalog>>, _code: string) {
  return null;
}

router.get("/partner-factories/:id", async (req, res, next) => {
  try {
    const account = getAccount(String(req.params.id));
    if (!account) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const catalog = await loadCatalog();
    linkExactShipmentLines(account.id, (code) => exactCatalogProduct(catalog, code));
    const { passwordHash: _hash, salt: _salt, passwordPlain, ...safe } = account;
    res.json({ account: { ...safe, password: passwordPlain || null }, shipments: listShipments(account.id) });
  } catch (error) {
    next(error);
  }
});

function lineUnits(line: { pairs: number; boxes: number; quantity: number; colors: Array<{ name?: string; quantity: number }> }) {
  const pack = line.pairs > 0 ? line.pairs : 0;
  const colors = (line.colors ?? []).filter((color) => color.name?.trim() && color.quantity > 0);
  if (pack > 0 && colors.length) return colors.reduce((sum, color) => sum + color.quantity * pack, 0);
  if (pack > 0 && line.boxes > 0) return pack * line.boxes;
  if (line.quantity > 0) return line.quantity;
  return pack;
}

function kopecks(som: number) {
  return Math.round(som * 100);
}

function supplyGone(error: unknown) {
  if (!(error instanceof MoySkladError)) return false;
  return error.status === 404 || /корзин|recycle|trash|удален/i.test(error.message);
}

function priceFromWaybill(name: string, lines: Array<{ factoryCode: string; sectionCode: string; productCode: string; size: string; price: number; colors: Array<{ name?: string }> }>) {
  const raw = name.trim();
  const color = raw.match(/\(([^)]+)\)\s*$/)?.[1]?.trim().toLowerCase() || "";
  const base = raw.replace(/\s*\([^)]+\)\s*$/, "").trim().toLowerCase();
  let best: { score: number; price: number } | null = null;
  for (const line of lines) {
    if (!(line.price > 0)) continue;
    const identity = ["bordo", line.factoryCode, line.sectionCode, line.productCode, line.size].filter(Boolean).join(" ").trim().toLowerCase();
    let score = 0;
    if (base === identity) score = 4;
    else if (color && base === `${identity} ${color}`) score = 4;
    else if (identity && base.startsWith(identity)) score = 3;
    else if (line.productCode && line.size && base.includes(line.productCode.toLowerCase()) && base.includes(line.size.toLowerCase())) score = 2;
    if (color && (line.colors ?? []).some((item) => item.name?.trim().toLowerCase() === color)) score += 1;
    if (score > (best?.score ?? 0)) best = { score, price: kopecks(line.price) };
  }
  return best?.price ?? 0;
}

async function fillZeroSupplyPrices(supplyId: string, lines: Array<{ factoryCode: string; sectionCode: string; productCode: string; size: string; price: number; colors: Array<{ name?: string }> }>) {
  const doc = await moysklad<{ applicable?: boolean; sum?: number; deleted?: string }>(`/entity/supply/${encodeURIComponent(supplyId)}`);
  if (doc.deleted) throw new MoySkladError("Операция находится в корзине. Обновление операции запрещено.", 400);
  const page = await moysklad<{ rows: Array<{ id: string; price?: number; assortment?: { name?: string; meta?: { href?: string; type?: string } } }> }>(
    `/entity/supply/${encodeURIComponent(supplyId)}/positions?expand=assortment&limit=100`,
  );
  const expected = lines.flatMap((line) => receiptParts(line).map((part) => (part.quantity > 0 ? kopecks(line.price) : 0))).filter((price) => price > 0);
  const zero = page.rows.map((row, index) => ({ row, index })).filter((item) => !(item.row.price > 0));
  if (!zero.length) return (doc.sum ?? 0) > 0;
  if (doc.applicable) {
    await moyskladSend(`/entity/supply/${encodeURIComponent(supplyId)}`, { applicable: false }, "PUT");
  }
  let wrote = 0;
  for (const item of zero) {
    const row = item.row;
    const price = priceFromWaybill(row.assortment?.name || "", lines) || expected[item.index] || 0;
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

async function postSupplyDocument(
  core: Record<string, unknown>,
  packed: Array<Record<string, unknown>>,
  unpacked: Array<Record<string, unknown>>,
) {
  const attempts: Array<{ applicable: boolean; positions: Array<Record<string, unknown>>; label: string }> = [
    { applicable: true, positions: packed, label: "packed" },
    { applicable: true, positions: unpacked, label: "unpacked" },
    { applicable: false, positions: unpacked, label: "draft" },
  ];
  let last: unknown;
  for (const attempt of attempts) {
    try {
      return await moyskladSend<{ id: string; name?: string }>("/entity/supply", {
        ...core,
        applicable: attempt.applicable,
        positions: attempt.positions,
      });
    } catch (error) {
      last = error;
      const retry = permissionDenied(error)
        || (error instanceof MoySkladError && /pack|uom|barcode|applicable|уникал|unique|уже существ|корзин/i.test(`${error.parameter || ""} ${error.message}`));
      if (retry && /уникал|unique|уже существ|корзин/i.test(error instanceof Error ? error.message : "")) {
        delete core.name;
      }
      logger.warn({ label: attempt.label, err: error instanceof Error ? error.message : error }, "MoySklad supply create retry");
      if (!retry) throw error;
    }
  }
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
      const matched = account ? matchWaybillProduct(catalog, { factoryCode: line.factoryCode || account.code, factoryName: account.catalogName || account.name, groupCode: line.sectionCode, productCode: line.productCode, size: line.size }) : null;
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

router.post("/partner-factories/shipments/:id/supply", async (req, res, next) => {
  try {
    const shipment = listShipments().find((item) => item.id === String(req.params.id));
    if (!shipment) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (shipment.moyskladId) {
      try {
        const filled = await fillZeroSupplyPrices(shipment.moyskladId, shipment.lines);
        if (filled) {
          res.json({ id: shipment.moyskladId, number: shipment.moyskladNumber || shipment.number, shipment, already: true });
          return;
        }
      } catch (error) {
        if (!supplyGone(error)) throw error;
        logger.warn({ supply: shipment.moyskladId, err: error instanceof Error ? error.message : error }, "Posted MoySklad supply is gone, creating a new one");
      }
      await replaceZeroSupply(shipment.moyskladId);
      clearShipmentPosted(shipment.id);
    }
    const account = getAccount(shipment.factoryId);
    let positions = shipment.lines.map((line) => ({ line, quantity: lineUnits(line) })).filter((item) => item.quantity > 0);
    if (!positions.length) {
      res.status(400).json({ error: "rejected", detail: "Kirim qatorlari bo‘sh" });
      return;
    }
    const catalog = await loadCatalog();
    const storeId = String(req.body?.storeId ?? "").trim();
    const store = catalog.warehouses.find((item) => item.id === storeId) || (catalog.warehouses.length === 1 ? catalog.warehouses[0] : null);
    if (!store) {
      res.status(400).json({ error: "store" });
      return;
    }
    const queries = [...new Set([
      account?.counterpartyName,
      account?.catalogName,
      account?.name,
      account?.code,
    ].map((value) => value?.trim()).filter((value): value is string => Boolean(value && value.length >= 2)))];
    const [organization, currencies, ...agentPages] = await Promise.all([
      moysklad<{ rows: Array<{ meta: { href: string; type: string; mediaType: string } }> }>("/entity/organization?limit=1"),
      moysklad<{ rows: Array<{ isoCode?: string; meta: { href: string; type: string; mediaType: string } }> }>("/entity/currency?limit=100"),
      ...queries.map((query) => moysklad<{ rows: Array<{ id?: string; name?: string; meta: { href: string; type: string; mediaType: string } }> }>(`/entity/counterparty?limit=25&search=${encodeURIComponent(query)}`).catch(() => ({ rows: [] }))),
    ]);
    const currency = currencies.rows.find((row) => row.isoCode === "UZS");
    const company = organization.rows[0];
    const base = "https://api.moysklad.ru/api/remap/1.2";
    const meta = (href: string, type: string) => ({ href, type, mediaType: "application/json" });
    let agentMeta: { href: string; type: string; mediaType: string } | null = null;
    if (account?.counterpartyId) {
      try {
        const saved = await moysklad<{ meta: { href: string; type: string; mediaType: string }; name?: string }>(`/entity/counterparty/${encodeURIComponent(account.counterpartyId)}`);
        agentMeta = saved.meta;
      } catch {
        agentMeta = null;
      }
    }
    if (!agentMeta) {
      const rows = agentPages.flatMap((page) => page.rows).filter((row) => row.id && row.name && row.meta);
      const lowered = queries.map((query) => query.toLowerCase());
      const exact = rows.filter((row) => lowered.includes((row.name || "").trim().toLowerCase()));
      const unique = new Map(exact.map((row) => [row.id!, row]));
      if (unique.size === 1) agentMeta = [...unique.values()][0].meta;
      else if (rows.length === 1) agentMeta = rows[0].meta;
    }
    if (!agentMeta || !currency || !company) {
      res.status(400).json({ error: agentMeta ? "currency" : "agent" });
      return;
    }
    const planned = await buildSupplyPositions(positions.map((item) => item.line), currency.meta, {
      factoryCode: account?.code || "",
      factoryName: account?.catalogName || account?.name || "",
      catalog,
      supplierMeta: agentMeta,
    });
    if (!planned.positions.length) {
      res.status(400).json({ error: "rejected", detail: "Kirim qatorlari bo‘sh" });
      return;
    }
    for (const link of planned.links) linkShipmentLine(shipment.id, link.lineId, link.product);
    for (const product of planned.created) {
      addCatalogProduct({
        id: product.id,
        name: product.name || "",
        code: product.code || null,
        article: product.article || null,
        barcodes: product.barcodes ?? [],
        factory: account?.name || null,
        category: product.folderName || null,
        unit: "шт",
        packType: null,
        packSize: 1,
        imageUrl: null,
        stock: 0,
        available: 0,
        cost: null,
        salePrice: null,
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
    const supplyCore = {
      name: shipment.number,
      moment: `${shipment.date} 12:00:00`,
      organization: { meta: company.meta },
      agent: { meta: agentMeta },
      store: { meta: meta(`${base}/entity/store/${store.id}`, "store") },
      rate: { currency: { meta: currency.meta } },
    };
    const packed = planned.positions.map((item) => ({
      quantity: item.quantity,
      price: item.price,
      discount: 0,
      vat: 0,
      vatEnabled: false,
      assortment: item.assortment,
      ...(item.pack ? { pack: item.pack } : {}),
    }));
    const unpacked = planned.positions.map((item) => ({
      quantity: item.quantity,
      price: item.price,
      discount: 0,
      vat: 0,
      vatEnabled: false,
      assortment: item.assortment,
    }));
    const created = await postSupplyDocument(supplyCore, packed, unpacked);
    try {
      await fillZeroSupplyPrices(created.id, shipment.lines);
    } catch (error) {
      logger.warn({ supply: created.id, err: error instanceof Error ? error.message : error }, "MoySklad supply price fill after create failed");
    }
    applyReceiptStock(planned.positions.map((item) => ({ productId: item.stockId, warehouseId: store.id, quantity: item.quantity })));
    const saved = markShipmentPosted(shipment.id, { id: created.id, number: created.name || shipment.number });
    void recordAudit({ action: "shipment.posted", entityType: "shipment", entityId: shipment.id, details: created.name || shipment.number });
    res.status(201).json({ id: created.id, number: created.name || shipment.number, shipment: saved });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Kirim yozilmadi";
    logger.warn({
      shipment: String(req.params.id),
      detail,
      path: error instanceof MoySkladError ? error.path : undefined,
      moyCode: error instanceof MoySkladError ? error.moyCode : undefined,
      parameter: error instanceof MoySkladError ? error.parameter : undefined,
    }, "MoySklad supply failed");
    if (error instanceof MoySkladError) {
      res.status(error.status >= 400 && error.status < 500 ? 400 : 502).json({ error: "rejected", detail });
      return;
    }
    res.status(502).json({ error: "rejected", detail });
  }
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
    const query = String(req.query.q ?? "").trim().toLowerCase();
    if (query.length < 2) {
      res.json({ items: [] });
      return;
    }
    const catalog = await loadCatalog();
    const account = res.locals.factory as { code?: string; name?: string; catalogName?: string };
    const compact = query.replace(/[\s-]/g, "");
    const scored: Array<{ score: number; id: string; name: string; code: string | null; article: string | null; barcode: string | null }> = [];
    for (const product of catalog.products) {
      if (!productBelongsToFactory(product, account.code || "", account.catalogName || account.name || "")) continue;
      const code = (product.code || "").toLowerCase();
      const article = (product.article || "").toLowerCase();
      const name = product.name.toLowerCase();
      let score = 0;
      const token = new RegExp(`(^|\\D)${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\D|$)`);
      if (code === query || article === query) score = 4;
      else if (token.test(name)) score = 3;
      else if (code === compact || article === compact) score = 2;
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
    const catalog = await loadCatalog();
    const byId = new Map(catalog.products.map((product) => [product.id, product]));
    const lines = (Array.isArray(req.body?.lines) ? req.body.lines : []).map((line: { productId?: string; productCode?: string }) => {
      const product = byId.get(String(line?.productId ?? "").trim());
      const typed = String(line?.productCode ?? "").trim().toLowerCase();
      const matches = product && [product.code, product.article, product.name, ...product.barcodes].some((value) => String(value || "").trim().toLowerCase() === typed);
      return matches && product ? { ...line, productId: product.id, productName: product.name } : { ...line, productId: null, productName: null };
    });
    const saved = reviseShipment(res.locals.factory.id, String(req.params.id), {
      date: req.body?.date,
      note: req.body?.note,
      lines,
    });
    linkExactShipmentLines(res.locals.factory.id, (code) => exactCatalogProduct(catalog, code));
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
    const catalog = await loadCatalog();
    const byId = new Map(catalog.products.map((product) => [product.id, product]));
    const lines = (Array.isArray(req.body?.lines) ? req.body.lines : []).map((line: { productId?: string; productCode?: string }) => {
      const product = byId.get(String(line?.productId ?? "").trim());
      const typed = String(line?.productCode ?? "").trim().toLowerCase();
      const matches = product && [product.code, product.article, product.name, ...product.barcodes].some((value) => String(value || "").trim().toLowerCase() === typed);
      return matches && product ? { ...line, productId: product.id, productName: product.name } : { ...line, productId: null, productName: null };
    });
    const created = createShipment(res.locals.factory.id, {
      date: req.body?.date,
      note: req.body?.note,
      lines,
    });
    linkExactShipmentLines(res.locals.factory.id, (code) => exactCatalogProduct(catalog, code));
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
