/**
 * MoySklad «Взаиморасчеты» — agent TEGidagi kontragentlar.
 *
 * Qoida: har bir raqam MS UI bilan 1:1 (oxirgi tiyingacha).
 *   Приход     — credit hujjatlar (sum × rate.value)
 *   Расход     — debit hujjatlar; agar demand.payedSum > sum va MS balansi
 *                ortiqcha to‘lovni ko‘rsatmasa — farq Расход ga qo‘shiladi
 *   Конечный   — /report/counterparty
 *   Начальный  — closing − Приход + Расход
 *
 * MS yordam hujjatlari:
 *   Приход: Приемки, Входящие платежи, Приходные ордера, Полученные отчёты комиссионера,
 *           Возвраты покупателей (salesreturn)
 *   Расход: Отгрузки, Исходящие платежи, Расходные ордера, Выданные отчёты комиссионера
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { logger } from "../logger";
import {
  moysklad,
  moyskladConfigured,
  resetMoySkladMaxInFlight,
  resetMoySkladMinGapMs,
  setMoySkladMaxInFlight,
  setMoySkladMinGapMs,
} from "../moysklad";
import { money, moneyAdd } from "./money";
import { PRIMARY_TAG, tagCandidatesForAgent } from "./ms-agent-tags";

/**
 * MS UI «Взаиморасчеты» hujjatlari.
 * Приход (credit) / Расход (debit) — alohida tomonlar; aralashtirmaslik.
 */
const CREDIT_ENTITIES = [
  "supply",
  "paymentin",
  "cashin",
  "commissionreportin",
  "salesreturn",
] as const;
const DEBIT_ENTITIES = ["demand", "paymentout", "cashout", "commissionreportout"] as const;

const PAGE = 1000;
const FRESH_MS = 10 * 60_000;
const STALE_MS = 6 * 60 * 60_000;
/**
 * v17: ortiqcha to‘lov (payedSum > sum) MS balansida aks etmasa — Расход ga qo‘shiladi.
 * v16: tezlik — agent= OR-batch (global period skan yo‘q).
 * v15: salesreturn. v14: rate.value.
 */
const CACHE_VERSION = "v17";
const MS_ENTITY_BASE = "https://api.moysklad.ru/api/remap/1.2/entity/counterparty";
const CREDIT_ENRICH_CONCURRENCY = 4;
const MS_FAST = { maxAttempts: 6 } as const;
/** Agent modal: entity so‘rovlari parallel (OR-batch). */
const AGENT_DOC_CONCURRENCY = 8;
/** MS filter URL uzunligi — agent OR chunk (katta = kamroq so‘rov). */
const AGENT_FILTER_CHUNK = 15;
const CP_INDEX_TTL_MS = 60 * 60_000;
const CACHE_DIR =
  process.env.SMART_OMBOR_CACHE_DIR ||
  (existsSync("/var/lib/smart-ombor") ? "/var/lib/smart-ombor/ms-cache" : join(process.cwd(), ".ms-cache"));

type MsCp = { id?: string; name?: string; tags?: string[]; meta?: { href?: string } };
type MsDoc = {
  sum?: number;
  applicable?: boolean;
  /** Asosiy valyutada (tiyin) — bog‘langan to‘lovlar jami. */
  payedSum?: number;
  /** MS: sum — hujjat valyutasida; rate.value — asosiy valyutaga kurs (masalan USD→UZS 12000). */
  rate?: { value?: number; currency?: { meta?: { href?: string } } };
  agent?: { id?: string; meta?: { href?: string }; name?: string };
};

type CpMovement = { credit: number; debit: number; overpay: number };

/** Взаиморасчеты sum — asosiy valyutada (tiyin). rate.value bo‘lsa ko‘paytiriladi. */
function docSumKop(doc: MsDoc) {
  const sum = Number(doc.sum || 0);
  if (!Number.isFinite(sum) || sum === 0) return 0;
  const rate = Number(doc.rate?.value);
  if (Number.isFinite(rate) && rate > 0) return Math.round(sum * rate);
  return Math.round(sum);
}

