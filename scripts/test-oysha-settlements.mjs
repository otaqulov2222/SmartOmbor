/**
 * Oysha MS «Взаиморасчеты» parity test.
 * Live: MOYSKLAD_TOKEN=... node scripts/test-oysha-settlements.mjs
 * Offline math: node scripts/test-oysha-settlements.mjs --math
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://api.moysklad.ru/api/remap/1.2";
const MS_ENTITY = `${BASE}/entity/counterparty`;
const FROM = process.env.KPI_FROM || "2026-10-15";
const TO = process.env.KPI_TO || "2026-11-15";
const TAG = process.env.KPI_TAG || "oisha";

/** MS UI screenshot (Oysha / oisha) — expected totals. */
const EXPECTED = {
  customers: 6,
  opening: -132_478_800,
  income: 285_623_970,
  expense: 515_544_240,
  closing: -362_399_070,
  rows: [
    { name: "Sherzod aka chekshorp", opening: -132_478_800, income: 236_400_000, expense: 459_792_370, closing: -355_871_170 },
    { name: "Behzod aka Yakkabog'", opening: 0, income: 17_980_020, expense: 24_507_920, closing: -6_527_900 },
    { name: "Ulug'bek aka sardili", opening: 0, income: 16_091_310, expense: 16_091_310, closing: 0 },
    { name: "Baby kids", opening: 0, income: 4_875_600, expense: 4_875_600, closing: 0 },
    { name: "Rustam aka Jizzax", opening: 0, income: 8_737_540, expense: 8_737_540, closing: 0 },
    { name: "Gulbahor opa chirchiq", opening: 0, income: 1_539_500, expense: 1_539_500, closing: 0 },
  ],
};

const CREDIT = ["supply", "paymentin", "cashin", "commissionreportin"];
const DEBIT = ["demand", "paymentout", "cashout", "commissionreportout"];

function money(n) {
  return Math.round(Number(n) || 0);
}

