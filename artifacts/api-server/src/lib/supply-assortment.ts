import { matchNamedProducts, matchProductFolder, matchWaybillProduct, parseBordoName, type Catalog } from "./catalog";
import { loadMarkup, markedSale } from "./markup";
import type { ShipmentLine } from "./partners";
import { logger } from "./logger";
import { MoySkladError, moysklad, moyskladSend, permissionDenied } from "./moysklad";

const BASE = "https://api.moysklad.ru/api/remap/1.2";
const SALE_TYPES = ["Exclusive", "Premium", "Standard"];
const PIECE_UOM = "19f1edc0-fc42-4001-94cb-c9ec9c62ec10";
const PACHKA_UOM = "2061e032-0683-11f1-0a80-00e70010dbf7";

type Meta = { href: string; type: string; mediaType: string };

type Price = { value?: number; currency?: { meta: Meta }; priceType?: { meta?: Meta; name?: string } };

type ProductRow = {
  id: string;
  name?: string;
  code?: string;
  article?: string;
  meta: Meta;
  salePrices?: Price[];
  folderName?: string;
  barcodes?: string[];
};

type VariantRow = {
  id: string;
  name?: string;
  code?: string;
  meta?: Meta;
  characteristics?: Array<{ name?: string; value?: string }>;
  product?: { meta?: { href?: string } };
};

export type SupplyPosition = {
  quantity: number;
  price: number;
  assortment: { meta: Meta };
  stockId: string;
  pack?: { id: string; quantity: number; uom: { meta: Meta } };
};

type Planned = {
  positions: SupplyPosition[];
  links: Array<{ lineId: string; product: { id: string; name: string } }>;
  created: ProductRow[];
};

function entityMeta(href: string, type: string): Meta {
  return { href, type, mediaType: "application/json" };
}

function uomMeta(id: string): Meta {
  return entityMeta(`${BASE}/entity/uom/${id}`, "uom");
}

type GoodsPack = { id: string; quantity: number; uom?: { meta?: Meta; name?: string } };

function packBody(pack: GoodsPack, quantity = pack.quantity) {
  return { id: pack.id, quantity, uom: { meta: pack.uom?.meta ?? uomMeta(PACHKA_UOM) } };
}

export function isPachkaPack(pack: { uom?: { meta?: { href?: string }; name?: string } }) {
  const href = pack.uom?.meta?.href || "";
  if (href.includes(PACHKA_UOM)) return true;
  const name = (pack.uom?.name || "").trim().toLowerCase();
  return name === "pachka" || name === "пачка" || name === "pack";
}

export async function ensurePachka(productId: string, packSize: number): Promise<GoodsPack | null> {
  try {
    const current = await moysklad<{ uom?: { meta?: Meta }; packs?: GoodsPack[] }>(`/entity/product/${productId}?expand=packs.uom,uom`);
    const packs = current.packs ?? [];
    const pachka = packs.find((pack) => isPachkaPack(pack));
    if (!(packSize > 1)) {
      if (!current.uom) await optionalWrite(() => moyskladSend(`/entity/product/${productId}`, { uom: { meta: uomMeta(PIECE_UOM) } }, "PUT"), "MoySklad uom skipped", { productId });
      return null;
    }
    if (pachka?.id && pachka.quantity === packSize && current.uom && pachka.uom?.meta) return pachka;
    const next = packs
      .filter((pack) => pack.id && pack.id !== pachka?.id)
      .map((pack) => packBody(pack));
    if (packSize > 1) next.push(pachka?.id ? packBody(pachka, packSize) : { quantity: packSize, uom: { meta: uomMeta(PACHKA_UOM) } });
    const updated = await moyskladSend<{ packs?: GoodsPack[] }>(`/entity/product/${productId}`, {
      ...(current.uom ? {} : { uom: { meta: uomMeta(PIECE_UOM) } }),
      ...(next.length ? { packs: next } : {}),
    }, "PUT");
    const saved = (updated.packs ?? []).find((pack) => pack.quantity === packSize && pack.uom?.meta);
    if (saved?.id && saved.uom?.meta) return saved;
    const again = await moysklad<{ packs?: GoodsPack[] }>(`/entity/product/${productId}?expand=packs.uom`);
    return (again.packs ?? []).find((pack) => isPachkaPack(pack) && pack.quantity === packSize) ?? null;
  } catch (error) {
    if (!permissionDenied(error)) throw error;
    logger.warn({ productId, packSize, err: error instanceof Error ? error.message : error }, "MoySklad pack skipped");
    return null;
  }
}

export function pieceCount(line: Pick<ShipmentLine, "pairs" | "boxes" | "quantity" | "colors">): number {
  const pack = line.pairs > 0 ? line.pairs : 0;
  const colors = (line.colors ?? []).filter((color) => color.name?.trim() && color.quantity > 0);
  if (pack > 0 && colors.length) return colors.reduce((sum, color) => sum + color.quantity * pack, 0);
  if (pack > 0 && line.boxes > 0) return pack * line.boxes;
  return line.quantity > 0 ? line.quantity : pack;
}

