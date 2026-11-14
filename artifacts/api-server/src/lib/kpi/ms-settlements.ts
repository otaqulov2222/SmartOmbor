/**
 * MoySklad «Взаиморасчеты» — agent guruhidagi kontragentlar hisoboti.
 * KPI reyting/detail shu manbadan (otgruzka taxmini emas).
 */
import { moysklad, moyskladConfigured } from "../moysklad";
import { money } from "./money";

const AGENT_FOLDER_ALIASES: Record<string, string[]> = {
  shaxzod: ["shaxzod", "шахзод", "Shaxzod", "Шаход", "Шахзод"],
  oysha: ["oysha", "oisha", "Oysha", "Ойша"],
  farzona: ["farzona", "Farzona", "Фарзона"],
  elyor: ["elyor", "Elyor", "Элёр", "Элер"],
  abbos: ["abbos", "Abbos", "Аббос"],
  baxodir: ["baxodir", "Baxodir", "Боходир", "Баходир"],
  muzaffar: ["muzaffar", "Muzaffar", "Музаффар"],
  avliyo: ["avliyo", "Avliyo", "Авлиё"],
  gulzoda: ["gulzoda", "Gulzoda"],
  nafisa: ["nafisa", "Nafisa"],
  nozim: ["nozim", "Nozim"],
  abdugani: ["abdugani", "abdug'ani", "Abdug'ani"],
  farxodaka: ["farxodaka", "farxod aka", "Farxod aka"],
};

type MsFolder = { id?: string; name?: string; meta?: { href?: string } };
type MsCp = { id?: string; name?: string; meta?: { href?: string } };
type MsSettlementRow = {
  counterparty?: { id?: string; name?: string; meta?: { href?: string } };
  firstDebt?: number;
  credit?: number;
  debit?: number;
  lastDebt?: number;
  // ba’zi akkauntlarda boshqa nomlar
  firstBalance?: number;
  lastBalance?: number;
  creditSum?: number;
  debitSum?: number;
};

function som(kopecks: unknown) {
  const n = Number(kopecks);
  return money(Number.isFinite(n) ? n / 100 : 0);
}

function foldName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function aliasesForLogin(login: string) {
  const key = foldName(login);
  return AGENT_FOLDER_ALIASES[key] || [login, key];
}

let folderCache: { at: number; rows: MsFolder[] } | null = null;

async function listFolders() {
  if (folderCache && Date.now() - folderCache.at < 120_000) return folderCache.rows;
  const page = await moysklad<{ rows?: MsFolder[] }>("/entity/counterpartyfolder?limit=100").catch(
    () => ({ rows: [] as MsFolder[] }),
  );
  folderCache = { at: Date.now(), rows: page.rows || [] };
  return folderCache.rows;
}

export async function findAgentFolder(login: string, fullName?: string) {
  const folders = await listFolders();
  const wanted = new Set(
    [...aliasesForLogin(login), fullName || "", login]
      .map(foldName)
      .filter(Boolean),
  );
  for (const folder of folders) {
    const name = foldName(folder.name || "");
    if (!name || !folder.meta?.href) continue;
    if (wanted.has(name)) return folder;
  }
  // qisman moslash: "shaxzod" ichida
  for (const folder of folders) {
    const name = foldName(folder.name || "");
    if (!folder.meta?.href) continue;
    for (const alias of wanted) {
      if (alias.length >= 4 && (name.includes(alias) || alias.includes(name))) return folder;
    }
  }
  return null;
}

export async function listGroupCounterparties(folderHref: string) {
  const out: Array<{ id: string; name: string }> = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const page = await moysklad<{ rows?: MsCp[] }>(
      `/entity/counterparty?limit=100&offset=${offset}&filter=${encodeURIComponent(`group=${folderHref}`)}`,
    ).catch(() => ({ rows: [] as MsCp[] }));
    const rows = page.rows || [];
    if (!rows.length) break;
    for (const row of rows) {
      if (!row.id || !row.name) continue;
      out.push({ id: row.id, name: row.name.trim() });
    }
    if (rows.length < 100) break;
  }
  return out;
}

