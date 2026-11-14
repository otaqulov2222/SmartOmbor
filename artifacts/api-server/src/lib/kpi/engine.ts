import { asc, desc, eq, sql } from "drizzle-orm";
import {
  db,
  kpiAgentsTable,
  kpiCalculationsTable,
  kpiLedgerTable,
  kpiOrdersTable,
  kpiPoliciesTable,
  kpiStagesTable,
} from "@workspace/db";
import { money, moneyCmp, moneyPct } from "./money";

function tashkentYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export type StageSnap = {
  name: string;
  sortOrder: number;
  dayFrom: number;
  dayTo: number;
  percent: string;
};

export type PolicySnap = {
  id: string;
  name: string;
  baseType: string;
  startAnchor: string;
  warningDays: number;
  stages: StageSnap[];
};

export async function getActivePolicy(): Promise<PolicySnap | null> {
  const policies = await db
    .select()
    .from(kpiPoliciesTable)
    .where(eq(kpiPoliciesTable.active, true))
    .orderBy(desc(kpiPoliciesTable.updatedAt))
    .limit(1);
  const policy = policies[0];
  if (!policy) return null;
  const stages = await db
    .select()
    .from(kpiStagesTable)
    .where(eq(kpiStagesTable.policyId, policy.id))
    .orderBy(asc(kpiStagesTable.sortOrder));
  return {
    id: policy.id,
    name: policy.name,
    baseType: policy.baseType,
    startAnchor: policy.startAnchor,
    warningDays: policy.warningDays,
    stages: stages.map((s) => ({
      name: s.name,
      sortOrder: s.sortOrder,
      dayFrom: s.dayFrom,
      dayTo: s.dayTo,
      percent: money(s.percent),
    })),
  };
}

export function snapshotPolicy(policy: PolicySnap): PolicySnap {
  return structuredClone(policy);
}

/** Calendar-day difference in Asia/Tashkent (not server UTC local). */
function daysBetween(anchor: Date, now = new Date()): number {
  const a = tashkentYmd(anchor);
  const b = tashkentYmd(now);
  const aMs = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
  const bMs = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
  return Math.floor((bMs - aMs) / 86_400_000);
}

export function resolveStage(stages: StageSnap[], dayIndex: number): StageSnap | null {
  const sorted = [...stages].sort((a, b) => a.sortOrder - b.sortOrder || a.dayFrom - b.dayFrom);
  for (const stage of sorted) {
    if (dayIndex >= stage.dayFrom && dayIndex <= stage.dayTo) return stage;
  }
  return null;
}

function stageEndsAt(anchor: Date, stage: StageSnap | null): Date | null {
  if (!stage) return null;
  const end = new Date(anchor);
  end.setDate(end.getDate() + stage.dayTo);
  end.setHours(23, 59, 59, 999);
  return end;
}

/** 1: shu kun 3% · 2: 1 hafta 2% · 3: 15 kun ichida 1%. */
export const DEFAULT_STAGES: StageSnap[] = [
  { name: "1-bosqich", sortOrder: 1, dayFrom: 0, dayTo: 0, percent: "3.00" },
  { name: "2-bosqich", sortOrder: 2, dayFrom: 1, dayTo: 7, percent: "2.00" },
  { name: "3-bosqich", sortOrder: 3, dayFrom: 8, dayTo: 15, percent: "1.00" },
];

export async function ensureDefaultPolicy(actorId?: string) {
  const existing = await getActivePolicy();
  if (existing) return existing;
  const [policy] = await db
    .insert(kpiPoliciesTable)
    .values({
      name: "Standart 3 bosqich",
      active: true,
      baseType: "paid_amount",
      startAnchor: "order_confirmed",
      warningDays: 2,
      createdBy: actorId || "system",
    })
    .returning();
  for (const stage of DEFAULT_STAGES) {
    await db.insert(kpiStagesTable).values({
      policyId: policy.id,
      name: stage.name,
      sortOrder: stage.sortOrder,
      dayFrom: stage.dayFrom,
      dayTo: stage.dayTo,
      percent: stage.percent,
    });
  }
  return (await getActivePolicy())!;
}

/** Jack qoidasi: 3% / 2% / 1% diapazonlarini majburiy qo‘llash. */
export async function ensureTargetStages() {
  const policy = await ensureDefaultPolicy();
  const sig = policy.stages
    .map((s) => `${s.dayFrom}-${s.dayTo}:${Number(s.percent).toFixed(2)}`)
    .join("|");
  const targetSig = DEFAULT_STAGES.map((s) => `${s.dayFrom}-${s.dayTo}:${Number(s.percent).toFixed(2)}`).join("|");
  if (sig === targetSig) return policy;

  await db.delete(kpiStagesTable).where(eq(kpiStagesTable.policyId, policy.id));
  for (const stage of DEFAULT_STAGES) {
    await db.insert(kpiStagesTable).values({
      policyId: policy.id,
      name: stage.name,
      sortOrder: stage.sortOrder,
      dayFrom: stage.dayFrom,
      dayTo: stage.dayTo,
      percent: stage.percent,
    });
  }
  return (await getActivePolicy())!;
}

