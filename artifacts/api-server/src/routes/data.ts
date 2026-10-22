import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataFile } from "../lib/data-dir";
import { Router, type IRouter, type Request } from "express";
import {
  getNonMovingProductsQueryDaysDefault,
  GetCurrentUserResponse,
  GetDashboardResponse,
  GetMoyskladStatusResponse,
  GetNonMovingProductsQueryParams,
  GetNonMovingProductsResponse,
  GetPurchaseRecommendationsQueryParams,
  GetPurchaseRecommendationsResponse,
  GetSalesAnalyticsQueryParams,
  GetSalesAnalyticsResponse,
  ListDocumentsQueryParams,
  ListDocumentsResponse,
  ListProductsQueryParams,
  ListProductsResponse,
  ListStockQueryParams,
  ListStockResponse,
  ListUsersResponse,
  ListWarehousesResponse,
  LookupBarcodeParams,
  LookupBarcodeResponse,
  SyncMoyskladResponse,
} from "@workspace/api-zod";
import { addCatalogProduct, catalogLoadedAt, catalogSyncing, catalogSyncState, ensureSuppliers, findProductsByBarcode, idleDays, loadCatalog, matchProductFolder, peekCatalog, resetCatalog, resolveScan, scanIndex, updateCatalogProduct, type CatalogProduct } from "../lib/catalog";
import { ensurePachka, nextInternalEan13, writeProductCard } from "../lib/supply-assortment";
import { addScanHit, clearScanSession, readScanSession, removeScanHit, subscribeScanSession } from "../lib/scan-session";
import { orderRecommendations } from "../lib/recommendations";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { listAccounts } from "../lib/partners";
import { moysklad, moyskladAll, moyskladBinary, moyskladConfigured, moyskladSend, money, MoySkladError } from "../lib/moysklad";

const SALE_MARKUP: Record<string, number> = { Premium: 5, Exclusive: 8, Standard: 10 };

function markedSale(cost: number, priceType: string) {
  const pct = SALE_MARKUP[priceType];
  if (pct == null || !(cost > 0)) return null;
  return Math.round(cost * (100 + pct) / 100);
}

function sameFactoryCode(left: string, right: string) {
  const a = left.trim().toUpperCase();
  const b = right.trim().toUpperCase();
  return Boolean(a && b && a === b);
}

function labelTokens(label: string) {
  return label.toUpperCase().split(/[^0-9A-Z]+/).filter(Boolean);
}

function codeInLabel(label: string, code: string) {
  const wanted = code.trim().toUpperCase();
  if (!wanted) return false;
  if (sameFactoryCode(label, wanted)) return true;
  return labelTokens(label).includes(wanted);
}

function pickByFactoryCode<T>(rows: T[], labelOf: (row: T) => string, code: string) {
  const hits = rows.filter((row) => codeInLabel(labelOf(row), code));
  if (hits.length <= 1) return hits[0] ?? null;
  const wanted = code.trim().toUpperCase();
  const exact = hits.filter((row) => labelTokens(labelOf(row)).includes(wanted));
  if (exact.length === 1) return exact[0];
  const ending = hits.filter((row) => labelOf(row).trim().toUpperCase().endsWith(wanted));
  return ending.length === 1 ? ending[0] : exact[0] ?? hits[0];
}

async function findCounterparty(query: string, code: string, factoryName: string) {
  const page = await moysklad<{ rows: Array<{ id?: string; name?: string }> }>(`/entity/counterparty?limit=15&search=${encodeURIComponent(query)}`);
  const name = factoryName.trim().toUpperCase();
  const hit = page.rows.find((row) => {
    const label = (row.name || "").trim().toUpperCase();
    return Boolean(row.id && (label === name || codeInLabel(label, code)));
  }) || (page.rows.length === 1 && page.rows[0].id ? page.rows[0] : null);
  return hit?.id && hit.name ? { id: hit.id, name: hit.name } : null;
}

async function resolvePartnerFactory(code: string) {
  const wanted = code.trim();
  if (wanted.length < 2) return null;
  const accounts = listAccounts();
  const account = accounts.find((item) => sameFactoryCode(item.code, wanted))
    || pickByFactoryCode(accounts, (item) => `${item.code} ${item.name} ${item.catalogName}`, wanted);
  const catalog = peekCatalog() ?? await loadCatalog();
  const factoryNames = [...new Set((catalog?.products ?? []).map((product) => product.factory?.trim()).filter((name): name is string => Boolean(name)))];
  const catalogName = account ? null : pickByFactoryCode(factoryNames, (name) => name, wanted);
  if (!account && !catalogName) return null;
  const name = account?.name || catalogName || wanted;
  let supplierId = account?.counterpartyId || "";
  let supplierName = account?.counterpartyName || name;
  if (!supplierId) {
    const queries = [...new Set([supplierName, name, account?.code, wanted].filter((item): item is string => Boolean(item && item.trim())))];
    for (const query of queries) {
      try {
        const hit = await findCounterparty(query, wanted, name);
        if (hit) {
          supplierId = hit.id;
          supplierName = hit.name;
          break;
        }
      } catch {
        /* try next query */
      }
    }
  }
  return { code: (account?.code || wanted).toUpperCase(), name, supplierId, supplierName };
}

const router: IRouter = Router();
const SYNC_COOLDOWN_MS = 5 * 60 * 1000;

function numericQuery(query: Request["query"], keys: string[]) {
  const next: Record<string, unknown> = { ...query };
  for (const key of keys) {
    const value = next[key];
    if (typeof value === "string" && value !== "") next[key] = Number(value);
  }
  return next;
}

function fail(error: unknown): { status: number; message: string } {
  if (error instanceof MoySkladError) return { status: error.status || 502, message: error.message };
  if (error instanceof Error) return { status: 500, message: error.message };
  return { status: 500, message: "Unexpected error" };
}

router.get("/users", (_req, res) => {
  res.json(
    ListUsersResponse.parse([
      { id: "local", name: "Administrator", email: "local@smart-ombor", role: "super_admin" },
    ]),
  );
});

router.get("/me", (_req, res) => {
  res.json(
    GetCurrentUserResponse.parse({
      id: "local",
      name: "Administrator",
      email: "local@smart-ombor",
      role: "super_admin",
    }),
  );
});

router.get("/moysklad/status", async (_req, res) => {
  if (!moyskladConfigured()) {
    res.json(
      GetMoyskladStatusResponse.parse({
        configured: false,
        connected: false,
        companyName: null,
        lastSync: catalogLoadedAt(),
        error: "MOYSKLAD_TOKEN topilmadi",
      }),
    );
    return;
  }

  const cached = peekCatalog();
  if (catalogSyncing() && cached) {
    res.json(
      GetMoyskladStatusResponse.parse({
        configured: true,
        connected: true,
        companyName: cached.companyName,
        lastSync: cached.loadedAt,
        error: cached.error,
      }),
    );
    return;
  }

  try {
    const [organization, catalog] = await Promise.all([
      moysklad<{ rows?: Array<{ name?: string }> }>("/entity/organization?limit=1"),
      loadCatalog(),
    ]);
    res.json(
      GetMoyskladStatusResponse.parse({
        configured: true,
        connected: true,
        companyName: organization.rows?.[0]?.name ?? catalog.companyName,
        lastSync: catalog.loadedAt,
        error: catalog.error,
      }),
    );
  } catch (error) {
    const problem = fail(error);
    const catalog = peekCatalog();
    res.json(
      GetMoyskladStatusResponse.parse({
        configured: true,
        connected: false,
        companyName: catalog?.companyName ?? null,
        lastSync: catalog?.loadedAt ?? catalogLoadedAt(),
        error: problem.status === 403 ? "MoySklad API ruxsati yo‘q" : problem.message,
      }),
    );
  }
});

