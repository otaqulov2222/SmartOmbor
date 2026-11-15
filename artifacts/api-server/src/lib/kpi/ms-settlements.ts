/**
 * MoySklad «Взаиморасчеты» — agent TEGidagi kontragentlar.
 *
 * Qoida: hech qachon raqamlarni «tenglashtirib» yubormaymiz.
 * Faqat MS dagi bor ma’lumot:
 *   Приход / Расход — hujjatlar yig‘indisi (o‘zgartirilmaydi)
 *   Конечный       — /report/counterparty
 *   Начальный      — closing − Приход + Расход (buxgalteriya identitesi, aylanma invent qilinmaydi)
 *
 * MS yordam hujjatlari:
 *   Приход: Приемки, Входящие платежи, Приходные ордера, Полученные отчёты комиссионера
 *   Расход: Отгрузки, Исходящие платежи, Расходные ордера, Выданные отчёты комиссионера
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { moysklad, moyskladConfigured } from "../moysklad";
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
/** v5: to‘liq hujjat skani (xato=bo‘sh deb to‘xtatmaslik) + agent filter. */
const CACHE_VERSION = "v5";
const MS_ENTITY_BASE = "https://api.moysklad.ru/api/remap/1.2/entity/counterparty";
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

function readDiskSummary(from: string, to: string) {
  try {
    const raw = readFileSync(summaryPath(from, to), "utf8");
    const parsed = JSON.parse(raw) as { at: number; byLogin: Record<string, AgentSettlement> };
    if (!parsed?.byLogin || !parsed.at) return null;
    return parsed;
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
  for (let offset = 0; offset < 20_000; offset += PAGE) {
    const page = await moysklad<{ rows?: MsReportRow[] }>(
      `/report/counterparty?limit=${PAGE}&offset=${offset}&momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}`,
    ).catch(() => ({ rows: [] as MsReportRow[] }));
    const rows = page.rows || [];
    if (!rows.length) break;
    for (const row of rows) {
      const id = String(row.counterparty?.id || cpIdFromHref(row.counterparty?.meta?.href) || "").trim();
      if (!id) continue;
      byCp.set(id, Number(row.balance || 0));
    }
    if (rows.length < PAGE) break;
  }

  const at = Date.now();
  balanceCache.set(key, { at, byCp });
  const entries: Record<string, number> = {};
  for (const [id, v] of byCp) entries[id] = v;
  writeDiskMap(balancesPath(from, to), entries);
  return byCp;
}

/** Bitta entity — meta.size bo‘yicha to‘liq; xato bo‘lsa qayta urinadi, bo‘sh deb to‘xtamaydi. */
async function fetchEntityDocs(entity: string, filter: string): Promise<MsDoc[]> {
  const out: MsDoc[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < total && offset < 100_000; offset += PAGE) {
    let lastErr: unknown;
    let page: { rows?: MsDoc[]; meta?: { size?: number } } | null = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        page = await moysklad<{ rows?: MsDoc[]; meta?: { size?: number } }>(
          `/entity/${entity}?limit=${PAGE}&offset=${offset}&filter=${encodeURIComponent(filter)}`,
        );
        lastErr = undefined;
        break;
      } catch (error) {
        lastErr = error;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
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

/** Global davr skani — ketma-ket (429 dan saqlanish). */
async function scanMovementsGlobal(from: string, to: string) {
  const byCp = new Map<string, { credit: number; debit: number }>();
  const moment = `moment>=${from} 00:00:00;moment<=${to} 23:59:59`;
  for (const entity of CREDIT_ENTITIES) {
    const rows = await fetchEntityDocs(entity, moment);
    for (const row of rows) {
      if (row.applicable === false) continue;
      bumpMovement(byCp, docAgentId(row), "credit", Number(row.sum || 0));
    }
  }
  for (const entity of DEBIT_ENTITIES) {
    const rows = await fetchEntityDocs(entity, moment);
    for (const row of rows) {
      if (row.applicable === false) continue;
      bumpMovement(byCp, docAgentId(row), "debit", Number(row.sum || 0));
    }
  }
  return byCp;
}

/**
 * Agent TEGidagi kontragentlar uchun to‘lovlarni agent= filter bilan qayta o‘qiydi.
 * Global skan o‘tkazib yuborgan paymentin/cashin larni to‘ldiradi (MS Приход parity).
 */
async function enrichCreditsForCounterparties(
  byCp: Map<string, { credit: number; debit: number }>,
  cpIds: string[],
  from: string,
  to: string,
) {
  const moment = `moment>=${from} 00:00:00;moment<=${to} 23:59:59`;
  // Faqat kirim tomoni — chiqim allaqachon mos kelgan.
  const creditOnly = ["paymentin", "cashin", "supply", "commissionreportin"] as const;
  for (const cpId of cpIds) {
    const agentFilter = `agent=${MS_ENTITY_BASE}/${cpId};${moment}`;
    let credit = 0;
    for (const entity of creditOnly) {
      const rows = await fetchEntityDocs(entity, agentFilter);
      for (const row of rows) {
        if (row.applicable === false) continue;
        credit += Number(row.sum || 0);
      }
    }
    if (!credit) continue;
    const cur = byCp.get(cpId) || { credit: 0, debit: 0 };
    // Agent-filter aniqroq — shu kontragent uchun credit ni almashtiramiz (kamaytirib yubormaymiz).
    if (credit > cur.credit) cur.credit = credit;
    byCp.set(cpId, cur);
  }
}

async function loadPeriodMovements(
  from: string,
  to: string,
  focusCpIds?: string[],
) {
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
  if (focusCpIds?.length) await enrichCreditsForCounterparties(byCp, focusCpIds, from, to);
  const at = Date.now();
  movementCache.set(key, { at, byCp });
  const entries: Record<string, { credit: number; debit: number }> = {};
  for (const [id, v] of byCp) entries[id] = v;
  writeDiskMap(movementsPath(from, to), entries);
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

async function computeAll(
  agents: Array<{ login: string; fullName: string }>,
  from: string,
  to: string,
) {
  const tags = await Promise.all(
    agents.map(async (agent) => ({
      agent,
      tag: await resolveAgentTag(agent.login, agent.fullName),
    })),
  );

  const uniqueTags = [...new Set(tags.map((t) => t.tag).filter(Boolean) as string[])];
  await Promise.all(uniqueTags.map((tag) => listTagCounterparties(tag)));

  const focusCpIds: string[] = [];
  const seen = new Set<string>();
  for (const tag of uniqueTags) {
    for (const cp of await listTagCounterparties(tag)) {
      if (seen.has(cp.id)) continue;
      seen.add(cp.id);
      focusCpIds.push(cp.id);
    }
  }

  // Avval guruhlar, keyin aylanma — agent filter bilan Kirim to‘liq bo‘lsin.
  const [movements, closings] = await Promise.all([
    loadPeriodMovements(from, to, focusCpIds),
    loadClosingBalances(from, to),
  ]);

  const byLogin: Record<string, AgentSettlement> = {};
  const at = Date.now();
  for (const { agent, tag } of tags) {
    const group = tag ? await listTagCounterparties(tag) : [];
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

/** Fon isitish — bir davr uchun bitta parallel. */
export function warmMsSettlements(
  agents: Array<{ login: string; fullName: string }>,
  from: string,
  to: string,
  force = false,
) {
  if (!moyskladConfigured()) return Promise.resolve();
  const key = `${from}:${to}`;
  const existing = peekSummary(from, to);
  if (!force && existing && Date.now() - existing.at < FRESH_MS) return Promise.resolve();
  const inflight = warming.get(key);
  if (inflight) return inflight;

  const job = computeAll(agents, from, to)
    .then(() => undefined)
    .catch(() => undefined)
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
  if (from && to) {
    unlinkQuiet(summaryPath(from, to));
    unlinkQuiet(movementsPath(from, to));
    unlinkQuiet(balancesPath(from, to));
    return;
  }
  try {
    for (const name of readdirSync(CACHE_DIR)) {
      if (
        name.startsWith("settlements-v") ||
        name.startsWith("mov-v") ||
        name.startsWith("bal-v")
      ) {
        unlinkQuiet(join(CACHE_DIR, name));
      }
    }
  } catch {
    /* ignore */
  }
}

export function invalidateMsSettlementsCache(from?: string, to?: string) {
  if (from && to) {
    const key = `${from}:${to}`;
    summaryMem.delete(key);
    movementCache.delete(key);
    balanceCache.delete(key);
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

/** Sync tugaguncha yangi MS raqamlarini hisoblaydi. */
export async function refreshMsSettlements(
  agents: Array<{ login: string; fullName: string }>,
  from: string,
  to: string,
) {
  if (!moyskladConfigured()) return;
  invalidateMsSettlementsCache(from, to);
  await warmMsSettlements(agents, from, to, true);
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

  const cached = peekSummary(from, to);
  const age = cached ? Date.now() - cached.at : Infinity;

  if (cached && age < FRESH_MS) {
    for (const agent of agents) {
      out.set(
        agent.login.toLowerCase(),
        cached.byLogin[agent.login.toLowerCase()] || emptySettlement({ ...agent, from, to }),
      );
    }
    return { map: out, status: "ready" };
  }

  if (cached && age < STALE_MS) {
    for (const agent of agents) {
      out.set(
        agent.login.toLowerCase(),
        cached.byLogin[agent.login.toLowerCase()] || emptySettlement({ ...agent, from, to }),
      );
    }
    void warmMsSettlements(agents, from, to, true);
    return { map: out, status: "stale" };
  }

  void warmMsSettlements(agents, from, to, true);
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
  if (hit && Date.now() - hit.at < FRESH_MS) return { ...hit.data, msStatus: "ready" };

  const summary = peekSummary(input.from, input.to);
  const fromSummary = summary?.byLogin[input.login.toLowerCase()];
  const age = summary ? Date.now() - summary.at : Infinity;

  if (fromSummary && age < FRESH_MS) {
    settlementsCache.set(cacheKey, { at: summary!.at, data: fromSummary });
    return { ...fromSummary, msStatus: "ready" };
  }
  if (fromSummary && age < STALE_MS) {
    void warmMsSettlements(agentsForWarm, input.from, input.to, true);
    return { ...fromSummary, msStatus: "stale" };
  }

  void warmMsSettlements(agentsForWarm, input.from, input.to, true);
  const tag = PRIMARY_TAG[foldName(input.login)] || null;
  return {
    ...empty,
    folderName: tag,
    msStatus: "warming",
  };
}
