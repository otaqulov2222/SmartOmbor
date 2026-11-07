import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataFile } from "./data-dir";
import { idFromHref, money, moysklad, moyskladAll, MoySkladError } from "./moysklad";
import { logger } from "./logger";

export interface CatalogProduct {
  id: string;
  name: string;
  code: string | null;
  article: string | null;
  barcodes: string[];
  factory: string | null;
  category: string | null;
  unit: string | null;
  packType: string | null;
  packSize: number;
  imageUrl: string | null;
  stock: number;
  available: number;
  cost: number | null;
  salePrice: number | null;
  lastSale: string | null;
  lastReceipt: string | null;
  sales7: number;
  sales30: number;
  sales60: number;
  sales90: number;
  daysCover: number | null;
  stockStatus: "healthy" | "low" | "out" | "non_moving";
  inTransit: number;
}

export interface CatalogWarehouse {
  id: string;
  name: string;
  code: string | null;
  address: string | null;
}

export interface CatalogStockRow {
  product: CatalogProduct;
  warehouse: CatalogWarehouse;
  quantity: number;
  inTransit: number;
  value: number | null;
}

export interface CatalogDocument {
  id: string;
  kind: "receipt" | "transfer" | "inventory";
  number: string;
  date: string;
  status: string;
  sourceWarehouse: string | null;
  targetWarehouse: string | null;
  itemCount: number;
  total: number | null;
  moyskladId: string | null;
}

export interface Catalog {
  companyName: string | null;
  loadedAt: string;
  productCount: number;
  products: CatalogProduct[];
  warehouses: CatalogWarehouse[];
  stockRows: CatalogStockRow[];
  documents: CatalogDocument[];
  salesToday: number;
  incomingToday: number;
  pendingTransfers: number;
  error: string | null;
  imageHrefs: Map<string, string>;
  salesCoverage: { days7: boolean; days30: boolean; days90: boolean };
}

interface MetaRef {
  meta?: { href?: string };
  name?: string;
}

interface ProductRow {
  id?: string;
  name?: string;
  code?: string;
  article?: string;
  archived?: boolean;
  pathName?: string;
  barcodes?: Array<Record<string, string>>;
  salePrices?: Array<{ value?: number }>;
  buyPrice?: { value?: number };
  uom?: { name?: string };
  supplier?: { name?: string; meta?: { href?: string } };
  meta?: { href?: string };
}

interface StockRow {
  meta?: { href?: string };
  stock?: number;
  inTransit?: number;
  reserve?: number;
  name?: string;
  code?: string;
  article?: string;
  price?: number;
  salePrice?: number;
  stockDays?: number;
  uom?: { name?: string };
  folder?: { name?: string };
  image?: {
    meta?: { href?: string };
    miniature?: { href?: string; downloadHref?: string };
  };
}

interface StoreStock {
  meta?: { href?: string };
  name?: string;
  stock?: number;
  reserve?: number;
  inTransit?: number;
}

interface ByStoreRow extends StockRow {
  stockByStore?: StoreStock[];
}

interface StoreRow {
  id?: string;
  name?: string;
  code?: string;
  address?: string;
  meta?: { href?: string };
}

interface DocRow {
  id?: string;
  name?: string;
  moment?: string;
  applicable?: boolean;
  sum?: number;
  agent?: MetaRef;
  description?: string;
  store?: MetaRef;
  sourceStore?: MetaRef;
  targetStore?: MetaRef;
  positions?: { meta?: { size?: number } };
  meta?: { href?: string };
}

const LOW_STOCK = 3;
const CACHE_FILE = dataFile("catalog-cache.json");
let cache: Catalog | null = null;
let pending: Promise<Catalog> | null = null;
let lastBuildError: string | null = null;
let epoch = 0;

let persistQueued: Catalog | null = null;
let persistRunning = false;

function remember(next: Catalog) {
  cache = next;
  // Yangi katalog — eski waybill/barcode/name indekslari yaroqsiz.
  waybillIndexCatalog = null;
  indexedCatalog = null;
  nameCatalog = null;
  scanIndexCatalog = null;
  scanIndexBody = null;
  persistQueued = next;
  if (persistRunning) return;
  persistRunning = true;
  // Katta JSON.stringify event loopni muzlatadi — faqat bo‘sh paytda, bo‘laklab.
  const pump = () => {
    const job = persistQueued;
    persistQueued = null;
    if (!job) {
      persistRunning = false;
      return;
    }
    setTimeout(() => {
      void (async () => {
        try {
          mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
          const plain = {
            ...job,
            imageHrefs: [...job.imageHrefs.entries()],
          };
          const text = await new Promise<string>((resolve, reject) => {
            setImmediate(() => {
              try {
                resolve(JSON.stringify(plain));
              } catch (error) {
                reject(error);
              }
            });
          });
          await writeFile(CACHE_FILE, text);
        } catch (error) {
          logger.warn({ err: error }, "Catalog cache was not saved");
        } finally {
          if (persistQueued) pump();
          else persistRunning = false;
        }
      })();
    }, 1500);
  };
  pump();
}

async function recall(): Promise<Catalog | null> {
  try {
    const text = await readFile(CACHE_FILE, "utf8");
    const raw = JSON.parse(text) as Catalog & { imageHrefs: Array<[string, string]> };
    if (!raw?.loadedAt || !Array.isArray(raw.products)) return null;
    const catalog = { ...raw, imageHrefs: new Map(raw.imageHrefs ?? []) };
    alignStoreStock(catalog);
    return catalog;
  } catch {
    return null;
  }
}

export function alignStoreStock(catalog: Catalog): void {
  const totals = new Map<string, number>();
  for (const row of catalog.stockRows) {
    totals.set(row.product.id, (totals.get(row.product.id) ?? 0) + row.quantity);
  }
  const salesKnown = catalog.salesCoverage?.days30 === true;
  const changed = new Map<string, CatalogProduct>();
  for (const product of catalog.products) {
    const qty = totals.get(product.id);
    if (qty == null || qty === product.stock) continue;
    const reserve = product.stock - product.available;
    product.stock = qty;
    product.available = qty - reserve;
    if (salesKnown && product.sales30 > 0) product.daysCover = Math.round(product.stock / (product.sales30 / 30));
    product.stockStatus = stockStatus(product.stock, product.daysCover, product.sales30, salesKnown);
    changed.set(product.id, product);
  }
  for (const row of catalog.stockRows) {
    const product = changed.get(row.product.id);
    if (!product || row.product === product) continue;
    row.product.stock = product.stock;
    row.product.available = product.available;
    row.product.daysCover = product.daysCover;
    row.product.stockStatus = product.stockStatus;
  }
}

function stockStatus(stock: number, daysCover: number | null, sales30 = 0, salesKnown = false): CatalogProduct["stockStatus"] {
  if (stock <= 0) return "out";
  if (stock <= LOW_STOCK) return "low";
  if (salesKnown && sales30 <= 0) return "non_moving";
  if (!salesKnown && daysCover != null && daysCover >= 90) return "non_moving";
  return "healthy";
}

function barcodeValues(rows: ProductRow["barcodes"]): string[] {
  const values: string[] = [];
  for (const row of rows ?? []) {
    for (const value of Object.values(row)) {
      if (value) values.push(String(value));
    }
  }
  return values;
}

