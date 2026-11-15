/**
 * MoySklad «Взаиморасчеты» — agent TEGidagi kontragentlar.
 *
 * Qoida: taxmin yo‘q, tenglashtirish yo‘q — har bir raqam MS dagi bilan 1:1.
 *   Приход / Расход — har kontragent uchun agent= filter (to‘liq hujjatlar)
 *   Конечный       — /report/counterparty
 *   Начальный      — closing − Приход + Расход
 *
 * MS yordam hujjatlari:
 *   Приход: Приемки, Входящие платежи, Приходные ордера, Полученные отчёты комиссионера
 *   Расход: Отгрузки, Исходящие платежи, Расходные ордера, Выданные отчёты комиссионера
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { logger } from "../logger";
import {
  moysklad,
  moyskladConfigured,
  resetMoySkladMaxInFlight,
  setMoySkladMaxInFlight,
} from "../moysklad";
import { money } from "./money";

/** Login → asosiy MS teg (probe qilmasdan). */
const PRIMARY_TAG: Record<string, string> = {
  shaxzod: "шахзод",
  oysha: "oisha",
  farzona: "farzona",
  elyor: "elyor",
  abbos: "abbos",
  baxodir: "боходир",
  muzaffar: "музаффар",
  avliyo: "avliyo",
  gulzoda: "gulzoda",
  nafisa: "nafisa",
  nozim: "nozim",
  abdugani: "abdugani",
  farxodaka: "farxodaka",
  sevinch: "sevinch",
};

const AGENT_TAG_ALIASES: Record<string, string[]> = {
  shaxzod: ["шахзод", "shaxzod"],
  oysha: ["oisha", "oysha", "ойша"],
  farzona: ["farzona"],
  elyor: ["elyor"],
  abbos: ["abbos"],
  baxodir: ["боходир", "baxodir", "баходир"],
  muzaffar: ["музаффар", "muzaffar"],
  avliyo: ["avliyo"],
  gulzoda: ["gulzoda"],
  nafisa: ["nafisa"],
  nozim: ["nozim"],
  abdugani: ["abdugani", "abdug'ani"],
  farxodaka: ["farxodaka", "farxod aka"],
  sevinch: ["sevinch"],
};

/**
 * MS UI «Взаиморасчеты» hujjatlari.
 * Приход (credit) / Расход (debit) — alohida tomonlar; aralashtirmaslik.
 */
const CREDIT_ENTITIES = ["supply", "paymentin", "cashin", "commissionreportin"] as const;
const DEBIT_ENTITIES = ["demand", "paymentout", "cashout", "commissionreportout"] as const;

const PAGE = 1000;
const FRESH_MS = 10 * 60_000;
const STALE_MS = 6 * 60 * 60_000;
/** v10: modal = bitta agent exact (await); fields= olib tashlandi (MS buzilardi). */
const CACHE_VERSION = "v10";
const MS_ENTITY_BASE = "https://api.moysklad.ru/api/remap/1.2/entity/counterparty";
const CREDIT_ENRICH_CONCURRENCY = 4;
const MS_FAST = { maxAttempts: 3 } as const;
const AGENT_DOC_CONCURRENCY = 16;
const CACHE_DIR =
  process.env.SMART_OMBOR_CACHE_DIR ||
  (existsSync("/var/lib/smart-ombor") ? "/var/lib/smart-ombor/ms-cache" : join(process.cwd(), ".ms-cache"));

type MsCp = { id?: string; name?: string; tags?: string[]; meta?: { href?: string } };
type MsDoc = {
  sum?: number;
  applicable?: boolean;
  agent?: { id?: string; meta?: { href?: string }; name?: string };
};
type MsReportRow = {
  balance?: number;
  counterparty?: { id?: string; name?: string; meta?: { href?: string } };
};

function som(kopecks: unknown) {
  const n = Number(kopecks);
  return money(Number.isFinite(n) ? n / 100 : 0);
}

function foldName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function aliasesForLogin(login: string, fullName?: string) {
  const key = foldName(login);
  const fromMap = AGENT_TAG_ALIASES[key] || [];
  const extra = [login, key, fullName || "", foldName(fullName || "")]
    .map(foldName)
    .filter(Boolean);
  return [...new Set([...fromMap.map(foldName), ...extra])];
}

function cpIdFromHref(href?: string) {
  if (!href) return "";
  return href.split("/").pop()?.split("?")[0] || "";
}

function docAgentId(doc: MsDoc) {
  return String(doc.agent?.id || cpIdFromHref(doc.agent?.meta?.href) || "").trim();
}