export function receiptParts(line: Pick<ShipmentLine, "pairs" | "boxes" | "quantity" | "colors">): Array<{ color: string | null; quantity: number }> {
  const pack = line.pairs > 0 ? line.pairs : 0;
  const colors = (line.colors ?? []).filter((color) => color.name?.trim() && color.quantity > 0);
  if (pack > 0 && colors.length) return colors.map((color) => ({ color: color.name.trim(), quantity: color.quantity * pack }));
  const total = pieceCount(line);
  if (total <= 0) return [];
  return [{ color: null, quantity: total }];
}

function cardDescription(line: Pick<ShipmentLine, "model" | "note">) {
  return [line.model, line.note].map((value) => value.trim()).filter(Boolean).join(". ");
}

function requireWaybillLine(line: ShipmentLine) {
  const label = [line.productCode, line.size].filter((value) => value.trim()).join(" ") || "qator";
  if (!line.productCode.trim()) throw new MoySkladError("Mahsulot kodi kiritilmagan", 400);
  if (!line.size.trim()) throw new MoySkladError(`Razmer tanlanmagan (${label})`, 400);
  if (!(line.price > 0)) throw new MoySkladError(`Narx kiritilmagan (${label})`, 400);
  if (pieceCount(line) <= 0) throw new MoySkladError(`Miqdor yo‘q (${label})`, 400);
}

function asPriceTypes(raw: unknown): Array<{ name: string; meta: Meta }> {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { rows?: unknown[] })?.rows) ? (raw as { rows: unknown[] }).rows : [];
  return list.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as { name?: string; meta?: Partial<Meta> };
    if (!item.name?.trim() || !item.meta?.href) return [];
    return [{ name: item.name.trim(), meta: { href: item.meta.href, type: item.meta.type || "pricetype", mediaType: item.meta.mediaType || "application/json" } }];
  });
}

function samePriceType(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export async function writeProductCard(
  productId: string,
  som: number,
  priceType: string,
  currencyMeta: Meta,
  extras: { article?: string; supplierMeta?: Meta | null; description?: string; folderMeta?: Meta | null; packSize?: number; buySom?: number } = {},
) {
  if (!productId) return;
  const buy = extras.buySom != null && extras.buySom > 0 ? extras.buySom : som;
  const buyKopecks = buy > 0 ? Math.round(buy * 100) : 0;
  const kopecks = som > 0 ? Math.round(som * 100) : 0;
  let current: { salePrices?: Price[]; article?: string; description?: string; supplier?: { meta?: Meta }; uom?: { meta?: Meta }; productFolder?: { meta?: Meta } } = {};
  try {
    current = await moysklad(`/entity/product/${encodeURIComponent(productId)}?expand=salePrices.priceType,supplier,uom,productFolder`);
  } catch (error) {
    if (!permissionDenied(error) && !(error instanceof MoySkladError && error.status === 404)) throw error;
  }
  const article = extras.article?.trim();
  const description = extras.description?.trim();
  const card: Record<string, unknown> = {
    ...(buyKopecks > 0 ? { buyPrice: { value: buyKopecks, currency: { meta: currencyMeta } } } : {}),
    ...(article && !current.article?.trim() ? { article } : {}),
    ...(description && !current.description?.trim() ? { description } : {}),
    ...(extras.supplierMeta && !current.supplier?.meta?.href ? { supplier: { meta: extras.supplierMeta } } : {}),
    ...(extras.folderMeta && !current.productFolder?.meta?.href ? { productFolder: { meta: extras.folderMeta } } : {}),
    ...(!current.uom ? { uom: { meta: uomMeta(PIECE_UOM) } } : {}),
  };
  if (Object.keys(card).length) {
    await optionalWrite(
      () => moyskladSend(`/entity/product/${encodeURIComponent(productId)}`, card, "PUT"),
      "MoySklad product card skipped",
      { productId },
    );
  }
  if (extras.packSize && extras.packSize > 1) await ensurePachka(productId, extras.packSize);
  if (!(kopecks > 0) || !priceType) return;
  if (hasSaleMarkup(current.salePrices)) return;
  const listed = await listedPrices(current.salePrices, priceType, som, currencyMeta);
  if (!listed) {
    logger.warn({ productId, priceType }, "MoySklad Exclusive/sale price was not written");
    return;
  }
  await optionalWrite(
    () => moyskladSend(`/entity/product/${encodeURIComponent(productId)}`, { salePrices: priceBody(listed) }, "PUT"),
    "MoySklad sale prices skipped",
    { productId, priceType },
  );
}

function normalizeColor(value: string) {
  return value.trim().toLocaleUpperCase("ru-RU").replace(/[\s-]+/g, "").replace(/^Р/u, "R");
}

function sameColor(left: string, right: string) {
  return normalizeColor(left) === normalizeColor(right);
}

function variantColor(variant: VariantRow) {
  const chars = variant.characteristics ?? [];
  const named = chars.find((item) => /^(rang|цвет|color)$/i.test(item.name?.trim() || ""));
  if (named?.value?.trim()) return named.value.trim();
  if (chars[0]?.value?.trim()) return chars[0].value.trim();
  const fromName = (variant.name || "").match(/\(([^)]+)\)\s*$/);
  if (fromName?.[1]) return fromName[1].trim();
  const tail = (variant.name || "").match(/\s+(R-?\d+)\s*$/i);
  return tail?.[1]?.trim() || "";
}