function emptyProduct(partial: Partial<CatalogProduct> & Pick<CatalogProduct, "id" | "name">): CatalogProduct {
  return {
    code: null,
    article: null,
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
    ...partial,
  };
}

function storeName(map: Map<string, CatalogWarehouse>, ref: MetaRef | undefined): string | null {
  const id = idFromHref(ref?.meta?.href);
  return ref?.name || map.get(id)?.name || null;
}

async function build(): Promise<Catalog> {
  const started = Date.now();
  const [organization, storesPage, productPage] = await Promise.all([
    moysklad<{ rows: Array<{ name?: string }> }>("/entity/organization?limit=1"),
    moyskladAll<StoreRow>("/entity/store"),
    moyskladAll<ProductRow>("/entity/product"),
  ]);

  const warehouses: CatalogWarehouse[] = storesPage.rows.map((store) => ({
    id: store.id || idFromHref(store.meta?.href),
    name: store.name || "Ombor",
    code: store.code || null,
    address: store.address || null,
  }));
  const warehouseById = new Map(warehouses.map((warehouse) => [warehouse.id, warehouse]));

  const products = new Map<string, CatalogProduct>();
  const supplierIds = new Map<string, string>();
  for (let i = 0; i < productPage.rows.length; i += 1) {
    const row = productPage.rows[i];
    // Event loopni bo‘shatish — parallel kirim so‘rovlari muzlamasin.
    if (i > 0 && i % 400 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    if (row.archived) continue;
    const id = row.id || idFromHref(row.meta?.href);
    if (!id) continue;
    const supplierId = idFromHref(row.supplier?.meta?.href);
    if (supplierId) supplierIds.set(id, supplierId);
    const sale = row.salePrices?.find((price) => price.value != null)?.value;
    products.set(
      id,
      emptyProduct({
        id,
        name: row.name || "Nomsiz mahsulot",
        code: row.code || null,
        article: row.article || null,
        barcodes: barcodeValues(row.barcodes),
        factory: row.supplier?.name || null,
        category: row.pathName || null,
        unit: row.uom?.name || null,
        cost: money(row.buyPrice?.value),
        salePrice: money(sale),
      }),
    );
  }
  const imageHrefs = new Map<string, string>();
  const [stock, directory] = await Promise.all([
    moyskladAll<StockRow>("/report/stock/all"),
    supplierIds.size > 0 ? supplierDirectory() : Promise.resolve(new Map<string, string>()),
  ]);
  for (const [productId, supplierId] of supplierIds) {
    const name = directory.get(supplierId);
    const product = products.get(productId);
    if (product && name) product.factory = name;
  }

  for (const row of stock.rows) {
    const id = idFromHref(row.meta?.href);
    if (!id) continue;
    const current = products.get(id) ?? emptyProduct({ id, name: row.name || "Nomsiz mahsulot" });
    const onHand = row.stock ?? 0;
    const reserve = row.reserve ?? 0;
    const daysCover = typeof row.stockDays === "number" ? row.stockDays : null;
    const imageHref = row.image?.meta?.href || row.image?.miniature?.href;
    if (imageHref) imageHrefs.set(id, imageHref);
    products.set(id, {
      ...current,
      name: row.name || current.name,
      code: row.code || current.code,
      article: row.article || current.article,
      category: row.folder?.name || current.category,
      unit: row.uom?.name || current.unit,
      stock: onHand,
      available: onHand - reserve,
      inTransit: row.inTransit ?? 0,
      cost: money(row.price) ?? current.cost,
      salePrice: money(row.salePrice) ?? current.salePrice,
      daysCover,
      stockStatus: stockStatus(onHand, daysCover),
      imageUrl: imageHref ? `/api/products/${id}/image` : current.imageUrl,
    });
  }

  const salesCoverage = { days7: false, days30: false, days90: false };
  const [sales7, sales30, sales90, byStore] = await Promise.all([
    salesQuantities(7).catch((error: unknown) => {
      logger.warn({ err: error }, "MoySklad 7-day sales skipped");
      return null;
    }),
    salesQuantities(30).catch((error: unknown) => {
      logger.warn({ err: error }, "MoySklad 30-day sales skipped");
      return null;
    }),
    salesQuantities(90).catch((error: unknown) => {
      logger.warn({ err: error }, "MoySklad 90-day sales skipped");
      return null;
    }),
    moyskladAll<ByStoreRow>("/report/stock/bystore"),
  ]);
  if (sales7) salesCoverage.days7 = true;
  if (sales30) salesCoverage.days30 = true;
  if (sales90) salesCoverage.days90 = true;
  for (const product of products.values()) {
    if (sales7) product.sales7 = sales7.get(product.id) ?? 0;
    if (sales30) product.sales30 = sales30.get(product.id) ?? 0;
    if (sales90) product.sales90 = sales90.get(product.id) ?? 0;
    if (sales30) {
      const daily = product.sales30 / 30;
      product.daysCover = daily > 0 ? Math.round(product.stock / daily) : null;
      product.stockStatus = stockStatus(product.stock, product.daysCover, product.sales30, true);
    }
  }

  const stockRows: CatalogStockRow[] = [];
  for (const row of byStore.rows) {
    const id = idFromHref(row.meta?.href);
    const product = products.get(id);
    if (!product) continue;
    for (const cell of row.stockByStore ?? []) {
      const quantity = cell.stock ?? 0;
      const inTransit = cell.inTransit ?? 0;
      if (quantity === 0 && inTransit === 0) continue;
      const warehouseId = idFromHref(cell.meta?.href);
      const warehouse = warehouseById.get(warehouseId) ?? {
        id: warehouseId || cell.name || "store",
        name: cell.name || "Ombor",
        code: null,
        address: null,
      };
      stockRows.push({
        product,
        warehouse,
        quantity,
        inTransit,
        value: product.cost == null ? null : product.cost * quantity,
      });
    }
  }

  const today = new Date();
  const day = today.toISOString().slice(0, 10);
  const filter = encodeURIComponent(`moment>=${day} 00:00:00;moment<=${day} 23:59:59`);
  const skipDenied = (label: string) => (error: unknown) => {
    logger.warn({ err: error }, `MoySklad ${label} skipped`);
    return null;
  };
  const [demands, supplies, moves, suppliesRecent, movesRecent, inventories] = await Promise.all([
    moysklad<{ meta: { size: number }; rows: DocRow[] }>(`/entity/demand?limit=100&filter=${filter}`).catch(skipDenied("demands")),
    moysklad<{ meta: { size: number }; rows: DocRow[] }>(`/entity/supply?limit=100&filter=${filter}`).catch(skipDenied("supplies")),
    moysklad<{ meta: { size: number } }>("/entity/move?limit=1&filter=applicable=false").catch(skipDenied("moves")),
    moysklad<{ rows: DocRow[] }>("/entity/supply?limit=100&order=moment,desc&expand=agent").catch(skipDenied("supply-list")),
    moysklad<{ rows: DocRow[] }>("/entity/move?limit=100&order=moment,desc").catch(skipDenied("move-list")),
    moysklad<{ rows: DocRow[] }>("/entity/inventory?limit=100&order=moment,desc").catch(skipDenied("inventory")),
  ]);

  const documents: CatalogDocument[] = [
    ...(suppliesRecent?.rows ?? []).map((row) => toDocument(row, "receipt", warehouseById)),
    ...(movesRecent?.rows ?? []).map((row) => toDocument(row, "transfer", warehouseById)),
    ...(inventories?.rows ?? []).map((row) => toDocument(row, "inventory", warehouseById)),
  ].sort((a, b) => b.date.localeCompare(a.date));

  const catalog: Catalog = {
    companyName: organization.rows[0]?.name ?? null,
    loadedAt: new Date().toISOString(),
    productCount: products.size,
    products: [...products.values()].sort((a, b) => a.name.localeCompare(b.name, "uz")),
    warehouses,
    stockRows,
    documents,
    salesToday: (demands?.rows ?? []).reduce((sum, row) => sum + (money(row.sum) ?? 0), 0),
    incomingToday: supplies?.meta.size ?? 0,
    pendingTransfers: moves?.meta.size ?? 0,
    error: null,
    imageHrefs,
    salesCoverage,
  };
  alignStoreStock(catalog);

  logger.info(
    {
      ms: Date.now() - started,
      products: catalog.products.length,
      stockRows: catalog.stockRows.length,
      warehouses: catalog.warehouses.length,
    },
    "MoySklad catalog loaded",
  );
  return catalog;
}

function toDocument(
  row: DocRow,
  kind: CatalogDocument["kind"],
  warehouses: Map<string, CatalogWarehouse>,
): CatalogDocument {
  return {
    id: row.id || idFromHref(row.meta?.href) || randomUUID(),
    kind,
    number: row.name || "—",
    date: row.moment ? row.moment.replace(" ", "T") : new Date().toISOString(),
    status: row.applicable === false ? "draft" : "posted",
    sourceWarehouse: kind === "receipt" ? row.agent?.name || null : storeName(warehouses, kind === "transfer" ? row.sourceStore : row.store),
    targetWarehouse: kind === "receipt" ? storeName(warehouses, row.store) : kind === "transfer" ? storeName(warehouses, row.targetStore) : null,
    itemCount: row.positions?.meta?.size ?? 0,
    total: money(row.sum),
    moyskladId: row.id || idFromHref(row.meta?.href) || null,
  };
}

async function salesQuantities(days: number): Promise<Map<string, number>> {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - (days - 1));
  const momentFrom = `${from.toISOString().slice(0, 10)} 00:00:00`;
  const momentTo = `${to.toISOString().slice(0, 10)} 23:59:59`;
  const profit = await moyskladAll<{ assortment?: { meta?: { href?: string } }; sellQuantity?: number }>(
    `/report/profit/byproduct?momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}`,
  );
  const quantities = new Map<string, number>();
  for (const row of profit.rows) {
    const id = idFromHref(row.assortment?.meta?.href);
    if (id) quantities.set(id, row.sellQuantity ?? 0);
  }
  return quantities;
}

