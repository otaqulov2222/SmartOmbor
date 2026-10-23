import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./data-dir";

const FILE = dataFile("markup.json");

export const SALE_TYPES = ["Premium", "Exclusive", "Standard"] as const;
export const SALE_READ_ORDER = ["Exclusive", "Premium", "Standard"] as const;
export type SaleType = (typeof SALE_TYPES)[number];
export type SaleMarkup = Record<SaleType, number>;

export const DEFAULT_MARKUP: SaleMarkup = { Premium: 5, Exclusive: 10, Standard: 13 };

let memory: SaleMarkup | undefined;

export function parsePct(value: unknown): number | null {
  if (value == null || value === "") return null;
  const next = Math.round(Number(value));
  if (!Number.isFinite(next) || next < 0 || next > 99) return null;
  return next;
}

export function parseMarkups(raw: unknown, fallbackType?: string, fallbackPct?: unknown): Partial<SaleMarkup> {
  const src = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const out: Partial<SaleMarkup> = {};
  for (const type of SALE_TYPES) {
    const pct = parsePct(src[type]);
    if (pct != null) out[type] = pct;
  }
  if (SALE_TYPES.includes(fallbackType as SaleType) && out[fallbackType as SaleType] == null) {
    const pct = parsePct(fallbackPct);
    if (pct != null) out[fallbackType as SaleType] = pct;
  }
  return out;
}

function clamp(value: unknown, fallback: number) {
  return parsePct(value) ?? fallback;
}

function normalize(raw: Partial<SaleMarkup> | null | undefined): SaleMarkup {
  return {
    Premium: clamp(raw?.Premium, DEFAULT_MARKUP.Premium),
    Exclusive: clamp(raw?.Exclusive, DEFAULT_MARKUP.Exclusive),
    Standard: clamp(raw?.Standard, DEFAULT_MARKUP.Standard),
  };
}

export function loadMarkup(): SaleMarkup {
  if (memory) return memory;
  try {
    memory = normalize(JSON.parse(readFileSync(FILE, "utf8")) as Partial<SaleMarkup>);
  } catch {
    memory = { ...DEFAULT_MARKUP };
  }
  return memory;
}

export function saveMarkup(input: Partial<SaleMarkup>): SaleMarkup {
  const next = normalize({ ...loadMarkup(), ...input });
  mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, FILE);
  memory = next;
  return next;
}

export function markupFromPrices(cost: number | null | undefined, sale: number | null | undefined): number | null {
  if (!(typeof cost === "number" && cost > 0) || !(typeof sale === "number" && sale > 0)) return null;
  return parsePct(((sale / cost) - 1) * 100);
}

export function markedSale(cost: number, priceType: string, markup = loadMarkup(), pct?: number | null): number | null {
  const rate = parsePct(pct) ?? (SALE_TYPES.includes(priceType as SaleType) ? markup[priceType as SaleType] : undefined);
  if (rate == null || !(cost > 0)) return null;
  return Math.round(cost * (100 + rate) / 100);
}

export function resolveMarkups(
  requested?: Partial<SaleMarkup> | null,
  inherited?: Partial<SaleMarkup> | null,
  defaults = loadMarkup(),
): SaleMarkup {
  const pick = (key: SaleType) => parsePct(inherited?.[key]) ?? parsePct(requested?.[key]) ?? defaults[key];
  return { Premium: pick("Premium"), Exclusive: pick("Exclusive"), Standard: pick("Standard") };
}

export function salesOf(cost: number, markups: SaleMarkup): Record<SaleType, number> | null {
  if (!(cost > 0)) return null;
  return {
    Premium: Math.round(cost * (100 + markups.Premium) / 100),
    Exclusive: Math.round(cost * (100 + markups.Exclusive) / 100),
    Standard: Math.round(cost * (100 + markups.Standard) / 100),
  };
}

export function markupsFromSales(cost: number | null | undefined, sales: Partial<Record<SaleType, number | null | undefined>>): Partial<SaleMarkup> {
  const out: Partial<SaleMarkup> = {};
  for (const type of SALE_TYPES) {
    const pct = markupFromPrices(cost, sales[type] ?? null);
    if (pct != null) out[type] = pct;
  }
  return out;
}
