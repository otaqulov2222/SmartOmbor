import type { Catalog, CatalogProduct } from "./catalog";

const COVER_DAYS = 30;

export interface OrderLine {
  product: CatalogProduct;
  warehouseId: string;
  dailyAverage: number;
  leadTimeDays: number;
  safetyStock: number;
  onHand: number;
  inTransit: number;
  suggestedQuantity: number;
  reason: "out_of_stock" | "fast" | "low_stock";
}

export function orderRecommendations(catalog: Catalog, warehouseId?: string): OrderLine[] {
  const scoped = warehouseId
    ? catalog.stockRows
        .filter((row) => row.warehouse.id === warehouseId)
        .map((row) => ({ product: row.product, onHand: row.quantity, inTransit: row.inTransit, warehouseId: row.warehouse.id }))
    : catalog.products.map((product) => ({
        product,
        onHand: product.stock,
        inTransit: product.inTransit,
        warehouseId: catalog.warehouses[0]?.id ?? "all",
      }));

  const lines: OrderLine[] = [];
  for (const row of scoped) {
    const windowSales = row.product.sales30 > 0 ? row.product.sales30 : row.product.sales7;
    const windowDays = row.product.sales30 > 0 ? 30 : 7;
    if (windowSales <= 0) continue;
    const daily = windowSales / windowDays;
    const target = Math.ceil(daily * COVER_DAYS);
    const suggested = Math.max(0, target - row.onHand - row.inTransit);
    if (suggested < 1) continue;
    const cover = row.onHand / daily;
    if (cover >= COVER_DAYS) continue;
    lines.push({
      product: row.product,
      warehouseId: row.warehouseId,
      dailyAverage: Math.round(daily * 100) / 100,
      leadTimeDays: COVER_DAYS,
      safetyStock: target,
      onHand: row.onHand,
      inTransit: row.inTransit,
      suggestedQuantity: suggested,
      reason: row.onHand <= 0 ? "out_of_stock" : cover < 7 ? "fast" : "low_stock",
    });
  }
  lines.sort((a, b) => b.dailyAverage * b.suggestedQuantity - a.dailyAverage * a.suggestedQuantity || b.suggestedQuantity - a.suggestedQuantity);
  return lines.slice(0, 80);
}

export function orderBasis(line: OrderLine) {
  const windowDays = line.product.sales30 > 0 ? 30 : 7;
  const sold = windowDays === 30 ? line.product.sales30 : line.product.sales7;
  const daily = windowDays > 0 ? sold / windowDays : 0;
  const coverDays = daily > 0 ? Math.round((line.onHand / daily) * 10) / 10 : 0;
  return { windowDays, sold, coverDays, target: line.safetyStock, coverTarget: line.leadTimeDays };
}

const COLOR_WORDS: Array<[RegExp, string]> = [
  [/\bqora\b|\bчерн/i, "qora"],
  [/\boq\b|\bбел(ый|ая|ое)?\b/i, "oq"],
  [/\bjigarrang\b|\bкоричнев/i, "jigarrang"],
  [/\bsariq\b|\bж[её]лт/i, "sariq"],
  [/\bqizil\b|\bкрасн/i, "qizil"],
  [/\bko['’‘]?k\b|\bсин(ий|яя|ее)?\b/i, "kok"],
  [/\byashil\b|\bзел[её]н/i, "yashil"],
  [/\bkulrang\b|\bсер(ый|ая|ое)?\b/i, "kulrang"],
  [/\bbej\b|\bбеж/i, "bej"],
  [/\bpushti\b|\bрозов/i, "pushti"],
];

export function productTraits(name: string): { size: string | null; color: string | null } {
  const sizeMatch = [...name.matchAll(/(\d{2})\s*[-–]\s*(\d{2})/g)].pop();
  const color = COLOR_WORDS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
  return { size: sizeMatch ? `${sizeMatch[1]}-${sizeMatch[2]}` : null, color };
}