router.get("/moysklad/sync", (_req, res) => {
  res.json(catalogSyncState());
});

router.post("/moysklad/sync", async (_req, res) => {
  const startedAt = new Date().toISOString();
  try {
    const current = peekCatalog() ?? await loadCatalog(false);
    const age = Date.now() - Date.parse(current.loadedAt);
    const fresh = !catalogSyncing() && age >= 0 && age < SYNC_COOLDOWN_MS;
    if (fresh) {
      res.json(
        SyncMoyskladResponse.parse({
          id: crypto.randomUUID(),
          status: "completed",
          startedAt,
          finishedAt: current.loadedAt,
          productCount: current.productCount,
          warehouseCount: current.warehouses.length,
          error: "already-fresh",
        }),
      );
      return;
    }
    const before = current.loadedAt;
    const job = loadCatalog(true);
    const raced = await Promise.race([
      job.then((catalog) => ({ done: true as const, catalog })),
      new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 2500)),
    ]);
    if (!raced.done) {
      void job
        .then((catalog) => {
          if (catalog.loadedAt !== before) void recordAudit({ action: "catalog.sync", entityType: "catalog", details: `${catalog.productCount}` });
        })
        .catch((error: unknown) => {
          logger.warn({ err: error instanceof Error ? error.message : error }, "Background catalog sync failed");
        });
      res.json(
        SyncMoyskladResponse.parse({
          id: crypto.randomUUID(),
          status: "running",
          startedAt,
          finishedAt: current.loadedAt,
          productCount: current.productCount,
          warehouseCount: current.warehouses.length,
          error: null,
        }),
      );
      return;
    }
    const catalog = raced.catalog;
    const kept = catalog.loadedAt === before;
    if (!kept) void recordAudit({ action: "catalog.sync", entityType: "catalog", details: `${catalog.productCount}` });
    res.json(
      SyncMoyskladResponse.parse({
        id: crypto.randomUUID(),
        status: "completed",
        startedAt,
        finishedAt: catalog.loadedAt,
        productCount: catalog.productCount,
        warehouseCount: catalog.warehouses.length,
        error: kept ? "kept-cache" : null,
      }),
    );
  } catch (error) {
    const problem = fail(error);
    const cached = peekCatalog();
    if (cached) {
      res.json(
        SyncMoyskladResponse.parse({
          id: crypto.randomUUID(),
          status: "completed",
          startedAt,
          finishedAt: cached.loadedAt,
          productCount: cached.productCount,
          warehouseCount: cached.warehouses.length,
          error: "kept-cache",
        }),
      );
      return;
    }
    res.status(problem.status).json(
      SyncMoyskladResponse.parse({
        id: crypto.randomUUID(),
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        productCount: 0,
        warehouseCount: 0,
        error: problem.message,
      }),
    );
  }
});

router.get("/dashboard", async (_req, res, next) => {
  try {
    const catalog = await loadCatalog();
    const products = catalog.products;
    res.json(
      GetDashboardResponse.parse({
        productCount: catalog.productCount,
        stockUnits: products.reduce((sum, product) => sum + product.stock, 0),
        stockValue: products.reduce((sum, product) => sum + (product.cost ?? 0) * product.stock, 0),
        lowStockCount: products.filter((product) => product.stockStatus === "low").length,
        nonMovingCount: products.filter((product) => {
          const days = idleDays(product, catalog.salesCoverage ?? { days7: false, days30: false, days90: false });
          return days != null && days >= getNonMovingProductsQueryDaysDefault;
        }).length,
        expiringCount: 0,
        pendingTransfers: catalog.pendingTransfers,
        salesToday: catalog.salesToday,
        incomingToday: catalog.incomingToday,
        lastSync: catalog.loadedAt,
      }),
    );
  } catch (error) {
    next(error);
  }
});

function shiftDay(iso: string, delta: number) {
  const [year, month, day] = iso.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day));
  next.setUTCDate(next.getUTCDate() + delta);
  return next.toISOString().slice(0, 10);
}

function tashkentToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

type DayDocument = {
  id: string;
  kind: "receipt" | "transfer" | "sale";
  number: string;
  date: string;
  status: "posted" | "draft";
  sourceWarehouse: string | null;
  targetWarehouse: string | null;
};

type DaySnapshot = {
  date: string;
  sales: number;
  incoming: number;
  trend: Array<{ date: string; amount: number }>;
  documents: DayDocument[];
};

const dayCache = new Map<string, { savedAt: number; body: DaySnapshot }>();
const dayInflight = new Map<string, Promise<DaySnapshot>>();
const DAY_CACHE_FILE = dataFile("day-view.json");
let dayDiskRead = false;

function readDayDisk() {
  if (dayDiskRead) return;
  dayDiskRead = true;
  try {
    const parsed = JSON.parse(readFileSync(DAY_CACHE_FILE, "utf8")) as Record<string, { savedAt: number; body: DaySnapshot }>;
    for (const [key, entry] of Object.entries(parsed)) {
      if (entry?.body?.date === key && typeof entry.savedAt === "number") dayCache.set(key, entry);
    }
  } catch {
    // The first visit builds the snapshot.
  }
}