export function idleDays(product: CatalogProduct, coverage: Catalog["salesCoverage"]): number | null {
  if (product.stock <= 0) return null;
  if (!coverage.days30) return null;
  if (coverage.days7 && product.sales7 > 0) return 0;
  if (product.sales30 > 0) return coverage.days7 ? 7 : 0;
  if (coverage.days90) return product.sales90 > 0 ? 30 : 90;
  return 30;
}

function startBuild(): Promise<Catalog> {
  if (pending) return pending;
  const stamp = epoch;
  lastBuildError = null;
  pending = build()
    .then((next) => {
      if (stamp === epoch) remember(next);
      if (stamp === epoch) pending = null;
      lastBuildError = null;
      return next;
    })
    .catch((error: unknown) => {
      if (stamp === epoch) pending = null;
      lastBuildError = error instanceof Error ? error.message : "MoySklad sync failed";
      throw error instanceof Error ? error : new MoySkladError("MoySklad sync failed", 502);
    });
  return pending;
}

export function catalogSyncing(): boolean {
  return pending != null;
}

export function catalogSyncState(): { running: boolean; lastSync: string | null; error: string | null } {
  return { running: pending != null, lastSync: cache?.loadedAt ?? null, error: lastBuildError };
}

export function resetCatalog() {
  epoch += 1;
  cache = null;
  pending = null;
  try { unlinkSync(CACHE_FILE); } catch { /* no snapshot yet */ }
}

export async function loadCatalog(force = false): Promise<Catalog> {
  if (!cache) cache = await recall();
  if (!force && cache) return cache;
  try {
    return await (pending ?? startBuild());
  } catch (error) {
    if (!cache) cache = await recall();
    if (cache) {
      logger.warn({ err: error }, "MoySklad refresh failed; keeping saved catalog");
      return cache;
    }
    throw error;
  }
}

let warehousesOnly: CatalogWarehouse[] | null = null;

/** Kirim uchun: disk/xotira katalogi (moslash aniq), yo‘q bo‘lsa faqat omborlar. */
export async function loadCatalogForSupply(): Promise<Catalog> {
  const known = await peekOrRecallCatalog();
  if (known?.warehouses?.length) return known;
  if (known?.products?.length) {
    if (!warehousesOnly?.length) {
      try {
        const storesPage = await moyskladAll<StoreRow>("/entity/store");
        warehousesOnly = storesPage.rows.map((store) => ({
          id: store.id || idFromHref(store.meta?.href),
          name: store.name || "Ombor",
          code: store.code || null,
          address: store.address || null,
        }));
        known.warehouses = warehousesOnly;
      } catch (error) {
        logger.warn({ err: error }, "Supply warehouse fetch failed; using catalog without stores");
      }
    } else {
      known.warehouses = warehousesOnly;
    }
    return known;
  }
  if (!warehousesOnly?.length) {
    const storesPage = await moyskladAll<StoreRow>("/entity/store");
    warehousesOnly = storesPage.rows.map((store) => ({
      id: store.id || idFromHref(store.meta?.href),
      name: store.name || "Ombor",
      code: store.code || null,
      address: store.address || null,
    }));
  }
  return {
    companyName: null,
    loadedAt: new Date().toISOString(),
    productCount: 0,
    products: [],
    warehouses: warehousesOnly,
    stockRows: [],
    documents: [],
    salesToday: 0,
    incomingToday: 0,
    pendingTransfers: 0,
    error: null,
    imageHrefs: new Map(),
    salesCoverage: { days7: false, days30: false, days90: false },
  };
}

let supplierFill: Promise<Catalog> | null = null;

export function ensureSuppliers(catalog: Catalog): Promise<Catalog> {
  if (supplierFill) return supplierFill;
  supplierFill = (async () => {
    const named = catalog.products.filter((product) => product.factory?.trim()).length;
    if (catalog.products.length === 0 || named / catalog.products.length >= 0.2) return catalog;
    return fillSuppliers(catalog);
  })().finally(() => {
    supplierFill = null;
  });
  return supplierFill;
}

async function supplierDirectory(): Promise<Map<string, string>> {
  const page = await moyskladAll<{ id?: string; name?: string; meta?: { href?: string } }>("/entity/counterparty");
  const names = new Map<string, string>();
  for (const row of page.rows) {
    const id = row.id || idFromHref(row.meta?.href);
    const name = row.name?.trim();
    if (id && name) names.set(id, name);
  }
  return names;
}

