type ScanProduct = { id: string; name: string };
type ScanHit = { barcode: string; ambiguous?: boolean; products: ScanProduct[]; locations?: unknown[] };

let items: ScanHit[] = [];
let revision = 0;

function keyOf(hit: ScanHit) {
  return hit.products.map((product) => product.id).sort().join("-");
}

function readable(body: unknown): ScanHit | null {
  if (!body || typeof body !== "object") return null;
  const hit = body as ScanHit;
  if (!Array.isArray(hit.products) || hit.products.length === 0) return null;
  if (!hit.products.every((product) => product && typeof product.id === "string" && product.id && typeof product.name === "string")) return null;
  return { ...hit, barcode: typeof hit.barcode === "string" ? hit.barcode : "", products: hit.products };
}

export function readScanSession() {
  return { revision, items };
}

export function addScanHit(body: unknown) {
  const hit = readable(body);
  if (!hit) return { ...readScanSession(), added: false };
  const key = keyOf(hit);
  const added = !items.some((item) => keyOf(item) === key);
  items = [hit, ...items.filter((item) => keyOf(item) !== key)].slice(0, 200);
  revision += 1;
  return { revision, items, added };
}

export function removeScanHit(productId: string) {
  const next = items.flatMap((item) => {
    const products = item.products.filter((product) => product.id !== productId);
    if (!products.length) return [];
    return [{ ...item, products, ambiguous: products.length > 1 }];
  });
  if (next.length !== items.length) revision += 1;
  items = next;
  return readScanSession();
}

export function clearScanSession() {
  if (items.length) revision += 1;
  items = [];
  return readScanSession();
}
