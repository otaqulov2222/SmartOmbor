import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

function remember(next: Catalog) {
  cache = next;
  try {
    mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.tmp`;
    const body = {
      ...next,
      imageHrefs: [...next.imageHrefs.entries()],
    };
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, CACHE_FILE);
  } catch (error) {
    logger.warn({ err: error }, "Catalog cache was not saved");
  }
}

function recall(): Catalog | null {
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Catalog & { imageHrefs: Array<[string, string]> };
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
  for (const row of productPage.rows) {
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
  if (!cache) cache = recall();
  if (!force && cache) return cache;
  try {
    return await (pending ?? startBuild());
  } catch (error) {
    if (!cache) cache = recall();
    if (cache) {
      logger.warn({ err: error }, "MoySklad refresh failed; keeping saved catalog");
      return cache;
    }
    throw error;
  }
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
  const current = cache ?? recall();
  const product = current?.products.find((item) => item.id === id);
  if (!current || !product) return;
  Object.assign(product, patch);
  indexedCatalog = null;
  nameCatalog = null;
  remember(current);
}

export function applyReceiptStock(entries: Array<{ productId: string; warehouseId: string; quantity: number }>) {
  const current = cache ?? recall();
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
  const current = cache ?? recall();
  if (!current || current.products.some((item) => item.id === product.id)) return;
  current.products.unshift(product);
  current.productCount = current.products.length;
  indexedCatalog = null;
  nameCatalog = null;
  remember(current);
}

export function peekCatalog(): Catalog | null {
  if (!cache) cache = recall();
  return cache;
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

export function normalizeBordoCode(value: string): string {
  return foldGlyphs(value).trim().replace(/\s+/g, " ").toLocaleUpperCase("en-US");
}

export const BORDO_SIZES = ["20-23", "20-25", "22-27", "24-29", "30-35", "36-40", "40-44", "41-43"] as const;

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

function codeTokens(value: string) {
  return normalizeBordoCode(value).split(" ").filter(Boolean).map(compactCode).filter(Boolean);
}

function tokensPrefixed(longer: string[], shorter: string[]) {
  return shorter.length > 0 && shorter.every((token, i) => token === longer[i]);
}

function distinctiveCode(tokens: string[]) {
  return tokens.some((token) => token.length >= 2 || /^\d/.test(token));
}

export function productCodeMatches(nameCode: string, typed: string) {
  if (sameProductCode(nameCode, typed)) return true;
  const named = codeTokens(nameCode);
  const want = codeTokens(typed);
  if (!named.length || !want.length) return false;
  if (named.length >= want.length && tokensPrefixed(named, want)) return distinctiveCode(want);
  if (want.length >= named.length && tokensPrefixed(want, named)) return distinctiveCode(named);
  return false;
}

export function foldProductName(value: string) {
  return normalizeBordoCode(value).replace(/\s+\d{4,}$/, "");
}

export function sameBordoCard(
  name: string,
  input: { factoryCode: string; productCode: string; size: string; groupCode?: string },
) {
  const parts = parseBordoName(name);
  if (!parts) return false;
  if (parts.color) return false;
  if (!sameFactoryCode(parts.factoryCode, input.factoryCode)) return false;
  if (!productCodeMatches(parts.productCode, input.productCode)) return false;
  if (input.size.trim() && compactCode(parts.size) !== compactCode(normalizeBordoSize(input.size))) return false;
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

export function parseBordoName(name: string): { factoryCode: string; groupCode: string; productCode: string; size: string; color: string } | null {
  let raw = foldGlyphs(name).trim().replace(/\s+/g, " ");
  let color = "";
  const paren = raw.match(/\(([^)]+)\)\s*$/);
  if (paren && paren.index != null) {
    color = paren[1].trim();
    raw = raw.slice(0, paren.index).trim();
  }
  const tail = raw.match(/\s+(R-?\d+)\s*$/i);
  if (tail && tail.index != null) {
    color = color || tail[1];
    raw = raw.slice(0, tail.index).trim();
  }
  raw = raw.replace(/\s+\d{4,}$/, "");
  const sizeMatches = [...raw.matchAll(/\d{1,2}-\d{1,2}/g)];
  const sizeMatch = [...sizeMatches].reverse().find((item) => BORDO_SIZES.some((size) => compactCode(size) === compactCode(item[0]))) ?? sizeMatches[sizeMatches.length - 1];
  if (!sizeMatch || sizeMatch.index == null) return null;
  const size = normalizeBordoSize(sizeMatch[0]);
  const after = raw.slice(sizeMatch.index + size.length).trim();
  if (after && !/^\d{4,}$/.test(after)) color = color || after.replace(/^\((.*)\)$/, "$1").trim();
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
  const productCode = productTokens.join(" ");
  if (!productCode) return null;
  return { factoryCode, groupCode, productCode, size, color };
}

export function productBelongsToFactory(product: { name: string; factory: string | null }, factoryCode: string, factoryName: string) {
  const factory = (product.factory || "").trim().toLowerCase();
  const label = factoryName.trim().toLowerCase();
  if (label && factory && (factory === label || factory.includes(label) || label.includes(factory))) return true;
  const code = factoryCode.trim().toLowerCase();
  const parts = parseBordoName(product.name);
  if (code && parts && sameFactoryCode(parts.factoryCode, code)) return true;
  return code.length >= 3 && wholeToken(`${product.factory || ""} ${product.name}`.toLowerCase(), code);
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

export function listWaybillProducts(
  catalog: Catalog,
  input: { factoryCode: string; factoryName: string; productCode: string; size?: string; groupCode?: string },
): CatalogProduct[] {
  const code = input.productCode.trim();
  const size = input.size?.trim() || "";
  const group = input.groupCode?.trim() || "";
  if (!code) return [];
  const rows = catalog.products.filter((product) => {
    if (!isParentCard(product)) return false;
    if (!productBelongsToFactory(product, input.factoryCode, input.factoryName)) return false;
    const parts = parseBordoName(product.name);
    if (parts) {
      if (!productCodeMatches(parts.productCode, code)) return false;
      if (size && compactCode(parts.size) !== compactCode(size)) return false;
      if (group && parts.groupCode && !sameToken(parts.groupCode, group)) return false;
      if (group && !parts.groupCode && lastNumericToken(product.category || "") !== group) return false;
      return true;
    }
    const byIdentity = sameProductCode(product.code || "", code) || sameProductCode(product.article || "", code);
    const byName = wholeToken(product.name, code, 1) || productCodeMatches(product.name, code);
    if (!byIdentity && !byName) return false;
    if (size && !nameHasSize(product.name, size)) return false;
    if (group && lastNumericToken(product.name) !== group && lastNumericToken(product.category || "") !== group && !wholeToken(product.name, group)) return false;
    return true;
  });
  if (!group) return rows;
  const exact = rows.filter((product) => {
    const parts = parseBordoName(product.name);
    return parts ? sameToken(parts.groupCode, group) : lastNumericToken(product.name) === group || lastNumericToken(product.category || "") === group;
  });
  return exact;
}

export function pickPassport(rows: CatalogProduct[]): { id: string; name: string } | null {
  if (!rows.length) return null;
  if (rows.length === 1) return { id: rows[0].id, name: rows[0].name };
  const withGroup = rows.filter((product) => Boolean(parseBordoName(product.name)?.groupCode));
  const pool = withGroup.length ? withGroup : rows;
  const chosen = [...pool].sort((a, b) => b.name.length - a.name.length || b.stock - a.stock)[0];
  return chosen ? { id: chosen.id, name: chosen.name } : null;
}

export function matchWaybillProduct(
  catalog: Catalog,
  input: { factoryCode: string; factoryName: string; productCode: string; size: string; groupCode?: string },
): { id: string; name: string } | null {
  const code = input.productCode.trim();
  if (!code) return null;
  const group = input.groupCode?.trim() || "";
  const exact = listWaybillProducts(catalog, input);
  const hit = pickPassport(exact);
  if (hit || !group) return hit;
  const typed = group.toLowerCase();
  const loose = listWaybillProducts(catalog, { ...input, groupCode: "" }).filter((product) => {
    const other = (parseBordoName(product.name)?.groupCode || "").toLowerCase();
    if (!other) return true;
    return other !== typed && !other.startsWith(typed) && !typed.startsWith(other);
  });
  const withGroup = loose.filter((product) => Boolean(parseBordoName(product.name)?.groupCode));
  const ungrouped = loose.filter((product) => !parseBordoName(product.name)?.groupCode);
  return pickPassport(withGroup.length ? withGroup : ungrouped);
}

export function matchNamedProducts(
  rows: Array<{ id: string; name: string; factory?: string | null }>,
  input: { factoryCode: string; factoryName: string; productCode: string; size: string; groupCode?: string },
): { id: string; name: string } | null {
  return matchWaybillProduct(
    { products: rows.map((row) => emptyProduct({ id: row.id, name: row.name, factory: row.factory ?? input.factoryName })) } as Catalog,
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