function writeDayDisk() {
  try {
    mkdirSync(path.dirname(DAY_CACHE_FILE), { recursive: true });
    const tmp = `${DAY_CACHE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(dayCache)));
    renameSync(tmp, DAY_CACHE_FILE);
  } catch {
    // A missed snapshot only makes the next cold start slower.
  }
}

async function salesByDay(from: string, to: string): Promise<Map<string, { amount: number; quantity: number }>> {
  const buckets = new Map<string, { amount: number; quantity: number }>();
  let cursor = from;
  while (cursor <= to) {
    buckets.set(cursor, { amount: 0, quantity: 0 });
    cursor = shiftDay(cursor, 1);
  }
  try {
    const plot = await moysklad<{ series?: Array<{ date?: string; sum?: number }> }>(
      `/report/sales/plotseries?interval=day&momentFrom=${encodeURIComponent(`${from} 00:00:00`)}&momentTo=${encodeURIComponent(`${to} 23:59:59`)}`,
    );
    if (!Array.isArray(plot.series) || plot.series.length === 0) throw new Error("plot");
    let matched = 0;
    for (const point of plot.series) {
      const key = String(point.date ?? "").slice(0, 10);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      matched += 1;
      bucket.amount = money(point.sum) ?? 0;
    }
    if (matched === 0) throw new Error("plot");
    return buckets;
  } catch {
    const filter = encodeURIComponent(`moment>=${from} 00:00:00;moment<=${to} 23:59:59`);
    const demands = await moyskladAll<{ moment?: string; sum?: number; positions?: { meta?: { size?: number } } }>(
      `/entity/demand?filter=${filter}`,
    );
    for (const row of demands.rows) {
      const bucket = buckets.get((row.moment ?? "").slice(0, 10));
      if (!bucket) continue;
      bucket.amount += money(row.sum) ?? 0;
      bucket.quantity += row.positions?.meta?.size ?? 0;
    }
    return buckets;
  }
}

async function salesByDayFromDemands(from: string, to: string, store: string): Promise<Map<string, { amount: number; quantity: number }>> {
  const buckets = new Map<string, { amount: number; quantity: number }>();
  let cursor = from;
  while (cursor <= to) {
    buckets.set(cursor, { amount: 0, quantity: 0 });
    cursor = shiftDay(cursor, 1);
  }
  const filter = encodeURIComponent(`moment>=${from} 00:00:00;moment<=${to} 23:59:59${store}`);
  const demands = await moyskladAll<{ moment?: string; sum?: number; positions?: { meta?: { size?: number } } }>(
    `/entity/demand?order=moment,desc&filter=${filter}`,
  );
  for (const row of demands.rows) {
    const bucket = buckets.get((row.moment ?? "").slice(0, 10));
    if (!bucket) continue;
    bucket.amount += money(row.sum) ?? 0;
    bucket.quantity += row.positions?.meta?.size ?? 0;
  }
  return buckets;
}

function emptyDay(date: string): DaySnapshot {
  const trend: Array<{ date: string; amount: number }> = [];
  let cursor = shiftDay(date, -6);
  while (cursor <= date) {
    trend.push({ date: cursor, amount: 0 });
    cursor = shiftDay(cursor, 1);
  }
  return { date, sales: 0, incoming: 0, trend, documents: [] };
}

function loadDay(date: string): Promise<DaySnapshot> {
  const running = dayInflight.get(date);
  if (running) return running;
  const job = buildDay(date)
    .then((body) => {
      dayCache.set(date, { savedAt: Date.now(), body });
      writeDayDisk();
      return body;
    })
    .catch(() => {
      const cached = dayCache.get(date);
      if (cached) return cached.body;
      const body = emptyDay(date);
      dayCache.set(date, { savedAt: 0, body });
      return body;
    })
    .finally(() => {
      dayInflight.delete(date);
    });
  dayInflight.set(date, job);
  return job;
}

async function buildDay(date: string): Promise<DaySnapshot> {
    const from = shiftDay(date, -6);
    const dayFilter = encodeURIComponent(`moment>=${date} 00:00:00;moment<=${date} 23:59:59`);
    type Row = { id?: string; name?: string; moment?: string; sum?: number; applicable?: boolean; agent?: { name?: string }; store?: { name?: string }; sourceStore?: { name?: string }; targetStore?: { name?: string } };
    const [amounts, supplies, dayDemands, daySupplies, dayMoves] = await Promise.all([
      salesByDay(from, date),
      moysklad<{ meta: { size: number } }>(`/entity/supply?limit=1&filter=${dayFilter}`),
      moysklad<{ rows: Row[] }>(`/entity/demand?limit=8&order=moment,desc&filter=${dayFilter}&expand=agent,store`),
      moysklad<{ rows: Row[] }>(`/entity/supply?limit=8&order=moment,desc&filter=${dayFilter}&expand=agent,store`),
      moysklad<{ rows: Row[] }>(`/entity/move?limit=8&order=moment,desc&filter=${dayFilter}&expand=sourceStore,targetStore`).catch(() => ({ rows: [] as Row[] })),
    ]);
    const asDoc = (row: Row, kind: DayDocument["kind"], source: string | null, target: string | null): DayDocument => ({
      id: row.id || `${kind}-${row.name}-${row.moment}`,
      kind,
      number: row.name || "—",
      date: row.moment ? row.moment.replace(" ", "T") : `${date}T00:00:00`,
      status: row.applicable === false ? "draft" : "posted",
      sourceWarehouse: source,
      targetWarehouse: target,
    });
    const documents = [
      ...daySupplies.rows.map((row) => asDoc(row, "receipt", row.agent?.name || null, row.store?.name || null)),
      ...dayDemands.rows.map((row) => asDoc(row, "sale", row.agent?.name || null, row.store?.name || null)),
      ...(dayMoves?.rows ?? []).map((row) => asDoc(row, "transfer", row.sourceStore?.name || null, row.targetStore?.name || null)),
    ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
    return {
      date,
      sales: amounts.get(date)?.amount ?? 0,
      incoming: supplies.meta.size,
      trend: [...amounts.entries()].map(([key, value]) => ({ date: key, amount: value.amount })),
      documents,
    };
}

router.get("/dashboard/day", async (req, res, next) => {
  try {
    const date = String(req.query.date ?? "");
    const today = tashkentToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) {
      res.status(400).json({ error: "date" });
      return;
    }
    readDayDisk();
    const cached = dayCache.get(date);
    const freshFor = date === today ? 2 * 60_000 : 6 * 60 * 60_000;
    if (cached && (catalogSyncing() || Date.now() - cached.savedAt < freshFor)) {
      res.json(cached.body);
      return;
    }
    if (cached) {
      res.json(cached.body);
      if (!catalogSyncing()) void loadDay(date).catch(() => undefined);
      return;
    }
    res.json(await loadDay(date));
  } catch (error) {
    next(error);
  }
});

router.get("/dashboard/warehouses", async (_req, res, next) => {
  try {
    const catalog = await loadCatalog();
    const totals = new Map<string, { id: string; name: string; units: number; products: number; inTransit: number; value: number }>();
    for (const warehouse of catalog.warehouses) {
      totals.set(warehouse.id, { id: warehouse.id, name: warehouse.name, units: 0, products: 0, inTransit: 0, value: 0 });
    }
    for (const row of catalog.stockRows) {
      const entry = totals.get(row.warehouse.id) ?? { id: row.warehouse.id, name: row.warehouse.name, units: 0, products: 0, inTransit: 0, value: 0 };
      entry.units += row.quantity;
      entry.inTransit += row.inTransit;
      entry.value += row.value ?? 0;
      if (row.quantity > 0) entry.products += 1;
      totals.set(entry.id, entry);
    }
    res.json([...totals.values()].sort((a, b) => b.units - a.units));
  } catch (error) {
    next(error);
  }
});

router.get("/warehouses", async (_req, res, next) => {
  try {
    const catalog = await loadCatalog();
    res.json(ListWarehousesResponse.parse(catalog.warehouses));
  } catch (error) {
    next(error);
  }
});

function matchesSearch(product: CatalogProduct, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [product.name, product.code, product.article, product.category, product.factory, ...product.barcodes]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

function ean13(code: string) {
  if (!/^\d{13}$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop() ?? -1;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) sum += digits[digits.length - 1 - i] * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === check;
}

function som(value: unknown): number | null {
  if (value == null || value === "") return null;
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0) return Number.NaN;
  return price;
}

router.post("/products", async (req, res, next) => {
  try {
    const factoryCode = String(req.body?.factoryCode ?? "").trim().toUpperCase();
    const groupCode = String(req.body?.groupCode ?? "").trim();
    const productCode = String(req.body?.productCode ?? req.body?.code ?? "").trim();
    const size = String(req.body?.size ?? "").trim();
    const priceType = String(req.body?.priceType ?? "").trim();
    const builtName = ["Bordo", factoryCode, groupCode, productCode, size].filter(Boolean).join(" ").trim();
    const name = factoryCode ? builtName : String(req.body?.name ?? "").trim() || builtName;
    const code = productCode;
    const article = String(req.body?.article ?? "").trim() || productCode || groupCode;
    const catalog = peekCatalog() ?? await loadCatalog();
    let barcode = String(req.body?.barcode ?? "").trim();
    if (!barcode) barcode = nextInternalEan13(catalog, new Set());
    const prices = {
      Exclusive: som(req.body?.priceExclusive ?? req.body?.price),
      Premium: som(req.body?.pricePremium),
      Standard: som(req.body?.priceStandard),
    };
    let cost = som(req.body?.cost);
    if (cost != null && SALE_MARKUP[priceType] != null) {
      const sale = markedSale(cost, priceType);
      prices.Exclusive = priceType === "Exclusive" ? sale : null;
      prices.Premium = priceType === "Premium" ? sale : null;
      prices.Standard = priceType === "Standard" ? sale : null;
    } else {
      if (prices.Exclusive == null && cost != null) prices.Exclusive = cost;
      if (cost == null && prices.Exclusive != null) cost = prices.Exclusive;
    }
    const packSize = Math.max(0, Math.round(Number(req.body?.packSize) || 0));
    if (!factoryCode || !groupCode || !size || cost == null || SALE_MARKUP[priceType] == null || name.length < 2 || Number.isNaN(cost) || Object.values(prices).some((price) => Number.isNaN(price))) {
      res.status(400).json({ error: "rejected" });
      return;
    }
    const partner = await resolvePartnerFactory(factoryCode);
    if (!partner) {
      res.status(400).json({ error: "factory_missing" });
      return;
    }
    const uomMeta = { href: "https://api.moysklad.ru/api/remap/1.2/entity/uom/19f1edc0-fc42-4001-94cb-c9ec9c62ec10", type: "uom", mediaType: "application/json" };
    const pachkaMeta = { href: "https://api.moysklad.ru/api/remap/1.2/entity/uom/2061e032-0683-11f1-0a80-00e70010dbf7", type: "uom", mediaType: "application/json" };
    const payload: Record<string, unknown> = { name, uom: { meta: uomMeta } };
    if (code) payload.code = code;
    if (article) payload.article = article;
    if (barcode) payload.barcodes = [ean13(barcode) ? { ean13: barcode } : { code128: barcode }];
    if (packSize > 1) payload.packs = [{ quantity: packSize, uom: { meta: pachkaMeta } }];
    let folderId = String(req.body?.folderId ?? "").trim();
    let supplierId = String(req.body?.supplierId ?? "").trim();
    let folderName: string | null = null;
    let supplierName: string | null = null;
    if (!supplierId) {
      supplierId = partner.supplierId;
      supplierName = partner.supplierName;
    }
    if (!folderId && groupCode.length >= 3) {
      const folders = await moyskladAll<{ id?: string; name?: string; pathName?: string }>("/entity/productfolder");
      const matched = matchProductFolder(folders.rows.filter((row) => row.id && row.name).map((row) => ({ id: row.id as string, name: row.name as string, pathName: row.pathName })), groupCode);
      if (matched?.id) folderId = matched.id;
    }
    if (folderId) {
      try {
        const folder = await moysklad<{ name?: string; meta: { href: string; type: string; mediaType: string } }>(`/entity/productfolder/${encodeURIComponent(folderId)}`);
        payload.productFolder = { meta: folder.meta };
        folderName = folder.name || null;
      } catch {
        res.status(400).json({ error: "rejected" });
        return;
      }
    }
    if (supplierId) {
      try {
        const supplier = await moysklad<{ name?: string; meta: { href: string; type: string; mediaType: string } }>(`/entity/counterparty/${encodeURIComponent(supplierId)}`);
        payload.supplier = { meta: supplier.meta };
        supplierName = supplier.name || null;
      } catch {
        res.status(400).json({ error: "rejected" });
        return;
      }
    }
    const quoted = (Object.entries(prices) as Array<[string, number | null]>).filter((entry): entry is [string, number] => entry[1] != null);
    if (quoted.length > 0 || cost != null) {
      const [priceTypes, currencies] = await Promise.all([
        moysklad<Array<{ name?: string; meta: { href: string; type: string; mediaType: string } }>>("/context/companysettings/pricetype"),
        moysklad<{ rows: Array<{ isoCode?: string; meta: { href: string; type: string; mediaType: string } }> }>("/entity/currency?limit=100"),
      ]);
      const currency = currencies.rows.find((row) => row.isoCode === "UZS")?.meta;
      const salePrices = quoted.flatMap(([typeName, price]) => {
        const priceType = priceTypes.find((row) => row.name === typeName)?.meta;
        return currency && priceType ? [{ value: Math.round(price * 100), currency: { meta: currency }, priceType: { meta: priceType } }] : [];
      });
      if (!currency || salePrices.length !== quoted.length) {
        res.status(400).json({ error: "rejected" });
        return;
      }
      if (salePrices.length > 0) payload.salePrices = salePrices;
      if (cost != null) payload.buyPrice = { value: Math.round(cost * 100), currency: { meta: currency } };
    }
    const created = await moyskladSend<{ id: string; name: string; code?: string; article?: string }>("/entity/product", payload);
    try {
      const currencies = await moysklad<{ rows: Array<{ isoCode?: string; meta: { href: string; type: string; mediaType: string } }> }>("/entity/currency?limit=100");
      const currency = currencies.rows.find((row) => row.isoCode === "UZS")?.meta;
      const sale = prices.Exclusive ?? prices.Premium ?? prices.Standard ?? cost ?? 0;
      const typeName = prices.Exclusive != null ? "Exclusive" : prices.Premium != null ? "Premium" : prices.Standard != null ? "Standard" : sale > 0 ? "Exclusive" : "";
      const asMeta = (id: string, type: string) => id ? { href: `https://api.moysklad.ru/api/remap/1.2/entity/${type}/${id}`, type, mediaType: "application/json" } : null;
      if (currency) {
        await writeProductCard(created.id, sale, typeName, currency, {
          article,
          supplierMeta: asMeta(supplierId, "counterparty"),
          folderMeta: asMeta(folderId, "productfolder"),
          packSize,
          buySom: cost ?? undefined,
        });
      } else if (packSize > 1) {
        await ensurePachka(created.id, packSize);
      }
    } catch (error) {
      logger.warn({ productId: created.id, err: error instanceof Error ? error.message : error }, "MoySklad product card finish skipped");
    }
    addCatalogProduct({
      id: created.id,
      name: created.name,
      code: created.code || code || null,
      article: created.article || article || null,
      barcodes: barcode ? [barcode] : [],
      factory: supplierName,
      category: folderName,
      unit: "шт",
      packType: packSize > 1 ? "pachka" : null,
      packSize: packSize > 1 ? packSize : 1,
      imageUrl: null,
      stock: 0,
      available: 0,
      cost,
      salePrice: prices.Exclusive ?? prices.Premium ?? prices.Standard,
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
    void recordAudit({ action: "product.created", entityType: "product", entityId: created.id, details: created.name });
    res.status(201).json({ id: created.id, name: created.name });
  } catch (error) {
    if (error instanceof MoySkladError) {
      res.status(error.status >= 400 && error.status < 500 ? 400 : 502).json({ error: "rejected" });
      return;
    }
    next(error);
  }
});