const tagCache = new Map<string, { at: number; tag: string | null }>();
const groupCache = new Map<string, { at: number; rows: Array<{ id: string; name: string }> }>();
const balanceCache = new Map<string, { at: number; byCp: Map<string, number> }>();
const movementCache = new Map<string, { at: number; byCp: Map<string, { credit: number; debit: number }> }>();
const settlementsCache = new Map<string, { at: number; data: AgentSettlement }>();
const summaryMem = new Map<string, { at: number; byLogin: Record<string, AgentSettlement> }>();
const warming = new Map<string, Promise<void>>();
const enriching = new Map<string, Promise<void>>();
/** Ochilgan agent modal — enrich navbatida birinchi. */
let enrichPriorityLogin = "";

function ensureCacheDir() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function summaryPath(from: string, to: string) {
  return join(CACHE_DIR, `settlements-${CACHE_VERSION}-${from}_${to}.json`);
}

function movementsPath(from: string, to: string) {
  return join(CACHE_DIR, `mov-${CACHE_VERSION}-${from}_${to}.json`);
}

function balancesPath(from: string, to: string) {
  return join(CACHE_DIR, `bal-${CACHE_VERSION}-${from}_${to}.json`);
}

function readDiskSummaryFile(path: string) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { at: number; byLogin: Record<string, AgentSettlement> };
    if (!parsed?.byLogin || !parsed.at) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readDiskSummary(from: string, to: string) {
  const exact = readDiskSummaryFile(summaryPath(from, to));
  if (exact) return exact;
  // Oldingi versiya cache — darhol ko‘rsatish (nol kutmaslik).
  try {
    ensureCacheDir();
    const needle = `_${from}_${to}.json`;
    let best: { at: number; byLogin: Record<string, AgentSettlement> } | null = null;
    for (const name of readdirSync(CACHE_DIR)) {
      if (!name.startsWith("settlements-") || !name.endsWith(needle)) continue;
      const parsed = readDiskSummaryFile(join(CACHE_DIR, name));
      if (!parsed) continue;
      if (!best || parsed.at > best.at) best = parsed;
    }
    return best;
  } catch {
    return null;
  }
}

function writeDiskSummary(from: string, to: string, byLogin: Record<string, AgentSettlement>) {
  try {
    ensureCacheDir();
    writeFileSync(
      summaryPath(from, to),
      JSON.stringify({ at: Date.now(), from, to, version: CACHE_VERSION, byLogin }),
      "utf8",
    );
  } catch {
    /* ignore */
  }
}

function peekSummary(from: string, to: string) {
  const key = `${from}:${to}`;
  const mem = summaryMem.get(key);
  if (mem) return mem;
  const disk = readDiskSummary(from, to);
  if (disk) {
    summaryMem.set(key, disk);
    for (const [login, data] of Object.entries(disk.byLogin)) {
      settlementsCache.set(`${foldName(login)}:${from}:${to}`, { at: disk.at, data });
    }
    return disk;
  }
  return null;
}