async function fillSuppliers(catalog: Catalog): Promise<Catalog> {
  const [directory, page] = await Promise.all([
    supplierDirectory(),
    moyskladAll<{ id?: string; meta?: { href?: string }; supplier?: { meta?: { href?: string } } }>("/entity/product"),
  ]);
  const names = new Map<string, string>();
  for (const row of page.rows) {
    const id = row.id || idFromHref(row.meta?.href);
    const name = directory.get(idFromHref(row.supplier?.meta?.href));
    if (id && name) names.set(id, name);
  }
  if (names.size === 0) return catalog;
  for (const product of catalog.products) {
    const name = names.get(product.id);
    if (name) product.factory = name;
  }
  for (const row of catalog.stockRows) {
    const name = names.get(row.product.id);
    if (name) row.product.factory = name;
  }
  remember(catalog);
  return catalog;
}

export function updateCatalogProduct(id: string, patch: Partial<CatalogProduct>) {
  const current = cache;
  const product = current?.products.find((item) => item.id === id);
  if (!current || !product) return;
  Object.assign(product, patch);
  indexedCatalog = null;
  nameCatalog = null;
  remember(current);
}

export function applyReceiptStock(entries: Array<{ productId: string; warehouseId: string; quantity: number }>) {
  const current = cache;
  if (!current) return;
  for (const entry of entries) {
    if (entry.quantity <= 0) continue;
    const product = current.products.find((item) => item.id === entry.productId);
    if (!product) continue;
    product.stock += entry.quantity;
    product.available += entry.quantity;
    if (product.stock > 0 && product.stockStatus === "out") product.stockStatus = "healthy";
    const warehouse = current.warehouses.find((item) => item.id === entry.warehouseId);
    const row = current.stockRows.find((item) => item.product.id === entry.productId && item.warehouse.id === entry.warehouseId);
    if (row) {
      row.quantity += entry.quantity;
      row.product.stock = product.stock;
      row.product.available = product.available;
      row.product.stockStatus = product.stockStatus;
    } else if (warehouse) {
      current.stockRows.push({
        product,
        warehouse,
        quantity: entry.quantity,
        inTransit: 0,
        value: product.cost == null ? null : product.cost * entry.quantity,
      });
    }
  }
  indexedCatalog = null;
  nameCatalog = null;
  remember(current);
}

export function addCatalogProduct(product: CatalogProduct) {
  const current = cache;
  if (!current || current.products.some((item) => item.id === product.id)) return;
  current.products.unshift(product);
  current.productCount = current.products.length;
  indexedCatalog = null;
  nameCatalog = null;
  remember(current);
}

export function peekCatalog(): Catalog | null {
  return cache;
}

/** Xotirada yo‘q bo‘lsa disk cache’dan — to‘liq MoySklad sync kutmasdan. */
export async function peekOrRecallCatalog(): Promise<Catalog | null> {
  if (cache?.products?.length) return cache;
  const disk = await recall();
  if (disk?.products?.length) {
    cache = disk;
    return disk;
  }
  return cache;
}

/**
 * GET/list uchun: disk/xotira. To‘liq MoySklad build hech qachon so‘rovni bloklamaydi.
 * Bo‘sh bo‘lsa fon sync ishga tushadi va null qaytadi (handler 503/bo‘sh UI bersin).
 */
export async function catalogForRead(): Promise<Catalog | null> {
  const hit = await peekOrRecallCatalog();
  if (hit?.products?.length) {
    // Indeksni isitish — keyingi waybill match CPU yemasin.
    waybillIndexFor(hit);
    return hit;
  }
  if (!catalogSyncing()) {
    void loadCatalog(false).catch((error) => {
      logger.warn({ err: error }, "Background catalog warm failed");
    });
  }
  return hit;
}

let bootstrapOnce: Promise<Catalog | null> | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/** Server start: diskdan darhol, keyin fon sync. Ro‘yxatlar bo‘sh qolmasin. */
export function ensureCatalogBootstrapped(): Promise<Catalog | null> {
  if (!bootstrapOnce) {
    bootstrapOnce = (async () => {
      const disk = await peekOrRecallCatalog();
      logger.info({
        products: disk?.products.length ?? 0,
        warehouses: disk?.warehouses.length ?? 0,
        source: disk ? "disk-or-memory" : "empty",
      }, "Catalog bootstrap");
      return disk;
    })().catch((error) => {
      logger.warn({ err: error }, "Catalog bootstrap failed");
      return null;
    });
  }
  return bootstrapOnce;
}