let rangCharacteristic: { id: string; name: string; href: string } | null = null;

async function colorCharacteristic() {
  if (rangCharacteristic) return rangCharacteristic;
  try {
    const metadata = await moysklad<{ characteristics?: Array<{ id?: string; name?: string }> }>("/entity/variant/metadata");
    const found = (metadata.characteristics ?? []).find((item) => /^(rang|цвет|color)$/i.test(item.name?.trim() || "") && item.id && item.name);
    if (!found?.id || !found.name) return null;
    rangCharacteristic = { id: found.id, name: found.name, href: `${BASE}/entity/variant/metadata/characteristics/${found.id}` };
    return rangCharacteristic;
  } catch (error) {
    if (!permissionDenied(error)) throw error;
    logger.warn({ err: error instanceof Error ? error.message : error }, "MoySklad rang characteristic unavailable");
    return null;
  }
}

async function productById(id: string) {
  try {
    const row = await moysklad<ProductRow>(`/entity/product/${encodeURIComponent(id)}?expand=salePrices.priceType`);
    if (row.id === id && row.meta?.type !== "variant") return row;
  } catch (error) {
    if (!(error instanceof MoySkladError) || error.status !== 404) throw error;
  }
  return null;
}

async function productByName(name: string) {
  const page = await moysklad<{ rows: Array<{ id?: string; name?: string }> }>(`/entity/product?limit=10&filter=name=${encodeURIComponent(name)}`);
  const hit = page.rows.find((row) => row.id && row.name === name);
  return hit?.id ? productById(hit.id) : null;
}

function uniqueNameConflict(error: unknown) {
  if (!(error instanceof MoySkladError)) return false;
  return error.status === 409 || error.status === 412 || /уникал|unique|already exists|уже существ/i.test(error.message);
}

async function optionalWrite<T>(task: () => Promise<T>, label: string, extra?: Record<string, unknown>): Promise<T | null> {
  try {
    return await task();
  } catch (error) {
    if (!permissionDenied(error)) throw error;
    logger.warn({ ...extra, err: error instanceof Error ? error.message : error }, label);
    return null;
  }
}

const STRIP_PRODUCT_FIELDS = ["packs", "barcodes", "productFolder", "supplier", "salePrices", "buyPrice", "code"] as const;

async function createProduct(body: Record<string, unknown>): Promise<ProductRow & { packs?: GoodsPack[]; barcodes?: Array<Record<string, string>> }> {
  const payload: Record<string, unknown> = { ...body };
  for (let attempt = 0; attempt < STRIP_PRODUCT_FIELDS.length + 1; attempt += 1) {
    try {
      return await moyskladSend<ProductRow & { packs?: GoodsPack[]; barcodes?: Array<Record<string, string>> }>("/entity/product", payload);
    } catch (error) {
      if (uniqueNameConflict(error)) {
        const existing = await productByName(String(payload.name ?? ""));
        if (existing) return existing;
        throw error;
      }
      if (!permissionDenied(error)) throw error;
      const drop = error instanceof MoySkladError && error.parameter && error.parameter in payload
        ? error.parameter
        : STRIP_PRODUCT_FIELDS.find((field) => field in payload);
      if (!drop) throw error;
      logger.warn({ field: drop, name: payload.name }, "MoySklad product create retry without field");
      delete payload[drop];
    }
  }
  throw new MoySkladError("MoySklad mahsulot yaratilmadi", 403);
}

async function variantsOf(productId: string) {
  const rows: VariantRow[] = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const page = await moysklad<{ meta?: { size?: number }; rows: VariantRow[] }>(`/entity/variant?limit=100&offset=${offset}&filter=productid=${encodeURIComponent(productId)}&expand=characteristics`);
    rows.push(...page.rows.filter((row) => row.id));
    if (rows.length >= (page.meta?.size ?? rows.length) || page.rows.length < 100) break;
  }
  return rows;
}