/** Отгрузка bo‘yicha ortiqcha to‘lov (payedSum − sum), asosiy valyutada. */
function demandOverpayKop(doc: MsDoc) {
  const sum = docSumKop(doc);
  const payed = Number(doc.payedSum);
  if (!Number.isFinite(payed) || payed <= 0) return 0;
  return Math.max(0, Math.round(payed) - sum);
}
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

function aliasesForLogin(login: string, fullName?: string, msTag?: string) {
  return tagCandidatesForAgent({ login, fullName, msTag });
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
const movementCache = new Map<string, { at: number; byCp: Map<string, CpMovement> }>();
const settlementsCache = new Map<string, { at: number; data: AgentSettlement }>();
const summaryMem = new Map<string, { at: number; byLogin: Record<string, AgentSettlement> }>();
const warming = new Map<string, Promise<void>>();
const enriching = new Map<string, Promise<void>>();
/** Ochilgan agent modal — enrich navbatida birinchi. */
let enrichPriorityLogin = "";
/**
 * Bir vaqtda faqat BITTA period isitiladi.
 * Eng so‘nggi so‘ralgan period ustun — eski navbatdagi days30/quarter «Shu oy»ni bloklamaydi.
 */
let warmGate: Promise<void> = Promise.resolve();
let warmGeneration = 0;
let preferredWarmKey = "";
/** Settlements kerak emas (admin / ofis). */
const SKIP_SETTLE_LOGINS = new Set([
  "ofis",
  "vanseling",
  "bordouzadmin",
  "bordoomboradmin",
  "administrator",
  "admin",
]);

function isSkipSettleLogin(login: string) {
  return SKIP_SETTLE_LOGINS.has(foldName(login).replace(/\s+/g, ""));
}

function isWarmSuperseded(key: string, gen: number) {
  return preferredWarmKey !== key && gen !== warmGeneration;
}

/** Summary da hali hisoblanmagan agent bormi — «fresh» bo‘lsa ham isitish kerak. */
function summaryMissingAgents(
  byLogin: Record<string, AgentSettlement> | undefined,
  agents: Array<{ login: string }>,
) {
  if (!byLogin) return true;
  for (const a of agents) {
    if (isSkipSettleLogin(a.login)) continue;
    if (!byLogin[a.login.toLowerCase()]) return true;
  }
  return false;
}

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
  // Faqat JORIY CACHE_VERSION — eski noto‘g‘ri Kirim qaytib kelmasin.
  return readDiskSummaryFile(summaryPath(from, to));
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

async function resolveAgentTag(
  login: string,
  fullName?: string,
  msTag?: string,
): Promise<string | null> {
  const cacheKey = foldName(login);
  const hit = tagCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.tag;

  // Seed agentlar: PRIMARY_TAG darhol (MS probe kutmasdan).
  const primary = PRIMARY_TAG[cacheKey];
  if (primary && !msTag) {
    tagCache.set(cacheKey, { at: Date.now(), tag: primary });
    return primary;
  }

  for (const tag of aliasesForLogin(login, fullName, msTag)) {
    const page = await moysklad<{ meta?: { size?: number } }>(
      `/entity/counterparty?limit=1&filter=${encodeURIComponent(`tags=${tag}`)}`,
    ).catch(() => null);
    if (Number(page?.meta?.size || 0) > 0) {
      tagCache.set(cacheKey, { at: Date.now(), tag });
      return tag;
    }
  }
  // msTag berilgan bo‘lsa — MS da hali mijoz yo‘q bo‘lsa ham shu tegni saqlaymiz
  // (keyinroq teglangan kontragentlar shu bilan tortiladi).
  if (msTag && foldName(msTag)) {
    const forced = foldName(msTag);
    tagCache.set(cacheKey, { at: Date.now(), tag: forced });
    return forced;
  }
  tagCache.set(cacheKey, { at: Date.now(), tag: null });
  return null;
}

function cpIndexPath() {
  return join(CACHE_DIR, `cp-tags-${CACHE_VERSION}.json`);
}

type CpTagRow = { id: string; name: string; tags: string[] };

function readCpTagIndex(): { at: number; rows: CpTagRow[] } | null {
  try {
    const parsed = JSON.parse(readFileSync(cpIndexPath(), "utf8")) as { at: number; rows: CpTagRow[] };
    if (!parsed?.at || !Array.isArray(parsed.rows)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCpTagIndex(rows: CpTagRow[]) {
  try {
    ensureCacheDir();
    writeFileSync(cpIndexPath(), JSON.stringify({ at: Date.now(), rows }), "utf8");
  } catch {
    /* ignore */
  }
}

/** Barcha kontragentlar + tags — 1 marta (keyin disk). tags= filter ishonchsiz. */
async function loadCounterpartyTagIndex(): Promise<CpTagRow[]> {
  const disk = readCpTagIndex();
  if (disk && Date.now() - disk.at < CP_INDEX_TTL_MS && disk.rows.length > 0) return disk.rows;

  const out: CpTagRow[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < total && offset < 100_000; offset += PAGE) {
    const page = await moysklad<{ rows?: MsCp[]; meta?: { size?: number } }>(
      `/entity/counterparty?limit=${PAGE}&offset=${offset}`,
      MS_FAST,
    );
    if (Number.isFinite(Number(page.meta?.size))) total = Number(page.meta?.size);
    const rows = page.rows || [];
    if (!rows.length) break;
    for (const row of rows) {
      if (!row.id || !row.name) continue;
      out.push({
        id: row.id,
        name: row.name.trim(),
        tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
      });
    }
    if (offset + rows.length >= total) break;
  }
  writeCpTagIndex(out);
  logger.info({ count: out.length }, "ms-settlements counterparty tag index loaded");
  return out;
}

async function listByTagFilter(tag: string): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  let total = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < total && offset < 20_000; offset += PAGE) {
    const page = await moysklad<{ rows?: MsCp[]; meta?: { size?: number } }>(
      `/entity/counterparty?limit=${PAGE}&offset=${offset}&filter=${encodeURIComponent(`tags=${tag}`)}`,
      MS_FAST,
    );
    if (Number.isFinite(Number(page.meta?.size))) total = Number(page.meta?.size);
    const rows = page.rows || [];
    if (!rows.length) break;
    for (const row of rows) {
      if (!row.id || !row.name) continue;
      out.push({ id: row.id, name: row.name.trim() });
    }
    if (offset + rows.length >= total) break;
  }
  return out;
}

async function listTagCounterparties(tag: string) {
  const key = foldName(tag);
  const hit = groupCache.get(key) || groupCache.get(tag);
  // Bo‘sh natijani uzoq cache’lama — teg xatosi qotib qolmasin.
  if (hit && Date.now() - hit.at < 15 * 60_000 && hit.rows.length > 0) return hit.rows;
  if (hit && hit.rows.length === 0 && Date.now() - hit.at < 20_000) return hit.rows;

  let out: Array<{ id: string; name: string }> = [];
  try {
    out = await listByTagFilter(tag);
  } catch (error) {
    logger.warn({ err: error, tag }, "ms-settlements tags= filter failed — using full index");
  }

  if (!out.length) {
    const index = await loadCounterpartyTagIndex();
    const wanted = new Set(
      [tag, key, ...aliasesForLogin(tag)]
        .map(foldName)
        .filter(Boolean),
    );
    out = index
      .filter((row) => row.tags.some((t) => wanted.has(foldName(t))))
      .map((row) => ({ id: row.id, name: row.name }));
  }

  if (!out.length) {
    logger.warn({ tag }, "ms-settlements no counterparties for tag");
  } else {
    logger.info({ tag, count: out.length }, "ms-settlements tag group ready");
  }

  const packed = { at: Date.now(), rows: out };
  groupCache.set(key, packed);
  groupCache.set(tag, packed);
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
    total += docSumKop(row);
  }
  return total;
}

function emptyMovement(): CpMovement {
  return { credit: 0, debit: 0, overpay: 0 };
}

function bumpMovement(
  byCp: Map<string, CpMovement>,
  id: string,
  side: "credit" | "debit",
  sum: number,
  overpay = 0,
) {
  if (!id) return;
  const cur = byCp.get(id) || emptyMovement();
  if (Number.isFinite(sum) && sum !== 0) cur[side] += sum;
  if (Number.isFinite(overpay) && overpay > 0) cur.overpay += overpay;
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
  const byCp = new Map<string, CpMovement>();
  const moment = `moment>=${from} 00:00:00;moment<=${to} 23:59:59`;
  const all = [
    ...CREDIT_ENTITIES.map((entity) => ({ entity, side: "credit" as const })),
    ...DEBIT_ENTITIES.map((entity) => ({ entity, side: "debit" as const })),
  ];
  await mapPool(all, 2, async ({ entity, side }) => {
    const rows = await fetchEntityDocs(entity, moment);
    for (const row of rows) {
      if (row.applicable === false) continue;
      const overpay = side === "debit" && entity === "demand" ? demandOverpayKop(row) : 0;
      bumpMovement(byCp, docAgentId(row), side, docSumKop(row), overpay);
    }
  });
  return byCp;
}

/**
 * Aniqlik: kontragent uchun Приход = agent= filter (4 entity parallel).
 * Расход globaldan qoladi.
 */
async function enrichCreditsExact(
  byCp: Map<string, CpMovement>,
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
    const cur = byCp.get(cpId) || emptyMovement();
    cur.credit = credit;
    byCp.set(cpId, cur);
  });
}