/** Bir xil Bordo nomdagi twin kartochkalarni aniqlaydi — 15 daqiqalik hisobot uchun. */
export function reportBordoNameTwins(catalog: Catalog, limit = 20) {
  const groups = new Map<string, CatalogProduct[]>();
  for (const product of catalog.products) {
    const parts = parseBordoName(product.name);
    if (!parts || parts.color) continue;
    const key = [
      canonicalFactoryCode(parts.factoryCode),
      compactCode(parts.groupCode),
      coreProductCode(parts.productCode),
      compactCode(parts.size),
      compactCode(parts.article),
    ].join("|");
    if (!key.replace(/\|/g, "")) continue;
    const list = groups.get(key);
    if (list) list.push(product);
    else groups.set(key, [product]);
  }
  const twins = [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({
      key,
      count: rows.length,
      name: rows[0]?.name || key,
      codes: rows.map((row) => row.code || row.id).slice(0, 6),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
  if (twins.length) {
    logger.warn({ twinGroups: twins.length, sample: twins.slice(0, 8) }, "Bordo twin-card check: same identity, multiple MoySklad cards");
  } else {
    logger.info({ products: catalog.products.length }, "Bordo twin-card check: no exact-name twins");
  }
  return twins;
}

export function startCatalogKeepalive() {
  if (keepAliveTimer) return;
  const refresh = (force: boolean) => {
    void loadCatalog(force)
      .then((catalog) => {
        if (catalog?.products?.length) reportBordoNameTwins(catalog);
      })
      .catch((error) => {
        logger.warn({ err: error }, force ? "Catalog keepalive force sync failed" : "Catalog keepalive soft load failed");
      });
  };
  // Tez soft-load (disk), keyin periodik yangilash + twin hisobot.
  setTimeout(() => refresh(false), 2_000);
  setTimeout(() => refresh(true), 45_000);
  keepAliveTimer = setInterval(() => {
    if (!cache?.products?.length) {
      void peekOrRecallCatalog().then((hit) => {
        if (!hit?.products?.length) refresh(true);
        else reportBordoNameTwins(hit);
      });
      return;
    }
    refresh(true);
  }, 15 * 60_000);
  if (typeof keepAliveTimer === "object" && keepAliveTimer && "unref" in keepAliveTimer) {
    keepAliveTimer.unref();
  }
}

export function catalogLoadedAt(): string | null {
  return cache?.loadedAt ?? null;
}

const LOOKALIKE: Record<string, string> = {
  А: "A", В: "B", С: "C", Е: "E", Ё: "E", Н: "H", К: "K", М: "M", О: "O", Р: "P", Т: "T", Х: "X", У: "Y",
  а: "A", в: "B", с: "C", е: "E", ё: "E", н: "H", к: "K", м: "M", о: "O", р: "P", т: "T", х: "X", у: "Y",
};

export function foldGlyphs(value: string) {
  const prepared = value.normalize("NFKC")
    .replace(/бордо/gi, "Bordo")
    .replace(/[–—−]/g, "-")
    .replace(/(\d{1,2})-+(\d{1,2})/g, "$1-$2")
    .replace(/[\u00a0\u2007\u202f\u200b\u2060]/g, " ");
  return [...prepared].map((ch) => LOOKALIKE[ch] ?? ch).join("");
}

export function compactCode(value: string): string {
  return foldGlyphs(value).trim().replace(/[\s\-_.\/]+/g, "").toLocaleLowerCase("en-US");
}

export function normalizeBordoColor(value: string) {
  return value.normalize("NFKC")
    .replace(/[Рр]/g, "R")
    .trim()
    .replace(/[\s\-_.\/]+/g, "")
    .toLocaleUpperCase("en-US");
}

export function sameBordoColor(left: string, right: string) {
  return normalizeBordoColor(left) === normalizeBordoColor(right);
}

export function normalizeBordoCode(value: string): string {
  return foldGlyphs(value).trim().replace(/\s+/g, " ").toLocaleUpperCase("en-US");
}

export const BORDO_SIZES = ["20-23", "20-25", "22-27", "24-29", "28-32", "30-35", "33-37", "35-39", "36-40", "40-44", "41-43"] as const;

export function normalizeBordoSize(value: string): string {
  const folded = foldGlyphs(value).trim().replace(/\s+/g, "");
  if (!folded) return "";
  const known = BORDO_SIZES.find((size) => compactCode(size) === compactCode(folded));
  if (known) return known;
  const hit = folded.match(/^(\d{1,2})-(\d{1,2})$/);
  return hit ? `${Number(hit[1])}-${Number(hit[2])}` : value.trim().replace(/[–—−]/g, "-");
}

export function canonicalFactoryCode(value: string, fallback = ""): string {
  const raw = normalizeBordoCode(value);
  const fb = normalizeBordoCode(fallback);
  if (/^\d{3,6}$/.test(raw)) return raw;
  if (/^\d{3,6}$/.test(fb) && compactCode(raw).endsWith(compactCode(fb))) return fb;
  const tail = raw.match(/(\d{3,6})$/);
  if (tail) return tail[1];
  if (/^\d{3,6}$/.test(fb)) return fb;
  return raw || fb;
}

export function sameFactoryCode(left: string, right: string) {
  const a = canonicalFactoryCode(left);
  const b = canonicalFactoryCode(right);
  return Boolean(a) && a === b;
}

export function sameProductCode(left: string, right: string) {
  const a = compactCode(left);
  const b = compactCode(right);
  return Boolean(a) && a === b;
}

/** Model revision (R4/R5/R7) ni olib tashlab asosiy kodni qaytaradi — 088 R5 ≈ 088. */
export function coreProductCode(value: string): string {
  const raw = foldGlyphs(value).trim().replace(/\s+/g, " ");
  if (!raw) return "";
  const stripped = raw.replace(/\s+R-?\d+$/i, "").trim();
  return compactCode(stripped || raw);
}

export function productModelToken(value: string): string {
  const raw = foldGlyphs(value).trim().replace(/\s+/g, " ");
  const hit = raw.match(/\s+(R-?\d+)$/i);
  return hit ? hit[1].toUpperCase().replace(/^R-/i, "R") : "";
}

export function productCodeMatches(nameCode: string, typed: string) {
  const a = coreProductCode(nameCode);
  const b = coreProductCode(typed);
  return Boolean(a) && a === b;
}

export function foldProductName(value: string) {
  // Artikul (43937) identity — strip qilinsa eski/yangi kartochka bir xil bo‘lib qoladi.
  return normalizeBordoCode(value);
}

/**
 * Identity artikul: faqat NOM oxiridagi 43937 kabi qo‘shimcha.
 * MoySklad `article` maydoni o‘zi identity EMAS — u yerda barcode/kod/yolg‘on 43937 yozilgan
 * bo‘lishi mumkin; shuni “farq” deb o‘qisa Bordo 0035 1020 B 708 36-40 kabi kartochka
 * topilmay, yana 128… dublikat ochiladi. Farq faqat nomdagi artikul bilan.
 */
export function bordoIdentityArticle(
  name: string,
  _msArticle?: string | null,
  _productCodeHint = "",
): string {
  const parts = parseBordoName(name);
  return parts?.article ? compactCode(parts.article) : "";
}

export function bordoCardArticle(name: string, fallbackArticle = ""): string {
  return bordoIdentityArticle(name, fallbackArticle);
}

/** MoySkladda article yozishdan oldin: tovar/guruh/zavod/razmer nusxasini yozmaslik. */
export function sanitizeMoySkladArticle(
  article: string,
  identity: { productCode?: string; groupCode?: string; factoryCode?: string; size?: string },
): string {
  const art = String(article || "").trim();
  if (!art) return "";
  const compact = compactCode(art);
  if (identity.productCode && compact === coreProductCode(identity.productCode)) return "";
  if (identity.productCode && compact === compactCode(identity.productCode)) return "";
  if (identity.groupCode && compact === compactCode(identity.groupCode)) return "";
  if (identity.factoryCode && compact === compactCode(identity.factoryCode)) return "";
  if (identity.size && compact === compactCode(identity.size)) return "";
  return art;
}

/** Canonical parent nom — har doim shu tartib. */
export function bordoParentName(input: {
  factoryCode: string;
  groupCode?: string;
  productCode: string;
  size: string;
  article?: string;
}): string {
  const factory = canonicalFactoryCode(input.factoryCode) || normalizeBordoCode(input.factoryCode);
  const group = normalizeBordoCode(input.groupCode || "");
  const code = normalizeBordoCode(input.productCode);
  const size = normalizeBordoSize(input.size);
  const article = sanitizeMoySkladArticle(input.article || "", {
    productCode: code,
    groupCode: group,
    factoryCode: factory,
    size,
  });
  return ["Bordo", factory, group, code, size, article].filter(Boolean).join(" ").trim();
}

export function sameBordoCard(
  name: string,
  input: { factoryCode: string; productCode: string; size: string; groupCode?: string; article?: string },
  extras?: { article?: string | null },
) {
  const parts = parseBordoName(name);
  if (!parts) return false;
  if (parts.color) return false;
  if (!sameFactoryCode(parts.factoryCode, input.factoryCode)) return false;
  if (!productCodeMatches(parts.productCode, input.productCode)) return false;
  if (input.size.trim() && compactCode(parts.size) !== compactCode(normalizeBordoSize(input.size))) return false;
  // Guruh qattiq: 1020 ≠ 1021 ≠ 2021 — xato guruhga eski kartochka topilmasin.
  const group = input.groupCode?.trim() || "";
  if (group) {
    if (!parts.groupCode || !sameToken(parts.groupCode, group)) return false;
  }
  // Artikul qattiq: "…24-29" ≠ "…24-29 43937". Lekin article=289 (kod nusxasi) e’tiborsiz.
  const wanted = compactCode(input.article ?? "");
  const got = bordoIdentityArticle(name, extras?.article, input.productCode || parts.productCode);
  if (wanted !== got) return false;
  return true;
}

function indexKeys(value: string): string[] {
  const compact = compactCode(value);
  if (compact.length < 3) return [];
  const keys = [compact];
  if (/^\d+$/.test(compact) && compact.length >= 8) {
    const bare = compact.replace(/^0+/, "");
    if (bare.length >= 6) keys.push(bare);
    if (compact.length === 12) keys.push(`0${compact}`);
    if (compact.length === 13 && compact.startsWith("0")) keys.push(compact.slice(1));
  }
  return keys;
}

function lookupKeys(value: string): string[] {
  const compact = compactCode(value);
  if (compact.length < 3) return [];
  const keys = new Set(indexKeys(compact));
  if (/^\d+$/.test(compact) && compact.length >= 4 && compact.length < 6) keys.add(compact.padStart(6, "0"));
  if (/^\d+$/.test(compact) && compact.length === 12) keys.add(`0${compact}`);
  if (/^\d{13}$/.test(compact) && compact.startsWith("2000000")) {
    const tail = compact.slice(-6);
    keys.add(tail);
    const bare = tail.replace(/^0+/, "");
    if (bare.length >= 3) keys.add(bare);
  }
  return [...keys];
}

let indexedCatalog: Catalog | null = null;
let barcodeIndex = new Map<string, CatalogProduct[]>();

function wholeToken(name: string, token: string, min = 3) {
  const haystack = foldGlyphs(name);
  const clean = foldGlyphs(token).trim();
  if (clean.length < min) return false;
  return new RegExp(`(^|\\D)${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\D|$)`, "i").test(haystack);
}

function nameHasSize(name: string, size: string) {
  if (!size.trim()) return true;
  const needle = size.trim().replace(/[–—−]/g, "-");
  if (compactCode(parseBordoName(name)?.size || "") === compactCode(needle)) return true;
  return wholeToken(foldGlyphs(name), needle, Math.min(3, needle.length));
}

function sameToken(left: string, right: string) {
  const a = compactCode(left);
  const b = compactCode(right);
  return Boolean(a) && a === b;
}

export function lastNumericToken(label: string) {
  const tokens = normalizeBordoCode(label).split(/[^0-9A-Z]+/).filter(Boolean);
  let nums = tokens.filter((token) => /^\d+$/.test(token));
  if (nums.length >= 2 && /^\d{4,}$/.test(nums[nums.length - 1])) nums = nums.slice(0, -1);
  const groups = nums.filter((token) => /^\d{3,6}$/.test(token) && Number(token) > 44);
  return groups[groups.length - 1] || nums[nums.length - 1] || "";
}

/**
 * Bordo identity (tartib qat’iy):
 *   Bordo {zavod=factoryCode} {guruh=groupCode} {tovar=productCode} {razmer=size} [artikul] [(rang)]
 * Misollar:
 *   Bordo 0044 1020 289 36-40          → zavod 0044, guruh 1020, tovar 289, razmer 36-40
 *   Bordo 0007 1020 2522 24-29 43937   → … + artikul 43937 (nom oxiridagi qo‘shimcha)
 * MoySklad `article` maydoniga tovar/guruh kodini yozish — XATO (dublikat ochadi).
 */
export function parseBordoName(name: string): { factoryCode: string; groupCode: string; productCode: string; size: string; color: string; model: string; article: string } | null {
  let raw = foldGlyphs(name).trim().replace(/\s+/g, " ");
  let color = "";
  let model = "";
  let article = "";
  const paren = raw.match(/\(([^)]+)\)\s*$/);
  if (paren && paren.index != null) {
    color = paren[1].trim();
    raw = raw.slice(0, paren.index).trim();
  }
  // Oxiridagi R5 faqat size bo‘lmasa model/rang — size dan oldin ham bo‘lishi mumkin.
  const tail = raw.match(/\s+(R-?\d+)\s*$/i);
  if (tail && tail.index != null) {
    model = tail[1].toUpperCase().replace(/^R-/i, "R");
    raw = raw.slice(0, tail.index).trim();
  }
  // Size dan keyingi 4+ raqam = artikul (43937). Olib tashlamasdan saqlaymiz — aks holda eski kartochkaga yopishadi.
  const articleTail = raw.match(/\s+(\d{4,})\s*$/);
  if (articleTail && articleTail.index != null) {
    const beforeArticle = raw.slice(0, articleTail.index);
    if (/\d{1,2}-\d{1,2}/.test(beforeArticle)) {
      article = articleTail[1];
      raw = beforeArticle.trim();
    }
  }
  const sizeMatches = [...raw.matchAll(/\d{1,2}-\d{1,2}/g)];
  const sizeMatch = [...sizeMatches].reverse().find((item) => BORDO_SIZES.some((size) => compactCode(size) === compactCode(item[0]))) ?? sizeMatches[sizeMatches.length - 1];
  if (!sizeMatch || sizeMatch.index == null) return null;
  const size = normalizeBordoSize(sizeMatch[0]);
  const after = raw.slice(sizeMatch.index + sizeMatch[0].length).trim();
  if (after && /^\d{4,}$/.test(after)) article = article || after;
  else if (after) color = color || after.replace(/^\((.*)\)$/, "$1").trim();
  const head = raw.slice(0, sizeMatch.index).trim();
  const tokens = head.split(/\s+/).filter(Boolean);
  if (tokens[0] && /^(bordo|бордо)$/i.test(tokens[0])) tokens.shift();
  if (tokens.length < 2) return null;
  const factoryCode = tokens[0];
  const rest = tokens.slice(1);
  let groupCode = "";
  let productTokens = rest;
  if (rest.length >= 2 && /^\d{3,6}$/.test(rest[0])) {
    groupCode = rest[0];
    productTokens = rest.slice(1);
  }
  while (productTokens.length >= 2 && /^\d{4,}$/.test(productTokens[productTokens.length - 1])) {
    productTokens = productTokens.slice(0, -1);
  }
  // "088 R5" → productCode=088, model=R5 (rang emas — parent kartochka bo‘lib qolsin).
  if (productTokens.length >= 2 && /^R-?\d+$/i.test(productTokens[productTokens.length - 1])) {
    model = productTokens[productTokens.length - 1].toUpperCase().replace(/^R-/i, "R");
    productTokens = productTokens.slice(0, -1);
  }
  const productCode = productTokens.join(" ");
  if (!productCode) return null;
  return { factoryCode, groupCode, productCode, size, color, model, article };
}

function sameFactoryLabel(left: string, right: string) {
  const a = left.trim();
  const b = right.trim();
  if (!a || !b) return false;
  if (a.localeCompare(b, "ru", { sensitivity: "accent" }) === 0) return true;
  return compactCode(a) === compactCode(b);
}

export function productBelongsToFactory(product: { name: string; factory: string | null }, factoryCode: string, factoryName: string) {
  const parts = parseBordoName(product.name);
  if (parts?.factoryCode) {
    if (factoryCode.trim() && sameFactoryCode(parts.factoryCode, factoryCode)) return true;
    if (factoryName.trim() && sameFactoryLabel(parts.factoryCode, factoryName)) return true;
  }
  const supplier = (product.factory || "").trim();
  if (supplier) {
    if (factoryName.trim() && sameFactoryLabel(supplier, factoryName)) return true;
    if (factoryCode.trim() && (sameFactoryLabel(supplier, factoryCode) || sameFactoryCode(supplier, factoryCode))) return true;
    const code = canonicalFactoryCode(factoryCode);
    if (code && /^\d{3,6}$/.test(code) && lastNumericToken(supplier) === code) return true;
  }
  return false;
}

export function folderLabel(row: { name?: string; pathName?: string }) {
  const name = (row.name || "").trim();
  const pathName = (row.pathName || "").trim();
  if (!pathName || pathName === name) return name;
  if (pathName.endsWith(name) || pathName.endsWith(`/${name}`)) return pathName;
  return `${pathName}/${name}`;
}

export function matchProductFolder<T extends { name: string; pathName?: string }>(folders: T[], groupCode: string): T | null {
  const code = groupCode.trim();
  if (code.length < 3) return null;
  const folded = code.toLocaleUpperCase("ru-RU");
  const hits = folders.filter((folder) => folder.name.trim().toLocaleUpperCase("ru-RU") === folded || lastNumericToken(folder.name) === code);
  if (hits.length === 1) return hits[0];
  if (!hits.length) return null;
  const named = hits.filter((folder) => folder.name.trim().toLocaleUpperCase("ru-RU") === folded);
  if (named.length === 1) return named[0];
  const pool = named.length ? named : hits;
  const shortest = Math.min(...pool.map((folder) => folder.name.length));
  const names = pool.filter((folder) => folder.name.length === shortest);
  return names.length === 1 ? names[0] : names[0] ?? null;
}

function isParentCard(product: { name: string }) {
  const parts = parseBordoName(product.name);
  if (parts?.color) return false;
  return !/\([^)]*\)\s*$/.test(product.name);
}

/** Parent-kartochkalar: asosiy kod bo‘yicha indeks — har safar to‘liq katalog filterlamaslik (GET 504). */
let waybillIndexCatalog: Catalog | null = null;
let waybillByCore = new Map<string, CatalogProduct[]>();

function waybillIndexFor(catalog: Catalog) {
  if (waybillIndexCatalog === catalog) return waybillByCore;
  const next = new Map<string, CatalogProduct[]>();
  const add = (key: string, product: CatalogProduct) => {
    if (!key) return;
    const bucket = next.get(key);
    if (bucket) bucket.push(product);
    else next.set(key, [product]);
  };
  for (const product of catalog.products) {
    if (!isParentCard(product)) continue;
    const parts = parseBordoName(product.name);
    if (parts?.productCode) add(coreProductCode(parts.productCode), product);
    if (product.code) add(coreProductCode(product.code), product);
    if (product.article) add(coreProductCode(product.article), product);
  }
  waybillIndexCatalog = catalog;
  waybillByCore = next;
  return next;
}

export function listWaybillProducts(
  catalog: Catalog,
  input: { factoryCode: string; factoryName: string; productCode: string; size?: string; groupCode?: string; article?: string },
): CatalogProduct[] {
  const code = input.productCode.trim();
  const size = input.size?.trim() || "";
  const group = input.groupCode?.trim() || "";
  const wantedArticle = compactCode(input.article || "");
  if (!code) return [];
  const core = coreProductCode(code);
  // To‘liq katalog fallback yo‘q — GET/matches 504 bermasin. Indeks miss = bo‘sh.
  const pool = waybillIndexFor(catalog).get(core) ?? [];
  if (!pool.length) return [];
  const seen = new Set<string>();
  const rows: CatalogProduct[] = [];
  for (const product of pool) {
    if (seen.has(product.id)) continue;
    seen.add(product.id);
    if (!isParentCard(product)) continue;
    if (!productBelongsToFactory(product, input.factoryCode, input.factoryName)) continue;
    const parts = parseBordoName(product.name);
    const cardArticle = bordoIdentityArticle(product.name, product.article, code || parts?.productCode || "");
    // Artikul bo‘sh ≠ 43937 — lekin MS article=productCode (289) dublikat ochirmasin.
    if (cardArticle !== wantedArticle) continue;
    if (parts) {
      if (!productCodeMatches(parts.productCode, code)) continue;
      if (size && compactCode(parts.size) !== compactCode(size)) continue;
      if (group) {
        if (!parts.groupCode || !sameToken(parts.groupCode, group)) continue;
      }
      rows.push(product);
      continue;
    }
    // Parse bo‘lmasa faqat code/article aniq tengligi — wholeToken bilan 277→eski tovar xatosi bo‘lmasin.
    const byIdentity = sameProductCode(product.code || "", code) || sameProductCode(product.article || "", code);
    if (!byIdentity) continue;
    if (size && !nameHasSize(product.name, size)) continue;
    if (group && lastNumericToken(product.name) !== group && lastNumericToken(product.category || "") !== group) continue;
    rows.push(product);
  }
  if (!group) return rows;
  return rows.filter((product) => {
    const parts = parseBordoName(product.name);
    return parts ? sameToken(parts.groupCode, group) : lastNumericToken(product.name) === group || lastNumericToken(product.category || "") === group;
  });
}

function establishedCardScore(product: CatalogProduct) {
  let score = 0;
  if (product.cost && product.cost > 0) score += 8;
  // Faqat HAQIQIY qo‘shimcha artikul (43937) — product code nusxasi emas.
  if (bordoIdentityArticle(product.name, product.article, product.code || "")) score += 6;
  if ((product.stock || 0) > 0) score += 4;
  if ((product.stock || 0) >= 50) score += 3;
  if ((product.barcodes || []).some((code) => code && !/^200\d{10}$/.test(code))) score += 3;
  const code = String(product.code || "").trim();
  // MoySklad auto-code (1284399…) yangi dublikatlarda — eski/barcode kodlar afzal.
  if (code && !/^128\d{7,}$/.test(code)) score += 8;
  if (code && code.length <= 6) score += 2;
  if (code && code.length >= 10 && !/^128\d{7,}$/.test(code) && !/^200\d{10}$/.test(code)) score += 4;
  return score;
}

export function pickPassport(
  rows: CatalogProduct[],
  prefer?: { groupCode?: string; productCode?: string },
): { id: string; name: string } | null {
  if (!rows.length) return null;
  if (rows.length === 1) return { id: rows[0].id, name: rows[0].name };
  // Identity: factory + guruh + asosiy kod + razmer (bir xil guruhdagi twinlar — yangi ochilmasin).
  const keys = new Set(
    rows.map((row) => {
      const p = parseBordoName(row.name);
      if (!p) return foldProductName(row.name);
      return [
        canonicalFactoryCode(p.factoryCode),
        compactCode(p.groupCode),
        coreProductCode(p.productCode),
        compactCode(p.size),
        bordoIdentityArticle(row.name, row.article, p.productCode),
      ].join("|");
    }),
  );
  if (keys.size !== 1) return null;
  const wantedGroup = prefer?.groupCode?.trim() || "";
  const wantedModel = productModelToken(prefer?.productCode || "");
  const best = [...rows].sort((a, b) => {
    const aEst = establishedCardScore(a);
    const bEst = establishedCardScore(b);
    if (bEst !== aEst) return bEst - aEst;
    const pa = parseBordoName(a.name);
    const pb = parseBordoName(b.name);
    if (wantedModel) {
      const aM = Number(Boolean(pa?.model && pa.model.toUpperCase() === wantedModel));
      const bM = Number(Boolean(pb?.model && pb.model.toUpperCase() === wantedModel));
      if (bM !== aM) return bM - aM;
    }
    if (wantedGroup) {
      const aG = Number(Boolean(pa?.groupCode && sameToken(pa.groupCode, wantedGroup)));
      const bG = Number(Boolean(pb?.groupCode && sameToken(pb.groupCode, wantedGroup)));
      if (bG !== aG) return bG - aG;
    }
    if ((b.stock || 0) !== (a.stock || 0)) return (b.stock || 0) - (a.stock || 0);
    return a.name.length - b.name.length;
  })[0];
  return best ? { id: best.id, name: best.name } : null;
}

/** Markup meros uchun: identity bog‘lamaydi, faqat foizlarni olish. */
export function pickSibling(rows: CatalogProduct[]): { id: string; name: string } | null {
  if (!rows.length) return null;
  if (rows.length === 1) return { id: rows[0].id, name: rows[0].name };
  const withGroup = rows.filter((product) => Boolean(parseBordoName(product.name)?.groupCode));
  const pool = withGroup.length ? withGroup : rows;
  const chosen = [...pool].sort((a, b) => b.name.length - a.name.length || b.stock - a.stock)[0];
  return chosen ? { id: chosen.id, name: chosen.name } : null;
}

export function matchWaybillProduct(
  catalog: Catalog,
  input: { factoryCode: string; factoryName: string; productCode: string; size: string; groupCode?: string; article?: string },
): { id: string; name: string } | null {
  const code = input.productCode.trim();
  if (!code) return null;
  // Aniq factory + guruh + kod + razmer + artikul. Artikul farqi — yangi kartochka.
  return pickPassport(listWaybillProducts(catalog, input), {
    groupCode: input.groupCode,
    productCode: input.productCode,
  });
}

export function matchNamedProducts(
  rows: Array<{ id: string; name: string; factory?: string | null; article?: string | null }>,
  input: { factoryCode: string; factoryName: string; productCode: string; size: string; groupCode?: string; article?: string },
): { id: string; name: string } | null {
  return matchWaybillProduct(
    { products: rows.map((row) => emptyProduct({ id: row.id, name: row.name, factory: row.factory ?? null, article: row.article ?? null })) } as Catalog,
    input,
  );
}

export function findProductsByBarcode(catalog: Catalog, raw: string): CatalogProduct[] {
  if (indexedCatalog !== catalog) {
    const next = new Map<string, CatalogProduct[]>();
    for (const product of catalog.products) {
      const values = [product.code, product.article, ...product.barcodes].filter((value): value is string => !!value);
      for (const value of values) {
        for (const key of indexKeys(value)) {
          const list = next.get(key);
          if (list) {
            if (!list.some((item) => item.id === product.id)) list.push(product);
          } else next.set(key, [product]);
        }
      }
    }
    barcodeIndex = next;
    indexedCatalog = catalog;
  }
  const found = new Map<string, CatalogProduct>();
  for (const key of lookupKeys(raw)) {
    for (const product of barcodeIndex.get(key) ?? []) found.set(product.id, product);
  }
  return [...found.values()];
}

function labelTokens(value: string): string[] {
  const normalized = value.toLowerCase().replace(/[–—]/g, "-");
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/\d{2}-\d{2}/g)) tokens.add(match[0]);
  const withoutSizes = normalized.replace(/\d{2}-\d{2}/g, " ");
  for (const match of withoutSizes.matchAll(/\d+/g)) {
    if (match[0].length >= 3 && match[0].length <= 6) tokens.add(match[0]);
  }
  return [...tokens];
}

