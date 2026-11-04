/** Decimal money helpers — avoid float math. Amounts stored as numeric strings. */

export function money(value: unknown): string {
  if (value == null || value === "") return "0.00";
  const raw = String(value).replace(/\s/g, "").replace(",", ".");
  const n = Number(raw);
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

export function moneyAdd(...parts: unknown[]): string {
  let total = 0n;
  for (const part of parts) {
    total += toCents(part);
  }
  return fromCents(total);
}

export function moneySub(left: unknown, right: unknown): string {
  return fromCents(toCents(left) - toCents(right));
}

export function moneyMul(amount: unknown, qty: unknown): string {
  const a = toCents(amount);
  const q = Number(String(qty ?? 0).replace(",", "."));
  if (!Number.isFinite(q)) return "0.00";
  // qty may have 3 decimals; work in milli-units then round to cents
  const milli = BigInt(Math.round(q * 1000));
  const product = (a * milli + 500n) / 1000n;
  return fromCents(product);
}

export function moneyPct(base: unknown, percent: unknown): string {
  const b = toCents(base);
  const p = Number(String(percent ?? 0).replace(",", "."));
  if (!Number.isFinite(p)) return "0.00";
  // percent * 10000 for 4 decimal places → (base_cents * percent_bps) / 1000000? 
  // KPI = base * percent / 100 → cents = round(base_cents * percent / 100)
  const scaled = Number(b) * p;
  return fromCents(BigInt(Math.round(scaled / 100)));
}

export function moneyCmp(left: unknown, right: unknown): number {
  const a = toCents(left);
  const b = toCents(right);
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

function toCents(value: unknown): bigint {
  const s = money(value);
  const neg = s.startsWith("-");
  const [whole, frac = "00"] = s.replace("-", "").split(".");
  const cents = BigInt(whole || "0") * 100n + BigInt((frac + "00").slice(0, 2));
  return neg ? -cents : cents;
}

function fromCents(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
