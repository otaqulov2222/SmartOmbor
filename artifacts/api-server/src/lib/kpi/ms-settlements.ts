/**
 * MoySklad «Взаиморасчеты» — agent TEGidagi kontragentlar.
 * Bu akkauntda counterpartyfolder yo‘q; guruh = tags (oisha, шахзод, …).
 * Приход/Расход = davrdagi hujjatlar; yakuniy = report.balance.
 */
import { moysklad, moyskladConfigured } from "../moysklad";
import { money } from "./money";

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

type MsCp = { id?: string; name?: string; tags?: string[]; meta?: { href?: string } };
type MsDoc = {
  sum?: number;
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
const movementCache = new Map<string, { at: number; byCp: Map<string, { credit: number; debit: number }> }>();
const balanceCache = new Map<string, { at: number; byCp: Map<string, number> }>();
const settlementsCache = new Map<string, { at: number; data: AgentSettlement }>();

async function resolveAgentTag(login: string, fullName?: string): Promise<string | null> {
  const cacheKey = foldName(login);
  const hit = tagCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 300_000) return hit.tag;

  for (const tag of aliasesForLogin(login, fullName)) {
    const page = await moysklad<{ meta?: { size?: number } }>(
      `/entity/counterparty?limit=1&filter=${encodeURIComponent(`tags=${tag}`)}`,
    ).catch(() => null);
    const size = Number(page?.meta?.size || 0);
    if (size > 0) {
      tagCache.set(cacheKey, { at: Date.now(), tag });
      return tag;
    }
  }
  tagCache.set(cacheKey, { at: Date.now(), tag: null });
  return null;
}

async function listTagCounterparties(tag: string) {
  const hit = groupCache.get(tag);
  if (hit && Date.now() - hit.at < 120_000) return hit.rows;

  const out: Array<{ id: string; name: string }> = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const page = await moysklad<{ rows?: MsCp[] }>(
      `/entity/counterparty?limit=100&offset=${offset}&filter=${encodeURIComponent(`tags=${tag}`)}`,
    ).catch(() => ({ rows: [] as MsCp[] }));
    const rows = page.rows || [];
    if (!rows.length) break;
    for (const row of rows) {
      if (!row.id || !row.name) continue;
      out.push({ id: row.id, name: row.name.trim() });
    }
    if (rows.length < 100) break;
  }
  groupCache.set(tag, { at: Date.now(), rows: out });
  return out;
}

async function loadPeriodMovements(from: string, to: string) {
  const key = `${from}:${to}`;
  const hit = movementCache.get(key);
  if (hit && Date.now() - hit.at < 90_000) return hit.byCp;

  const byCp = new Map<string, { credit: number; debit: number }>();
  const bump = (id: string, side: "credit" | "debit", sum: number) => {
    if (!id || !Number.isFinite(sum) || sum === 0) return;
    const cur = byCp.get(id) || { credit: 0, debit: 0 };
    cur[side] += sum;
    byCp.set(id, cur);
  };

  const moment = `moment>=${from} 00:00:00;moment<=${to} 23:59:59`;
  // MS взаиморасчеты: Приход = balansni oshiradi, Расход = kamaytiradi.
  const creditEntities = ["paymentin", "cashin", "salesreturn", "supply"] as const;
  const debitEntities = ["demand", "paymentout", "cashout", "purchasereturn"] as const;

  const scan = async (entity: string, side: "credit" | "debit") => {
    for (let offset = 0; offset < 8000; offset += 100) {
      const page = await moysklad<{ rows?: MsDoc[] }>(
        `/entity/${entity}?limit=100&offset=${offset}&filter=${encodeURIComponent(moment)}`,
      ).catch(() => ({ rows: [] as MsDoc[] }));
      const rows = page.rows || [];
      if (!rows.length) break;
      for (const row of rows) bump(docAgentId(row), side, Number(row.sum || 0));
      if (rows.length < 100) break;
    }
  };

  await Promise.all([
    ...creditEntities.map((e) => scan(e, "credit")),
    ...debitEntities.map((e) => scan(e, "debit")),
  ]);

  movementCache.set(key, { at: Date.now(), byCp });
  return byCp;
}