let nameCatalog: Catalog | null = null;
let nameIndex = new Map<string, CatalogProduct[]>();

function nameIndexFor(catalog: Catalog) {
  if (nameCatalog === catalog) return nameIndex;
  const next = new Map<string, CatalogProduct[]>();
  for (const product of catalog.products) {
    const tokens = labelTokens(`${product.name} ${product.article ?? ""}`);
    for (const token of tokens) {
      const list = next.get(token);
      if (list) {
        if (!list.some((item) => item.id === product.id)) list.push(product);
      } else next.set(token, [product]);
    }
  }
  nameIndex = next;
  nameCatalog = catalog;
  return next;
}

export function findProductsByLabel(catalog: Catalog, raw: string): { products: CatalogProduct[]; label: string } {
  const index = nameIndexFor(catalog);
  const tokens = labelTokens(raw);
  const useful = tokens.filter((token) => (index.get(token)?.length ?? 0) > 0);
  if (useful.length < 2) return { products: [], label: "" };
  let ids: Set<string> | null = null;
  const byId = new Map<string, CatalogProduct>();
  for (const token of useful) {
    const list = index.get(token) ?? [];
    for (const product of list) byId.set(product.id, product);
    const next = new Set(list.map((product) => product.id));
    ids = ids === null ? next : new Set([...ids].filter((id) => next.has(id)));
    if (ids.size === 0) return { products: [], label: "" };
  }
  if (ids && ids.size > 1 && useful.length < 3) return { products: [], label: "" };
  if (!ids || ids.size === 0 || ids.size > 6) return { products: [], label: "" };
  const products = [...ids].map((id) => byId.get(id)).filter((product): product is CatalogProduct => !!product);
  return { products, label: useful.join(" ") };
}