async function ensureVariant(
  product: ProductRow,
  color: string,
  known: VariantRow[],
  catalog: Catalog,
  used: Set<string>,
): Promise<VariantRow | null> {
  const found = known.find((row) => sameColor(variantColor(row), color));
  if (found?.id) {
    await ensureBarcodes("variant", found.id, catalog, used);
    return found;
  }
  const rang = await colorCharacteristic();
  if (!rang || !product.meta) return null;
  const prices = (product.salePrices ?? []).filter((price) => price.priceType?.meta && price.value != null);
  const barcode = nextInternalEan13(catalog, used);
  const attempts: Array<Record<string, unknown>> = [
    {
      product: { meta: product.meta },
      characteristics: [{ id: rang.id, name: rang.name, meta: entityMeta(rang.href, "attributemetadata"), value: color }],
      barcodes: [{ ean13: barcode }],
      ...(prices.length ? { salePrices: prices.map((price) => ({ value: price.value, currency: price.currency, priceType: { meta: price.priceType?.meta } })) } : {}),
    },
    {
      product: { meta: product.meta },
      characteristics: [{ id: rang.id, name: rang.name, meta: entityMeta(rang.href, "attributemetadata"), value: color }],
      barcodes: [{ ean13: barcode }],
    },
    {
      product: { meta: product.meta },
      characteristics: [{ id: rang.id, name: rang.name, meta: entityMeta(rang.href, "attributemetadata"), value: color }],
    },
  ];
  for (const body of attempts) {
    try {
      const created = await moyskladSend<VariantRow>("/entity/variant", body);
      used.add(barcode);
      if (created.id) await ensureBarcodes("variant", created.id, catalog, used);
      known.push({ ...created, characteristics: [{ name: "rang", value: color }] });
      return created;
    } catch (error) {
      if (uniqueNameConflict(error)) {
        const rows = await variantsOf(product.id);
        known.splice(0, known.length, ...rows);
        const hit = rows.find((row) => sameColor(variantColor(row), color));
        if (hit?.id) {
          await ensureBarcodes("variant", hit.id, catalog, used);
          return hit;
        }
      }
      if (!permissionDenied(error) && !(error instanceof MoySkladError)) throw error;
      if (!permissionDenied(error) && body === attempts[attempts.length - 1]) throw error;
      logger.warn({ color, product: product.name, err: error instanceof Error ? error.message : error }, "MoySklad variant create retry");
    }
  }
  return null;
}

async function colorNamedProduct(
  parent: ProductRow,
  color: string,
  extras: {
    folder: FolderRow | null;
    supplierMeta?: Meta | null;
    currencyMeta: Meta;
    price: number;
    priceType: string;
    article: string;
    description?: string;
    packSize: number;
    catalog: Catalog;
    used: Set<string>;
  },
): Promise<ProductRow> {
  const name = `${parent.name || ""} ${color}`.trim();
  const sale = extras.price > 0 && extras.priceType ? (markedSale(extras.price, extras.priceType, loadMarkup()) ?? extras.price) : extras.price;
  const existing = await productByName(name);
  if (existing) {
    await writeProductCard(existing.id, sale, extras.priceType, extras.currencyMeta, {
      article: extras.article,
      supplierMeta: extras.supplierMeta,
      description: extras.description,
      folderMeta: extras.folder?.meta ?? null,
      packSize: extras.packSize,
      buySom: extras.price,
    });
    return existing;
  }
  const listed = sale > 0 ? await listedPrices(undefined, extras.priceType, sale, extras.currencyMeta) : null;
  const barcode = nextInternalEan13(extras.catalog, extras.used);
  extras.used.add(barcode);
  const packSize = extras.packSize > 1 ? extras.packSize : 0;
  const created = await createProduct({
    name,
    uom: { meta: uomMeta(PIECE_UOM) },
    barcodes: [{ ean13: barcode }],
    ...(listed ? { salePrices: priceBody(listed) } : {}),
    ...(extras.folder ? { productFolder: { meta: extras.folder.meta } } : {}),
    ...(extras.supplierMeta ? { supplier: { meta: extras.supplierMeta } } : {}),
    ...(extras.article ? { article: extras.article } : {}),
    ...(packSize ? { packs: [{ quantity: packSize, uom: { meta: uomMeta(PACHKA_UOM) } }] } : {}),
    ...(extras.price > 0 ? { buyPrice: { value: Math.round(extras.price * 100), currency: { meta: extras.currencyMeta } } } : {}),
  });
  if (listed) created.salePrices = listed;
  created.barcodes = barcodeValues(created.barcodes);
  await writeProductCard(created.id, sale, extras.priceType, extras.currencyMeta, {
    article: extras.article,
    supplierMeta: extras.supplierMeta,
    description: extras.description,
    folderMeta: extras.folder?.meta ?? null,
    packSize,
    buySom: extras.price,
  });
  return created;
}

type FolderRow = { id: string; name: string; pathName?: string; meta: Meta; parent?: Meta | null };

async function productFolders(): Promise<FolderRow[]> {
  const folders: FolderRow[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const page = await moysklad<{ meta?: { size?: number }; rows: Array<{ id?: string; name?: string; pathName?: string; meta?: Meta; productFolder?: { meta?: Meta } }> }>(`/entity/productfolder?limit=100&offset=${offset}`);
    for (const row of page.rows) {
      if (row.id && row.name && row.meta) folders.push({ id: row.id, name: row.name, pathName: row.pathName, meta: row.meta, parent: row.productFolder?.meta ?? null });
    }
    if (folders.length >= (page.meta?.size ?? folders.length)) break;
  }
  return folders;
}