function persistMovements(from: string, to: string, byCp: Map<string, CpMovement>) {
  const at = Date.now();
  movementCache.set(`${from}:${to}`, { at, byCp });
  const entries: Record<string, CpMovement> = {};
  for (const [id, v] of byCp) entries[id] = v;
  writeDiskMap(movementsPath(from, to), entries);
}

/**
 * Kirim + Chiqim: faqat shu agent kontragentlari uchun agent= OR-batch.
 * Global period skan YO‘Q — bir xil aniqliq, ancha tez.
 * MS: bir xil maydon bo‘yicha bir nechta shart = OR.
 */
async function loadMovementsForCpIdsExact(cpIds: string[], from: string, to: string) {
  const byCp = new Map<string, CpMovement>();
  if (!cpIds.length) return byCp;
  const want = new Set(cpIds);
  for (const id of cpIds) byCp.set(id, emptyMovement());
  const moment = `moment>=${from} 00:00:00;moment<=${to} 23:59:59`;

  const chunks: string[][] = [];
  for (let i = 0; i < cpIds.length; i += AGENT_FILTER_CHUNK) {
    chunks.push(cpIds.slice(i, i + AGENT_FILTER_CHUNK));
  }

  const tasks: Array<{ entity: string; side: "credit" | "debit"; filter: string }> = [];
  for (const chunk of chunks) {
    const agentOr = chunk.map((id) => `agent=${MS_ENTITY_BASE}/${id}`).join(";");
    const filter = `${agentOr};${moment}`;
    for (const entity of CREDIT_ENTITIES) tasks.push({ entity, side: "credit", filter });
    for (const entity of DEBIT_ENTITIES) tasks.push({ entity, side: "debit", filter });
  }

  await mapPool(tasks, AGENT_DOC_CONCURRENCY, async ({ entity, side, filter }) => {
    const rows = await fetchEntityDocs(entity, filter);
    for (const row of rows) {
      if (row.applicable === false) continue;
      const id = docAgentId(row);
      if (!want.has(id)) continue;
      const overpay = side === "debit" && entity === "demand" ? demandOverpayKop(row) : 0;
      bumpMovement(byCp, id, side, docSumKop(row), overpay);
    }
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

  // Faqat per-id report — bulk list ba’zan 0 qaytaradi (aniqlik buziladi).
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
  msTag?: string;
}): Promise<AgentSettlement> {
  if (isSkipSettleLogin(input.login)) {
    return emptySettlement(input);
  }
  const started = Date.now();
  agentFastActive += 1;
  enrichPriorityLogin = foldName(input.login);
  setMoySkladMaxInFlight(8);
  setMoySkladMinGapMs(10);
  try {
    let tag = await resolveAgentTag(input.login, input.fullName, input.msTag);
    let group = tag ? await listTagCounterparties(tag) : [];
    if (!group.length) {
      for (const alt of aliasesForLogin(input.login, input.fullName, input.msTag)) {
        if (tag && foldName(alt) === foldName(tag)) continue;
        const rows = await listTagCounterparties(alt);
        if (rows.length) {
          tag = alt;
          group = rows;
          break;
        }
      }
    }
    if (!group.length) {
      logger.error({ login: input.login, tag }, "ms-settlements agent has zero counterparties");
    }
    const cpIds = group.map((g) => g.id);
    const movStarted = Date.now();
    const [movements, closings] = await Promise.all([
      loadMovementsForCpIdsExact(cpIds, input.from, input.to),
      loadClosingsForCpIds(cpIds, input.from, input.to),
    ]);
    const movMs = Date.now() - movStarted;

    // Period movement cache’ga merge
    const periodKey = `${input.from}:${input.to}`;
    const prevMov = movementCache.get(periodKey)?.byCp || new Map<string, CpMovement>();
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
      {
        login: input.login,
        cps: group.length,
        rows: data.rows.length,
        movMs,
        ms: Date.now() - started,
      },
      "ms-settlements agent-fast ready",
    );
    return data;
  } finally {
    agentFastActive = Math.max(0, agentFastActive - 1);
    resetMoySkladMinGapMs();
    resetMoySkladMaxInFlight();
  }
}

