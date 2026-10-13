import { randomUUID } from "node:crypto";
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
  supplier?: { name?: string };
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
  store?: MetaRef;
  sourceStore?: MetaRef;
  targetStore?: MetaRef;
  positions?: { meta?: { size?: number } };
  meta?: { href?: string };
}

const LOW_STOCK = 3;
let cache: Catalog | null = null;
let pending: Promise<Catalog> | null = null;

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
  for (const row of productPage.rows) {
    if (row.archived) continue;
    const id = row.id || idFromHref(row.meta?.href);
    if (!id) continue;
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

  const salesTo = new Date();
  const salesFrom = new Date();
  salesFrom.setDate(salesTo.getDate() - 29);
  const momentFrom = `${salesFrom.toISOString().slice(0, 10)} 00:00:00`;
  const momentTo = `${salesTo.toISOString().slice(0, 10)} 23:59:59`;
  try {
    const profit = await moyskladAll<{ assortment?: { meta?: { href?: string } }; sellQuantity?: number }>(
      `/report/profit/byproduct?momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}`,
    );
    const sold = new Set<string>();
    for (const row of profit.rows) {
      const id = idFromHref(row.assortment?.meta?.href);
      const product = products.get(id);
      if (!product) continue;
      product.sales30 = row.sellQuantity ?? 0;
      sold.add(id);
    }
    for (const product of products.values()) {
      if (!sold.has(product.id)) product.sales30 = 0;
      product.stockStatus = stockStatus(product.stock, product.daysCover, product.sales30, true);
    }
  } catch (error) {
    logger.warn({ err: error }, "MoySklad profit report skipped");
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
    moysklad<{ rows: DocRow[] }>("/entity/supply?limit=100&order=moment,desc"),
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
    sourceWarehouse: storeName(warehouses, kind === "transfer" ? row.sourceStore : row.store),
    targetWarehouse: kind === "transfer" ? storeName(warehouses, row.targetStore) : null,
    itemCount: row.positions?.meta?.size ?? 0,
    moyskladId: row.id || idFromHref(row.meta?.href) || null,
  };
}

export async function loadCatalog(force = false): Promise<Catalog> {
  if (pending) return pending;
  if (!force && cache) return cache;
  pending = build()
    .then((next) => {
      cache = next;
      pending = null;
      return next;
    })
    .catch((error: unknown) => {
      pending = null;
      if (cache && !force) return cache;
      throw error instanceof Error ? error : new MoySkladError("MoySklad sync failed", 502);
    });
  return pending;
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
    if (match[0].length >= 4 && match[0].length <= 6) tokens.add(match[0]);
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
  let bestToken = "";
  let best: CatalogProduct[] | undefined;
  for (const token of tokens) {
    const list = index.get(token);
    if (!list?.length || list.length > 3) continue;
    const strong = /^\d{5,6}$/.test(token);
    if (!strong && list.length !== 1) continue;
    if (!best || list.length < best.length || (list.length === best.length && token.length > bestToken.length)) {
      best = list;
      bestToken = token;
    }
  }
  if (!best || !bestToken) return { products: [], label: "" };
  if (best.length === 1 && !/^\d{5,6}$/.test(bestToken)) {
    const supported = tokens.some((token) => token !== bestToken && (index.get(token) ?? []).some((product) => product.id === best![0].id));
    if (!supported) return { products: [], label: "" };
  }
  if (best.length > 1 && !/^\d{5,6}$/.test(bestToken)) return { products: [], label: "" };
  const name = best.length === 1 ? best[0].name.toLowerCase() : "";
  const label = best.length === 1
    ? labelTokens(best[0].name).sort((a, b) => name.indexOf(a) - name.indexOf(b)).join(" ")
    : bestToken;
  return { products: best, label };
}

export function resolveScan(catalog: Catalog, code: string, text: string): { barcode: string; products: CatalogProduct[] } {
  const clean = code.trim();
  if (clean) {
    const products = findProductsByBarcode(catalog, clean);
    if (products.length) return { barcode: clean, products };
  }
  const label = findProductsByLabel(catalog, `${text} ${clean}`);
  return { barcode: label.label || clean, products: label.products };
}