async function uzsSalePrices(quoted: Array<[string, number]>) {
  if (quoted.length === 0) return [];
  const [priceTypes, currencies] = await Promise.all([
    moysklad<Array<{ name?: string; meta: { href: string; type: string; mediaType: string } }>>("/context/companysettings/pricetype"),
    moysklad<{ rows: Array<{ isoCode?: string; meta: { href: string; type: string; mediaType: string } }> }>("/entity/currency?limit=100"),
  ]);
  const currency = currencies.rows.find((row) => row.isoCode === "UZS")?.meta;
  const salePrices = quoted.flatMap(([typeName, price]) => {
    const priceType = priceTypes.find((row) => row.name === typeName)?.meta;
    return currency && priceType ? [{ value: Math.round(price * 100), currency: { meta: currency }, priceType: { meta: priceType } }] : [];
  });
  if (!currency || salePrices.length !== quoted.length) return null;
  return salePrices;
}

router.get("/products/folders", async (_req, res, next) => {
  try {
    const page = await moyskladAll<{ id?: string; name?: string; pathName?: string }>("/entity/productfolder");
    res.json({ items: page.rows.filter((row) => row.id && row.name).map((row) => ({ id: row.id, name: row.pathName || row.name })) });
  } catch (error) {
    next(error);
  }
});