async function ensureFolder(folders: FolderRow[], groupCode: string): Promise<FolderRow | null> {
  const code = groupCode.trim();
  if (code.length < 3) return null;
  const existing = matchProductFolder(folders, code);
  if (existing) return existing;
  const parent = folders.find((folder) => /^\d{3,5}$/.test(folder.name.trim()) && folder.parent)?.parent ?? null;
  try {
    const created = await moyskladSend<{ id?: string; name?: string; pathName?: string; meta?: Meta }>("/entity/productfolder", {
      name: code,
      ...(parent ? { productFolder: { meta: parent } } : {}),
    });
    if (!created.id || !created.meta) return null;
    const folder: FolderRow = { id: created.id, name: created.name || code, pathName: created.pathName, meta: created.meta, parent };
    folders.push(folder);
    return folder;
  } catch (error) {
    logger.warn({ section: code, err: error instanceof Error ? error.message : error }, "MoySklad folder could not be created");
    return null;
  }
}

let saleTypeCache: Array<{ name: string; meta: Meta }> | null = null;

async function saleTypes() {
  if (saleTypeCache) return saleTypeCache;
  try {
    saleTypeCache = asPriceTypes(await moysklad("/context/companysettings/pricetype"));
  } catch (error) {
    if (!permissionDenied(error)) throw error;
    logger.warn({ err: error instanceof Error ? error.message : error }, "MoySklad price types unavailable");
    saleTypeCache = [];
  }
  return saleTypeCache;
}

async function listedPrices(current: Price[] | undefined, typeName: string, som: number, currencyMeta: Meta): Promise<Price[] | null> {
  const wanted = typeName.trim();
  if (!wanted || !(som > 0)) return null;
  const kopecks = Math.round(som * 100);
  const fromProduct = asPriceTypes((current ?? []).map((price) => ({ name: price.priceType?.name, meta: price.priceType?.meta })));
  const types = new Map<string, { name: string; meta: Meta }>();
  for (const row of [...fromProduct, ...(await saleTypes())]) {
    if (!types.has(row.meta.href)) types.set(row.meta.href, row);
  }
  if (!types.size) {
    logger.warn({ typeName: wanted }, "MoySklad sale price type was not found");
    return null;
  }
  const chosen = [...types.values()].find((row) => samePriceType(row.name, wanted));
  if (!chosen) {
    logger.warn({ typeName: wanted, have: [...types.values()].map((row) => row.name) }, "MoySklad sale price type was not found");
    return null;
  }
  return [...types.values()].map((type) => {
    const existing = (current ?? []).find((price) => price.priceType?.meta?.href === type.meta.href);
    return {
      value: samePriceType(type.name, wanted) ? kopecks : (existing?.value ?? 0),
      currency: existing?.currency ?? { meta: currencyMeta },
      priceType: { meta: type.meta, name: type.name },
    };
  });
}

function priceBody(rows: Price[]) {
  return rows
    .filter((price) => price.priceType?.meta && price.value != null)
    .map((price) => ({ value: price.value, currency: price.currency, priceType: { meta: price.priceType?.meta } }));
}

function barcodeValues(rows?: Array<Record<string, string>> | string[]): string[] {
  if (!rows?.length) return [];
  if (typeof rows[0] === "string") return (rows as string[]).filter(Boolean);
  return (rows as Array<Record<string, string>>).flatMap((item) => Object.values(item)).filter((value) => value.length > 0);
}