export function ensureAgentSettlement(input: {
  login: string;
  fullName: string;
  from: string;
  to: string;
  msTag?: string;
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
    const byCp = new Map<string, CpMovement>();
    for (const [id, v] of Object.entries(disk.entries)) {
      const row = v as { credit?: number; debit?: number; overpay?: number };
      byCp.set(id, {
        credit: Number(row.credit || 0),
        debit: Number(row.debit || 0),
        overpay: Number(row.overpay || 0),
      });
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
/** Modal hisobi ketayotganda warm boshqa agentlarni kutsin. */
let agentFastActive = 0;

async function waitForAgentFastSlot(login: string) {
  const key = foldName(login);
  while (agentFastActive > 0 && enrichPriorityLogin && key !== enrichPriorityLogin) {
    await new Promise((r) => setTimeout(r, 40));
  }
}

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
 * income — credit hujjatlar (rate.value bilan).
 * expense — debit hujjatlar; MS balansi ortiqcha to‘lovni yutganda (payedSum > sum
 *   va closing kredit ko‘rsatmasa) farq Расход ga qo‘shiladi — MS UI 1:1.
 * closing — /report/counterparty.
 * opening — closing − income + expense (identitet).
 */
function buildSettlement(input: {
  login: string;
  fullName: string;
  from: string;
  to: string;
  tag: string | null;
  group: Array<{ id: string; name: string }>;
  movements: Map<string, CpMovement>;
  closings: Map<string, number>;
}): AgentSettlement {
  if (!input.tag) return emptySettlement(input);

  const rows = input.group
    .map((cp) => {
      const mv = input.movements.get(cp.id) || emptyMovement();
      const creditKop = Math.round(Number(mv.credit) || 0);
      let debitKop = Math.round(Number(mv.debit) || 0);
      const overpayKop = Math.round(Number(mv.overpay) || 0);
      const closingKop = input.closings.has(cp.id) ? Math.round(Number(input.closings.get(cp.id)) || 0) : 0;
      // Ortiqcha to‘lov MS balansida kredit bo‘lib chiqmasa — UI Расход ni ko‘taradi.
      if (overpayKop > 0 && closingKop <= 0) {
        const openingRaw = closingKop - creditKop + debitKop;
        if (openingRaw < 0) {
          debitKop += Math.min(-openingRaw, overpayKop);
        }
      }
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
    moneyAdd(...rows.map((row) => row[key]));

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
  movements: Map<string, CpMovement>,
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
  movements: Map<string, CpMovement>,
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
 * Fon isitish: agentlar 2 parallel; periodlar GLOBAL navbat + so‘nggi so‘rov ustun.
 * Eski kesh HECH QACHON «bo‘sh UI» uchun o‘chirilmaydi (qarang: refreshMsSettlements).
 */
export function warmMsSettlements(
  agents: Array<{ login: string; fullName: string; msTag?: string }>,
  from: string,
  to: string,
  force = false,
  priorityLogin?: string,
) {
  if (!moyskladConfigured()) return Promise.resolve();
  if (priorityLogin) enrichPriorityLogin = foldName(priorityLogin);
  const key = `${from}:${to}`;
  const existing = peekSummary(from, to);
  const settleAgents = agents.filter((a) => !isSkipSettleLogin(a.login));
  const incomplete = summaryMissingAgents(existing?.byLogin, settleAgents);
  // To‘liq va yangi kesh — qayta isitma. Qisman kesh bo‘lsa — yetishmaganlarni to‘ldir.
  if (!force && existing && Date.now() - existing.at < FRESH_MS && !incomplete) {
    return Promise.resolve();
  }
  const inflight = warming.get(key);
  if (inflight) {
    preferredWarmKey = key;
    warmGeneration += 1;
    return inflight;
  }

  preferredWarmKey = key;
  const myGen = ++warmGeneration;
  const job = (async () => {
    const prev = warmGate;
    let release!: () => void;
    warmGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev.catch(() => undefined);
    try {
      if (isWarmSuperseded(key, myGen)) {
        logger.info({ from, to }, "ms-settlements warm skipped — newer period preferred");
        return;
      }
      const already = peekSummary(from, to)?.byLogin || {};
      const remaining = settleAgents.filter((a) => force || !already[a.login.toLowerCase()]);
      logger.info(
        { from, to, agents: settleAgents.length, todo: remaining.length },
        "ms-settlements warm start",
      );
      if (!remaining.length) return;
      const takeNext = () => {
        const prefer = enrichPriorityLogin;
        let idx = prefer ? remaining.findIndex((a) => foldName(a.login) === prefer) : 0;
        if (idx < 0) idx = 0;
        return remaining.splice(idx, 1)[0];
      };
      const workers = Array.from({ length: Math.min(2, Math.max(remaining.length, 1)) }, async () => {
        while (remaining.length) {
          if (isWarmSuperseded(key, myGen)) {
            remaining.length = 0;
            logger.info({ from, to }, "ms-settlements warm aborted — newer period preferred");
            return;
          }
          const agent = takeNext();
          if (!agent) return;
          await waitForAgentFastSlot(agent.login);
          await ensureAgentSettlement({
            login: agent.login,
            fullName: agent.fullName,
            msTag: agent.msTag,
            from,
            to,
          });
        }
      });
      await Promise.all(workers);
      if (!isWarmSuperseded(key, myGen)) {
        logger.info({ from, to }, "ms-settlements warm done");
      }
    } finally {
      release();
    }
  })()
    .then(() => undefined)
    .catch((error) => {
      logger.error({ err: error, from, to }, "ms-settlements warm failed");
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

/** Yangi/tahrirlangan agent uchun MS teg cache ni yangilash (to‘liq settlements tozalanmasin). */
export function invalidateAgentTagCache(login?: string) {
  if (!login) {
    tagCache.clear();
    return;
  }
  const key = foldName(login);
  tagCache.delete(key);
  for (const k of [...settlementsCache.keys()]) {
    if (k.startsWith(`${key}:`)) settlementsCache.delete(k);
  }
  for (const k of [...summaryMem.keys()]) summaryMem.delete(k);
}

/** Staff sync: yangi agent tegini oldindan cache qilish. */
export async function probeAgentMsTag(input: {
  login: string;
  fullName?: string;
  msTag?: string;
}): Promise<string | null> {
  invalidateAgentTagCache(input.login);
  if (!moyskladConfigured()) {
    const forced = foldName(input.msTag || "");
    if (forced) {
      tagCache.set(foldName(input.login), { at: Date.now(), tag: forced });
      return forced;
    }
    return PRIMARY_TAG[foldName(input.login)] || null;
  }
  return resolveAgentTag(input.login, input.fullName, input.msTag);
}

/**
 * Soft refresh: eski summary ekranda qoladi; faqat agent cache + movements yangilanadi.
 * Summary/diskni o‘chirmaymiz — aks holda Boshqaruv daqiqalarlab «…» bo‘lib qoladi.
 */
export async function refreshMsSettlements(
  agents: Array<{ login: string; fullName: string; msTag?: string }>,
  from: string,
  to: string,
  priorityLogin?: string,
) {
  if (!moyskladConfigured()) return;
  for (const k of [...settlementsCache.keys()]) {
    if (k.endsWith(`:${from}:${to}`)) settlementsCache.delete(k);
  }
  for (const k of [...movementCache.keys()]) {
    if (k.startsWith(`${from}:${to}`)) movementCache.delete(k);
  }
  unlinkQuiet(movementsPath(from, to));
  if (priorityLogin) enrichPriorityLogin = foldName(priorityLogin);
  await warmMsSettlements(agents, from, to, true, priorityLogin);
}

export async function getAgentsMsSettlementSummaries(
  agents: Array<{ login: string; fullName: string; msTag?: string }>,
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
    const incomplete = summaryMissingAgents(cached.byLogin, agents);
    if (busy || age >= FRESH_MS || incomplete) {
      // Qisman kesh yoki eskirgan — fonda to‘ldiramiz; ekrandagi bor raqamlar saqlanadi.
      if (!warming.has(key)) void warmMsSettlements(agents, from, to, false);
      return { map: out, status: incomplete || busy ? "warming" : "stale" };
    }
    return { map: out, status: "ready" };
  }

  // Modal ochilishiga yo‘l berish — warm biroz kechiktiriladi.
  setTimeout(() => {
    void warmMsSettlements(agents, from, to, false);
  }, 400);
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
    msTag?: string;
  },
  warmAgents?: Array<{ login: string; fullName: string; msTag?: string }>,
): Promise<AgentSettlement & { msStatus: MsSettleStatus }> {
  const empty = emptySettlement(input);
  void warmAgents;
  if (!moyskladConfigured()) return { ...empty, msStatus: "ready" };

  const cacheKey = `${foldName(input.login)}:${input.from}:${input.to}`;
  const hit = settlementsCache.get(cacheKey);
  if (hit && hasSettlementData(hit.data)) {
    const age = Date.now() - hit.at;
    if (age < FRESH_MS) return { ...hit.data, msStatus: "ready" };
    if (age < STALE_MS) {
      // Eski aniq raqam — darhol; yangilash fonda.
      enrichPriorityLogin = foldName(input.login);
      void ensureAgentSettlement(input);
      return { ...hit.data, msStatus: "stale" };
    }
  }

  const summary = peekSummary(input.from, input.to);
  const fromSummary = summary?.byLogin[input.login.toLowerCase()];
  if (fromSummary && hasSettlementData(fromSummary) && summary) {
    const age = Date.now() - summary.at;
    settlementsCache.set(cacheKey, { at: summary.at, data: fromSummary });
    if (age < FRESH_MS) return { ...fromSummary, msStatus: "ready" };
    if (age < STALE_MS) {
      enrichPriorityLogin = foldName(input.login);
      void ensureAgentSettlement(input);
      return { ...fromSummary, msStatus: "stale" };
    }
  }

  // Faqat OCHILGAN agent — boshqalarni shu yerda ishga tushirma.
  enrichPriorityLogin = foldName(input.login);
  const data = await ensureAgentSettlement(input);
  return { ...data, msStatus: hasSettlementData(data) ? "ready" : "warming" };
}