router.get("/products/suppliers", async (req, res, next) => {
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

router.get("/products/factory-setup", async (req, res, next) => {
  try {
    const code = String(req.query.code ?? "").trim();
    if (code.length < 2) {
      res.json({ found: false, code: "", name: "", supplierId: "", supplierName: "" });
      return;
    }
    const partner = await resolvePartnerFactory(code);
    if (!partner) {
      res.json({ found: false, code, name: "", supplierId: "", supplierName: "" });
      return;
    }
    res.json({ found: true, ...partner });
  } catch (error) {
    next(error);
  }
});

router.get("/products/next-barcode", async (_req, res, next) => {
  try {
    const catalog = peekCatalog() ?? await loadCatalog();
    res.json({ barcode: nextInternalEan13(catalog, new Set()) });
  } catch (error) {
    next(error);
  }
});

router.get("/products/suggest", async (req, res, next) => {
  try {
    const code = String(req.query.code ?? "").trim();
    if (code.length < 2) {
      res.json({ folderId: "", folderName: "", supplierId: "", supplierName: "", article: "", cost: null, priceExclusive: null, packSize: null });
      return;
    }
    const catalog = peekCatalog() ?? await loadCatalog();
    const needle = code.toLowerCase();
    const exact = catalog.products.filter((product) => product.code?.toLowerCase() === needle || product.article?.toLowerCase() === needle);
    const sample = exact.find((product) => product.category || product.factory || product.cost || product.salePrice) || exact[0] || null;
    const folders = await moyskladAll<{ id?: string; name?: string; pathName?: string }>("/entity/productfolder");
    const folderRows = folders.rows.filter((row) => row.id && row.name).map((row) => ({ id: row.id as string, name: row.name as string, pathName: row.pathName }));
    const byCategory = sample?.category
      ? folderRows.find((folder) => folder.pathName === sample.category || folder.name === sample.category)
      : null;
    const byCode = matchProductFolder(folderRows, code);
    const folder = byCategory || byCode;
    let supplierId = "";
    let supplierName = sample?.factory || "";
    if (supplierName.length >= 2) {
      const page = await moysklad<{ rows: Array<{ id?: string; name?: string }> }>(`/entity/counterparty?limit=15&search=${encodeURIComponent(supplierName)}`);
      const hit = page.rows.find((row) => row.id && row.name && row.name.trim().toLowerCase() === supplierName.trim().toLowerCase())
        || (page.rows.length === 1 && page.rows[0].id ? page.rows[0] : null);
      if (hit?.id && hit.name) {
        supplierId = hit.id;
        supplierName = hit.name;
      }
    }
    res.json({
      folderId: folder?.id || "",
      folderName: folder ? (folder.pathName || folder.name) : "",
      supplierId,
      supplierName: supplierId ? supplierName : "",
      article: sample?.article || code,
      cost: sample?.cost ?? null,
      priceExclusive: sample?.salePrice ?? sample?.cost ?? null,
      packSize: sample && sample.packSize > 1 ? sample.packSize : null,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/products/:id/editor", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const row = await moysklad<{
      id?: string;
      name?: string;
      code?: string;
      article?: string;
      barcodes?: Array<Record<string, string>>;
      salePrices?: Array<{ value?: number; priceType?: { name?: string } }>;
    }>(`/entity/product/${encodeURIComponent(id)}?expand=salePrices.priceType`);
    const prices = { Exclusive: null as number | null, Premium: null as number | null, Standard: null as number | null };
    for (const price of row.salePrices ?? []) {
      const typeName = price.priceType?.name;
      if ((typeName === "Exclusive" || typeName === "Premium" || typeName === "Standard") && price.value != null) {
        prices[typeName] = Math.round(price.value) / 100;
      }
    }
    const barcodes = (row.barcodes ?? []).flatMap((item) => Object.values(item)).filter((value) => value.length > 0);
    res.json({ id: row.id || id, name: row.name || "", code: row.code || "", article: row.article || "", barcode: barcodes[0] || "", prices });
  } catch (error) {
    if (error instanceof MoySkladError) {
      res.status(error.status >= 400 && error.status < 500 ? 400 : 502).json({ error: "rejected" });
      return;
    }
    next(error);
  }
});

router.put("/products/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const name = String(req.body?.name ?? "").trim();
    const code = String(req.body?.code ?? "").trim();
    const article = String(req.body?.article ?? "").trim();
    const barcode = String(req.body?.barcode ?? "").trim();
    const prices = {
      Exclusive: som(req.body?.priceExclusive),
      Premium: som(req.body?.pricePremium),
      Standard: som(req.body?.priceStandard),
    };
    if (name.length < 2 || Object.values(prices).some((price) => Number.isNaN(price))) {
      res.status(400).json({ error: "rejected" });
      return;
    }
    const current = await moysklad<{
      barcodes?: Array<Record<string, string>>;
      salePrices?: Array<{ value?: number; priceType?: { name?: string } }>;
    }>(`/entity/product/${encodeURIComponent(id)}?expand=salePrices.priceType`);
    const kept = { Exclusive: null as number | null, Premium: null as number | null, Standard: null as number | null };
    for (const price of current.salePrices ?? []) {
      const typeName = price.priceType?.name;
      if ((typeName === "Exclusive" || typeName === "Premium" || typeName === "Standard") && price.value != null) {
        kept[typeName] = Math.round(price.value) / 100;
      }
    }
    const merged = {
      Exclusive: prices.Exclusive ?? kept.Exclusive,
      Premium: prices.Premium ?? kept.Premium,
      Standard: prices.Standard ?? kept.Standard,
    };
    const quoted = (Object.entries(merged) as Array<[string, number | null]>).filter((entry): entry is [string, number] => entry[1] != null);
    const payload: Record<string, unknown> = { name };
    if (code) payload.code = code;
    if (article) payload.article = article;
    const existingCodes = (current.barcodes ?? []).flatMap((item) => Object.values(item)).filter((value) => value.length > 0);
    if (barcode && barcode !== existingCodes[0]) {
      payload.barcodes = [barcode, ...existingCodes.filter((value) => value !== barcode)].map((value) => (ean13(value) ? { ean13: value } : { code128: value }));
    }
    const userPriced = Object.values(prices).some((price) => price != null);
    if (userPriced) {
      const salePrices = await uzsSalePrices(quoted);
      if (!salePrices) {
        res.status(400).json({ error: "rejected" });
        return;
      }
      payload.salePrices = salePrices;
    }
    const saved = await moyskladSend<{ id: string; name: string; code?: string; article?: string }>(`/entity/product/${encodeURIComponent(id)}`, payload, "PUT");
    const nextBarcodes = Array.isArray(payload.barcodes)
      ? (payload.barcodes as Array<Record<string, string>>).flatMap((item) => Object.values(item))
      : undefined;
    updateCatalogProduct(id, {
      name: saved.name,
      code: saved.code || code || null,
      article: saved.article || article || null,
      ...(nextBarcodes ? { barcodes: nextBarcodes } : {}),
      ...(userPriced ? { salePrice: merged.Exclusive ?? merged.Premium ?? merged.Standard } : {}),
    });
    void recordAudit({ action: "product.updated", entityType: "product", entityId: id, details: saved.name });
    res.json({ id, name: saved.name });
  } catch (error) {
    if (error instanceof MoySkladError) {
      res.status(error.status >= 400 && error.status < 500 ? 400 : 502).json({ error: "rejected" });
      return;
    }
    next(error);
  }
});

router.get("/products", async (req, res, next) => {
  try {
    const query = ListProductsQueryParams.parse(numericQuery(req.query, ["idleDays", "page", "pageSize"]));
    const catalog = await loadCatalog();
    let items = catalog.products.filter((product) => matchesSearch(product, query.search ?? ""));
    if (query.factory) items = items.filter((product) => product.factory === query.factory);
    if (query.category) items = items.filter((product) => product.category === query.category);
    if (query.warehouseId) {
      const ids = new Set(
        catalog.stockRows.filter((row) => row.warehouse.id === query.warehouseId).map((row) => row.product.id),
      );
      items = items.filter((product) => ids.has(product.id));
    }
    if (query.stockStatus === "low") items = items.filter((product) => product.stockStatus === "low");
    if (query.stockStatus === "available") items = items.filter((product) => product.stock > 0);
    if (query.stockStatus === "out") items = items.filter((product) => product.stockStatus === "out");
    if (query.idleDays) {
      items = items.filter((product) => (product.daysCover ?? 0) >= query.idleDays!);
    }
    const start = (query.page - 1) * query.pageSize;
    res.json(
      ListProductsResponse.parse({
        items: items.slice(start, start + query.pageSize),
        page: query.page,
        pageSize: query.pageSize,
        total: items.length,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.get("/products/:id/image", async (req, res, next) => {
  try {
    const catalog = await loadCatalog();
    const href = catalog.imageHrefs.get(String(req.params.id));
    if (!href) {
      res.status(404).end();
      return;
    }
    const target = req.query.size === "mini"
      ? `${href}${href.includes("?") ? "&" : "?"}miniature=true`
      : href;
    const image = await moyskladBinary(target);
    res.setHeader("Content-Type", image.type);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(image.body);
  } catch (error) {
    next(error);
  }
});

router.get("/scan-index", async (_req, res, next) => {
  try {
    res.json(scanIndex(await loadCatalog()));
  } catch (error) {
    next(error);
  }
});

router.get("/scan-session/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const unsubscribe = subscribeScanSession((body) => {
    res.write(`data: ${JSON.stringify(body)}\n\n`);
  });
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

router.get("/scan-session", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(readScanSession());
});

router.post("/scan-session", (req, res) => {
  res.json(addScanHit(req.body));
});

router.delete("/scan-session/:productId", (req, res) => {
  res.json(removeScanHit(String(req.params.productId)));
});

router.delete("/scan-session", (_req, res) => {
  res.json(clearScanSession());
});

router.get("/products/resolve", async (req, res, next) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const text = typeof req.query.text === "string" ? req.query.text : "";
    const catalog = await loadCatalog();
    const resolved = resolveScan(catalog, code, text);
    const ids = new Set(resolved.products.map((product) => product.id));
    const locations = catalog.stockRows
      .filter((row) => ids.has(row.product.id))
      .map((row) => ({
        productId: row.product.id,
        warehouseName: row.warehouse.name,
        quantity: row.quantity,
        inTransit: row.inTransit,
      }))
      .sort((a, b) => b.quantity - a.quantity);
    res.json(LookupBarcodeResponse.parse({
      barcode: resolved.barcode,
      ambiguous: resolved.products.length > 1,
      products: resolved.products,
      locations,
    }));
  } catch (error) {
    next(error);
  }
});

router.get("/products/barcode/:barcode", async (req, res, next) => {
  try {
    const { barcode } = LookupBarcodeParams.parse(req.params);
    const catalog = await loadCatalog();
    const products = findProductsByBarcode(catalog, barcode);
    const ids = new Set(products.map((product) => product.id));
    const locations = catalog.stockRows
      .filter((row) => ids.has(row.product.id))
      .map((row) => ({
        productId: row.product.id,
        warehouseName: row.warehouse.name,
        quantity: row.quantity,
        inTransit: row.inTransit,
      }))
      .sort((a, b) => b.quantity - a.quantity);
    res.json(LookupBarcodeResponse.parse({ barcode, ambiguous: products.length > 1, products, locations }));
  } catch (error) {
    next(error);
  }
});

router.get("/products/:id", async (req, res, next) => {
  try {
    const catalog = await loadCatalog();
    const product = catalog.products.find((item) => item.id === String(req.params.id));
    if (!product) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(product);
  } catch (error) {
    next(error);
  }
});

router.get("/stock", async (req, res, next) => {
  try {
    const query = ListStockQueryParams.parse(req.query);
    const catalog = await loadCatalog();
    let items = catalog.stockRows;
    if (query.warehouseId) items = items.filter((row) => row.warehouse.id === query.warehouseId);
    if (query.search) items = items.filter((row) => matchesSearch(row.product, query.search ?? ""));
    const start = (query.page - 1) * query.pageSize;
    res.json(
      ListStockResponse.parse({
        items: items.slice(start, start + query.pageSize),
        page: query.page,
        pageSize: query.pageSize,
        total: items.length,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.get("/documents/:id", async (req, res, next) => {
  try {
    const catalog = await loadCatalog();
    const id = String(req.params.id);
    const summary = catalog.documents.find((item) => item.id === id);
    if (!summary) {
      res.status(404).json({ error: "Hujjat topilmadi" });
      return;
    }
    const entity = summary.kind === "receipt" ? "supply" : summary.kind === "transfer" ? "move" : "inventory";
    const positions = await moyskladAll<{
      quantity?: number;
      price?: number;
      calculatedQuantity?: number;
      correctionAmount?: number;
      assortment?: { name?: string; code?: string; article?: string };
    }>(`/entity/${entity}/${id}/positions?expand=assortment`);
    const header = await moysklad<{ description?: string }>(`/entity/${entity}/${id}`);
    const lines = positions.rows.map((row, index) => {
      const price = money(row.price);
      const quantity = row.quantity ?? 0;
      const calculatedQuantity = row.calculatedQuantity ?? null;
      const correctionAmount = row.correctionAmount ?? null;
      return {
        id: `${id}-${index}`,
        name: row.assortment?.name || "Mahsulot",
        code: row.assortment?.code || null,
        article: row.assortment?.article || null,
        quantity,
        price,
        sum: price == null ? null : Math.round(price * quantity),
        calculatedQuantity,
        correctionAmount,
        correctionValue: price == null || correctionAmount == null ? null : Math.round(price * correctionAmount),
      };
    });
    const diffs = lines.filter((line) => (line.correctionAmount ?? 0) !== 0);
    const inventory = summary.kind === "inventory";
    const shown = inventory ? diffs.slice(0, 400) : lines;
    const quantity = lines.reduce((sum, line) => sum + line.quantity, 0);
    const shortageQty = diffs.reduce((sum, line) => sum + Math.min(0, line.correctionAmount ?? 0), 0);
    const surplusQty = diffs.reduce((sum, line) => sum + Math.max(0, line.correctionAmount ?? 0), 0);
    res.json({
      ...summary,
      description: header.description || null,
      quantity,
      lineTotal: lines.length,
      diffCount: diffs.length,
      shortageQty,
      surplusQty,
      truncated: inventory && diffs.length > shown.length,
      lines: shown,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/documents", async (req, res, next) => {
  try {
    const query = ListDocumentsQueryParams.parse(req.query);
    const catalog = await loadCatalog();
    let items = catalog.documents;
    if (query.kind && query.kind !== "all") items = items.filter((item) => item.kind === query.kind);
    if (query.status) items = items.filter((item) => item.status === query.status);
    res.json(ListDocumentsResponse.parse(items));
  } catch (error) {
    next(error);
  }
});

router.get("/analytics/non-moving", async (req, res, next) => {
  try {
    const query = GetNonMovingProductsQueryParams.parse(numericQuery(req.query, ["days"]));
    const catalog = await loadCatalog();
    const idle = (product: CatalogProduct) => {
      const days = idleDays(product, catalog.salesCoverage);
      return days != null && days >= query.days;
    };
    const items = query.warehouseId
      ? [...new Map(
          catalog.stockRows
            .filter((row) => row.warehouse.id === query.warehouseId && row.quantity > 0 && idle(row.product))
            .map((row) => [row.product.id, row.product] as const),
        ).values()]
      : catalog.products.filter((product) => idle(product));
    res.json(GetNonMovingProductsResponse.parse(items));
  } catch (error) {
    next(error);
  }
});

router.get("/catalog/factories", async (_req, res, next) => {
  try {
    const catalog = await loadCatalog();
    const ready = catalog.products.some((product) => product.factory?.trim());
    if (!ready) void ensureSuppliers(catalog).catch(() => undefined);
    const grouped = new Map<string, { name: string; count: number; stock: number; value: number; products: Array<{ id: string; name: string; code: string | null; stock: number; value: number }> }>();
    for (const product of catalog.products) {
      const name = product.factory?.trim() || "";
      const current = grouped.get(name) ?? { name, count: 0, stock: 0, value: 0, products: [] };
      const value = product.stock * (product.salePrice ?? 0);
      current.count += 1;
      current.stock += product.stock;
      current.value += value;
      current.products.push({ id: product.id, name: product.name, code: product.code, stock: product.stock, value });
      grouped.set(name, current);
    }
    const items = [...grouped.values()];
    for (const item of items) item.products.sort((a, b) => b.stock - a.stock || a.name.localeCompare(b.name));
    items.sort((a, b) => Number(!a.name) - Number(!b.name) || b.stock - a.stock || b.count - a.count);
    res.json({ items, ready });
  } catch (error) {
    next(error);
  }
});

router.get("/analytics/recommendations", async (req, res, next) => {
  try {
    const query = GetPurchaseRecommendationsQueryParams.parse(req.query);
    const catalog = await loadCatalog();
    const items = orderRecommendations(catalog, query.warehouseId);
    res.json(GetPurchaseRecommendationsResponse.parse(items));
  } catch (error) {
    next(error);
  }
});

router.get("/analytics/rebalance", async (_req, res, next) => {
  try {
    const catalog = await loadCatalog();
    const grouped = new Map<string, typeof catalog.stockRows>();
    for (const row of catalog.stockRows) {
      if (row.quantity <= 0) continue;
      const rows = grouped.get(row.product.id) ?? [];
      rows.push(row);
      grouped.set(row.product.id, rows);
    }
    const items = [];
    for (const rows of grouped.values()) {
      if (rows.length < 2) continue;
      const product = rows[0].product;
      const daily = product.sales30 / 30;
      if (daily <= 0) continue;
      const share = daily / rows.length;
      const ranked = [...rows].sort((a, b) => b.quantity / share - a.quantity / share);
      const source = ranked[0];
      const target = ranked[ranked.length - 1];
      const sourceCover = source.quantity / share;
      const targetCover = target.quantity / share;
      if (sourceCover < 45 || targetCover > 21 || source.warehouse.id === target.warehouse.id) continue;
      const keep = Math.ceil(share * 30);
      const need = Math.max(0, Math.ceil(share * 21) - target.quantity);
      const suggested = Math.min(Math.max(0, source.quantity - keep), need);
      if (suggested < 1) continue;
      items.push({
        productId: product.id,
        name: product.name,
        code: product.code,
        barcode: product.barcodes[0] ?? null,
        fromWarehouse: source.warehouse.name,
        toWarehouse: target.warehouse.name,
        fromQuantity: source.quantity,
        toQuantity: target.quantity,
        dailyAverage: Math.round(share * 100) / 100,
        suggestedQuantity: suggested,
        reason: "imbalance",
      });
    }
    items.sort((a, b) => b.suggestedQuantity - a.suggestedQuantity);
    res.json({ items: items.slice(0, 40), proposal: true });
  } catch (error) {
    next(error);
  }
});

const SALES_CACHE_FILE = dataFile("sales-cache.json");
const SALES_FRESH_MS = 10 * 60 * 1000;

type SalesBody = ReturnType<typeof GetSalesAnalyticsResponse.parse>;
type SalesEntry = { savedAt: number; body: SalesBody };

const salesMemory = new Map<string, SalesEntry>();
const salesInflight = new Map<string, Promise<SalesBody>>();
let salesDiskRead = false;

function readSalesDisk() {
  if (salesDiskRead) return;
  salesDiskRead = true;
  try {
    const parsed = JSON.parse(readFileSync(SALES_CACHE_FILE, "utf8")) as Record<string, SalesEntry>;
    for (const [key, entry] of Object.entries(parsed)) {
      if (entry?.body && typeof entry.savedAt === "number") salesMemory.set(key, entry);
    }
  } catch {
    // The first visit builds the snapshot.
  }
}

function writeSalesDisk() {
  try {
    mkdirSync(path.dirname(SALES_CACHE_FILE), { recursive: true });
    const tmp = `${SALES_CACHE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(salesMemory)));
    renameSync(tmp, SALES_CACHE_FILE);
  } catch {
    // A missed snapshot only makes the next cold start slower.
  }
}

async function computeSales(query: { period: "7d" | "30d" | "90d" | "365d"; warehouseId?: string }): Promise<SalesBody> {
    const days = query.period === "7d" ? 7 : query.period === "90d" ? 90 : query.period === "365d" ? 365 : 30;
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    const momentFrom = `${from.toISOString().slice(0, 10)} 00:00:00`;
    const momentTo = `${new Date().toISOString().slice(0, 10)} 23:59:59`;
    const store = query.warehouseId
      ? `;store=https://api.moysklad.ru/api/remap/1.2/entity/store/${query.warehouseId}`
      : "";
    const profitFilter = store ? `&filter=${encodeURIComponent(store.slice(1))}` : "";
    const fromKey = momentFrom.slice(0, 10);
    const toKey = momentTo.slice(0, 10);
    const [byDay, profit] = await Promise.all([
      store
        ? salesByDayFromDemands(fromKey, toKey, store)
        : salesByDay(fromKey, toKey),
      moyskladAll<{
        assortment?: { meta?: { href?: string }; name?: string; code?: string; article?: string };
        sellQuantity?: number;
        sellSum?: number;
      }>(
        `/report/profit/byproduct?momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}${profitFilter}`,
      ).catch(() => ({ rows: [], size: 0 })),
    ]);
    const trend = [...byDay.entries()].map(([date, value]) => ({ date, ...value }));
    const totalAmount = trend.reduce((sum, point) => sum + point.amount, 0);
    const ranked = [...profit.rows].sort((a, b) => (b.sellQuantity ?? 0) - (a.sellQuantity ?? 0));
    const totalQuantity = ranked.reduce((sum, row) => sum + (row.sellQuantity ?? 0), 0)
      || trend.reduce((sum, point) => sum + point.quantity, 0);
    const catalog = peekCatalog();
    const topProducts = ranked.filter((row) => (row.sellQuantity ?? 0) > 0).slice(0, 8).map((row) => {
      const href = row.assortment?.meta?.href ?? "";
      const id = href.split("/").pop()?.split("?")[0] || row.assortment?.name || "product";
      const known = catalog?.products.find((product) => product.id === id);
      if (known) return { ...known, sales30: row.sellQuantity ?? known.sales30 };
      return {
        id,
        name: row.assortment?.name || "Mahsulot",
        code: row.assortment?.code || null,
        article: row.assortment?.article || null,
        barcodes: [],
        factory: null,
        category: null,
        unit: null,
        packType: null,
        packSize: 1,
        imageUrl: null,
        stock: 0,
        available: 0,
        cost: null,
        salePrice: money(row.sellSum),
        lastSale: null,
        lastReceipt: null,
        sales7: 0,
        sales30: row.sellQuantity ?? 0,
        sales60: 0,
        sales90: 0,
        daysCover: null,
        stockStatus: "healthy" as const,
      };
    });

    return GetSalesAnalyticsResponse.parse({
      period: query.period,
      totalAmount,
      totalQuantity,
      averagePerDay: days ? totalAmount / days : 0,
      trend,
      topProducts,
    });
}

function emptySales(query: { period: "7d" | "30d" | "90d" | "365d" }): SalesBody {
  return GetSalesAnalyticsResponse.parse({
    period: query.period,
    totalAmount: 0,
    totalQuantity: 0,
    averagePerDay: 0,
    trend: [],
    topProducts: [],
  });
}

function loadSales(key: string, query: { period: "7d" | "30d" | "90d" | "365d"; warehouseId?: string }) {
  const running = salesInflight.get(key);
  if (running) return running;
  const job = computeSales(query)
    .then((body) => {
      salesMemory.set(key, { savedAt: Date.now(), body });
      writeSalesDisk();
      return body;
    })
    .catch(() => {
      const cached = salesMemory.get(key);
      if (cached) return cached.body;
      const body = emptySales(query);
      salesMemory.set(key, { savedAt: 0, body });
      return body;
    })
    .finally(() => {
      salesInflight.delete(key);
    });
  salesInflight.set(key, job);
  return job;
}

router.get("/analytics/sales", async (req, res, next) => {
  try {
    const query = GetSalesAnalyticsQueryParams.parse(req.query);
    const key = `${query.period}:${query.warehouseId || "all"}`;
    readSalesDisk();
    const cached = salesMemory.get(key);
    if (cached) {
      if (Date.now() - cached.savedAt > SALES_FRESH_MS) void loadSales(key, query).catch(() => undefined);
      res.json(cached.body);
      return;
    }
    res.json(await loadSales(key, query));
  } catch (error) {
    next(error);
  }
});

router.get("/export/catalog", async (_req, res, next) => {
  try {
    const catalog = await loadCatalog();
    res.json({
      companyName: catalog.companyName,
      loadedAt: catalog.loadedAt,
      productCount: catalog.productCount,
      salesToday: catalog.salesToday,
      incomingToday: catalog.incomingToday,
      pendingTransfers: catalog.pendingTransfers,
      products: catalog.products,
      warehouses: catalog.warehouses,
      documents: catalog.documents,
      stockRows: catalog.stockRows.map((row) => ({
        productId: row.product.id,
        warehouseId: row.warehouse.id,
        warehouseName: row.warehouse.name,
        warehouseCode: row.warehouse.code,
        quantity: row.quantity,
        inTransit: row.inTransit,
        value: row.value,
      })),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