function pickRowMoney(row: MsSettlementRow) {
  const opening = row.firstDebt ?? row.firstBalance ?? 0;
  const income = row.credit ?? row.creditSum ?? 0;
  const expense = row.debit ?? row.debitSum ?? 0;
  const closing = row.lastDebt ?? row.lastBalance ?? 0;
  return {
    opening: som(opening),
    income: som(income),
    expense: som(expense),
    closing: som(closing),
  };
}

async function fetchSettlementRows(from: string, to: string) {
  const rows: MsSettlementRow[] = [];
  const momentFrom = `${from} 00:00:00`;
  const momentTo = `${to} 23:59:59`;
  for (let offset = 0; offset < 5000; offset += 100) {
    const page = await moysklad<{ rows?: MsSettlementRow[] }>(
      `/report/counterparty?limit=100&offset=${offset}&momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}`,
    ).catch(() => ({ rows: [] as MsSettlementRow[] }));
    const chunk = page.rows || [];
    if (!chunk.length) break;
    rows.push(...chunk);
    if (chunk.length < 100) break;
  }
  return rows;
}

function cpIdOf(row: MsSettlementRow) {
  const href = row.counterparty?.meta?.href || "";
  const fromHref = href.split("/").pop()?.split("?")[0] || "";
  return String(row.counterparty?.id || fromHref || "").trim();
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

const settlementsCache = new Map<string, { at: number; data: AgentSettlement }>();

export async function getAgentMsSettlements(input: {
  login: string;
  fullName: string;
  from: string;
  to: string;
}): Promise<AgentSettlement> {
  const empty: AgentSettlement = {
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
  if (!moyskladConfigured()) return empty;

  const cacheKey = `${input.login}:${input.from}:${input.to}`;
  const hit = settlementsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;

  const folder = await findAgentFolder(input.login, input.fullName);
  if (!folder?.meta?.href) {
    settlementsCache.set(cacheKey, { at: Date.now(), data: empty });
    return empty;
  }

  const group = await listGroupCounterparties(folder.meta.href);
  const idSet = new Set(group.map((g) => g.id));
  const nameById = new Map(group.map((g) => [g.id, g.name]));

  const report = await fetchSettlementRows(input.from, input.to);
  const byId = new Map<string, ReturnType<typeof pickRowMoney>>();
  for (const row of report) {
    const id = cpIdOf(row);
    if (!id || !idSet.has(id)) continue;
    byId.set(id, pickRowMoney(row));
  }

  // Guruhdagi BARCHA mijozlar — MS kabi (0 balansli ham).
  const rows = group
    .map((cp) => {
      const m = byId.get(cp.id) || {
        opening: "0.00",
        income: "0.00",
        expense: "0.00",
        closing: "0.00",
      };
      return { id: cp.id, name: nameById.get(cp.id) || cp.name, ...m };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "uz"));

  const sum = (key: "opening" | "income" | "expense" | "closing") =>
    money(rows.reduce((acc, row) => acc + Number(row[key] || 0), 0));

  const data: AgentSettlement = {
    agentLogin: input.login,
    agentName: input.fullName,
    folderName: folder.name || null,
    period: { from: input.from, to: input.to },
    customers: rows.length,
    income: sum("income"),
    expense: sum("expense"),
    opening: sum("opening"),
    closing: sum("closing"),
    rows,
  };
  settlementsCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

/** Reyting uchun — har agent guruhidan MS totals (ketma-ket, cache bilan). */
export async function getAgentsMsSettlementSummaries(
  agents: Array<{ login: string; fullName: string }>,
  from: string,
  to: string,
) {
  const out = new Map<string, AgentSettlement>();
  for (const agent of agents) {
    const row = await getAgentMsSettlements({
      login: agent.login,
      fullName: agent.fullName,
      from,
      to,
    });
    out.set(agent.login.toLowerCase(), row);
  }
  return out;
}
