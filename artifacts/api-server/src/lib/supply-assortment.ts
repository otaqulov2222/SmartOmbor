import { matchWaybillProduct, type Catalog } from "./catalog";
import type { ShipmentLine } from "./partners";
import { MoySkladError, moysklad, moyskladSend } from "./moysklad";

const BASE = "https://api.moysklad.ru/api/remap/1.2";

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
};

type Planned = {
  positions: SupplyPosition[];
  links: Array<{ lineId: string; product: { id: string; name: string } }>;
  created: ProductRow[];
};

function entityMeta(href: string, type: string): Meta {
  return { href, type, mediaType: "application/json" };
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
    const product = await moyskladSend<ProductRow>("/entity/product", {
      name: item.name,
      ...(code.length >= 8 ? { code } : {}),
      ...(item.line.price > 0 ? { buyPrice: { value: Math.round(item.line.price * 100), currency: { meta: currencyMeta } } } : {}),
    });
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
      const variant = await ensureVariant(product, part.color, known ?? []);
      positions.push({
        quantity: part.quantity,
        price: Math.round(item.line.price * 100),
        assortment: { meta: variant.meta?.href ? variant.meta : entityMeta(`${BASE}/entity/variant/${variant.id}`, "variant") },
        stockId: variant.id,
      });
    }
  }
  return { positions, links, created };
}