async function loadBalances(from: string, to: string) {
  const key = `${from}:${to}`;
  const hit = balanceCache.get(key);
  if (hit && Date.now() - hit.at < 90_000) return hit.byCp;

  const byCp = new Map<string, number>();
  const momentFrom = `${from} 00:00:00`;
  const momentTo = `${to} 23:59:59`;
  for (let offset = 0; offset < 5000; offset += 100) {
    const page = await moysklad<{ rows?: MsReportRow[] }>(
      `/report/counterparty?limit=100&offset=${offset}&momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}`,
    ).catch(() => ({ rows: [] as MsReportRow[] }));
    const rows = page.rows || [];
    if (!rows.length) break;
    for (const row of rows) {
      const id = String(row.counterparty?.id || cpIdFromHref(row.counterparty?.meta?.href) || "").trim();
      if (!id) continue;
      byCp.set(id, Number(row.balance || 0));
    }
    if (rows.length < 100) break;
  }
  balanceCache.set(key, { at: Date.now(), byCp });
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

function buildSettlement(input: {
  login: string;
  fullName: string;
  from: string;
  to: string;
  tag: string | null;
  group: Array<{ id: string; name: string }>;
  movements: Map<string, { credit: number; debit: number }>;
  balances: Map<string, number>;
}): AgentSettlement {
  if (!input.tag) return emptySettlement(input);

  // MS «Показать с нулевыми оборотами: Нет» — faqat aylanma/qoldiq borlar.
  const rows = input.group
    .map((cp) => {
      const mv = input.movements.get(cp.id) || { credit: 0, debit: 0 };
      const closingKop = input.balances.get(cp.id) ?? 0;
      const openingKop = closingKop - mv.credit + mv.debit;
      return {
        id: cp.id,
        name: cp.name,
        opening: som(openingKop),
        income: som(mv.credit),
        expense: som(mv.debit),
        closing: som(closingKop),
        keep: mv.credit !== 0 || mv.debit !== 0 || openingKop !== 0 || closingKop !== 0,
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

export async function getAgentMsSettlements(input: {
  login: string;
  fullName: string;
  from: string;
  to: string;
}): Promise<AgentSettlement> {
  const empty = emptySettlement(input);
  if (!moyskladConfigured()) return empty;

  const cacheKey = `${foldName(input.login)}:${input.from}:${input.to}`;
  const hit = settlementsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;

  const tag = await resolveAgentTag(input.login, input.fullName);
  if (!tag) {
    settlementsCache.set(cacheKey, { at: Date.now(), data: empty });
    return empty;
  }

  const [group, movements, balances] = await Promise.all([
    listTagCounterparties(tag),
    loadPeriodMovements(input.from, input.to),
    loadBalances(input.from, input.to),
  ]);

  const data = buildSettlement({
    login: input.login,
    fullName: input.fullName,
    from: input.from,
    to: input.to,
    tag,
    group,
    movements,
    balances,
  });
  settlementsCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

/** Reyting — bir marta davr hujjatlari, keyin har agent tegi. */
export async function getAgentsMsSettlementSummaries(
  agents: Array<{ login: string; fullName: string }>,
  from: string,
  to: string,
) {
  const out = new Map<string, AgentSettlement>();
  if (!moyskladConfigured()) {
    for (const agent of agents) out.set(agent.login.toLowerCase(), emptySettlement({ ...agent, from, to }));
    return out;
  }

  const [movements, balances] = await Promise.all([
    loadPeriodMovements(from, to),
    loadBalances(from, to),
  ]);

  for (const agent of agents) {
    const tag = await resolveAgentTag(agent.login, agent.fullName);
    const group = tag ? await listTagCounterparties(tag) : [];
    const data = buildSettlement({
      login: agent.login,
      fullName: agent.fullName,
      from,
      to,
      tag,
      group,
      movements,
      balances,
    });
    const cacheKey = `${foldName(agent.login)}:${from}:${to}`;
    settlementsCache.set(cacheKey, { at: Date.now(), data });
    out.set(agent.login.toLowerCase(), data);
  }
  return out;
}
