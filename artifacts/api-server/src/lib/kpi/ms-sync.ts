import { and, eq, sql } from "drizzle-orm";
import {
  db,
  kpiAgentsTable,
  kpiCustomerAssignmentsTable,
  kpiCustomersTable,
  kpiOrdersTable,
  kpiPaymentsTable,
} from "@workspace/db";
import { moysklad, moyskladConfigured } from "../moysklad";
import { hashPassword } from "./auth";
import { ensureDefaultPolicy, refreshOrderKpi, snapshotPolicy } from "./engine";
import { money } from "./money";

const SKIP_TAGS = new Set([
  "покупатель",
  "поставщик",
  "все",
  "ololmaysan",
  "usd",
  "som",
  "телеграм магазин от icorp",
  "call center",
]);

/** Default known Bordo MoySklad sales agents so list is never empty even before API round-trip finishes. */
const KNOWN_AGENTS: Array<[string, string]> = [
  ["Oysha", "oysha"],
  ["Shaxzod", "shaxzod"],
  ["Farzona", "farzona"],
  ["Elyor", "elyor"],
  ["Abbos", "abbos"],
  ["Baxodir", "baxodir"],
  ["Muzaffar", "muzaffar"],
  ["Avliyo", "avliyo"],
  ["Gulzoda", "gulzoda"],
  ["Nafisa", "nafisa"],
  ["Abdug'ani", "abdugani"],
  ["Nozim", "nozim"],
  ["Farxod aka", "farxodaka"],
  ["Van seling", "vanseling"],
  ["Ofis", "ofis"],
];

const ALIAS: Record<string, string> = {
  oisha: "Oysha",
  oysha: "Oysha",
  шахзод: "Shaxzod",
  shaxzod: "Shaxzod",
  музаффар: "Muzaffar",
  muzaffar: "Muzaffar",
  боходир: "Baxodir",
  baxodir: "Baxodir",
  elyor: "Elyor",
  abbos: "Abbos",
  farzona: "Farzona",
  gulzoda: "Gulzoda",
  avliyo: "Avliyo",
  nafisa: "Nafisa",
  nozim: "Nozim",
  "farxod aka": "Farxod aka",
  "abdug'ani": "Abdug'ani",
  abdugani: "Abdug'ani",
  ofis: "Ofis",
  "van seling": "Van seling",
};

