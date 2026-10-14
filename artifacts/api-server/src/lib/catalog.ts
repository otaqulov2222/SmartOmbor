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
    return { ...raw, imageHrefs: new Map(raw.imageHrefs ?? []) };
  } catch {
    return null;
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
  if (supplierIds.size > 0) {
    const directory = await supplierDirectory();
    for (const [productId, supplierId] of supplierIds) {
      const name = directory.get(supplierId);
      const product = products.get(productId);
      if (product && name) product.factory = name;
    }
  }

  const imageHrefs = new Map<string, string>();
  const stock = await moyskladAll<StockRow>("/report/stock/all");
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
  const sales7 = await salesQuantities(7).catch((error: unknown) => {
    logger.warn({ err: error }, "MoySklad 7-day sales skipped");
    return null;
  });
  const sales30 = await salesQuantities(30).catch((error: unknown) => {
    logger.warn({ err: error }, "MoySklad 30-day sales skipped");
    return null;
  });
  const sales90 = await salesQuantities(90).catch((error: unknown) => {
    logger.warn({ err: error }, "MoySklad 90-day sales skipped");
    return null;
  });
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

  const byStore = await moyskladAll<ByStoreRow>("/report/stock/bystore");
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
  const [demands, supplies, moves, suppliesRecent, movesRecent, inventories] = await Promise.all([
    moysklad<{ meta: { size: number }; rows: DocRow[] }>(`/entity/demand?limit=100&filter=${filter}`),
    moysklad<{ meta: { size: number }; rows: DocRow[] }>(`/entity/supply?limit=100&filter=${filter}`),
    moysklad<{ meta: { size: number } }>("/entity/move?limit=1&filter=applicable=false"),
    moysklad<{ rows: DocRow[] }>("/entity/supply?limit=100&order=moment,desc&expand=agent"),
    moysklad<{ rows: DocRow[] }>("/entity/move?limit=100&order=moment,desc"),
    moysklad<{ rows: DocRow[] }>("/entity/inventory?limit=100&order=moment,desc"),
  ]);

  const documents: CatalogDocument[] = [
    ...suppliesRecent.rows.map((row) => toDocument(row, "receipt", warehouseById)),
    ...movesRecent.rows.map((row) => toDocument(row, "transfer", warehouseById)),
    ...inventories.rows.map((row) => toDocument(row, "inventory", warehouseById)),
  ].sort((a, b) => b.date.localeCompare(a.date));

  const catalog: Catalog = {
    companyName: organization.rows[0]?.name ?? null,
    loadedAt: new Date().toISOString(),
    productCount: products.size,
    products: [...products.values()].sort((a, b) => a.name.localeCompare(b.name, "uz")),
    warehouses,
    stockRows,
    documents,
    salesToday: demands.rows.reduce((sum, row) => sum + (money(row.sum) ?? 0), 0),
    incomingToday: supplies.meta.size,
    pendingTransfers: moves.meta.size,
    error: null,
    imageHrefs,
    salesCoverage,
  };

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
  pending = build()
    .then((next) => {
      if (stamp === epoch) remember(next);
      if (stamp === epoch) pending = null;
      return next;
    })
    .catch((error: unknown) => {
      if (stamp === epoch) pending = null;
      throw error instanceof Error ? error : new MoySkladError("MoySklad sync failed", 502);
    });
  return pending;
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
  return pending ?? startBuild();
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

function compactCode(value: string): string {
  return value.trim().replace(/[\s-]/g, "").toLowerCase();
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
  return [...keys];
}

let indexedCatalog: Catalog | null = null;
let barcodeIndex = new Map<string, CatalogProduct[]>();

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
  if (tokens.length < 2) return { products: [], label: "" };
  let ids: Set<string> | null = null;
  const byId = new Map<string, CatalogProduct>();
  for (const token of tokens) {
    const list = index.get(token) ?? [];
    for (const product of list) byId.set(product.id, product);
    const next = new Set(list.map((product) => product.id));
    ids = ids === null ? next : new Set([...ids].filter((id) => next.has(id)));
    if (ids.size === 0) return { products: [], label: "" };
  }
  if (!ids || ids.size === 0 || ids.size > 6) return { products: [], label: "" };
  const products = [...ids].map((id) => byId.get(id)).filter((product): product is CatalogProduct => !!product);
  return { products, label: tokens.join(" ") };
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