function readDiskMap(path: string): { at: number; entries: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { at: number; entries: Record<string, unknown> };
    if (!parsed?.at || !parsed.entries) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDiskMap(path: string, entries: Record<string, unknown>) {
  try {
    ensureCacheDir();
    writeFileSync(path, JSON.stringify({ at: Date.now(), version: CACHE_VERSION, entries }), "utf8");
  } catch {
    /* ignore */
  }
}

async function resolveAgentTag(login: string, fullName?: string): Promise<string | null> {
  const cacheKey = foldName(login);
  const hit = tagCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.tag;

  const primary = PRIMARY_TAG[cacheKey];
  if (primary) {
    tagCache.set(cacheKey, { at: Date.now(), tag: primary });
    return primary;
  }

  for (const tag of aliasesForLogin(login, fullName)) {
    const page = await moysklad<{ meta?: { size?: number } }>(
      `/entity/counterparty?limit=1&filter=${encodeURIComponent(`tags=${tag}`)}`,
    ).catch(() => null);
    if (Number(page?.meta?.size || 0) > 0) {
      tagCache.set(cacheKey, { at: Date.now(), tag });
      return tag;
    }
  }
  tagCache.set(cacheKey, { at: Date.now(), tag: null });
  return null;
}

async function listTagCounterparties(tag: string) {
  const hit = groupCache.get(tag);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.rows;

  const out: Array<{ id: string; name: string }> = [];
  for (let offset = 0; offset < 5000; offset += PAGE) {
    const page = await moysklad<{ rows?: MsCp[] }>(
      `/entity/counterparty?limit=${PAGE}&offset=${offset}&filter=${encodeURIComponent(`tags=${tag}`)}`,
    ).catch(() => ({ rows: [] as MsCp[] }));
    const rows = page.rows || [];
    if (!rows.length) break;
    for (const row of rows) {
      if (!row.id || !row.name) continue;
      out.push({ id: row.id, name: row.name.trim() });
    }
    if (rows.length < PAGE) break;
  }
  groupCache.set(tag, { at: Date.now(), rows: out });
  return out;
}

/**
 * Davr oxiridagi qoldiq (MS «Конечный остаток»).
 * momentFrom/momentTo bilan chaqiriladi — UI dagi yakuniy bilan mos.
 */
async function loadClosingBalances(from: string, to: string) {
  const key = `${from}:${to}`;
  const hit = balanceCache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.byCp;

  const disk = readDiskMap(balancesPath(from, to));
  if (disk && Date.now() - disk.at < FRESH_MS) {
    const byCp = new Map<string, number>();
    for (const [id, v] of Object.entries(disk.entries)) byCp.set(id, Number(v || 0));
    balanceCache.set(key, { at: disk.at, byCp });
    return byCp;
  }

  const byCp = new Map<string, number>();
  const momentFrom = `${from} 00:00:00`;
  const momentTo = `${to} 23:59:59`;
  let total = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < total && offset < 100_000; offset += PAGE) {
    let page: { rows?: MsReportRow[]; meta?: { size?: number } } | null = null;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        page = await moysklad<{ rows?: MsReportRow[]; meta?: { size?: number } }>(
          `/report/counterparty?limit=${PAGE}&offset=${offset}&momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}`,
          MS_FAST,
        );
        lastErr = undefined;
        break;
      } catch (error) {
        lastErr = error;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    if (!page) {
      if (lastErr) throw lastErr;
      break;
    }
    if (Number.isFinite(Number(page.meta?.size))) total = Number(page.meta?.size);
    const rows = page.rows || [];
    for (const row of rows) {
      const id = String(row.counterparty?.id || cpIdFromHref(row.counterparty?.meta?.href) || "").trim();
      if (!id) continue;
      byCp.set(id, Number(row.balance || 0));
    }
    if (!rows.length || offset + rows.length >= total) break;
  }

  const at = Date.now();
  balanceCache.set(key, { at, byCp });
  const entries: Record<string, number> = {};
  for (const [id, v] of byCp) entries[id] = v;
  writeDiskMap(balancesPath(from, to), entries);
  return byCp;
}

/** Bitta entity — to‘liq pagination, tez retry. */
async function fetchEntityDocs(entity: string, filter: string): Promise<MsDoc[]> {
  const out: MsDoc[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < total && offset < 100_000; offset += PAGE) {
    let lastErr: unknown;
    let page: { rows?: MsDoc[]; meta?: { size?: number } } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        page = await moysklad<{ rows?: MsDoc[]; meta?: { size?: number } }>(
          `/entity/${entity}?limit=${PAGE}&offset=${offset}&filter=${encodeURIComponent(filter)}`,
          MS_FAST,
        );
        lastErr = undefined;
        break;
      } catch (error) {
        lastErr = error;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    if (!page) {
      if (lastErr) throw lastErr;
      break;
    }
    if (Number.isFinite(Number(page.meta?.size))) total = Number(page.meta?.size);
    const rows = page.rows || [];
    out.push(...rows);
    if (!rows.length) break;
    if (offset + rows.length >= total) break;
  }
  return out;
}