function fold(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function assertMath() {
  let opening = 0;
  let income = 0;
  let expense = 0;
  let closing = 0;
  const fails = [];
  for (const row of EXPECTED.rows) {
    const idOpening = money(row.closing - row.income + row.expense);
    if (idOpening !== money(row.opening)) {
      fails.push(`${row.name}: opening identity ${idOpening} != ${row.opening}`);
    }
    opening += row.opening;
    income += row.income;
    expense += row.expense;
    closing += row.closing;
  }
  if (opening !== EXPECTED.opening) fails.push(`total opening ${opening} != ${EXPECTED.opening}`);
  if (income !== EXPECTED.income) fails.push(`total income ${income} != ${EXPECTED.income}`);
  if (expense !== EXPECTED.expense) fails.push(`total expense ${expense} != ${EXPECTED.expense}`);
  if (closing !== EXPECTED.closing) fails.push(`total closing ${closing} != ${EXPECTED.closing}`);
  if (fails.length) {
    console.error("MATH FAIL");
    for (const f of fails) console.error(" -", f);
    process.exit(1);
  }
  console.log("MATH OK — MS screenshot identity + totals match");
}

async function ms(token, path, attempt = 0) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json;charset=utf-8",
    },
    signal: AbortSignal.timeout(35_000),
  });
  if (res.status === 429 && attempt < 5) {
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    return ms(token, path, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MS ${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchAll(token, pathPrefix) {
  const rows = [];
  let total = Infinity;
  for (let offset = 0; offset < total && offset < 100_000; offset += 1000) {
    const joiner = pathPrefix.includes("?") ? "&" : "?";
    const page = await ms(token, `${pathPrefix}${joiner}limit=1000&offset=${offset}`);
    if (Number.isFinite(Number(page.meta?.size))) total = Number(page.meta.size);
    const chunk = page.rows || [];
    rows.push(...chunk);
    if (!chunk.length || offset + chunk.length >= total) break;
  }
  return rows;
}

async function listTagCps(token, tag) {
  try {
    const viaFilter = await fetchAll(token, `/entity/counterparty?filter=${encodeURIComponent(`tags=${tag}`)}`);
    if (viaFilter.length) {
      return viaFilter.map((r) => ({ id: r.id, name: String(r.name || "").trim(), tags: r.tags || [] }));
    }
  } catch (e) {
    console.warn("tags= filter failed:", e.message);
  }
  console.log("Falling back to full counterparty index…");
  const all = await fetchAll(token, "/entity/counterparty");
  const want = fold(tag);
  return all
    .filter((r) => (r.tags || []).some((t) => fold(t) === want))
    .map((r) => ({ id: r.id, name: String(r.name || "").trim(), tags: r.tags || [] }));
}

async function sumEntity(token, entity, filter) {
  const rows = await fetchAll(token, `/entity/${entity}?filter=${encodeURIComponent(filter)}`);
  let sum = 0;
  for (const row of rows) {
    if (row.applicable === false) continue;
    sum += Number(row.sum || 0);
  }
  return sum; // kopecks
}

async function loadClosings(token, cpIds) {
  const map = new Map();
  const momentFrom = `${FROM} 00:00:00`;
  const momentTo = `${TO} 23:59:59`;
  // Prefer full report once
  try {
    const rows = await fetchAll(
      token,
      `/report/counterparty?momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}`,
    );
    const want = new Set(cpIds);
    for (const row of rows) {
      const id = String(row.counterparty?.id || "").trim();
      if (!want.has(id)) continue;
      map.set(id, Number(row.balance || 0));
    }
    if (map.size === cpIds.length) return map;
  } catch (e) {
    console.warn("full report failed:", e.message);
  }
  for (const id of cpIds) {
    if (map.has(id)) continue;
    try {
      const row = await ms(
        token,
        `/report/counterparty/${id}?momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}`,
      );
      map.set(id, Number(row.balance ?? row.rows?.[0]?.balance ?? 0));
    } catch {
      map.set(id, 0);
    }
  }
  return map;
}

async function computeLive(token) {
  const started = Date.now();
  const group = await listTagCps(token, TAG);
  console.log(`Tag "${TAG}" counterparties: ${group.length}`);
  for (const g of group) console.log(`  - ${g.name} (${g.id})`);

  const moment = `moment>=${FROM} 00:00:00;moment<=${TO} 23:59:59`;
  const movements = new Map();
  const tasks = [];
  for (const cp of group) {
    for (const entity of CREDIT) {
      tasks.push(async () => {
        const filter = `agent=${MS_ENTITY}/${cp.id};${moment}`;
        const sum = await sumEntity(token, entity, filter);
        const cur = movements.get(cp.id) || { credit: 0, debit: 0 };
        cur.credit += sum;
        movements.set(cp.id, cur);
      });
    }
    for (const entity of DEBIT) {
      tasks.push(async () => {
        const filter = `agent=${MS_ENTITY}/${cp.id};${moment}`;
        const sum = await sumEntity(token, entity, filter);
        const cur = movements.get(cp.id) || { credit: 0, debit: 0 };
        cur.debit += sum;
        movements.set(cp.id, cur);
      });
    }
  }

  // concurrency 8
  let i = 0;
  const workers = Array.from({ length: 8 }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      await tasks[idx]();
    }
  });
  await Promise.all(workers);

  const closings = await loadClosings(
    token,
    group.map((g) => g.id),
  );

  const rows = group
    .map((cp) => {
      const mv = movements.get(cp.id) || { credit: 0, debit: 0 };
      const credit = money(mv.credit / 100);
      const debit = money(mv.debit / 100);
      const closing = money((closings.get(cp.id) || 0) / 100);
      const opening = money(closing - credit + debit);
      return { name: cp.name, opening, income: credit, expense: debit, closing };
    })
    .filter((r) => r.opening || r.income || r.expense || r.closing)
    .sort((a, b) => a.name.localeCompare(b.name, "uz"));

  const tot = (k) => rows.reduce((a, r) => a + r[k], 0);
  const result = {
    ms: Date.now() - started,
    customers: rows.length,
    opening: tot("opening"),
    income: tot("income"),
    expense: tot("expense"),
    closing: tot("closing"),
    rows,
  };

  const outDir = join(process.cwd(), ".ms-cache");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `test-oysha-${FROM}_${TO}.json`), JSON.stringify(result, null, 2));
  return result;
}

function compare(result) {
  const fails = [];
  const check = (label, got, exp, tol = 0) => {
    if (Math.abs(got - exp) > tol) fails.push(`${label}: got ${got}, expected ${exp}`);
  };
  check("customers", result.customers, EXPECTED.customers);
  check("opening", result.opening, EXPECTED.opening);
  check("income", result.income, EXPECTED.income);
  check("expense", result.expense, EXPECTED.expense);
  check("closing", result.closing, EXPECTED.closing);

  console.log("\n=== LIVE RESULT ===");
  console.log(`time: ${result.ms} ms`);
  console.log(`customers: ${result.customers} (exp ${EXPECTED.customers})`);
  console.log(`opening: ${result.opening} (exp ${EXPECTED.opening})`);
  console.log(`income:  ${result.income} (exp ${EXPECTED.income})`);
  console.log(`expense: ${result.expense} (exp ${EXPECTED.expense})`);
  console.log(`closing: ${result.closing} (exp ${EXPECTED.closing})`);
  for (const row of result.rows) {
    console.log(`  ${row.name}: open=${row.opening} in=${row.income} out=${row.expense} close=${row.closing}`);
  }

  if (fails.length) {
    console.error("\nLIVE FAIL");
    for (const f of fails) console.error(" -", f);
    process.exit(1);
  }
  console.log("\nLIVE OK — matches MoySklad screenshot 1:1");
}

const args = process.argv.slice(2);
if (args.includes("--math")) {
  assertMath();
} else {
  assertMath();
  const token = process.env.MOYSKLAD_TOKEN?.trim();
  if (!token) {
    console.error("\nNO MOYSKLAD_TOKEN — live MS test skipped.");
    console.error("Set MOYSKLAD_TOKEN and re-run for full live parity test.");
    process.exit(2);
  }
  const result = await computeLive(token);
  compare(result);
}