function eanCheck(code: string) {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop() ?? -1;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) sum += digits[digits.length - 1 - i] * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === check;
}

export function resolveScan(catalog: Catalog, code: string, text: string): { barcode: string; products: CatalogProduct[] } {
  const clean = code.trim();
  if (clean) {
    const products = findProductsByBarcode(catalog, clean);
    if (products.length) return { barcode: clean, products };
    const runs = [...new Set(clean.match(/\d{8,14}/g) ?? [])];
    const ordered = [...runs.filter(eanCheck), ...runs.filter((value) => !eanCheck(value))];
    for (const run of ordered) {
      const extra = findProductsByBarcode(catalog, run);
      if (extra.length) return { barcode: run, products: extra };
    }
  }
  const label = findProductsByLabel(catalog, `${text} ${clean}`);
  return { barcode: label.label || clean, products: label.products };
}

let scanIndexCatalog: Catalog | null = null;
let scanIndexBody: { loadedAt: string; products: unknown[] } | null = null;

export function scanIndex(catalog: Catalog) {
  if (catalog.products.length === 0) return { loadedAt: catalog.loadedAt, products: [] };
  if (scanIndexCatalog === catalog && scanIndexBody) return scanIndexBody;
  const places = new Map<string, Array<{ productId: string; warehouseName: string; quantity: number; inTransit: number }>>();
  for (const row of catalog.stockRows) {
    if (row.quantity <= 0 && row.inTransit <= 0) continue;
    const list = places.get(row.product.id) ?? [];
    if (list.length >= 3 && list.every((item) => item.quantity >= row.quantity)) continue;
    list.push({ productId: row.product.id, warehouseName: row.warehouse.name, quantity: row.quantity, inTransit: row.inTransit });
    list.sort((a, b) => b.quantity - a.quantity);
    if (list.length > 3) list.length = 3;
    places.set(row.product.id, list);
  }
  const body = {
    loadedAt: catalog.loadedAt,
    products: catalog.products.map((product) => ({
      id: product.id,
      name: product.name,
      code: product.code,
      article: product.article,
      barcodes: product.barcodes,
      imageUrl: product.imageUrl,
      stock: product.stock,
      salePrice: product.salePrice,
      stockStatus: product.stockStatus,
      locations: places.get(product.id) ?? [],
    })),
  };
  scanIndexCatalog = catalog;
  scanIndexBody = body;
  return body;
}