function sumApplicable(rows: MsDoc[]) {
  let total = 0;
  for (const row of rows) {
    if (row.applicable === false) continue;
    const n = Number(row.sum || 0);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

function bumpMovement(
  byCp: Map<string, { credit: number; debit: number }>,
  id: string,
  side: "credit" | "debit",
  sum: number,
) {
  if (!id || !Number.isFinite(sum) || sum === 0) return;
  const cur = byCp.get(id) || { credit: 0, debit: 0 };
  cur[side] += sum;
  byCp.set(id, cur);
}

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/** Tez: 8 entity parallel (burst slotlar bilan). */
async function scanMovementsGlobal(from: string, to: string) {
  const byCp = new Map<string, { credit: number; debit: number }>();
  const moment = `moment>=${from} 00:00:00;moment<=${to} 23:59:59`;
  const all = [
    ...CREDIT_ENTITIES.map((entity) => ({ entity, side: "credit" as const })),
    ...DEBIT_ENTITIES.map((entity) => ({ entity, side: "debit" as const })),
  ];
  await mapPool(all, 8, async ({ entity, side }) => {
    const rows = await fetchEntityDocs(entity, moment);
    for (const row of rows) {
      if (row.applicable === false) continue;
      bumpMovement(byCp, docAgentId(row), side, Number(row.sum || 0));
    }
  });
  return byCp;
}

/**
 * Aniqlik: kontragent uchun Приход = agent= filter (4 entity parallel).
 * Расход globaldan qoladi.
 */
async function enrichCreditsExact(
  byCp: Map<string, { credit: number; debit: number }>,
  cpIds: string[],
  from: string,
  to: string,
) {
  if (!cpIds.length) return;
  const moment = `moment>=${from} 00:00:00;moment<=${to} 23:59:59`;
  await mapPool(cpIds, CREDIT_ENRICH_CONCURRENCY, async (cpId) => {
    const agentFilter = `agent=${MS_ENTITY_BASE}/${cpId};${moment}`;
    const parts = await Promise.all(
      CREDIT_ENTITIES.map(async (entity) => sumApplicable(await fetchEntityDocs(entity, agentFilter))),
    );
    const credit = parts.reduce((acc, n) => acc + n, 0);
    const cur = byCp.get(cpId) || { credit: 0, debit: 0 };
    cur.credit = credit;
    byCp.set(cpId, cur);
  });
}

function persistMovements(from: string, to: string, byCp: Map<string, { credit: number; debit: number }>) {
  const at = Date.now();
  movementCache.set(`${from}:${to}`, { at, byCp });
  const entries: Record<string, { credit: number; debit: number }> = {};
  for (const [id, v] of byCp) entries[id] = v;
  writeDiskMap(movementsPath(from, to), entries);
}

/** Faqat berilgan CP’lar — agent= bilan Kirim+Chiqim (modal uchun tez, 1:1). */
async function loadMovementsForCpIdsExact(cpIds: string[], from: string, to: string) {
  const byCp = new Map<string, { credit: number; debit: number }>();
  if (!cpIds.length) return byCp;
  const moment = `moment>=${from} 00:00:00;moment<=${to} 23:59:59`;
  const tasks: Array<{ cpId: string; entity: string; side: "credit" | "debit" }> = [];
  for (const cpId of cpIds) {
    for (const entity of CREDIT_ENTITIES) tasks.push({ cpId, entity, side: "credit" });
    for (const entity of DEBIT_ENTITIES) tasks.push({ cpId, entity, side: "debit" });
  }
  await mapPool(tasks, AGENT_DOC_CONCURRENCY, async ({ cpId, entity, side }) => {
    const filter = `agent=${MS_ENTITY_BASE}/${cpId};${moment}`;
    const sum = sumApplicable(await fetchEntityDocs(entity, filter));
    bumpMovement(byCp, cpId, side, sum);
  });
  return byCp;
}

/** Agent guruhi uchun yakuniy qoldiq — avval cache, yo‘q bo‘lsa per-id report. */
async function loadClosingsForCpIds(cpIds: string[], from: string, to: string) {
  const out = new Map<string, number>();
  if (!cpIds.length) return out;

  const key = `${from}:${to}`;
  const hit = balanceCache.get(key);
  const disk = hit ? null : readDiskMap(balancesPath(from, to));
  const existing = hit?.byCp || (disk
    ? new Map(Object.entries(disk.entries).map(([id, v]) => [id, Number(v || 0)]))
    : null);

  const missing: string[] = [];
  for (const id of cpIds) {
    if (existing?.has(id)) out.set(id, Number(existing.get(id)) || 0);
    else missing.push(id);
  }
  if (!missing.length) return out;

  const momentFrom = `${from} 00:00:00`;
  const momentTo = `${to} 23:59:59`;
  await mapPool(missing, 12, async (id) => {
    try {
      const row = await moysklad<{ balance?: number; rows?: Array<{ balance?: number }> }>(
        `/report/counterparty/${id}?momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}`,
        MS_FAST,
      );
      out.set(id, Number(row.balance ?? row.rows?.[0]?.balance ?? 0));
    } catch {
      try {
        const row = await moysklad<{ balance?: number }>(`/report/counterparty/${id}`, MS_FAST);
        out.set(id, Number(row.balance || 0));
      } catch {
        out.set(id, 0);
      }
    }
  });

  // Qisman cache’ga qo‘shish
  const merged = existing ? new Map(existing) : new Map<string, number>();
  for (const [id, v] of out) merged.set(id, v);
  balanceCache.set(key, { at: Date.now(), byCp: merged });
  const entries: Record<string, number> = {};
  for (const [id, v] of merged) entries[id] = v;
  writeDiskMap(balancesPath(from, to), entries);
  return out;
}

function patchAgentIntoSummary(from: string, to: string, data: AgentSettlement) {
  const key = `${from}:${to}`;
  const prev = peekSummary(from, to);
  const byLogin = { ...(prev?.byLogin || {}) };
  byLogin[data.agentLogin.toLowerCase()] = data;
  const at = Date.now();
  summaryMem.set(key, { at, byLogin });
  settlementsCache.set(`${foldName(data.agentLogin)}:${from}:${to}`, { at, data });
  writeDiskSummary(from, to, byLogin);
}

/** Bitta agent — kutib hisoblaydi (modal bo‘sh qolmasin). */
async function computeOneAgentFast(input: {
  login: string;
  fullName: string;
  from: string;
  to: string;
}): Promise<AgentSettlement> {
  const started = Date.now();
  setMoySkladMaxInFlight(20);
  try {
    const tag = await resolveAgentTag(input.login, input.fullName);
    const group = tag ? await listTagCounterparties(tag) : [];
    const cpIds = group.map((g) => g.id);
    const [movements, closings] = await Promise.all([
      loadMovementsForCpIdsExact(cpIds, input.from, input.to),
      loadClosingsForCpIds(cpIds, input.from, input.to),
    ]);

    // Period movement cache’ga merge
    const periodKey = `${input.from}:${input.to}`;
    const prevMov = movementCache.get(periodKey)?.byCp || new Map<string, { credit: number; debit: number }>();
    const merged = new Map(prevMov);
    for (const [id, v] of movements) merged.set(id, v);
    persistMovements(input.from, input.to, merged);

    const data = buildSettlement({
      login: input.login,
      fullName: input.fullName,
      from: input.from,
      to: input.to,
      tag,
      group,
      movements: merged,
      closings,
    });
    patchAgentIntoSummary(input.from, input.to, data);
    logger.info(
      { login: input.login, cps: group.length, rows: data.rows.length, ms: Date.now() - started },
      "ms-settlements agent-fast ready",
    );
    return data;
  } finally {
    resetMoySkladMaxInFlight();
  }
}

export function ensureAgentSettlement(input: {
  login: string;
  fullName: string;
  from: string;
  to: string;
}): Promise<AgentSettlement> {
  const key = `${foldName(input.login)}:${input.from}:${input.to}`;
  const hit = settlementsCache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS && hasSettlementData(hit.data)) {
    return Promise.resolve(hit.data);
  }
  const inflight = agentJobs.get(key);
  if (inflight) return inflight;
  const job = computeOneAgentFast(input)
    .catch((error) => {
      logger.error({ err: error, login: input.login }, "ms-settlements agent-fast failed");
      const tag = PRIMARY_TAG[foldName(input.login)] || null;
      return { ...emptySettlement(input), folderName: tag };
    })
    .finally(() => {
      agentJobs.delete(key);
    });
  agentJobs.set(key, job);
  return job;
}

/** Faqat global skan — enrich yo‘q (tez birinchi ekran). */
async function loadPeriodMovementsFast(from: string, to: string) {
  const key = `${from}:${to}`;
  const hit = movementCache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.byCp;

  const disk = readDiskMap(movementsPath(from, to));
  if (disk && Date.now() - disk.at < FRESH_MS) {
    const byCp = new Map<string, { credit: number; debit: number }>();
    for (const [id, v] of Object.entries(disk.entries)) {
      const row = v as { credit?: number; debit?: number };
      byCp.set(id, { credit: Number(row.credit || 0), debit: Number(row.debit || 0) });
    }
    movementCache.set(key, { at: disk.at, byCp });
    return byCp;
  }

  const byCp = await scanMovementsGlobal(from, to);
  persistMovements(from, to, byCp);
  return byCp;
}

export type AgentSettlement = {
  agentLogin: string;
  agentName: string;
  folderName: string | null;
  period: { from: string; to: string };
  customers: number;
  income: string;
  expense: string;
  opening: string;
  closing: string;
  rows: Array<{
    id: string;
    name: string;
    opening: string;
    income: string;
    expense: string;
    closing: string;
  }>;
};

export type MsSettleStatus = "ready" | "stale" | "warming";

const agentJobs = new Map<string, Promise<AgentSettlement>>();

function hasSettlementData(s: AgentSettlement | undefined | null) {
  if (!s) return false;
  return (
    (s.rows?.length || 0) > 0 ||
    Number(s.income) !== 0 ||
    Number(s.expense) !== 0 ||
    Number(s.closing) !== 0 ||
    Number(s.opening) !== 0
  );
}

function emptySettlement(input: { login: string; fullName: string; from: string; to: string }): AgentSettlement {
  return {
    agentLogin: input.login,
    agentName: input.fullName,
    folderName: null,
    period: { from: input.from, to: input.to },
    customers: 0,
    income: "0.00",
    expense: "0.00",
    opening: "0.00",
    closing: "0.00",
    rows: [],
  };
}

/**
 * income/expense — faqat hujjat skani (HECH QACHON boshqa ustunga tenglashtirilmaydi).
 * closing — faqat MS report.
 * opening — identitetdan (aylanma invent qilinmaydi).
 */
function buildSettlement(input: {
  login: string;
  fullName: string;
  from: string;
  to: string;
  tag: string | null;
  group: Array<{ id: string; name: string }>;
  movements: Map<string, { credit: number; debit: number }>;
  closings: Map<string, number>;
}): AgentSettlement {
  if (!input.tag) return emptySettlement(input);

  const rows = input.group
    .map((cp) => {
      const mv = input.movements.get(cp.id) || { credit: 0, debit: 0 };
      // Raw MS docs — no overwrite / no force-equalize.
      const creditKop = Number(mv.credit) || 0;
      const debitKop = Number(mv.debit) || 0;
      const closingKop = input.closings.has(cp.id) ? Number(input.closings.get(cp.id)) || 0 : 0;
      const openingKop = closingKop - creditKop + debitKop;
      return {
        id: cp.id,
        name: cp.name,
        opening: som(openingKop),
        income: som(creditKop),
        expense: som(debitKop),
        closing: som(closingKop),
        keep: creditKop !== 0 || debitKop !== 0 || openingKop !== 0 || closingKop !== 0,
      };
    })
    .filter((row) => row.keep)
    .map(({ keep: _keep, ...row }) => row)
    .sort((a, b) => a.name.localeCompare(b.name, "uz"));

  const sum = (key: "opening" | "income" | "expense" | "closing") =>
    money(rows.reduce((acc, row) => acc + Number(row[key] || 0), 0));

  return {
    agentLogin: input.login,
    agentName: input.fullName,
    folderName: input.tag,
    period: { from: input.from, to: input.to },
    customers: rows.length,
    income: sum("income"),
    expense: sum("expense"),
    opening: sum("opening"),
    closing: sum("closing"),
    rows,
  };
}

function publishSettlements(
  tags: Array<{ agent: { login: string; fullName: string }; tag: string | null }>,
  movements: Map<string, { credit: number; debit: number }>,
  closings: Map<string, number>,
  from: string,
  to: string,
) {
  const byLogin: Record<string, AgentSettlement> = {};
  const at = Date.now();
  for (const { agent, tag } of tags) {
    const group = tag ? groupCache.get(tag)?.rows || [] : [];
    const data = buildSettlement({
      login: agent.login,
      fullName: agent.fullName,
      from,
      to,
      tag,
      group,
      movements,
      closings,
    });
    byLogin[agent.login.toLowerCase()] = data;
    settlementsCache.set(`${foldName(agent.login)}:${from}:${to}`, { at, data });
  }
  summaryMem.set(`${from}:${to}`, { at, byLogin });
  writeDiskSummary(from, to, byLogin);
  return byLogin;
}

function startEnrichBackground(
  tags: Array<{ agent: { login: string; fullName: string }; tag: string | null }>,
  movements: Map<string, { credit: number; debit: number }>,
  closings: Map<string, number>,
  from: string,
  to: string,
) {
  const key = `${from}:${to}`;
  if (enriching.has(key)) return enriching.get(key)!;

  const job = (async () => {
    const remaining = tags.filter((t) => t.tag);
    while (remaining.length) {
      const prefer = enrichPriorityLogin;
      let idx = prefer ? remaining.findIndex((t) => foldName(t.agent.login) === prefer) : 0;
      if (idx < 0) idx = 0;
      const { agent, tag } = remaining.splice(idx, 1)[0];
      if (!tag) continue;
      const group = await listTagCounterparties(tag);
      if (!group.length) continue;
      try {
        await enrichCreditsExact(
          movements,
          group.map((cp) => cp.id),
          from,
          to,
        );
        persistMovements(from, to, movements);
        publishSettlements(tags, movements, closings, from, to);
        logger.info({ login: agent.login, cps: group.length }, "ms-settlements agent enriched");
      } catch (error) {
        logger.warn({ err: error, login: agent.login }, "ms-settlements enrich failed — keeping phase1");
      }
    }
  })()
    .catch((error) => {
      logger.error({ err: error, from, to }, "ms-settlements enrich background failed");
    })
    .finally(() => {
      enriching.delete(key);
    });

  enriching.set(key, job);
  return job;
}

/**
 * Phase1 (10–15s maqsad): global skan + balans → UI to‘liq.
 * Enrich — alohida fonda (warming bloklamaydi).
 */
async function computePhase1(
  agents: Array<{ login: string; fullName: string }>,
  from: string,
  to: string,
  priorityLogin?: string,
) {
  const started = Date.now();
  if (priorityLogin) enrichPriorityLogin = foldName(priorityLogin);

  setMoySkladMaxInFlight(20);
  try {
    const tags = await Promise.all(
      agents.map(async (agent) => ({
        agent,
        tag: await resolveAgentTag(agent.login, agent.fullName),
      })),
    );

    const uniqueTags = [...new Set(tags.map((t) => t.tag).filter(Boolean) as string[])];
    await Promise.all(uniqueTags.map((tag) => listTagCounterparties(tag)));

    const [movements, closings] = await Promise.all([
      loadPeriodMovementsFast(from, to),
      loadClosingBalances(from, to),
    ]);

    publishSettlements(tags, movements, closings, from, to);
    logger.info(
      { from, to, agents: agents.length, ms: Date.now() - started },
      "ms-settlements phase1 published",
    );

    // Aniqlik — UI kutmasin.
    void startEnrichBackground(tags, movements, closings, from, to);
    return summaryMem.get(`${from}:${to}`)?.byLogin || {};
  } finally {
    resetMoySkladMaxInFlight();
  }
}

/** Fon isitish — phase1 tugashi = UI tayyor. */
export function warmMsSettlements(
  agents: Array<{ login: string; fullName: string }>,
  from: string,
  to: string,
  force = false,
  priorityLogin?: string,
) {
  if (!moyskladConfigured()) return Promise.resolve();
  if (priorityLogin) enrichPriorityLogin = foldName(priorityLogin);
  const key = `${from}:${to}`;
  const existing = peekSummary(from, to);
  if (!force && existing && Date.now() - existing.at < FRESH_MS) {
    if (!enriching.has(key)) {
      // Fresh phase1 bor, enrich yo‘q bo‘lsa fonda ishga tushirish shart emas.
    }
    return Promise.resolve();
  }
  const inflight = warming.get(key);
  if (inflight) return inflight;

  const job = computePhase1(agents, from, to, priorityLogin)
    .then(() => undefined)
    .catch((error) => {
      logger.error({ err: error, from, to }, "ms-settlements phase1 failed");
    })
    .finally(() => {
      warming.delete(key);
    });
  warming.set(key, job);
  return job;
}

function unlinkQuiet(path: string) {
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

function clearVersionedDiskCache(from?: string, to?: string) {
  try {
    for (const name of readdirSync(CACHE_DIR)) {
      const matchPeriod =
        from && to
          ? name.includes(`${from}_${to}`)
          : true;
      if (
        matchPeriod &&
        (name.startsWith("settlements-v") || name.startsWith("mov-v") || name.startsWith("bal-v"))
      ) {
        unlinkQuiet(join(CACHE_DIR, name));
      }
    }
  } catch {
    /* ignore */
  }
  if (from && to) {
    unlinkQuiet(summaryPath(from, to));
    unlinkQuiet(movementsPath(from, to));
    unlinkQuiet(balancesPath(from, to));
  }
}

export function invalidateMsSettlementsCache(from?: string, to?: string) {
  if (from && to) {
    summaryMem.delete(`${from}:${to}`);
    balanceCache.delete(`${from}:${to}`);
    for (const k of [...movementCache.keys()]) {
      if (k.startsWith(`${from}:${to}`)) movementCache.delete(k);
    }
    for (const k of [...settlementsCache.keys()]) {
      if (k.endsWith(`:${from}:${to}`)) settlementsCache.delete(k);
    }
    clearVersionedDiskCache(from, to);
    return;
  }
  summaryMem.clear();
  balanceCache.clear();
  movementCache.clear();
  settlementsCache.clear();
  groupCache.clear();
  tagCache.clear();
  clearVersionedDiskCache();
}

/**
 * Soft refresh: eski raqamlar ekranda qoladi, yangisi tayyor bo‘lgach almashtiriladi.
 * Disk o‘chirilmaydi — UI nollanmaydi.
 */
export async function refreshMsSettlements(
  agents: Array<{ login: string; fullName: string }>,
  from: string,
  to: string,
  priorityLogin?: string,
) {
  if (!moyskladConfigured()) return;
  // Faqat RAM/movement+balance — disk summary saqlanadi (nol bo‘lmasin).
  for (const k of [...movementCache.keys()]) {
    if (k.startsWith(`${from}:${to}`)) movementCache.delete(k);
  }
  balanceCache.delete(`${from}:${to}`);
  for (const k of [...settlementsCache.keys()]) {
    if (k.endsWith(`:${from}:${to}`)) settlementsCache.delete(k);
  }
  try {
    unlinkQuiet(movementsPath(from, to));
    unlinkQuiet(balancesPath(from, to));
  } catch {
    /* ignore */
  }
  const key = `${from}:${to}`;
  const inflight = warming.get(key);
  if (inflight) {
    await inflight;
    return;
  }
  const job = computePhase1(agents, from, to, priorityLogin)
    .then(() => undefined)
    .catch((error) => {
      logger.error({ err: error, from, to }, "ms-settlements refresh failed");
    })
    .finally(() => {
      warming.delete(key);
    });
  warming.set(key, job);
  await job;
}

export async function getAgentsMsSettlementSummaries(
  agents: Array<{ login: string; fullName: string }>,
  from: string,
  to: string,
): Promise<{ map: Map<string, AgentSettlement>; status: MsSettleStatus }> {
  const out = new Map<string, AgentSettlement>();
  if (!moyskladConfigured()) {
    for (const agent of agents) out.set(agent.login.toLowerCase(), emptySettlement({ ...agent, from, to }));
    return { map: out, status: "ready" };
  }

  const key = `${from}:${to}`;
  const cached = peekSummary(from, to);
  const age = cached ? Date.now() - cached.at : Infinity;
  const busy = warming.has(key) || enriching.has(key);

  // Diskda bor bo‘lsa — darhol ko‘rsatamiz (nol emas). Yangilash fonda.
  if (cached) {
    for (const agent of agents) {
      out.set(
        agent.login.toLowerCase(),
        cached.byLogin[agent.login.toLowerCase()] || emptySettlement({ ...agent, from, to }),
      );
    }
    if (busy || age >= FRESH_MS) {
      if (age >= FRESH_MS) void warmMsSettlements(agents, from, to, true);
      return { map: out, status: "stale" };
    }
    return { map: out, status: "ready" };
  }

  void warmMsSettlements(agents, from, to, true);
  // Ro‘yxat ham to‘lsin — birinchi agentlarni fonda hisobla.
  void (async () => {
    for (const agent of agents) {
      try {
        await ensureAgentSettlement({ login: agent.login, fullName: agent.fullName, from, to });
      } catch {
        /* ignore */
      }
    }
  })();
  for (const agent of agents) {
    const login = agent.login.toLowerCase();
    const tag = PRIMARY_TAG[login] || null;
    out.set(
      login,
      tag
        ? {
            ...emptySettlement({ ...agent, from, to }),
            folderName: tag,
          }
        : emptySettlement({ ...agent, from, to }),
    );
  }
  return { map: out, status: "warming" };
}

export async function getAgentMsSettlements(
  input: {
    login: string;
    fullName: string;
    from: string;
    to: string;
  },
  warmAgents?: Array<{ login: string; fullName: string }>,
): Promise<AgentSettlement & { msStatus: MsSettleStatus }> {
  const empty = emptySettlement(input);
  const agentsForWarm = warmAgents?.length ? warmAgents : [{ login: input.login, fullName: input.fullName }];
  if (!moyskladConfigured()) return { ...empty, msStatus: "ready" };

  const cacheKey = `${foldName(input.login)}:${input.from}:${input.to}`;
  const hit = settlementsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < FRESH_MS && hasSettlementData(hit.data)) {
    void warmMsSettlements(agentsForWarm, input.from, input.to, false, input.login);
    return { ...hit.data, msStatus: "ready" };
  }

  const summary = peekSummary(input.from, input.to);
  const fromSummary = summary?.byLogin[input.login.toLowerCase()];
  if (fromSummary && hasSettlementData(fromSummary) && summary && Date.now() - summary.at < FRESH_MS) {
    settlementsCache.set(cacheKey, { at: summary.at, data: fromSummary });
    void warmMsSettlements(agentsForWarm, input.from, input.to, false, input.login);
    return { ...fromSummary, msStatus: "ready" };
  }

  // Modal bo‘sh qolmasin — shu agentni HOZIR hisobla (global skanni kutma).
  enrichPriorityLogin = foldName(input.login);
  const data = await ensureAgentSettlement(input);
  void warmMsSettlements(agentsForWarm, input.from, input.to, false, input.login);
  return { ...data, msStatus: "ready" };
}
