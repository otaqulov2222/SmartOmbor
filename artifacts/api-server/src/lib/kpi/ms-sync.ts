import { and, eq } from "drizzle-orm";
import {
  db,
  kpiAgentsTable,
  kpiCustomerAssignmentsTable,
  kpiCustomersTable,
  kpiOrdersTable,
  kpiPaymentsTable,
} from "@workspace/db";
import { moysklad, moyskladAll, moyskladConfigured } from "../moysklad";
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
  return (
    name
      .toLowerCase()
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

export async function syncKpiFromMoySklad(force = false) {
  if (!moyskladConfigured()) return { agents: 0, customers: 0, orders: 0 };
  if (!force && Date.now() - lastSyncAt < 45_000) {
    return { agents: 0, customers: 0, orders: 0 };
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
  const cached = cache.get(key);
  if (cached) return cached;

  const login = slugLogin(name);
  const existing = await db
    .select()
    .from(kpiAgentsTable)
    .where(eq(kpiAgentsTable.login, login))
    .limit(1);
  if (existing[0]) {
    if (existing[0].fullName !== name) {
      await db
        .update(kpiAgentsTable)
        .set({ fullName: name })
        .where(eq(kpiAgentsTable.id, existing[0].id));
    }
    cache.set(key, existing[0].id);
    return existing[0].id;
  }

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
    .returning();
  cache.set(key, created.id);
  return created.id;
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
  const agentCache = new Map<string, string>();
  const existingAgents = await db.select().from(kpiAgentsTable);
  for (const a of existingAgents) {
    agentCache.set(a.fullName.toLowerCase(), a.id);
    agentCache.set(a.login.toLowerCase(), a.id);
  }

  // 1. Sales channels → agents
  const channels = await moysklad<{ rows?: MsChannel[] }>("/entity/saleschannel?limit=100").catch(
    () => ({ rows: [] as MsChannel[] }),
  );
  for (const ch of channels.rows || []) {
    if (ch.name) await ensureAgentByName(agentCache, ch.name);
  }

  // 2. Counterparties (buyers)
  const cps = await moyskladAll<MsCounterparty>("/entity/counterparty?limit=100", 1500).catch(
    () => ({ rows: [] as MsCounterparty[] }),
  );
  const customerByMsId = new Map<string, { id: string; agentId: string | null }>();
  const localCustomers = await db.select().from(kpiCustomersTable);
  for (const c of localCustomers) {
    if (c.contractNumber.startsWith("ms:")) {
      customerByMsId.set(c.contractNumber.slice(3), { id: c.id, agentId: c.createdByAgentId });
    }
  }

  let customerCount = 0;
  for (const cp of cps.rows || []) {
    if (!cp.id || !cp.name) continue;
    const tags = cp.tags || [];
    if (tags.includes("поставщик") && !tags.includes("покупатель")) continue;
    const tagAgentName = pickAgentFromTags(tags);
    const agentId = tagAgentName ? await ensureAgentByName(agentCache, tagAgentName) : null;
    const msKey = `ms:${cp.id}`;
    const address = cp.actualAddress || cp.legalAddress || "";
    const found = customerByMsId.get(cp.id);
    let customerId: string;
    if (found) {
      customerId = found.id;
      if (agentId && found.agentId !== agentId) {
        await db
          .update(kpiCustomersTable)
          .set({ createdByAgentId: agentId, status: "active" })
          .where(eq(kpiCustomersTable.id, customerId));
      }
    } else {
      const [created] = await db
        .insert(kpiCustomersTable)
        .values({
          name: cp.name.trim(),
          stir: cp.inn || "",
          phone: cp.phone || "",
          address,
          type: "store",
          status: "active",
          contractNumber: msKey,
          notes: tags.join(", "),
          createdByAgentId: agentId,
          createdBy: "moysklad",
        })
        .returning();
      customerId = created.id;
      customerByMsId.set(cp.id, { id: customerId, agentId });
    }
    if (agentId) {
      const [active] = await db
        .select()
        .from(kpiCustomerAssignmentsTable)
        .where(
          and(
            eq(kpiCustomerAssignmentsTable.customerId, customerId),
            eq(kpiCustomerAssignmentsTable.active, true),
          ),
        )
        .limit(1);
      if (!active) {
        await db.insert(kpiCustomerAssignmentsTable).values({
          customerId,
          agentId,
          active: true,
          assignedBy: "moysklad",
        });
      } else if (active.agentId !== agentId) {
        await db
          .update(kpiCustomerAssignmentsTable)
          .set({ agentId })
          .where(eq(kpiCustomerAssignmentsTable.id, active.id));
      }
    }
    customerCount += 1;
  }

  // 3. Recent demands (last ~200 shipments)
  const demands = await moysklad<{ rows?: MsDemand[] }>(
    "/entity/demand?limit=100&order=moment,desc&expand=agent,salesChannel,payments",
  ).catch(() => ({ rows: [] as MsDemand[] }));

  const fallbackAgentId = (await ensureAgentByName(agentCache, "Ofis"))!;
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
    }

    const total = money((d.sum || 0) / 100);
    const paid = money((d.payedSum || 0) / 100);
    const momentDate = d.moment ? new Date(d.moment.replace(" ", "T") + "+05:00") : new Date();
    const orderDate = (d.moment || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
    const number = `MS-${d.name}`;
    let status = "confirmed";
    if (Number(paid) >= Number(total) && Number(total) > 0) status = "paid";
    else if (Number(paid) > 0) status = "partially_paid";

    // latest payment moment for stage calculation if paid
    let latestPayAt: Date | null = null;
    for (const p of d.payments || []) {
      if (p.moment) {
        const dt = new Date(p.moment.replace(" ", "T") + "+05:00");
        if (!latestPayAt || dt > latestPayAt) latestPayAt = dt;
      }
    }

    const existing = await db
      .select()
      .from(kpiOrdersTable)
      .where(eq(kpiOrdersTable.number, number))
      .limit(1);

    let orderId: string;
    if (existing[0]) {
      orderId = existing[0].id;
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
          invoiceRef: latestPayAt ? latestPayAt.toISOString() : existing[0].invoiceRef,
        })
        .where(eq(kpiOrdersTable.id, orderId));
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
    }

    // sync payment records
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

  return { agents: agentCache.size, customers: customerCount, orders: orderCount };
}