export async function refreshOrderKpi(
  orderId: string,
  actorId?: string,
  opts?: { useLatestPolicy?: boolean },
) {
  const orders = await db.select().from(kpiOrdersTable).where(eq(kpiOrdersTable.id, orderId)).limit(1);
  const order = orders[0];
  if (!order) return null;
  if (order.status === "cancelled" || order.status === "draft") {
    return null;
  }

  let snap = (order.policySnapshot as PolicySnap | null) || null;
  if (opts?.useLatestPolicy || !snap?.stages?.length) {
    const latest = await getActivePolicy();
    if (latest) {
      snap = latest;
      await db
        .update(kpiOrdersTable)
        .set({ policySnapshot: latest as unknown as Record<string, unknown> })
        .where(eq(kpiOrdersTable.id, orderId));
    }
  }
  if (!snap) return null;

  const [agentRow] = await db
    .select({ login: kpiAgentsTable.login, fullName: kpiAgentsTable.fullName })
    .from(kpiAgentsTable)
    .where(eq(kpiAgentsTable.id, order.agentId))
    .limit(1);
  const isHouseAccount =
    agentRow?.login === "ofis" ||
    agentRow?.login === "vanseling" ||
    agentRow?.fullName.toLowerCase() === "ofis";

  const anchor = order.confirmedAt
    ? new Date(order.confirmedAt)
    : new Date(`${order.orderDate}T09:00:00+05:00`);
  const settledAt =
    moneyCmp(order.paidAmount, order.total) >= 0 && order.invoiceRef
      ? new Date(order.invoiceRef)
      : new Date();
  const refDate = Number.isNaN(settledAt.getTime()) ? new Date() : settledAt;
  const dayIndex = Math.max(0, daysBetween(anchor, refDate));
  const stage = isHouseAccount ? null : resolveStage(snap.stages, dayIndex);
  const percent = stage ? money(stage.percent) : "0.00";
  const baseType = snap.baseType || "paid_amount";
  const baseAmount =
    baseType === "order_total" ? money(order.total) : money(order.paidAmount);
  const kpiAmount = isHouseAccount ? "0.00" : moneyPct(baseAmount, percent);
  const ends = stageEndsAt(anchor, stage);
  const daysRemaining = stage ? Math.max(0, stage.dayTo - dayIndex) : 0;

  let status = "pending";
  if (order.status === "cancelled") status = "cancelled";
  else if (moneyCmp(order.paidAmount, 0) <= 0) status = "pending";
  else if (moneyCmp(order.paidAmount, order.total) >= 0) status = "confirmed";
  else status = "partial";
  if (!stage && moneyCmp(baseAmount, 0) > 0) status = "expired";

  const existing = await db
    .select()
    .from(kpiCalculationsTable)
    .where(eq(kpiCalculationsTable.orderId, orderId))
    .limit(1);

  const payload = {
    agentId: order.agentId,
    baseType,
    baseAmount,
    stageName: stage?.name || "0%",
    stagePercent: percent,
    kpiAmount,
    status,
    stageDayFrom: stage?.dayFrom ?? 0,
    stageDayTo: stage?.dayTo ?? 0,
    anchorAt: anchor,
    stageEndsAt: ends,
    daysRemaining,
    policySnapshot: snap as unknown as Record<string, unknown>,
  };

  let calcId: string;
  if (existing[0]) {
    const prev = existing[0];
    await db
      .update(kpiCalculationsTable)
      .set(payload)
      .where(eq(kpiCalculationsTable.id, prev.id));
    calcId = prev.id;
    if (moneyCmp(prev.kpiAmount, kpiAmount) !== 0 || prev.stagePercent !== percent) {
      await db.insert(kpiLedgerTable).values({
        orderId,
        agentId: order.agentId,
        calculationId: calcId,
        entryType: "recalc",
        amount: kpiAmount,
        reason: `Bosqich: ${payload.stageName} (${percent}%)`,
        percent,
        actorId: actorId || "system",
        meta: { previous: prev.kpiAmount, dayIndex },
      });
    }
  } else {
    const [row] = await db
      .insert(kpiCalculationsTable)
      .values({ orderId, ...payload })
      .returning();
    calcId = row.id;
    await db.insert(kpiLedgerTable).values({
      orderId,
      agentId: order.agentId,
      calculationId: calcId,
      entryType: "accrual",
      amount: kpiAmount,
      reason: `KPI ochildi: ${payload.stageName}`,
      percent,
      actorId: actorId || "system",
      meta: { dayIndex },
    });
  }

  return db.select().from(kpiCalculationsTable).where(eq(kpiCalculationsTable.id, calcId)).limit(1).then((r) => r[0]);
}

export async function refreshAllOpenKpis(limit = 500, opts?: { useLatestPolicy?: boolean }) {
  const rows = await db
    .select({ id: kpiOrdersTable.id })
    .from(kpiOrdersTable)
    .where(sql`${kpiOrdersTable.status} NOT IN ('draft','cancelled')`)
    .limit(limit);
  for (const row of rows) {
    await refreshOrderKpi(row.id, "system", opts);
  }
  return rows.length;
}

export async function cancelOrderKpi(orderId: string, actorId?: string) {
  const calcs = await db
    .select()
    .from(kpiCalculationsTable)
    .where(eq(kpiCalculationsTable.orderId, orderId))
    .limit(1);
  const calc = calcs[0];
  if (!calc) return;
  await db
    .update(kpiCalculationsTable)
    .set({ status: "cancelled", kpiAmount: "0.00", stagePercent: "0.00" })
    .where(eq(kpiCalculationsTable.id, calc.id));
  await db.insert(kpiLedgerTable).values({
    orderId,
    agentId: calc.agentId,
    calculationId: calc.id,
    entryType: "reversal",
    amount: money(calc.kpiAmount),
    reason: "Savdo bekor qilindi",
    percent: "0",
    actorId: actorId || "system",
  });
}