function ean13Check(digits12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(digits12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

export function nextInternalEan13(catalog: Catalog, used: Set<string>): string {
  let max = 0;
  for (const product of catalog.products) {
    for (const code of product.barcodes) {
      if (!/^200\d{10}$/.test(code)) continue;
      const serial = Number(code.slice(3, 12));
      if (Number.isFinite(serial) && serial > max) max = serial;
    }
  }
  for (const code of used) {
    if (!/^200\d{10}$/.test(code)) continue;
    const serial = Number(code.slice(3, 12));
    if (Number.isFinite(serial) && serial > max) max = serial;
  }
  for (let serial = max + 1; serial < max + 10000; serial += 1) {
    const body = `200${String(serial).padStart(9, "0")}`;
    const code = `${body}${ean13Check(body)}`;
    if (!used.has(code)) return code;
  }
  throw new MoySkladError("Shtrix-kod yaratilmadi", 500);
}

async function placeInFolder(productId: string, folder: FolderRow) {
  try {
    const current = await moysklad<{ productFolder?: { meta?: { href?: string } } }>(`/entity/product/${encodeURIComponent(productId)}?expand=productFolder`);
    if (current.productFolder?.meta?.href === folder.meta.href) return;
    if (current.productFolder?.meta?.href) return;
    await moyskladSend(`/entity/product/${encodeURIComponent(productId)}`, { productFolder: { meta: folder.meta } }, "PUT");
  } catch (error) {
    if (!permissionDenied(error)) throw error;
    logger.warn({ productId, folder: folder.name, err: error instanceof Error ? error.message : error }, "MoySklad folder place skipped");
  }
}

async function ensureBarcodes(
  kind: "product" | "variant",
  id: string,
  catalog: Catalog,
  used: Set<string>,
): Promise<string[]> {
  const path = kind === "product" ? `/entity/product/${encodeURIComponent(id)}` : `/entity/variant/${encodeURIComponent(id)}`;
  const current = await moysklad<{ barcodes?: Array<Record<string, string>> }>(path);
  const existing = barcodeValues(current.barcodes);
  if (existing.length) {
    for (const code of existing) used.add(code);
    return existing;
  }
  const code = nextInternalEan13(catalog, used);
  used.add(code);
  const saved = await optionalWrite(() => moyskladSend(path, { barcodes: [{ ean13: code }] }, "PUT"), "MoySklad barcode skipped", { id, kind });
  return saved ? [code] : existing;
}

function saleTypeOf(line: ShipmentLine): string {
  if (SALE_TYPES.includes(line.priceType)) return line.priceType;
  return line.price > 0 ? "Exclusive" : "";
}

function hasSaleMarkup(prices?: Price[]) {
  return (prices ?? []).some((price) => Boolean(price.priceType?.name) && SALE_TYPES.includes(price.priceType?.name || "") && (price.value ?? 0) > 0);
}

function saleForLine(line: ShipmentLine) {
  const type = saleTypeOf(line);
  if (!(line.price > 0) || !type) return { type, sale: 0 };
  return { type, sale: markedSale(line.price, type, loadMarkup()) ?? line.price };
}

export async function stampWaybillCardPrices(
  lines: ShipmentLine[],
  currencyMeta: Meta,
  scope: { factoryCode: string; factoryName: string; catalog: Catalog; supplierMeta?: Meta | null },
) {
  const seen = new Set<string>();
  for (const line of lines) {
    if (!(line.price > 0)) continue;
    const name = ["Bordo", line.factoryCode || scope.factoryCode, line.sectionCode, line.productCode, line.size].filter(Boolean).join(" ").trim();
    const matched = await findExistingBordoProduct(line, scope);
    if (!matched?.id || seen.has(matched.id)) continue;
    seen.add(matched.id);
    const priced = saleForLine(line);
    await writeProductCard(matched.id, priced.sale, priced.type, currencyMeta, {
      article: line.productCode.trim(),
      supplierMeta: scope.supplierMeta,
      description: cardDescription(line),
      packSize: line.pairs > 1 ? line.pairs : 0,
      buySom: line.price,
    });
  }
}

function productIdentity(line: ShipmentLine, factoryCode: string) {
  return [
    (line.factoryCode || factoryCode).trim().toLowerCase(),
    line.sectionCode.trim().toLowerCase(),
    line.productCode.trim().toLowerCase(),
    line.size.trim().toLowerCase(),
  ].join("\0");
}

function parentIdentity(line: ShipmentLine, factoryCode: string) {
  return [
    (line.factoryCode || factoryCode).trim().toLowerCase(),
    line.productCode.trim().toLowerCase(),
    line.size.trim().toLowerCase(),
  ].join("\0");
}

export async function findExistingBordoProduct(
  line: { factoryCode?: string; sectionCode?: string; productCode: string; size: string; productId?: string | null },
  scope: { factoryCode: string; factoryName: string; catalog: Catalog },
): Promise<ProductRow | null> {
  if (line.productId) {
    const byId = await productById(line.productId);
    const parts = byId?.name ? parseBordoName(byId.name) : null;
    const factory = (line.factoryCode || scope.factoryCode).trim().toLowerCase();
    const codeOk = !parts || parts.productCode.toLowerCase() === line.productCode.trim().toLowerCase();
    const sizeOk = !line.size.trim() || !parts || parts.size === line.size.trim();
    const factoryOk = !parts || !factory || parts.factoryCode.toLowerCase() === factory;
    if (byId && codeOk && sizeOk && factoryOk) return byId;
  }
  const factory = line.factoryCode || scope.factoryCode;
  const groupCode = line.sectionCode || "";
  const catalogMatch = matchWaybillProduct(scope.catalog, {
    factoryCode: factory,
    factoryName: scope.factoryName,
    groupCode,
    productCode: line.productCode,
    size: line.size,
  });
  if (catalogMatch?.id) {
    const row = await productById(catalogMatch.id);
    if (row) return row;
  }
  const query = [factory, line.productCode, line.size].filter(Boolean).join(" ");
  if (query.length >= 3) {
    try {
      const page = await moysklad<{ rows: Array<{ id?: string; name?: string }> }>(`/entity/product?limit=50&search=${encodeURIComponent(query)}`);
      const rows = page.rows.filter((row): row is { id: string; name: string } => Boolean(row.id && row.name));
      const matched = matchNamedProducts(rows, {
        factoryCode: factory,
        factoryName: scope.factoryName,
        groupCode,
        productCode: line.productCode,
        size: line.size,
      });
      if (matched?.id) {
        const row = await productById(matched.id);
        if (row) return row;
      }
    } catch (error) {
      if (!permissionDenied(error) && !(error instanceof MoySkladError)) throw error;
      logger.warn({ query, err: error instanceof Error ? error.message : error }, "MoySklad product search skipped");
    }
  }
  const names = [...new Set([
    ["Bordo", factory, groupCode, line.productCode, line.size].filter(Boolean).join(" ").trim(),
    ...(groupCode.trim() ? [] : [["Bordo", factory, line.productCode, line.size].filter(Boolean).join(" ").trim()]),
  ])].filter((item) => item.length >= 2);
  for (const candidate of names) {
    const hit = await productByName(candidate);
    if (hit) return hit;
  }
  return null;
}

export async function buildSupplyPositions(
  lines: ShipmentLine[],
  currencyMeta: Meta,
  scope: { factoryCode: string; factoryName: string; catalog: Catalog; supplierMeta?: Meta | null },
): Promise<Planned> {
  const parents = new Map<string, ProductRow>();
  const variantCache = new Map<string, VariantRow[]>();
  const packCache = new Map<string, GoodsPack | null>();
  const usedBarcodes = new Set<string>();
  const resolved: Array<{ line: ShipmentLine; parent: ProductRow | null; name: string; key: string; folder: FolderRow | null }> = [];
  const created: ProductRow[] = [];
  const folders = await productFolders();

  for (const line of lines) {
    const parts = receiptParts(line);
    if (!parts.length) continue;
    requireWaybillLine(line);
    const name = ["Bordo", line.factoryCode || scope.factoryCode, line.sectionCode, line.productCode, line.size].filter(Boolean).join(" ").trim();
    const parent = await findExistingBordoProduct(line, scope);
    if (parent?.name) {
      const parts = parseBordoName(parent.name);
      if (parts?.groupCode) line.sectionCode = parts.groupCode;
    }
    const key = parent?.id || (line.sectionCode.trim() ? productIdentity(line, scope.factoryCode) : parentIdentity(line, scope.factoryCode));
    const folder = await ensureFolder(folders, line.sectionCode);
    const priceType = saleTypeOf(line);
    if (line.price > 0) line.priceType = priceType;
    if (!parent && (!line.productCode.trim() || name.length < 2)) {
      throw new MoySkladError(`Mahsulot kodi kiritilmagan${line.size ? ` (${line.size})` : ""}`, 400);
    }
    resolved.push({ line, parent, name, key, folder });
  }
  if (!resolved.length) throw new MoySkladError("Kirim qatorlari bo‘sh", 400);

  const byIdentity = new Map<string, ProductRow>();
  for (const item of resolved) {
    const known = item.parent || byIdentity.get(item.key) || null;
    if (known) {
      item.parent = known;
      if (item.folder) await placeInFolder(known.id, item.folder);
      known.barcodes = await ensureBarcodes("product", known.id, scope.catalog, usedBarcodes);
      parents.set(known.id, known);
      byIdentity.set(item.key, known);
      continue;
    }
    const code = item.line.productCode.trim();
    const packSize = item.line.pairs > 1 ? item.line.pairs : 0;
    const priced = saleForLine(item.line);
    const listed = priced.sale > 0 ? await listedPrices(undefined, priced.type, priced.sale, currencyMeta) : null;
    const barcode = nextInternalEan13(scope.catalog, usedBarcodes);
    usedBarcodes.add(barcode);
    const product = await createProduct({
      name: item.name,
      uom: { meta: uomMeta(PIECE_UOM) },
      barcodes: [{ ean13: barcode }],
      ...(listed ? { salePrices: priceBody(listed) } : {}),
      ...(item.folder ? { productFolder: { meta: item.folder.meta } } : {}),
      ...(scope.supplierMeta ? { supplier: { meta: scope.supplierMeta } } : {}),
      ...(packSize ? { packs: [{ quantity: packSize, uom: { meta: uomMeta(PACHKA_UOM) } }] } : {}),
      ...(code.length >= 8 ? { code } : {}),
      ...(code ? { article: code } : {}),
      ...(item.line.price > 0 ? { buyPrice: { value: Math.round(item.line.price * 100), currency: { meta: currencyMeta } } } : {}),
    });
    if (listed) product.salePrices = listed;
    if (item.folder) product.folderName = item.folder.name;
    product.barcodes = barcodeValues(product.barcodes);
    if (!product.barcodes.length) product.barcodes = await ensureBarcodes("product", product.id, scope.catalog, usedBarcodes);
    const createdPack = (product.packs ?? []).find((pack) => pack.id && pack.quantity === packSize);
    if (createdPack?.uom?.meta) packCache.set(`${product.id}:${packSize}`, createdPack);
    if (item.folder) await placeInFolder(product.id, item.folder);
    item.parent = product;
    parents.set(product.id, product);
    byIdentity.set(item.key, product);
    created.push(product);
  }

  const positions: SupplyPosition[] = [];
  const links: Planned["links"] = [];
  for (const item of resolved) {
    const parent = item.parent;
    if (!parent) throw new MoySkladError("Mahsulot yaratilmadi", 400);
    const full = parents.get(parent.id) ?? parent;
    if (!full.salePrices) {
      const loaded = await productById(full.id);
      if (loaded) parents.set(full.id, loaded);
    }
    const product = parents.get(parent.id) ?? full;
    if (item.line.price > 0) {
      const priced = saleForLine(item.line);
      await writeProductCard(product.id, priced.sale, priced.type, currencyMeta, {
        article: item.line.productCode.trim(),
        supplierMeta: scope.supplierMeta,
        description: cardDescription(item.line),
        folderMeta: item.folder?.meta ?? null,
        packSize: item.line.pairs > 1 ? item.line.pairs : 0,
        buySom: item.line.price,
      });
    }
    if (!product.meta?.href) product.meta = entityMeta(`${BASE}/entity/product/${product.id}`, "product");
    links.push({ lineId: item.line.id, product: { id: product.id, name: product.name || item.name } });
    const parts = receiptParts(item.line);
    const packSize = item.line.pairs > 1 ? item.line.pairs : 0;
    const packKey = `${product.id}:${packSize}`;
    if (!packCache.has(packKey)) packCache.set(packKey, await ensurePachka(product.id, packSize));
    let known = variantCache.get(product.id);
    if (!known && parts.some((part) => part.color)) {
      known = await variantsOf(product.id);
      variantCache.set(product.id, known);
    }
    for (const part of parts) {
      if (!part.color) {
        positions.push({
          quantity: part.quantity,
          price: Math.round(item.line.price * 100),
          assortment: { meta: product.meta?.href ? product.meta : entityMeta(`${BASE}/entity/product/${product.id}`, "product") },
          stockId: product.id,
        });
        continue;
      }
      const variant = await ensureVariant(product, part.color, known ?? [], scope.catalog, usedBarcodes);
      let assortment: { meta: Meta };
      let stockId: string;
      if (variant?.id) {
        if (item.line.price > 0) {
          let current = product.salePrices;
          try {
            const loaded = await moysklad<{ salePrices?: Price[] }>(`/entity/variant/${encodeURIComponent(variant.id)}?expand=salePrices.priceType`);
            if (loaded.salePrices?.length) current = loaded.salePrices;
          } catch (error) {
            if (!(error instanceof MoySkladError) || error.status !== 404) throw error;
          }
          const priced = saleForLine(item.line);
          const listed = hasSaleMarkup(current) ? null : await listedPrices(current, priced.type, priced.sale, currencyMeta);
          const saleBody = listed ? { salePrices: priceBody(listed) } : {};
          const buyBody = item.line.price > 0 ? { buyPrice: { value: Math.round(item.line.price * 100), currency: { meta: currencyMeta } } } : {};
          if (listed || item.line.price > 0) {
            try {
              await moyskladSend(`/entity/variant/${encodeURIComponent(variant.id)}`, { ...buyBody, ...saleBody }, "PUT");
            } catch (error) {
              if (listed) {
                await optionalWrite(
                  () => moyskladSend(`/entity/variant/${encodeURIComponent(variant.id)}`, saleBody, "PUT"),
                  "MoySklad variant price skipped",
                  { color: part.color },
                );
              } else if (!permissionDenied(error)) throw error;
            }
          }
        }
        assortment = { meta: variant.meta?.href ? variant.meta : entityMeta(`${BASE}/entity/variant/${variant.id}`, "variant") };
        stockId = variant.id;
      } else {
        const refreshed = await variantsOf(product.id);
        known.splice(0, known.length, ...refreshed);
        variantCache.set(product.id, known);
        const existingVariant = known.find((row) => sameColor(variantColor(row), part.color));
        if (existingVariant?.id) {
          assortment = { meta: existingVariant.meta?.href ? existingVariant.meta : entityMeta(`${BASE}/entity/variant/${existingVariant.id}`, "variant") };
          stockId = existingVariant.id;
          positions.push({
            quantity: part.quantity,
            price: Math.round(item.line.price * 100),
            assortment,
            stockId,
          });
          continue;
        }
        const existingColor = await productByName(`${product.name} ${part.color}`)
          || await productByName(`${product.name} (${part.color})`);
        if (existingColor?.id) {
          if (item.line.price > 0) {
            const priced = saleForLine(item.line);
            await writeProductCard(existingColor.id, priced.sale, priced.type, currencyMeta, {
              article: item.line.productCode.trim(),
              supplierMeta: scope.supplierMeta,
              packSize,
              buySom: item.line.price,
            });
          }
          if (!existingColor.meta?.href) existingColor.meta = entityMeta(`${BASE}/entity/product/${existingColor.id}`, "product");
          positions.push({
            quantity: part.quantity,
            price: Math.round(item.line.price * 100),
            assortment: { meta: existingColor.meta },
            stockId: existingColor.id,
          });
          continue;
        }
        const colored = await colorNamedProduct(product, part.color, {
          folder: item.folder,
          supplierMeta: scope.supplierMeta,
          currencyMeta,
          price: item.line.price,
          priceType: saleTypeOf(item.line),
          article: item.line.productCode.trim(),
          description: cardDescription(item.line),
          packSize,
          catalog: scope.catalog,
          used: usedBarcodes,
        });
        if (!colored.meta?.href) colored.meta = entityMeta(`${BASE}/entity/product/${colored.id}`, "product");
        parents.set(colored.id, colored);
        if (!created.some((row) => row.id === colored.id)) created.push(colored);
        assortment = { meta: colored.meta };
        stockId = colored.id;
      }
      positions.push({
        quantity: part.quantity,
        price: Math.round(item.line.price * 100),
        assortment,
        stockId,
      });
    }
  }
  return { positions, links, created };
}
