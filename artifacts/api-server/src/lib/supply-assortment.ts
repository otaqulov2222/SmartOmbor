import { matchWaybillProduct, type Catalog } from "./catalog";
import type { ShipmentLine } from "./partners";
import { MoySkladError, moysklad, moyskladSend } from "./moysklad";

const BASE = "https://api.moysklad.ru/api/remap/1.2";
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

async function ensurePachka(productId: string, packSize: number): Promise<GoodsPack | null> {
  const current = await moysklad<{ uom?: { meta?: Meta }; packs?: GoodsPack[] }>(`/entity/product/${productId}?expand=packs.uom,uom`);
  const packs = current.packs ?? [];
  const pachka = packs.find((pack) => pack.uom?.name?.trim().toLowerCase() === "pachka");
  if (!(packSize > 1)) {
    if (!current.uom) await moyskladSend(`/entity/product/${productId}`, { uom: { meta: uomMeta(PIECE_UOM) } }, "PUT");
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
  if (!(packSize > 1)) return null;
  const saved = (updated.packs ?? []).find((pack) => pack.quantity === packSize && pack.uom?.meta);
  if (saved?.id && saved.uom?.meta) return saved;
  const again = await moysklad<{ packs?: GoodsPack[] }>(`/entity/product/${productId}?expand=packs.uom`);
  return (again.packs ?? []).find((pack) => pack.uom?.name?.trim().toLowerCase() === "pachka" && pack.quantity === packSize) ?? null;
}

export function receiptParts(line: Pick<ShipmentLine, "pairs" | "boxes" | "quantity" | "colors">): Array<{ color: string | null; quantity: number }> {
  const pack = line.pairs > 0 ? line.pairs : 0;
  const colors = (line.colors ?? []).filter((color) => color.name.trim() && color.quantity > 0);
  if (pack > 0 && colors.length) return colors.map((color) => ({ color: color.name.trim(), quantity: color.quantity * pack }));
  if (pack > 0 && line.boxes > 0) return [{ color: null, quantity: pack * line.boxes }];
  const total = line.quantity > 0 ? line.quantity : pack;
  if (total <= 0) return [];
  if (!colors.length) return [{ color: null, quantity: total }];
  return colors.map((color) => ({ color: color.name.trim(), quantity: color.quantity }));
}

function sameColor(left: string, right: string) {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function variantColor(variant: VariantRow) {
  return (variant.characteristics ?? []).find((item) => item.name?.trim().toLowerCase() === "rang")?.value?.trim() || "";
}

let rangCharacteristic: { id: string; name: string; href: string } | null = null;

async function colorCharacteristic() {
  if (rangCharacteristic) return rangCharacteristic;
  const metadata = await moysklad<{ characteristics?: Array<{ id?: string; name?: string }> }>("/entity/variant/metadata");
  const found = (metadata.characteristics ?? []).find((item) => item.name?.trim().toLowerCase() === "rang" && item.id && item.name);
  if (!found?.id || !found.name) throw new MoySkladError("rang", 400);
  rangCharacteristic = { id: found.id, name: found.name, href: `${BASE}/entity/variant/metadata/characteristics/${found.id}` };
  return rangCharacteristic;
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

async function variantsOf(productId: string) {
  const page = await moysklad<{ rows: VariantRow[] }>(`/entity/variant?limit=100&filter=productid=${encodeURIComponent(productId)}&expand=characteristics`);
  return page.rows.filter((row) => row.id);
}

async function ensureVariant(product: ProductRow, color: string, known: VariantRow[]) {
  const found = known.find((row) => sameColor(variantColor(row), color));
  if (found?.id) return found;
  const rang = await colorCharacteristic();
  const prices = (product.salePrices ?? []).filter((price) => price.priceType?.meta && price.value != null);
  const body = {
    product: { meta: product.meta },
    characteristics: [{ id: rang.id, name: rang.name, meta: entityMeta(rang.href, "attributemetadata"), value: color }],
    ...(prices.length ? { salePrices: prices.map((price) => ({ value: price.value, currency: price.currency, priceType: { meta: price.priceType?.meta } })) } : {}),
  };
  let created: VariantRow;
  try {
    created = await moyskladSend<VariantRow>("/entity/variant", body);
  } catch (error) {
    if (!prices.length || !(error instanceof MoySkladError)) throw error;
    created = await moyskladSend<VariantRow>("/entity/variant", { product: body.product, characteristics: body.characteristics });
  }
  known.push({ ...created, characteristics: [{ name: "rang", value: color }] });
  return created;
}

export async function buildSupplyPositions(
  lines: ShipmentLine[],
  currencyMeta: Meta,
  scope: { factoryCode: string; factoryName: string; catalog: Catalog },
): Promise<Planned | null> {
  const parents = new Map<string, ProductRow>();
  const variantCache = new Map<string, VariantRow[]>();
  const packCache = new Map<string, GoodsPack | null>();
  const resolved: Array<{ line: ShipmentLine; parent: ProductRow | null; name: string }> = [];
  const created: ProductRow[] = [];

  for (const line of lines) {
    const parts = receiptParts(line);
    if (!parts.length) continue;
    const catalogMatch = matchWaybillProduct(scope.catalog, {
      factoryCode: scope.factoryCode,
      factoryName: scope.factoryName,
      productCode: line.productCode,
      size: line.size,
    });
    const parent: ProductRow | null = catalogMatch ? await productById(catalogMatch.id) : null;
    const name = ["Bordo", scope.factoryCode, line.productCode, line.model, line.size].filter(Boolean).join(" ").trim();
    if (!parent && (line.productCode.trim().length < 3 || name.length < 2)) return null;
    resolved.push({ line, parent, name });
  }

  for (const item of resolved) {
    if (item.parent) {
      parents.set(item.parent.id, item.parent);
      continue;
    }
    const code = item.line.productCode.trim();
    const packSize = item.line.pairs > 1 ? item.line.pairs : 0;
    const product = await moyskladSend<ProductRow & { packs?: GoodsPack[] }>("/entity/product", {
      name: item.name,
      uom: { meta: uomMeta(PIECE_UOM) },
      ...(packSize ? { packs: [{ quantity: packSize, uom: { meta: uomMeta(PACHKA_UOM) } }] } : {}),
      ...(code.length >= 8 ? { code } : {}),
      ...(item.line.price > 0 ? { buyPrice: { value: Math.round(item.line.price * 100), currency: { meta: currencyMeta } } } : {}),
    });
    const createdPack = (product.packs ?? []).find((pack) => pack.id && pack.quantity === packSize);
    if (createdPack?.uom?.meta) packCache.set(`${product.id}:${packSize}`, createdPack);
    item.parent = product;
    parents.set(product.id, product);
    created.push(product);
  }

  const positions: SupplyPosition[] = [];
  const links: Planned["links"] = [];
  for (const item of resolved) {
    const parent = item.parent;
    if (!parent) return null;
    const full = parents.get(parent.id) ?? parent;
    if (!full.salePrices) {
      const loaded = await productById(full.id);
      if (loaded) parents.set(full.id, loaded);
    }
    const product = parents.get(parent.id) ?? full;
    if (!product.meta?.href) product.meta = entityMeta(`${BASE}/entity/product/${product.id}`, "product");
    links.push({ lineId: item.line.id, product: { id: product.id, name: product.name || item.name } });
    const parts = receiptParts(item.line);
    const packSize = item.line.pairs > 1 ? item.line.pairs : 0;
    const packKey = `${product.id}:${packSize}`;
    if (!packCache.has(packKey)) packCache.set(packKey, await ensurePachka(product.id, packSize));
    const salePack = packCache.get(packKey);
    const pack = salePack?.id && salePack.uom?.meta ? { id: salePack.id, quantity: salePack.quantity, uom: { meta: salePack.uom.meta } } : undefined;
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
          ...(pack ? { pack } : {}),
        });
        continue;
      }
      const variant = await ensureVariant(product, part.color, known ?? []);
      positions.push({
        quantity: part.quantity,
        price: Math.round(item.line.price * 100),
        assortment: { meta: variant.meta?.href ? variant.meta : entityMeta(`${BASE}/entity/variant/${variant.id}`, "variant") },
        stockId: variant.id,
        ...(pack ? { pack } : {}),
      });
    }
  }
  return { positions, links, created };
}