function canonicalAgentName(raw: string): string | null {
  const clean = raw.trim().replace(/\s+/g, " ");
  if (!clean) return null;
  const low = clean.toLowerCase();
  if (SKIP_TAGS.has(low)) return null;
  if (ALIAS[low]) return ALIAS[low];
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function slugLogin(name: string) {
  const low = name.toLowerCase();
  for (const [full, login] of KNOWN_AGENTS) {
    if (full.toLowerCase() === low) return login;
  }
  return (
    low
      .replace(/[^a-z0-9а-яё]+/gi, "")
      .slice(0, 24) || "agent"
  );
}

type MsChannel = { id?: string; name?: string };
type MsCounterparty = {
  id?: string;
  name?: string;
  phone?: string;
  actualAddress?: string;
  legalAddress?: string;
  inn?: string;
  tags?: string[];
};
type MsPayment = {
  id?: string;
  moment?: string;
  linkedSum?: number;
  sum?: number;
  name?: string;
  meta?: { type?: string; href?: string };
};
type MsDemand = {
  id?: string;
  name?: string;
  moment?: string;
  applicable?: boolean;
  sum?: number;
  payedSum?: number;
  agent?: MsCounterparty;
  salesChannel?: { name?: string };
  payments?: MsPayment[];
};

let syncing: Promise<{ agents: number; customers: number; orders: number }> | null = null;
let lastSyncAt = 0;
let seededKnown = false;

/** Instant (<100ms): ensures known MoySklad agents exist in DB so UI is never blank. */
export async function ensureSeedAgents(cache = new Map<string, string>()) {
  const existing = await db.select().from(kpiAgentsTable);
  for (const a of existing) {
    cache.set(a.fullName.toLowerCase(), a.id);
    cache.set(a.login.toLowerCase(), a.id);
  }
  if (seededKnown && existing.length >= KNOWN_AGENTS.length) return cache;
  const pw = hashPassword("1234");
  for (const [fullName, login] of KNOWN_AGENTS) {
    if (cache.has(fullName.toLowerCase()) || cache.has(login)) continue;
    const [row] = await db
      .insert(kpiAgentsTable)
      .values({
        fullName,
        login,
        passwordHash: pw,
        status: "active",
        notes: "MoySklad",
        createdBy: "moysklad",
      })
      .onConflictDoNothing()
      .returning();
    if (row) {
      cache.set(fullName.toLowerCase(), row.id);
      cache.set(login, row.id);
    }
  }
  const reload = await db.select().from(kpiAgentsTable);
  for (const a of reload) {
    cache.set(a.fullName.toLowerCase(), a.id);
    cache.set(a.login.toLowerCase(), a.id);
  }
  seededKnown = true;
  return cache;
}

export async function syncKpiFromMoySklad(force = false) {
  await ensureSeedAgents();
  if (!moyskladConfigured()) return { agents: KNOWN_AGENTS.length, customers: 0, orders: 0 };
  if (!force && Date.now() - lastSyncAt < 45_000) {
    return { agents: KNOWN_AGENTS.length, customers: 0, orders: 0 };
  }
  if (syncing) return syncing;
  syncing = runSync()
    .then((res) => {
      lastSyncAt = Date.now();
      return res;
    })
    .finally(() => {
      syncing = null;
    });
  return syncing;
}

async function ensureAgentByName(
  cache: Map<string, string>,
  rawName: string,
): Promise<string | null> {
  const name = canonicalAgentName(rawName);
  if (!name) return null;
  const key = name.toLowerCase();
  const login = slugLogin(name);
  const hit = cache.get(key) || cache.get(login);
  if (hit) return hit;

  const [created] = await db
    .insert(kpiAgentsTable)
    .values({
      fullName: name,
      login,
      passwordHash: hashPassword("1234"),
      status: "active",
      notes: "MoySklad",
      createdBy: "moysklad",
    })
    .onConflictDoNothing()
    .returning();
  if (created) {
    cache.set(key, created.id);
    cache.set(login, created.id);
    return created.id;
  }
  const [found] = await db
    .select()
    .from(kpiAgentsTable)
    .where(eq(kpiAgentsTable.login, login))
    .limit(1);
  if (found) {
    cache.set(key, found.id);
    cache.set(login, found.id);
    return found.id;
  }
  return null;
}

function pickAgentFromTags(tags?: string[]): string | null {
  for (const tag of tags || []) {
    const c = canonicalAgentName(tag);
    if (c && c !== "Ofis") return c;
  }
  for (const tag of tags || []) {
    const c = canonicalAgentName(tag);
    if (c) return c;
  }
  return null;
}

async function runSync() {
  const policy = await ensureDefaultPolicy("moysklad");
  const snap = snapshotPolicy(policy);
  const agentCache = await ensureSeedAgents();

  // 1. Sales channels → any new agents
  const channels = await moysklad<{ rows?: MsChannel[] }>("/entity/saleschannel?limit=100").catch(
    () => ({ rows: [] as MsChannel[] }),
  );
  for (const ch of channels.rows || []) {
    if (ch.name) await ensureAgentByName(agentCache, ch.name);
  }

  const customerByMsId = new Map<string, { id: string; agentId: string | null }>();
  const localCustomers = await db.select().from(kpiCustomersTable);
  for (const c of localCustomers) {
    if (c.contractNumber.startsWith("ms:")) {
      customerByMsId.set(c.contractNumber.slice(3), { id: c.id, agentId: c.createdByAgentId });
    }
  }

  // 2. Demands FIRST (fast — 100 latest shipments with buyer + payments)
  const demands = await moysklad<{ rows?: MsDemand[] }>(
    "/entity/demand?limit=100&order=moment,desc&expand=agent,salesChannel,payments",
  ).catch(() => ({ rows: [] as MsDemand[] }));

  const fallbackAgentId = (await ensureAgentByName(agentCache, "Ofis"))!;
  const existingOrders = await db.select().from(kpiOrdersTable);
  const orderByNumber = new Map(existingOrders.map((o) => [o.number, o]));
  let orderCount = 0;

  for (const d of demands.rows || []) {
    if (!d.id || !d.name || d.applicable === false) continue;
    const cp = d.agent;
    if (!cp?.id || !cp.name) continue;
    const chName = d.salesChannel?.name ? canonicalAgentName(d.salesChannel.name) : null;
    const tagName = pickAgentFromTags(cp.tags);
    const agentName = chName || tagName || "Ofis";
    const agentId = (await ensureAgentByName(agentCache, agentName)) || fallbackAgentId;

    let cust = customerByMsId.get(cp.id);
    if (!cust) {
      const [created] = await db
        .insert(kpiCustomersTable)
        .values({
          name: cp.name.trim(),
          phone: cp.phone || "",
          address: cp.actualAddress || cp.legalAddress || "",
          type: "store",
          status: "active",
          contractNumber: `ms:${cp.id}`,
          notes: (cp.tags || []).join(", "),
          createdByAgentId: agentId,
          createdBy: "moysklad",
        })
        .returning();
      cust = { id: created.id, agentId };
      customerByMsId.set(cp.id, cust);
      await db.insert(kpiCustomerAssignmentsTable).values({
        customerId: created.id,
        agentId,
        active: true,
        assignedBy: "moysklad",
      });
    }

    const total = money((d.sum || 0) / 100);
    const paid = money((d.payedSum || 0) / 100);
    const momentDate = d.moment ? new Date(d.moment.replace(" ", "T") + "+05:00") : new Date();
    const orderDate = (d.moment || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
    const number = `MS-${d.name}`;
    let status = "confirmed";
    if (Number(paid) >= Number(total) && Number(total) > 0) status = "paid";
    else if (Number(paid) > 0) status = "partially_paid";

    let latestPayAt: Date | null = null;
    for (const p of d.payments || []) {
      if (p.moment) {
        const dt = new Date(p.moment.replace(" ", "T") + "+05:00");
        if (!latestPayAt || dt > latestPayAt) latestPayAt = dt;
      }
    }

    const prev = orderByNumber.get(number);
    let orderId: string;
    if (prev) {
      orderId = prev.id;
      if (prev.paidAmount !== paid || prev.total !== total || prev.agentId !== agentId) {
        await db
          .update(kpiOrdersTable)
          .set({
            agentId,
            customerId: cust.id,
            total,
            subtotal: total,
            paidAmount: paid,
            status,
            orderDate,
            confirmedAt: momentDate,
            invoiceRef: latestPayAt ? latestPayAt.toISOString() : prev.invoiceRef,
          })
          .where(eq(kpiOrdersTable.id, orderId));
      }
    } else {
      const [created] = await db
        .insert(kpiOrdersTable)
        .values({
          number,
          customerId: cust.id,
          agentId,
          status,
          orderDate,
          deliveryStatus: "delivered",
          paymentType: "deferred",
          subtotal: total,
          discount: "0.00",
          total,
          paidAmount: paid,
          contractRef: `ms-demand:${d.id}`,
          invoiceRef: latestPayAt ? latestPayAt.toISOString() : "",
          confirmedAt: momentDate,
          confirmedBy: "moysklad",
          policyId: policy.id,
          policySnapshot: snap as unknown as Record<string, unknown>,
          createdBy: "moysklad",
        })
        .returning();
      orderId = created.id;
      orderByNumber.set(number, created);
    }

    for (const p of d.payments || []) {
      const pid = p.meta?.href?.split("/").pop() || p.id;
      if (!pid) continue;
      const idem = `ms-pay:${d.id}:${pid}`;
      const payAmt = money(((p.linkedSum ?? p.sum) || 0) / 100);
      if (Number(payAmt) <= 0) continue;
      const paidAt = p.moment ? new Date(p.moment.replace(" ", "T") + "+05:00") : momentDate;
      await db
        .insert(kpiPaymentsTable)
        .values({
          orderId,
          amount: payAmt,
          paidAt,
          method: p.meta?.type || "cashin",
          reference: p.name || "MoySklad",
          status: "confirmed",
          idempotencyKey: idem,
          confirmedAt: paidAt,
          confirmedBy: "moysklad",
          createdBy: "moysklad",
        })
        .onConflictDoNothing();
    }

    await refreshOrderKpi(orderId, "moysklad");
    orderCount += 1;
  }

  // 3. Background counterparty enrichment (first 300 buyers in chunks)
  void syncCounterpartiesChunk(agentCache, customerByMsId).catch(() => undefined);

  return { agents: agentCache.size, customers: customerByMsId.size, orders: orderCount };
}

async function syncCounterpartiesChunk(
  agentCache: Map<string, string>,
  customerByMsId: Map<string, { id: string; agentId: string | null }>,
) {
  for (let offset = 0; offset < 600; offset += 100) {
    const page = await moysklad<{ rows?: MsCounterparty[] }>(
      `/entity/counterparty?limit=100&offset=${offset}`,
    ).catch(() => ({ rows: [] as MsCounterparty[] }));
    const rows = page.rows || [];
    if (!rows.length) break;
    for (const cp of rows) {
      if (!cp.id || !cp.name || customerByMsId.has(cp.id)) continue;
      const tags = cp.tags || [];
      if (tags.includes("поставщик") && !tags.includes("покупатель")) continue;
      const tagAgent = pickAgentFromTags(tags);
      const agentId = tagAgent ? await ensureAgentByName(agentCache, tagAgent) : null;
      const [created] = await db
        .insert(kpiCustomersTable)
        .values({
          name: cp.name.trim(),
          stir: cp.inn || "",
          phone: cp.phone || "",
          address: cp.actualAddress || cp.legalAddress || "",
          type: "store",
          status: "active",
          contractNumber: `ms:${cp.id}`,
          notes: tags.join(", "),
          createdByAgentId: agentId,
          createdBy: "moysklad",
        })
        .returning();
      customerByMsId.set(cp.id, { id: created.id, agentId });
      if (agentId) {
        await db.insert(kpiCustomerAssignmentsTable).values({
          customerId: created.id,
          agentId,
          active: true,
          assignedBy: "moysklad",
        });
      }
    }
    if (rows.length < 100) break;
  }
}

export async function ensureKpiBootstrapped() {
  await ensureSeedAgents();
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(kpiOrdersTable);
  if (n === 0) {
    await syncKpiFromMoySklad(true).catch(() => undefined);
  } else {
    void syncKpiFromMoySklad(false).catch(() => undefined);
  }
}
