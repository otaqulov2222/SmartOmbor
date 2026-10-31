import { canonicalFactoryCode, compactCode, foldProductName, matchNamedProducts, matchProductFolder, matchWaybillProduct, normalizeBordoColor, normalizeBordoSize, parseBordoName, productBelongsToFactory, productCodeMatches, sameBordoCard, sameBordoColor, sameFactoryCode, type Catalog } from "./catalog";
import { loadMarkup, markedSale, resolveMarkups, salesOf } from "./markup";
import type { ShipmentLine } from "./partners";
import { logger } from "./logger";
import { MoySkladError, moysklad, moyskladSend, permissionDenied, writeDropped } from "./moysklad";

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

export async function productPackSize(productId: string): Promise<number> {
  const id = String(productId || "").trim();
  if (!id) return 0;
  try {
    const current = await moysklad<{ packs?: GoodsPack[] }>(`/entity/product/${encodeURIComponent(id)}?expand=packs.uom`);
    const pachka = (current.packs ?? []).find((pack) => isPachkaPack(pack));
    const quantity = Math.round(Number(pachka?.quantity) || 0);
    return quantity > 1 ? quantity : 0;
  } catch (error) {
    logger.warn({ productId: id, err: error instanceof Error ? error.message : error }, "MoySklad pack size skipped");
    return 0;
  }
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

function colorRows(line: Pick<ShipmentLine, "colors">) {
  const merged = new Map<string, { name: string; quantity: number }>();
  for (const color of line.colors ?? []) {
    const quantity = Math.max(0, Number(color?.quantity) || 0);
    const name = normalizeBordoColor(String(color?.name ?? ""));
    if (!name || quantity <= 0) continue;
    const prev = merged.get(name);
    if (prev) prev.quantity += quantity;
    else merged.set(name, { name, quantity });
  }
  return [...merged.values()];
}

export function packSizeOf(line: { pachka?: number }): number {
  const pachka = Math.max(0, Math.round(Number(line.pachka) || 0));
  return pachka > 1 ? pachka : 0;
}

export function pieceCount(line: Pick<ShipmentLine, "pairs" | "boxes" | "quantity" | "colors">): number {
  const pack = line.pairs > 0 ? line.pairs : 0;
  const colors = colorRows(line);
  if (pack > 0 && colors.length) return colors.reduce((sum, color) => sum + color.quantity * pack, 0);
  if (pack > 0 && line.boxes > 0) return pack * line.boxes;
  return line.quantity > 0 ? line.quantity : pack;
}

export function receiptParts(line: Pick<ShipmentLine, "pairs" | "boxes" | "quantity" | "colors">): Array<{ color: string | null; quantity: number }> {
  const pack = line.pairs > 0 ? line.pairs : 0;
  const colors = colorRows(line);
  if (pack > 0 && colors.length) return colors.map((color) => ({ color: color.name, quantity: color.quantity * pack }));
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
  const colors = colorRows(line);
  const colorBoxes = colors.reduce((sum, color) => sum + color.quantity, 0);
  if (colors.length && line.boxes > 0 && colorBoxes !== line.boxes) {
    throw new MoySkladError(`Ranglar yig‘indisi ${colorBoxes} qop, qatorda ${line.boxes} qop (${label})`, 400);
  }
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
  extras: { article?: string; supplierMeta?: Meta | null; description?: string; folderMeta?: Meta | null; packSize?: number; buySom?: number; sales?: Partial<Record<string, number>> } = {},
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
    ...(extras.supplierMeta && current.supplier?.meta?.href !== extras.supplierMeta.href ? { supplier: { meta: extras.supplierMeta } } : {}),
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
  if (hasAllSaleMarkups(current.salePrices)) return;
  const sales = extras.sales && Object.values(extras.sales).some((value) => typeof value === "number" && value > 0)
    ? extras.sales
    : (kopecks > 0 && priceType ? { [priceType]: som } : null);
  if (!sales) return;
  const listed = await listedAllPrices(current.salePrices, sales, currencyMeta);
  if (!listed) {
    logger.warn({ productId, priceType, sales }, "MoySklad sale prices were not written");
    return;
  }
  await optionalWrite(
    () => moyskladSend(`/entity/product/${encodeURIComponent(productId)}`, { salePrices: priceBody(listed) }, "PUT"),
    "MoySklad sale prices skipped",
    { productId, priceType },
  );
}

function variantColor(variant: VariantRow) {
  const chars = variant.characteristics ?? [];
  const named = chars.find((item) => /^(rang|цвет|color)$/i.test(item.name?.trim() || ""));
  if (named?.value?.trim()) return named.value.trim();
  const parsed = parseBordoName(variant.name || "");
  if (parsed?.color) return parsed.color;
  if (chars[0]?.value?.trim()) return chars[0].value.trim();
  const fromName = (variant.name || "").match(/\(([^)]+)\)\s*$/);
  if (fromName?.[1]) return fromName[1].trim();
  const tail = (variant.name || "").match(/\s+([A-Z0-9]*R-?\d+[A-Z0-9]*)\s*$/i);
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

const productCache = new Map<string, ProductRow>();

function rememberProduct(row: ProductRow, aliases: string[] = []) {
  if (!row?.id) return row;
  productCache.set(`id:${row.id}`, row);
  for (const name of [row.name, ...aliases]) {
    const key = foldProductName(String(name || "").trim().replace(/\s+/g, " "));
    if (key) productCache.set(`name:${key}`, row);
  }
  return row;
}

function cachedByName(name: string) {
  const key = foldProductName(name.trim().replace(/\s+/g, " "));
  return key ? productCache.get(`name:${key}`) ?? null : null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function idFromHref(href?: string) {
  const path = String(href || "").split("?")[0];
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

async function productById(id: string) {
  const wanted = String(id || "").trim();
  if (!wanted) return null;
  const cached = productCache.get(`id:${wanted}`);
  if (cached) return cached;
  try {
    const row = await moysklad<ProductRow>(`/entity/product/${encodeURIComponent(wanted)}`);
    if (row.id === wanted && row.meta?.type !== "variant") return rememberProduct(row);
  } catch (error) {
    if (!(error instanceof MoySkladError) || error.status !== 404) throw error;
  }
  return null;
}

function namesEquivalent(left: string, right: string) {
  return foldProductName(left) === foldProductName(right);
}

function sameListedName(left: string, right: string) {
  const a = left.trim().replace(/\s+/g, " ");
  const b = right.trim().replace(/\s+/g, " ");
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.localeCompare(b, "ru", { sensitivity: "accent" }) === 0) return true;
  return namesEquivalent(a, b);
}

function quoteFilterValue(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function rowMatchesName(rowName: string, wanted: string) {
  if (sameListedName(rowName, wanted)) return true;
  const parsed = parseBordoName(wanted);
  if (!parsed) return false;
  const parts = parseBordoName(rowName);
  if (!parts) return false;
  if (!sameBordoColor(parts.color, parsed.color)) return false;
  return sameFactoryCode(parts.factoryCode, parsed.factoryCode)
    && productCodeMatches(parts.productCode, parsed.productCode)
    && compactCode(parts.size) === compactCode(parsed.size);
}

function pickNamedRow(rows: Array<{ id?: string; name?: string }>, wanted: string) {
  const exact = rows.find((row) => row.id && sameListedName(row.name || "", wanted));
  if (exact?.id) return exact;
  return rows.find((row) => row.id && rowMatchesName(row.name || "", wanted)) ?? null;
}

async function rowFromSearchHit(row: { id?: string; name?: string; meta?: { type?: string; href?: string }; product?: { meta?: { href?: string } } }, wanted: string) {
  const type = row.meta?.type || "";
  if (type === "variant") {
    const parentId = idFromHref(row.product?.meta?.href);
    if (parentId) return productById(parentId);
    return null;
  }
  if (row.id) {
    const loaded = await productById(row.id);
    if (loaded && recoveredCardFits(loaded, wanted)) return rememberProduct(loaded, [wanted, row.name || ""]);
    if (loaded) return loaded;
  }
  return null;
}

function nameAliases(name: string) {
  const trimmed = name.trim().replace(/\s+/g, " ");
  const parsed = parseBordoName(trimmed);
  const aliases = [trimmed];
  if (parsed) {
    const withGroup = ["Bordo", parsed.factoryCode, parsed.groupCode, parsed.productCode, parsed.size].filter(Boolean).join(" ").trim();
    const withoutGroup = ["Bordo", parsed.factoryCode, parsed.productCode, parsed.size].filter(Boolean).join(" ").trim();
    aliases.push(withGroup, withoutGroup);
    if (parsed.color) {
      aliases.push(`${withGroup} ${parsed.color}`, `${withGroup} (${parsed.color})`, `${withoutGroup} ${parsed.color}`, `${withoutGroup} (${parsed.color})`);
    }
  }
  return [...new Set(aliases.map((item) => item.trim().replace(/\s+/g, " ")).filter(Boolean))];
}

async function searchListedName(name: string) {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  const parsed = parseBordoName(trimmed);
  const queries = [...new Set([...nameAliases(trimmed), parsed?.productCode || ""].map((item) => item.trim()).filter((item) => item.length >= 2))];
  const paths = queries.flatMap((query) => [
    `/entity/product?limit=50&search=${encodeURIComponent(query)}`,
    `/entity/assortment?limit=50&search=${encodeURIComponent(query)}`,
  ]);
  for (const path of paths) {
    try {
      const page = await moysklad<{ rows: Array<{ id?: string; name?: string; meta?: { type?: string; href?: string }; product?: { meta?: { href?: string } } }> }>(path);
      for (const alias of nameAliases(trimmed)) {
        const hit = pickNamedRow(page.rows, alias);
        if (hit) {
          const loaded = await rowFromSearchHit(hit, trimmed);
          if (loaded) return loaded;
        }
      }
      if (parsed) {
        const identity = page.rows.find((row) => row.id && sameBordoCard(row.name || "", {
          factoryCode: parsed.factoryCode,
          productCode: parsed.productCode,
          size: parsed.size,
          groupCode: parsed.groupCode,
        }));
        if (identity) {
          const loaded = await rowFromSearchHit(identity, trimmed);
          if (loaded) return loaded;
        }
      }
    } catch (error) {
      if (!permissionDenied(error) && !(error instanceof MoySkladError)) throw error;
      logger.warn({ name: trimmed, err: error instanceof Error ? error.message : error }, "MoySklad product-by-name search skipped");
    }
  }
  return null;
}

async function productByName(name: string) {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  const remembered = cachedByName(trimmed);
  if (remembered && recoveredCardFits(remembered, trimmed) && (sameListedName(remembered.name || "", trimmed) || rowMatchesName(remembered.name || "", trimmed))) {
    return remembered;
  }
  try {
    const page = await moysklad<{ rows: Array<{ id?: string; name?: string }> }>(`/entity/product?limit=10&filter=${encodeURIComponent(`name=${quoteFilterValue(trimmed)}`)}`);
    const hit = pickNamedRow(page.rows, trimmed);
    if (hit?.id) {
      const row = await productById(hit.id);
      if (row && recoveredCardFits(row, trimmed)) return rememberProduct(row, [trimmed]);
    }
  } catch (error) {
    if (!permissionDenied(error) && !(error instanceof MoySkladError)) throw error;
  }
  return searchListedName(trimmed);
}

function uniqueNameConflict(error: unknown) {
  if (!(error instanceof MoySkladError)) return false;
  if (error.parameter === "name" || error.parameter === "article" || error.parameter === "code") return true;
  return error.status === 409 || error.status === 412 || /уникал|unique|already exists|уже существ/i.test(error.message);
}

function uniqueNameParameter(error: unknown) {
  if (!(error instanceof MoySkladError)) return "";
  if (error.parameter) return error.parameter;
  const match = error.message.match(/параметра '([^']+)'|parameter '([^']+)'/i);
  return match?.[1] || match?.[2] || "";
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

function recoveredCardFits(hit: ProductRow, wanted: string) {
  const expected = parseBordoName(wanted);
  if (!expected) return sameListedName(hit.name || "", wanted);
  const parts = parseBordoName(hit.name || "");
  if (!parts) return false;
  if (!sameFactoryCode(parts.factoryCode, expected.factoryCode)) return false;
  if (!productCodeMatches(parts.productCode, expected.productCode)) return false;
  if (compactCode(parts.size) !== compactCode(expected.size)) return false;
  if (expected.groupCode && parts.groupCode && compactCode(parts.groupCode) !== compactCode(expected.groupCode)) return false;
  return true;
}

async function recoverExistingProduct(name: string) {
  const wanted = name.trim().replace(/\s+/g, " ");
  if (!wanted) return null;
  for (const alias of nameAliases(wanted)) {
    const hit = await productByName(alias);
    if (hit && recoveredCardFits(hit, wanted)) return hit;
  }
  await sleep(300);
  for (const alias of nameAliases(wanted)) {
    const hit = await searchListedName(alias);
    if (hit && recoveredCardFits(hit, wanted)) return hit;
  }
  const fallback = await productByName(wanted);
  return fallback && recoveredCardFits(fallback, wanted) ? fallback : null;
}

async function createProduct(body: Record<string, unknown>): Promise<ProductRow & { packs?: GoodsPack[]; barcodes?: Array<Record<string, string>> }> {
  const payload: Record<string, unknown> = { ...body };
  const wanted = String(payload.name ?? "").trim().replace(/\s+/g, " ");
  const listed = wanted ? await productByName(wanted) : null;
  if (listed && recoveredCardFits(listed, wanted)) return listed;
  for (let attempt = 0; attempt < STRIP_PRODUCT_FIELDS.length + 3; attempt += 1) {
    try {
      const created = await moyskladSend<ProductRow & { packs?: GoodsPack[]; barcodes?: Array<Record<string, string>> }>("/entity/product", payload);
      return rememberProduct(created, [wanted]);
    } catch (error) {
      const existing = wanted ? await recoverExistingProduct(wanted) : null;
      if (existing) return existing;
      if (uniqueNameConflict(error) || writeDropped(error)) {
        const parameter = uniqueNameParameter(error);
        if (parameter === "barcodes") {
          delete payload.barcodes;
          continue;
        }
        if (parameter !== "name" && ("article" in payload || "code" in payload || parameter === "article" || parameter === "code")) {
          logger.warn({ name: payload.name, parameter }, "MoySklad product create retry without shared article");
          delete payload.article;
          delete payload.code;
          continue;
        }
        logger.warn({ name: wanted, parameter, err: error instanceof Error ? error.message : error }, "MoySklad product create recovered lookup");
        if (writeDropped(error)) {
          await sleep(400);
          continue;
        }
        break;
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
  const fallback = wanted ? await recoverExistingProduct(wanted) : null;
  if (fallback) return fallback;
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
  const wanted = normalizeBordoColor(color);
  if (!wanted) return null;
  const found = known.find((row) => sameBordoColor(variantColor(row), wanted));
  if (found?.id) return found;
  const rang = await colorCharacteristic();
  if (!rang || !product.meta) return null;
  const prices = (product.salePrices ?? []).filter((price) => price.priceType?.meta && price.value != null);
  const barcode = nextInternalEan13(catalog, used);
  const attempts: Array<Record<string, unknown>> = [
    {
      product: { meta: product.meta },
      characteristics: [{ id: rang.id, name: rang.name, meta: entityMeta(rang.href, "attributemetadata"), value: wanted }],
      barcodes: [{ ean13: barcode }],
      ...(prices.length ? { salePrices: prices.map((price) => ({ value: price.value, currency: price.currency, priceType: { meta: price.priceType?.meta } })) } : {}),
    },
    {
      product: { meta: product.meta },
      characteristics: [{ id: rang.id, name: rang.name, meta: entityMeta(rang.href, "attributemetadata"), value: wanted }],
      barcodes: [{ ean13: barcode }],
    },
    {
      product: { meta: product.meta },
      characteristics: [{ id: rang.id, name: rang.name, meta: entityMeta(rang.href, "attributemetadata"), value: wanted }],
    },
  ];
  for (const body of attempts) {
    try {
      const created = await moyskladSend<VariantRow>("/entity/variant", body);
      used.add(barcode);
      known.push({ ...created, characteristics: [{ name: "rang", value: wanted }] });
      return created;
    } catch (error) {
      const rows = await variantsOf(product.id).catch(() => known);
      known.splice(0, known.length, ...rows);
      const hit = rows.find((row) => sameBordoColor(variantColor(row), wanted));
      if (hit?.id) return hit;
      const parameter = uniqueNameParameter(error);
      if (parameter === "barcodes" && body.barcodes) {
        const next = nextInternalEan13(catalog, used);
        body.barcodes = [{ ean13: next }];
        logger.warn({ color, product: product.name, parameter }, "MoySklad variant barcode retry");
        continue;
      }
      if (uniqueNameConflict(error) || permissionDenied(error)) {
        logger.warn({ color, product: product.name, err: error instanceof Error ? error.message : error }, "MoySklad variant create skipped");
        if (body !== attempts[attempts.length - 1]) continue;
        return null;
      }
      if (!(error instanceof MoySkladError)) throw error;
      if (body === attempts[attempts.length - 1]) throw error;
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
    sales?: Partial<Record<string, number>> | null;
    article: string;
    description?: string;
    packSize: number;
    catalog: Catalog;
    used: Set<string>;
  },
): Promise<ProductRow> {
  const colorName = normalizeBordoColor(color);
  const names = [`${parent.name || ""} ${colorName}`.trim(), `${parent.name || ""} (${colorName})`.trim()];
  for (const name of names) {
    const existing = await productByName(name);
    if (existing && recoveredCardFits(existing, parent.name || name)) return existing;
  }
  const name = names[0];
  const sale = extras.price > 0 && extras.priceType ? (markedSale(extras.price, extras.priceType, loadMarkup()) ?? extras.price) : extras.price;
  const listed = extras.sales
    ? await listedAllPrices(undefined, extras.sales, extras.currencyMeta)
    : (sale > 0 ? await listedPrices(undefined, extras.priceType, sale, extras.currencyMeta) : null);
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
  return created;
}

type FolderRow = { id: string; name: string; pathName?: string; meta: Meta; parent?: Meta | null };

let folderCache: FolderRow[] | null = null;

async function productFolders(force = false): Promise<FolderRow[]> {
  if (!force && folderCache?.length) return folderCache;
  const folders: FolderRow[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const page = await moysklad<{ meta?: { size?: number }; rows: Array<{ id?: string; name?: string; pathName?: string; meta?: Meta; productFolder?: { meta?: Meta } }> }>(`/entity/productfolder?limit=100&offset=${offset}`);
    for (const row of page.rows) {
      if (row.id && row.name && row.meta) folders.push({ id: row.id, name: row.name, pathName: row.pathName, meta: row.meta, parent: row.productFolder?.meta ?? null });
    }
    if (folders.length >= (page.meta?.size ?? folders.length)) break;
  }
  folderCache = folders;
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
    try {
      const fresh = await productFolders(true);
      folders.splice(0, folders.length, ...fresh);
      const hit = matchProductFolder(folders, code);
      if (hit) return hit;
    } catch {
      /* keep the create error */
    }
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

async function listedAllPrices(current: Price[] | undefined, sales: Partial<Record<string, number>>, currencyMeta: Meta): Promise<Price[] | null> {
  const fromProduct = asPriceTypes((current ?? []).map((price) => ({ name: price.priceType?.name, meta: price.priceType?.meta })));
  const types = new Map<string, { name: string; meta: Meta }>();
  for (const row of [...fromProduct, ...(await saleTypes())]) {
    if (!types.has(row.meta.href)) types.set(row.meta.href, row);
  }
  if (!types.size) return null;
  const rows = [...types.values()].map((type) => {
    const existing = (current ?? []).find((price) => price.priceType?.meta?.href === type.meta.href);
    const som = Object.entries(sales).find(([name, value]) => samePriceType(name, type.name) && typeof value === "number" && value > 0)?.[1];
    const keep = (existing?.value ?? 0) > 0 ? existing?.value : null;
    return {
      value: keep ?? (som != null ? Math.round(som * 100) : 0),
      currency: existing?.currency ?? { meta: currencyMeta },
      priceType: { meta: type.meta, name: type.name },
    };
  });
  return rows.some((row) => (row.value ?? 0) > 0) ? rows : null;
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

function hasAllSaleMarkups(prices?: Price[]) {
  const present = (prices ?? []).filter((price) => (price.value ?? 0) > 0 && price.priceType?.name);
  return SALE_TYPES.every((type) => present.some((price) => samePriceType(price.priceType?.name || "", type)));
}

function saleForLine(line: ShipmentLine) {
  const type = saleTypeOf(line);
  if (!(line.price > 0) || !type) return { type, sale: 0 };
  return { type, sale: markedSale(line.price, type, loadMarkup(), line.markupPct) ?? line.price };
}

function salesForLine(line: ShipmentLine) {
  const requested = {
    Premium: line.markup?.Premium ?? (line.priceType === "Premium" ? line.markupPct ?? undefined : undefined),
    Exclusive: line.markup?.Exclusive ?? (line.priceType === "Exclusive" ? line.markupPct ?? undefined : undefined),
    Standard: line.markup?.Standard ?? (line.priceType === "Standard" ? line.markupPct ?? undefined : undefined),
  };
  const markups = resolveMarkups(requested);
  return salesOf(line.price, markups);
}

export async function stampWaybillCardPrices(
  lines: ShipmentLine[],
  currencyMeta: Meta,
  scope: { factoryCode: string; factoryName: string; catalog: Catalog; supplierMeta?: Meta | null },
) {
  const seen = new Set<string>();
  for (const line of lines) {
    if (!(line.price > 0)) continue;
    const name = ["Bordo", canonicalFactoryCode(scope.factoryCode || line.factoryCode, scope.factoryCode), line.sectionCode, line.productCode, normalizeBordoSize(line.size)].filter(Boolean).join(" ").trim();
    const matched = await findExistingBordoProduct(line, scope);
    if (!matched?.id || seen.has(matched.id)) continue;
    seen.add(matched.id);
    const priced = saleForLine(line);
    await writeProductCard(matched.id, priced.sale, priced.type, currencyMeta, {
      supplierMeta: scope.supplierMeta,
      description: cardDescription(line),
      packSize: packSizeOf(line),
      buySom: line.price,
      sales: salesForLine(line) ?? undefined,
    });
  }
}

function productIdentity(line: ShipmentLine, factoryCode: string) {
  return [
    compactCode(canonicalFactoryCode(factoryCode || line.factoryCode, factoryCode)),
    compactCode(line.sectionCode),
    compactCode(line.productCode),
    compactCode(normalizeBordoSize(line.size)),
  ].join("\0");
}

function parentIdentity(line: ShipmentLine, factoryCode: string) {
  return [
    compactCode(canonicalFactoryCode(factoryCode || line.factoryCode, factoryCode)),
    compactCode(line.productCode),
    compactCode(normalizeBordoSize(line.size)),
  ].join("\0");
}

function acceptFactoryProduct(
  row: ProductRow | null,
  scope: { factoryCode: string; factoryName: string; catalog: Catalog },
  line: { factoryCode?: string; sectionCode?: string; productCode: string; size: string },
): ProductRow | null {
  if (!row?.id) return null;
  const factory = canonicalFactoryCode(scope.factoryCode || line.factoryCode, scope.factoryCode);
  const catalogProduct = scope.catalog.products.find((product) => product.id === row.id);
  const name = row.name || catalogProduct?.name || "";
  const probe = { name, factory: catalogProduct?.factory ?? null };
  if (!productBelongsToFactory(probe, factory, scope.factoryName)) return null;
  const parts = parseBordoName(name);
  if (!parts) return null;
  if (line.productCode.trim() && !productCodeMatches(parts.productCode, line.productCode)) return null;
  if (line.size.trim() && compactCode(parts.size) !== compactCode(normalizeBordoSize(line.size))) return null;
  const group = compactCode(line.sectionCode || "");
  if (group && parts.groupCode && compactCode(parts.groupCode) !== group) return null;
  return row;
}

export async function findExistingBordoProduct(
  line: { factoryCode?: string; sectionCode?: string; productCode: string; size: string; productId?: string | null },
  scope: { factoryCode: string; factoryName: string; catalog: Catalog },
): Promise<ProductRow | null> {
  const factory = canonicalFactoryCode(scope.factoryCode || line.factoryCode, scope.factoryCode);
  const groupCode = line.sectionCode || "";
  const size = normalizeBordoSize(line.size);
  const name = ["Bordo", factory, groupCode, line.productCode, size].filter(Boolean).join(" ").trim();
  const remembered = acceptFactoryProduct(cachedByName(name), scope, line);
  if (remembered) return remembered;
  const localId = String(line.productId || "").trim();
  if (localId) {
    const local = scope.catalog.products.find((product) => product.id === localId);
    const loaded = local
      ? {
        id: local.id,
        name: local.name || name,
        meta: entityMeta(`${BASE}/entity/product/${local.id}`, "product"),
      }
      : await productById(localId);
    const accepted = acceptFactoryProduct(loaded, scope, line);
    if (accepted) return rememberProduct(accepted, [name]);
  }
  const catalogMatch = matchWaybillProduct(scope.catalog, {
    factoryCode: factory,
    factoryName: scope.factoryName,
    groupCode,
    productCode: line.productCode,
    size,
  });
  if (catalogMatch?.id) {
    const listed = scope.catalog.products.find((product) => product.id === catalogMatch.id);
    const accepted = acceptFactoryProduct({
      id: catalogMatch.id,
      name: catalogMatch.name || listed?.name || name,
      meta: entityMeta(`${BASE}/entity/product/${catalogMatch.id}`, "product"),
    }, scope, line);
    if (accepted) return rememberProduct(accepted, [name]);
  }
  const named = name.length >= 2 ? acceptFactoryProduct(await productByName(name), scope, line) : null;
  if (named) return named;
  const code = line.productCode.trim();
  if (code.length < 2) return null;
  try {
    const page = await moysklad<{ rows: Array<{ id?: string; name?: string }> }>(`/entity/product?limit=50&search=${encodeURIComponent(code)}`);
    const rows = page.rows.filter((row): row is { id: string; name: string } => Boolean(row.id && row.name));
    const matched = matchNamedProducts(rows, {
      factoryCode: factory,
      factoryName: scope.factoryName,
      groupCode,
      productCode: line.productCode,
      size,
    }) || matchNamedProducts(rows, {
      factoryCode: factory,
      factoryName: scope.factoryName,
      groupCode: "",
      productCode: line.productCode,
      size,
    });
    if (matched?.id) {
      const row = acceptFactoryProduct(await productById(matched.id), scope, line);
      if (row) return rememberProduct(row, [name]);
    }
    const identity = rows.find((row) => sameBordoCard(row.name, {
      factoryCode: factory,
      productCode: line.productCode,
      size,
      groupCode,
    }));
    if (identity?.id) {
      const row = acceptFactoryProduct(await productById(identity.id), scope, line);
      if (row) return rememberProduct(row, [name]);
    }
  } catch (error) {
    if (!permissionDenied(error) && !(error instanceof MoySkladError)) throw error;
    logger.warn({ code, err: error instanceof Error ? error.message : error }, "MoySklad product search skipped");
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
  const wanted = lines.filter((line) => receiptParts(line).length);
  for (const line of wanted) requireWaybillLine(line);
  resolved.push(...await Promise.all(wanted.map(async (line) => {
    const name = ["Bordo", canonicalFactoryCode(scope.factoryCode || line.factoryCode, scope.factoryCode), line.sectionCode, line.productCode, normalizeBordoSize(line.size)].filter(Boolean).join(" ").trim();
    const parent = await findExistingBordoProduct(line, scope);
    if (parent) rememberProduct(parent, [name]);
    if (parent?.name) {
      const parsed = parseBordoName(parent.name);
      if (parsed?.groupCode) line.sectionCode = parsed.groupCode;
    }
    const key = parent?.id || (line.sectionCode.trim() ? productIdentity(line, scope.factoryCode) : parentIdentity(line, scope.factoryCode));
    const priceType = saleTypeOf(line);
    if (line.price > 0) line.priceType = priceType;
    if (!parent && (!line.productCode.trim() || name.length < 2)) {
      throw new MoySkladError(`Mahsulot kodi kiritilmagan${line.size ? ` (${line.size})` : ""}`, 400);
    }
    return { line, parent, name, key, folder: null as FolderRow | null };
  })));
  if (!resolved.length) throw new MoySkladError("Kirim qatorlari bo‘sh", 400);

  const byIdentity = new Map<string, ProductRow>();
  const byName = new Map<string, ProductRow>();
  for (const item of resolved) {
    const known = item.parent || byIdentity.get(item.key) || byName.get(item.name) || null;
    if (known) {
      item.parent = known;
      parents.set(known.id, known);
      byIdentity.set(item.key, known);
      byName.set(item.name, known);
      continue;
    }
    const packSize = packSizeOf(item.line);
    const folders = await productFolders();
    const folder = item.folder ?? await ensureFolder(folders, item.line.sectionCode);
    item.folder = folder;
    const barcode = nextInternalEan13(scope.catalog, usedBarcodes);
    usedBarcodes.add(barcode);
    const sales = salesForLine(item.line);
    const listed = sales ? await listedAllPrices(undefined, sales, currencyMeta) : null;
    const product = await createProduct({
      name: item.name,
      uom: { meta: uomMeta(PIECE_UOM) },
      barcodes: [{ ean13: barcode }],
      ...(folder ? { productFolder: { meta: folder.meta } } : {}),
      ...(scope.supplierMeta ? { supplier: { meta: scope.supplierMeta } } : {}),
      ...(packSize ? { packs: [{ quantity: packSize, uom: { meta: uomMeta(PACHKA_UOM) } }] } : {}),
      ...(item.line.price > 0 ? { buyPrice: { value: Math.round(item.line.price * 100), currency: { meta: currencyMeta } } } : {}),
      ...(listed ? { salePrices: priceBody(listed) } : {}),
    });
    if (listed) product.salePrices = listed;
    if (folder) product.folderName = folder.name;
    product.barcodes = barcodeValues(product.barcodes);
    const createdPack = (product.packs ?? []).find((pack) => pack.id && pack.quantity === packSize);
    if (createdPack?.uom?.meta) packCache.set(`${product.id}:${packSize}`, createdPack);
    item.parent = product;
    parents.set(product.id, product);
    byIdentity.set(item.key, product);
    byName.set(item.name, product);
    if (!created.some((row) => row.id === product.id)) created.push(product);
  }

  const folders = await productFolders();
  for (const item of resolved) {
    if (item.folder || !item.line.sectionCode.trim()) continue;
    item.folder = await ensureFolder(folders, item.line.sectionCode);
  }
  const stamped = new Set<string>();
  for (const item of resolved) {
    const product = item.parent;
    if (!product || stamped.has(product.id)) continue;
    stamped.add(product.id);
    const priced = saleForLine(item.line);
    await writeProductCard(product.id, priced.sale, priced.type, currencyMeta, {
      supplierMeta: scope.supplierMeta,
      folderMeta: item.folder?.meta ?? null,
      description: cardDescription(item.line),
      packSize: packSizeOf(item.line),
      buySom: item.line.price,
      sales: salesForLine(item.line) ?? undefined,
    });
  }

  const colorIds = [...new Set(resolved.flatMap((item) => (item.parent && receiptParts(item.line).some((part) => part.color) ? [item.parent.id] : [])))];
  await Promise.all(colorIds.map(async (id) => {
    if (!variantCache.has(id)) variantCache.set(id, await variantsOf(id));
  }));

  const positions: SupplyPosition[] = [];
  const links: Planned["links"] = [];
  for (const item of resolved) {
    const parent = item.parent;
    if (!parent) throw new MoySkladError("Mahsulot yaratilmadi", 400);
    const product = parents.get(parent.id) ?? parent;
    if (!product.meta?.href) product.meta = entityMeta(`${BASE}/entity/product/${product.id}`, "product");
    links.push({ lineId: item.line.id, product: { id: product.id, name: product.name || item.name } });
    const parts = receiptParts(item.line);
    let known = variantCache.get(product.id);
    if (!known && parts.some((part) => part.color)) {
      known = await variantsOf(product.id);
      variantCache.set(product.id, known);
    }
    known = known ?? [];
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
      const variant = await ensureVariant(product, part.color, known, scope.catalog, usedBarcodes);
      let assortment: { meta: Meta };
      let stockId: string;
      if (variant?.id) {
        assortment = { meta: variant.meta?.href ? variant.meta : entityMeta(`${BASE}/entity/variant/${variant.id}`, "variant") };
        stockId = variant.id;
      } else {
        const refreshed = await variantsOf(product.id);
        known.splice(0, known.length, ...refreshed);
        variantCache.set(product.id, known);
        const existingVariant = known.find((row) => sameBordoColor(variantColor(row), part.color));
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
        const colorWanted = `${product.name} ${part.color}`;
        const existingColor = [await productByName(colorWanted), await productByName(`${product.name} (${part.color})`)]
          .find((row) => row && recoveredCardFits(row, product.name || colorWanted));
        if (existingColor?.id) {
          if (!existingColor.meta?.href) existingColor.meta = entityMeta(`${BASE}/entity/product/${existingColor.id}`, "product");
          const priced = saleForLine(item.line);
          await writeProductCard(existingColor.id, priced.sale, priced.type, currencyMeta, {
            supplierMeta: scope.supplierMeta,
            folderMeta: item.folder?.meta ?? null,
            packSize: packSizeOf(item.line),
            buySom: item.line.price,
            sales: salesForLine(item.line) ?? undefined,
          });
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
          sales: salesForLine(item.line),
          article: "",
          description: cardDescription(item.line),
          packSize: packSizeOf(item.line),
          catalog: scope.catalog,
          used: usedBarcodes,
        });
        if (!colored.meta?.href) colored.meta = entityMeta(`${BASE}/entity/product/${colored.id}`, "product");
        const priced = saleForLine(item.line);
        await writeProductCard(colored.id, priced.sale, priced.type, currencyMeta, {
          supplierMeta: scope.supplierMeta,
          folderMeta: item.folder?.meta ?? null,
          packSize: packSizeOf(item.line),
          buySom: item.line.price,
          sales: salesForLine(item.line) ?? undefined,
        });
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
  const collapsed: SupplyPosition[] = [];
  for (const position of positions) {
    const href = position.assortment.meta.href;
    const prev = collapsed.find((item) => item.stockId === position.stockId && item.price === position.price && item.assortment.meta.href === href);
    if (prev) {
      prev.quantity += position.quantity;
      continue;
    }
    collapsed.push({ ...position });
  }
  return { positions: collapsed, links, created };
}
