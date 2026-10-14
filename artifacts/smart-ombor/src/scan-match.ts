import type { BarcodeLocation, BarcodeLookup, Product } from '@workspace/api-client-react';

type Row = {
  id: string;
  name: string;
  code: string | null;
  article: string | null;
  barcodes: string[];
  imageUrl: string | null;
  stock: number;
  salePrice: number | null;
  stockStatus: Product['stockStatus'];
  locations: BarcodeLocation[];
};

type Built = { barcode: Map<string, Row[]>; name: Map<string, Row[]> };

let built: Built | null = null;
let loading: Promise<void> | null = null;

function compact(value: string) {
  return value.trim().replace(/[\s-]/g, '').toLowerCase();
}

function indexKeys(value: string) {
  const key = compact(value);
  if (key.length < 3) return [];
  const keys = [key];
  if (/^\d+$/.test(key) && key.length >= 8) {
    const bare = key.replace(/^0+/, '');
    if (bare.length >= 6) keys.push(bare);
    if (key.length === 12) keys.push(`0${key}`);
    if (key.length === 13 && key.startsWith('0')) keys.push(key.slice(1));
  }
  return keys;
}

function lookupKeys(value: string) {
  const key = compact(value);
  if (key.length < 3) return [];
  const keys = new Set(indexKeys(key));
  if (/^\d+$/.test(key) && key.length >= 4 && key.length < 6) keys.add(key.padStart(6, '0'));
  if (/^\d+$/.test(key) && key.length === 12) keys.add(`0${key}`);
  return [...keys];
}

function labelTokens(value: string) {
  const normalized = value.toLowerCase().replace(/[–—]/g, '-');
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/\d{2}-\d{2}/g)) tokens.add(match[0]);
  const withoutSizes = normalized.replace(/\d{2}-\d{2}/g, ' ');
  for (const match of withoutSizes.matchAll(/\d+/g)) {
    if (match[0].length >= 3 && match[0].length <= 6) tokens.add(match[0]);
  }
  return [...tokens];
}

function eanCheck(code: string) {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop() ?? -1;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) sum += digits[digits.length - 1 - i] * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === check;
}

function asProduct(row: Row): Product {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    article: row.article,
    barcodes: row.barcodes,
    factory: null,
    category: null,
    unit: null,
    packType: null,
    packSize: 1,
    imageUrl: row.imageUrl,
    stock: row.stock,
    available: row.stock,
    cost: null,
    salePrice: row.salePrice,
    lastSale: null,
    lastReceipt: null,
    sales7: 0,
    sales30: 0,
    sales60: 0,
    sales90: 0,
    daysCover: null,
    stockStatus: row.stockStatus,
  };
}

function lookup(rows: Row[], barcode: string, locations: BarcodeLocation[]): BarcodeLookup {
  return { barcode, ambiguous: rows.length > 1, products: rows.map(asProduct), locations };
}

function byBarcode(index: Built, raw: string) {
  const found = new Map<string, Row>();
  for (const key of lookupKeys(raw)) {
    for (const row of index.barcode.get(key) ?? []) found.set(row.id, row);
  }
  return [...found.values()];
}

function byLabel(index: Built, raw: string) {
  const useful = labelTokens(raw).filter(token => (index.name.get(token)?.length ?? 0) > 0);
  if (useful.length < 2) return [];
  let ids: Set<string> | null = null;
  const byId = new Map<string, Row>();
  for (const token of useful) {
    const list = index.name.get(token) ?? [];
    for (const row of list) byId.set(row.id, row);
    const next = new Set(list.map(row => row.id));
    ids = ids === null ? next : new Set([...ids].filter(id => next.has(id)));
    if (ids.size === 0) return [];
  }
  if (!ids || ids.size === 0 || ids.size > 6) return [];
  if (ids.size > 1 && useful.length < 3) return [];
  return [...ids].map(id => byId.get(id)).filter((row): row is Row => !!row);
}

export function scanIndexReady() {
  return built != null;
}

export function matchScan(code: string, text: string): BarcodeLookup | null {
  if (!built) return null;
  const clean = code.trim();
  if (clean) {
    const products = byBarcode(built, clean);
    if (products.length) return lookup(products, clean, products[0].locations);
    const runs = [...new Set(clean.match(/\d{8,14}/g) ?? [])];
    const ordered = [...runs.filter(eanCheck), ...runs.filter(value => !eanCheck(value))];
    for (const run of ordered) {
      const extra = byBarcode(built, run);
      if (extra.length) return lookup(extra, run, extra[0].locations);
    }
  }
  const rows = byLabel(built, `${text} ${clean}`);
  if (!rows.length && !clean) return lookup([], '', []);
  return lookup(rows, clean, rows[0]?.locations ?? []);
}

export function loadScanIndex() {
  if (built) return Promise.resolve();
  if (!loading) {
    loading = fetch('/api/scan-index').then(async response => {
      if (!response.ok) throw new Error('index');
      const body = await response.json() as { products?: Row[] };
      if (!body.products?.length) throw new Error('empty');
      const barcode = new Map<string, Row[]>();
      const name = new Map<string, Row[]>();
      for (const row of body.products) {
        for (const value of [row.code, row.article, ...(row.barcodes ?? [])]) {
          if (!value) continue;
          for (const key of indexKeys(value)) {
            const list = barcode.get(key);
            if (list) { if (!list.some(item => item.id === row.id)) list.push(row); }
            else barcode.set(key, [row]);
          }
        }
        for (const token of labelTokens(`${row.name} ${row.article ?? ''}`)) {
          const list = name.get(token);
          if (list) { if (!list.some(item => item.id === row.id)) list.push(row); }
          else name.set(token, [row]);
        }
      }
      built = { barcode, name };
    }).catch(() => {
      loading = null;
      window.setTimeout(() => { void loadScanIndex(); }, 5000);
    });
  }
  return loading;
}
