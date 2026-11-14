import { Router, type IRouter } from "express";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  db,
  kpiAgentsTable,
  kpiCalculationsTable,
  kpiCustomerAssignmentsTable,
  kpiCustomersTable,
  kpiLedgerTable,
  kpiLocationEventsTable,
  kpiNotificationsTable,
  kpiOrderItemsTable,
  kpiOrdersTable,
  kpiPaymentsTable,
  kpiPaymentAllocationsTable,
  kpiPoliciesTable,
  kpiProductsTable,
  kpiStagesTable,
  kpiTerritoriesTable,
  kpiVisitPlansTable,
  kpiVisitsTable,
} from "@workspace/db";
import { recordAudit } from "../lib/audit";
import {
  getKpiActor,
  getKpiAgent,
  hashPassword,
  loginAgent,
  logoutAgent,
  requireKpiAdmin,
  requireKpiAgent,
  requireKpiAgentOrAdmin,
} from "../lib/kpi/auth";
import {
  cancelOrderKpi,
  ensureDefaultPolicy,
  getActivePolicy,
  refreshOrderKpi,
  snapshotPolicy,
} from "../lib/kpi/engine";
import { ensureKpiSchema } from "../lib/kpi/ddl";
import { distanceMeters, inferCoordinates, orderRouteStops } from "../lib/kpi/geo";
import {
  BORDIM_GEOFENCE_M,
  hasAdminGps,
  parseAdminCoords,
  reverseGeocode,
} from "../lib/kpi/geocode";
import { ensureKpiBootstrapped, syncKpiFromMoySklad } from "../lib/kpi/ms-sync";
import { defaultKpiPeriod, resolveKpiPeriod } from "../lib/kpi/period";
import { money, moneyAdd, moneyCmp, moneyMul, moneyPct, moneySub } from "../lib/kpi/money";
import { buildXlsx, type Cell } from "../lib/xlsx-file";

const router: IRouter = Router();

router.use("/kpi", (_req, _res, next) => {
  ensureKpiSchema().then(() => next()).catch(next);
});

router.post("/kpi/sync", requireKpiAdmin(), async (req, res, next) => {
  try {
    const period = parsePeriod(req.body?.from, req.body?.to, req.body?.preset);
    const result = await syncKpiFromMoySklad(true, period);
    res.json({ ok: true, ...result, preset: period.preset, label: period.label });
  } catch (error) {
    next(error);
  }
});

function tashkentDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Inclusive from/to. preset: today|week|month|… yoki custom sanalar. */
function parsePeriod(rawFrom?: unknown, rawTo?: unknown, rawPreset?: unknown) {
  const period = resolveKpiPeriod({ from: rawFrom, to: rawTo, preset: rawPreset });
  return {
    ...period,
    label: `${period.label} · MS otgruzka / guruh`,
  };
}

function computePlanPct(monthSales: string | number, salesPlan: string | number): number | null {
  const plan = Number(salesPlan);
  if (!(plan > 0)) return null;
  return Math.round((Number(monthSales) / plan) * 100);
}

async function agentPeriodSales(agentId: string, from: string, to: string) {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${kpiOrdersTable.total}), 0)`,
    })
    .from(kpiOrdersTable)
    .where(
      and(
        eq(kpiOrdersTable.agentId, agentId),
        sql`${kpiOrdersTable.status} not in ('draft','cancelled')`,
        sql`${kpiOrdersTable.orderDate} >= ${from}`,
        sql`${kpiOrdersTable.orderDate} <= ${to}`,
      ),
    );
  return money(row?.total);
}

async function agentPeriodKpi(agentId: string, from: string, to: string) {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${kpiCalculationsTable.kpiAmount}), 0)`,
    })
    .from(kpiCalculationsTable)
    .innerJoin(kpiOrdersTable, eq(kpiOrdersTable.id, kpiCalculationsTable.orderId))
    .where(
      and(
        eq(kpiCalculationsTable.agentId, agentId),
        sql`${kpiCalculationsTable.status} in ('confirmed','partial','pending')`,
        sql`${kpiOrdersTable.orderDate} >= ${from}`,
        sql`${kpiOrdersTable.orderDate} <= ${to}`,
      ),
    );
  return money(row?.total);
}

/**
 * Auto daily visit plan: all active assigned customers.
 * Race-safe via unique (agent_id, plan_date). Backfills new assignments on later calls.
 */
async function ensureDailyVisitPlan(agentId: string) {
  const today = tashkentDate();

  const loadPlan = async () => {
    const rows = await db
      .select()
      .from(kpiVisitPlansTable)
      .where(and(eq(kpiVisitPlansTable.agentId, agentId), eq(kpiVisitPlansTable.planDate, today)))
      .limit(1);
    return rows[0] ?? null;
  };

  let plan = await loadPlan();
  let created = false;
  if (!plan) {
    try {
      const inserted = await db
        .insert(kpiVisitPlansTable)
        .values({
          agentId,
          planDate: today,
          notes: "Avtomatik kunlik reja",
          createdBy: "system",
        })
        .returning();
      plan = inserted[0] ?? null;
      created = Boolean(plan);
    } catch (error: unknown) {
      if (String((error as { code?: string })?.code) !== "23505") throw error;
      plan = await loadPlan();
    }
  }
  if (!plan) {
    throw Object.assign(new Error("Kunlik tashrif rejasi yaratilmadi."), { status: 500 });
  }

  const assigns = await db
    .select()
    .from(kpiCustomerAssignmentsTable)
    .where(and(eq(kpiCustomerAssignmentsTable.agentId, agentId), eq(kpiCustomerAssignmentsTable.active, true)));

  const planVisits = await db.select().from(kpiVisitsTable).where(eq(kpiVisitsTable.planId, plan.id));
  const onPlan = new Map(planVisits.map((v) => [v.customerId, v]));

  const recentVisits = await db
    .select()
    .from(kpiVisitsTable)
    .where(and(eq(kpiVisitsTable.agentId, agentId), eq(kpiVisitsTable.status, "done")))
    .orderBy(desc(kpiVisitsTable.createdAt))
    .limit(500);
  const doneToday = new Map<string, (typeof recentVisits)[0]>();
  for (const v of recentVisits) {
    const day = tashkentDate(v.finishedAt || v.createdAt);
    if (day === today && !doneToday.has(v.customerId)) doneToday.set(v.customerId, v);
  }

  let sortOrder = planVisits.reduce((max, v) => Math.max(max, Number(v.sortOrder) || 0), 0);
  for (const a of assigns) {
    if (onPlan.has(a.customerId)) continue;
    sortOrder += 1;
    const done = doneToday.get(a.customerId);
    if (done) {
      await db
        .update(kpiVisitsTable)
        .set({ planId: plan.id, sortOrder, updatedAt: new Date() })
        .where(eq(kpiVisitsTable.id, done.id));
      onPlan.set(a.customerId, done);
    } else {
      const [row] = await db
        .insert(kpiVisitsTable)
        .values({
          planId: plan.id,
          agentId,
          customerId: a.customerId,
          status: "planned",
          sortOrder,
          plannedAt: new Date(),
        })
        .returning();
      if (row) onPlan.set(a.customerId, row);
    }
  }

  if (created && assigns.length > 0) {
    await db.insert(kpiNotificationsTable).values({
      agentId,
      type: "visit_plan_daily",
      title: "Bugungi tashrif rejasi",
      body: `Bugun ${assigns.length} ta mijoz`,
      meta: { planId: plan.id, planDate: today, count: assigns.length },
    });
  }

  const [cnt] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(kpiVisitsTable)
    .where(eq(kpiVisitsTable.planId, plan.id));

  return { plan, visitPlanCount: cnt?.n ?? onPlan.size, created: created as boolean };
}

async function nextOrderNumber() {
  const day = tashkentDate().replaceAll("-", "");
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(kpiOrdersTable)
    .where(sql`${kpiOrdersTable.number} like ${"KPI-" + day + "%"}`);
  const seq = String((rows[0]?.n ?? 0) + 1).padStart(3, "0");
  return `KPI-${day}-${seq}`;
}

async function activeAssignment(customerId: string) {
  const rows = await db
    .select()
    .from(kpiCustomerAssignmentsTable)
    .where(and(eq(kpiCustomerAssignmentsTable.customerId, customerId), eq(kpiCustomerAssignmentsTable.active, true)))
    .limit(1);
  return rows[0] ?? null;
}

/* ---------- Agent auth ---------- */
router.post("/kpi/agent/login", async (req, res, next) => {
  try {
    const login = String(req.body?.login ?? "");
    const password = String(req.body?.password ?? "");
    const result = await loginAgent(login, password);
    if (!result) {
      res.status(401).json({ error: "Login yoki parol noto‘g‘ri." });
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/agent/logout", requireKpiAgent(), async (req, res, next) => {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (token) await logoutAgent(token);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get("/kpi/agent/me", requireKpiAgent(), async (_req, res, next) => {
  try {
    const agent = getKpiAgent(res);
    const [row] = await db.select().from(kpiAgentsTable).where(eq(kpiAgentsTable.id, agent.id)).limit(1);
    res.json({
      id: row.id,
      fullName: row.fullName,
      phone: row.phone,
      login: row.login,
      status: row.status,
      territoryId: row.territoryId,
      salesPlan: row.salesPlan,
      startedAt: row.startedAt,
    });
  } catch (error) {
    next(error);
  }
});

/* ---------- Dashboard ---------- */
router.get("/kpi/dashboard", requireKpiAdmin(), async (req, res, next) => {
  try {
    await ensureDefaultPolicy();
    await ensureKpiBootstrapped();
    const [agentsAfter] = await db
      .select({
        total: sql<number>`count(*) filter (where lower(${kpiAgentsTable.login}) not in ('ofis','vanseling'))::int`,
        active: sql<number>`count(*) filter (where ${kpiAgentsTable.status} = 'active' and lower(${kpiAgentsTable.login}) not in ('ofis','vanseling'))::int`,
      })
      .from(kpiAgentsTable);
    const period = parsePeriod(req.query.from, req.query.to, req.query.preset);
    const [customers] = await db.select({ total: sql<number>`count(*)::int`, pending: sql<number>`count(*) filter (where ${kpiCustomersTable.status} = 'pending')::int` }).from(kpiCustomersTable);
    const [orders] = await db.select({
      sales: sql<string>`coalesce(sum(${kpiOrdersTable.total}) filter (where ${kpiOrdersTable.status} not in ('draft','cancelled') and ${kpiOrdersTable.orderDate} >= ${period.from} and ${kpiOrdersTable.orderDate} <= ${period.to}), 0)`,
      paid: sql<string>`coalesce(sum(${kpiOrdersTable.paidAmount}) filter (where ${kpiOrdersTable.status} not in ('draft','cancelled') and ${kpiOrdersTable.orderDate} >= ${period.from} and ${kpiOrdersTable.orderDate} <= ${period.to}), 0)`,
      pendingConfirm: sql<number>`count(*) filter (where ${kpiOrdersTable.status} = 'pending_approval')::int`,
      overdue: sql<number>`count(*) filter (where ${kpiOrdersTable.status} = 'overdue')::int`,
    }).from(kpiOrdersTable);
    const [kpi] = await db.select({
      accrued: sql<string>`coalesce(sum(${kpiCalculationsTable.kpiAmount}) filter (where ${kpiCalculationsTable.status} in ('confirmed','partial','pending')), 0)`,
      confirmed: sql<string>`coalesce(sum(${kpiCalculationsTable.kpiAmount}) filter (where ${kpiCalculationsTable.status} = 'confirmed'), 0)`,
      pending: sql<string>`coalesce(sum(${kpiCalculationsTable.kpiAmount}) filter (where ${kpiCalculationsTable.status} = 'pending'), 0)`,
      expired: sql<string>`coalesce(sum(${kpiCalculationsTable.kpiAmount}) filter (where ${kpiCalculationsTable.status} = 'expired'), 0)`,
    }).from(kpiCalculationsTable)
      .innerJoin(kpiOrdersTable, eq(kpiOrdersTable.id, kpiCalculationsTable.orderId))
      .where(and(
        sql`${kpiOrdersTable.orderDate} >= ${period.from}`,
        sql`${kpiOrdersTable.orderDate} <= ${period.to}`,
      ));
    const due = moneySub(orders.sales, orders.paid);
    res.json({
      agentsTotal: agentsAfter.total,
      agentsActive: agentsAfter.active,
      customersTotal: customers.total,
      customersPending: customers.pending,
      salesTotal: money(orders.sales),
      paidTotal: money(orders.paid),
      dueTotal: money(due),
      overdueOrders: orders.overdue,
      pendingApproval: orders.pendingConfirm,
      kpiAccrued: money(kpi.accrued),
      kpiConfirmed: money(kpi.confirmed),
      kpiPending: money(kpi.pending),
      kpiExpired: money(kpi.expired),
      periodStart: period.from,
      periodEnd: period.to,
      periodLabel: period.label,
      periodPreset: period.preset,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/kpi/agent/dashboard", requireKpiAgent(), async (_req, res, next) => {
  try {
    const agent = getKpiAgent(res);
    const [orders] = await db.select({
      sales: sql<string>`coalesce(sum(${kpiOrdersTable.total}) filter (where ${kpiOrdersTable.status} not in ('draft','cancelled')), 0)`,
      paid: sql<string>`coalesce(sum(${kpiOrdersTable.paidAmount}) filter (where ${kpiOrdersTable.status} not in ('draft','cancelled')), 0)`,
      awaiting: sql<number>`count(*) filter (where ${kpiOrdersTable.status} in ('confirmed','partially_paid','overdue'))::int`,
    }).from(kpiOrdersTable).where(eq(kpiOrdersTable.agentId, agent.id));
    const [cust] = await db.select({ n: sql<number>`count(*)::int` }).from(kpiCustomerAssignmentsTable)
      .where(and(eq(kpiCustomerAssignmentsTable.agentId, agent.id), eq(kpiCustomerAssignmentsTable.active, true)));
    const [kpi] = await db.select({
      confirmed: sql<string>`coalesce(sum(${kpiCalculationsTable.kpiAmount}) filter (where ${kpiCalculationsTable.status} = 'confirmed'), 0)`,
      pending: sql<string>`coalesce(sum(${kpiCalculationsTable.kpiAmount}) filter (where ${kpiCalculationsTable.status} in ('pending','partial')), 0)`,
      risk: sql<string>`coalesce(sum(${kpiCalculationsTable.kpiAmount}) filter (where ${kpiCalculationsTable.daysRemaining} is not null and ${kpiCalculationsTable.daysRemaining} <= 2 and ${kpiCalculationsTable.status} in ('pending','partial')), 0)`,
    }).from(kpiCalculationsTable).where(eq(kpiCalculationsTable.agentId, agent.id));
    const nearest = await db.select({
      orderId: kpiOrdersTable.id,
      number: kpiOrdersTable.number,
      due: kpiOrdersTable.paymentDueDate,
      total: kpiOrdersTable.total,
      paid: kpiOrdersTable.paidAmount,
    }).from(kpiOrdersTable)
      .where(and(eq(kpiOrdersTable.agentId, agent.id), sql`${kpiOrdersTable.paymentDueDate} is not null`, sql`${kpiOrdersTable.status} not in ('draft','cancelled','paid')`))
      .orderBy(asc(kpiOrdersTable.paymentDueDate))
      .limit(1);
    res.json({
      customers: cust.n,
      salesTotal: money(orders.sales),
      paidTotal: money(orders.paid),
      awaitingPayments: orders.awaiting,
      kpiConfirmed: money(kpi.confirmed),
      kpiPending: money(kpi.pending),
      kpiAtRisk: money(kpi.risk),
      nearestDue: nearest[0] ?? null,
    });
  } catch (error) {
    next(error);
  }
});

/* ---------- Territories ---------- */
router.get("/kpi/territories", requireKpiAdmin(), async (_req, res, next) => {
  try {
    const rows = await db.select().from(kpiTerritoriesTable).orderBy(asc(kpiTerritoriesTable.name));
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/territories", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
    const name = String(req.body?.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "Hudud nomi kerak." });
      return;
    }
    const [row] = await db.insert(kpiTerritoriesTable).values({
      name,
      region: String(req.body?.region ?? "").trim(),
      createdBy: actor.id,
    }).returning();
    await recordAudit({ action: "kpi.territory.created", entityType: "kpi_territory", entityId: row.id, actorName: actor.name, details: name });
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

/* ---------- Agents ---------- */
router.get("/kpi/agents", requireKpiAdmin(), async (req, res, next) => {
  try {
    await ensureKpiBootstrapped();
    const period = parsePeriod(req.query.from, req.query.to, req.query.preset);
    const allAgents = await db.select().from(kpiAgentsTable).orderBy(asc(kpiAgentsTable.fullName));
    const agents = allAgents.filter((a) => a.login !== "ofis" && a.login !== "vanseling");
    const out = [];
    for (const agent of agents) {
      const [cust] = await db.select({ n: sql<number>`count(*)::int` }).from(kpiCustomerAssignmentsTable)
        .where(and(eq(kpiCustomerAssignmentsTable.agentId, agent.id), eq(kpiCustomerAssignmentsTable.active, true)));
      const salesTotal = await agentPeriodSales(agent.id, period.from, period.to);
      const kpiTotal = await agentPeriodKpi(agent.id, period.from, period.to);
      const salesPlan = money(agent.salesPlan);
      out.push({
        id: agent.id,
        fullName: agent.fullName,
        phone: agent.phone,
        login: agent.login,
        status: agent.status,
        territoryId: agent.territoryId,
        startedAt: agent.startedAt,
        salesPlan,
        notes: agent.notes,
        customers: cust?.n ?? 0,
        salesTotal,
        monthSales: salesTotal,
        planPct: computePlanPct(salesTotal, salesPlan),
        kpiTotal,
        createdAt: agent.createdAt,
        periodStart: period.from,
        periodEnd: period.to,
        periodLabel: period.label,
        periodPreset: period.preset,
      });
    }
    res.json(out);
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/agents", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
    const fullName = String(req.body?.fullName ?? "").trim();
    const login = String(req.body?.login ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    if (!fullName || !login || password.length < 4) {
      res.status(400).json({ error: "F.I.Sh., login va parol (min 4) kerak." });
      return;
    }
    const [row] = await db.insert(kpiAgentsTable).values({
      fullName,
      phone: String(req.body?.phone ?? "").trim(),
      login,
      passwordHash: hashPassword(password),
      territoryId: req.body?.territoryId || null,
      status: String(req.body?.status ?? "active"),
      startedAt: req.body?.startedAt || tashkentDate(),
      salesPlan: money(req.body?.salesPlan ?? 0),
      notes: String(req.body?.notes ?? ""),
      createdBy: actor.id,
    }).returning();
    await recordAudit({ action: "kpi.agent.created", entityType: "kpi_agent", entityId: row.id, actorName: actor.name, details: fullName });
    res.status(201).json({ id: row.id, fullName: row.fullName, login: row.login, status: row.status });
  } catch (error: unknown) {
    if (String((error as { code?: string })?.code) === "23505") {
      res.status(409).json({ error: "Bu login band." });
      return;
    }
    next(error);
  }
});

router.patch("/kpi/agents/:id", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
    const id = String(req.params.id);
    const patch: Record<string, unknown> = {};
    for (const key of ["fullName", "phone", "status", "notes"] as const) {
      if (req.body?.[key] != null) patch[key] = String(req.body[key]);
    }
    if (req.body?.territoryId !== undefined) patch.territoryId = req.body.territoryId || null;
    if (req.body?.startedAt !== undefined) patch.startedAt = req.body.startedAt || null;
    if (req.body?.salesPlan != null) patch.salesPlan = money(req.body.salesPlan);
    if (req.body?.password) patch.passwordHash = hashPassword(String(req.body.password));
    if (req.body?.login) patch.login = String(req.body.login).trim().toLowerCase();
    const [row] = await db.update(kpiAgentsTable).set(patch).where(eq(kpiAgentsTable.id, id)).returning();
    if (!row) {
      res.status(404).json({ error: "Agent topilmadi." });
      return;
    }
    await recordAudit({ action: "kpi.agent.updated", entityType: "kpi_agent", entityId: id, actorName: actor.name, details: row.fullName });
    res.json(row);
  } catch (error) {
    next(error);
  }
});

/* ---------- Customers + assignments ---------- */
router.get("/kpi/customers", requireKpiAdmin(), async (req, res, next) => {
  try {
    await ensureKpiBootstrapped();
    const q = String(req.query.q ?? "").trim();
    const rows = await db.select().from(kpiCustomersTable)
      .where(q ? or(ilike(kpiCustomersTable.name, `%${q}%`), ilike(kpiCustomersTable.phone, `%${q}%`)) : undefined)
      .orderBy(desc(kpiCustomersTable.createdAt))
      .limit(200);
    const out = [];
    for (const c of rows) {
      const assign = await activeAssignment(c.id);
      out.push({ ...c, agentId: assign?.agentId ?? null, assignmentId: assign?.id ?? null });
    }
    res.json(out);
  } catch (error) {
    next(error);
  }
});

router.get("/kpi/agent/customers", requireKpiAgent(), async (_req, res, next) => {
  try {
    const agent = getKpiAgent(res);
    const assigns = await db.select().from(kpiCustomerAssignmentsTable)
      .where(and(eq(kpiCustomerAssignmentsTable.agentId, agent.id), eq(kpiCustomerAssignmentsTable.active, true)));
    const out = [];
    for (const a of assigns) {
      const [c] = await db.select().from(kpiCustomersTable).where(eq(kpiCustomersTable.id, a.customerId)).limit(1);
      if (c) out.push(c);
    }
    res.json(out);
  } catch (error) {
    next(error);
  }
});

router.get("/kpi/geo/reverse", requireKpiAdmin(), async (req, res, next) => {
  try {
    const coords = parseAdminCoords(req.query.lat, req.query.lng);
    if (!coords) {
      res.status(400).json({ error: "Aniq lat/lng kerak." });
      return;
    }
    const geo = await reverseGeocode(coords.lat, coords.lng);
    if (!geo) {
      res.status(404).json({ error: "Manzil topilmadi. Koordinatalarni tekshiring." });
      return;
    }
    res.json({
      lat: Number(coords.lat.toFixed(6)),
      lng: Number(coords.lng.toFixed(6)),
      ...geo,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/customers", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
    const name = String(req.body?.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "Korxona nomi kerak." });
      return;
    }
    const coords = parseAdminCoords(req.body?.lat, req.body?.lng);
    if (!coords) {
      res.status(400).json({ error: "Aniq lat/lng kiriting (uchrashuv/to‘lov joyi)." });
      return;
    }
    const agentId = String(req.body?.agentId ?? "").trim();
    if (!agentId) {
      res.status(400).json({ error: "Mas’ul agentni tanlang." });
      return;
    }
    const [agent] = await db.select({ id: kpiAgentsTable.id }).from(kpiAgentsTable).where(eq(kpiAgentsTable.id, agentId)).limit(1);
    if (!agent) {
      res.status(400).json({ error: "Agent topilmadi." });
      return;
    }
    let address = String(req.body?.address ?? "").trim();
    if (!address) {
      const geo = await reverseGeocode(coords.lat, coords.lng);
      address = geo?.address || `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`;
    }
    const lat = String(coords.lat.toFixed(6));
    const lng = String(coords.lng.toFixed(6));
    const [row] = await db.insert(kpiCustomersTable).values({
      name,
      stir: String(req.body?.stir ?? "").trim(),
      contactName: String(req.body?.contactName ?? "").trim(),
      phone: String(req.body?.phone ?? "").trim(),
      address,
      lat,
      lng,
      gpsSource: "admin",
      type: String(req.body?.type ?? "store"),
      status: String(req.body?.status ?? "active"),
      contractNumber: String(req.body?.contractNumber ?? ""),
      paymentTermsNote: String(req.body?.paymentTermsNote ?? ""),
      notes: String(req.body?.notes ?? ""),
      createdBy: actor.id,
    }).returning();
    await db.insert(kpiCustomerAssignmentsTable).values({
      customerId: row.id,
      agentId,
      active: true,
      assignedBy: actor.id,
    });
    await recordAudit({
      action: "kpi.customer.created",
      entityType: "kpi_customer",
      entityId: row.id,
      actorName: actor.name,
      details: `${name}; gps=${lat},${lng}; agent=${agentId}`,
    });
    res.status(201).json({ ...row, agentId });
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/agent/customers", requireKpiAgent(), async (req, res, next) => {
  try {
    const agent = getKpiAgent(res);
    const name = String(req.body?.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "Korxona nomi kerak." });
      return;
    }
    const [row] = await db.insert(kpiCustomersTable).values({
      name,
      stir: String(req.body?.stir ?? "").trim(),
      contactName: String(req.body?.contactName ?? "").trim(),
      phone: String(req.body?.phone ?? "").trim(),
      address: String(req.body?.address ?? "").trim(),
      lat: req.body?.lat != null ? String(req.body.lat) : null,
      lng: req.body?.lng != null ? String(req.body.lng) : null,
      type: String(req.body?.type ?? "store"),
      status: "pending",
      notes: String(req.body?.notes ?? ""),
      createdByAgentId: agent.id,
      createdBy: agent.id,
    }).returning();
    await db.insert(kpiCustomerAssignmentsTable).values({
      customerId: row.id,
      agentId: agent.id,
      active: true,
      assignedBy: agent.id,
      note: "Agent yaratgan — admin tasdig‘ida",
    });
    await recordAudit({ action: "kpi.customer.pending", entityType: "kpi_customer", entityId: row.id, actorName: agent.fullName, details: name });
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/customers/:id/assign", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
    const customerId = String(req.params.id);
    const agentId = String(req.body?.agentId ?? "");
    if (!agentId) {
      res.status(400).json({ error: "agentId kerak." });
      return;
    }
    const current = await activeAssignment(customerId);
    if (current && current.agentId !== agentId) {
      await db.update(kpiCustomerAssignmentsTable).set({
        active: false,
        unassignedAt: new Date(),
      }).where(eq(kpiCustomerAssignmentsTable.id, current.id));
    }
    if (current?.agentId === agentId) {
      res.json(current);
      return;
    }
    const [row] = await db.insert(kpiCustomerAssignmentsTable).values({
      customerId,
      agentId,
      active: true,
      assignedBy: actor.id,
      note: String(req.body?.note ?? ""),
    }).returning();
    await recordAudit({ action: "kpi.customer.assigned", entityType: "kpi_customer", entityId: customerId, actorName: actor.name, details: agentId });
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

router.patch("/kpi/customers/:id", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
    const id = String(req.params.id);
    const patch: Record<string, unknown> = {};
    for (const key of ["name", "stir", "contactName", "phone", "address", "type", "status", "contractNumber", "paymentTermsNote", "notes"] as const) {
      if (req.body?.[key] != null) patch[key] = String(req.body[key]);
    }
    const touchingGps = req.body?.lat !== undefined || req.body?.lng !== undefined;
    if (touchingGps) {
      if (req.body?.lat == null || req.body?.lng == null || req.body?.lat === "" || req.body?.lng === "") {
        patch.lat = null;
        patch.lng = null;
        patch.gpsSource = null;
      } else {
        const coords = parseAdminCoords(req.body.lat, req.body.lng);
        if (!coords) {
          res.status(400).json({ error: "Aniq lat/lng kiriting." });
          return;
        }
        patch.lat = String(coords.lat.toFixed(6));
        patch.lng = String(coords.lng.toFixed(6));
        patch.gpsSource = "admin";
        if (req.body?.address == null || !String(req.body.address).trim()) {
          const geo = await reverseGeocode(coords.lat, coords.lng);
          if (geo?.address) patch.address = geo.address;
        }
      }
    }
    const [row] = await db.update(kpiCustomersTable).set(patch).where(eq(kpiCustomersTable.id, id)).returning();
    if (!row) {
      res.status(404).json({ error: "Mijoz topilmadi." });
      return;
    }
    const nextAgentId = req.body?.agentId != null ? String(req.body.agentId).trim() : "";
    if (req.body?.agentId !== undefined) {
      const current = await activeAssignment(id);
      if (!nextAgentId) {
        if (current) {
          await db.update(kpiCustomerAssignmentsTable).set({
            active: false,
            unassignedAt: new Date(),
          }).where(eq(kpiCustomerAssignmentsTable.id, current.id));
        }
      } else if (!current || current.agentId !== nextAgentId) {
        if (current) {
          await db.update(kpiCustomerAssignmentsTable).set({
            active: false,
            unassignedAt: new Date(),
          }).where(eq(kpiCustomerAssignmentsTable.id, current.id));
        }
        await db.insert(kpiCustomerAssignmentsTable).values({
          customerId: id,
          agentId: nextAgentId,
          active: true,
          assignedBy: actor.id,
        });
      }
    }
    await recordAudit({ action: "kpi.customer.updated", entityType: "kpi_customer", entityId: id, actorName: actor.name, details: row.name });
    const assign = await activeAssignment(id);
    res.json({ ...row, agentId: assign?.agentId ?? null });
  } catch (error) {
    next(error);
  }
});

router.delete("/kpi/customers/:id", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
    const id = String(req.params.id);
    const [cust] = await db.select().from(kpiCustomersTable).where(eq(kpiCustomersTable.id, id)).limit(1);
    if (!cust) {
      res.status(404).json({ error: "Mijoz topilmadi." });
      return;
    }
    const [orderHit] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(kpiOrdersTable)
      .where(eq(kpiOrdersTable.customerId, id));
    if ((orderHit?.n ?? 0) > 0) {
      res.status(409).json({
        error: `Bu mijozda ${orderHit.n} ta savdo bor — o‘chirib bo‘lmaydi. Agentni olib tashlang yoki statusni o‘zgartiring.`,
      });
      return;
    }
    await db.delete(kpiVisitsTable).where(eq(kpiVisitsTable.customerId, id));
    await db.delete(kpiCustomerAssignmentsTable).where(eq(kpiCustomerAssignmentsTable.customerId, id));
    await db.delete(kpiCustomersTable).where(eq(kpiCustomersTable.id, id));
    await recordAudit({
      action: "kpi.customer.deleted",
      entityType: "kpi_customer",
      entityId: id,
      actorName: actor.name,
      details: cust.name,
    });
    res.json({ ok: true, id, name: cust.name });
  } catch (error) {
    next(error);
  }
});

/* ---------- Products ---------- */
router.get("/kpi/products", requireKpiAdmin(), async (_req, res, next) => {
  try {
    const rows = await db.select().from(kpiProductsTable).where(eq(kpiProductsTable.active, true)).orderBy(asc(kpiProductsTable.name)).limit(500);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.get("/kpi/agent/products", requireKpiAgent(), async (_req, res, next) => {
  try {
    const rows = await db.select().from(kpiProductsTable).where(eq(kpiProductsTable.active, true)).orderBy(asc(kpiProductsTable.name)).limit(500);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/products", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
    const code = String(req.body?.code ?? "").trim();
    const name = String(req.body?.name ?? "").trim();
    if (!code || !name) {
      res.status(400).json({ error: "Kod va nom kerak." });
      return;
    }
    const [row] = await db.insert(kpiProductsTable).values({
      code,
      name,
      unit: String(req.body?.unit ?? "dona"),
      price: money(req.body?.price ?? 0),
      createdBy: actor.id,
    }).returning();
    res.status(201).json(row);
  } catch (error: unknown) {
    if (String((error as { code?: string })?.code) === "23505") {
      res.status(409).json({ error: "Mahsulot kodi band." });
      return;
    }
    next(error);
  }
});

/* ---------- Orders ---------- */
type LineIn = { productId?: string; productCode?: string; productName?: string; quantity?: unknown; unitPrice?: unknown; discount?: unknown };

async function buildItems(lines: LineIn[]) {
  const items = [];
  let subtotal = "0.00";
  for (const line of lines || []) {
    let productName = String(line.productName ?? "").trim();
    let productCode = String(line.productCode ?? "").trim();
    let productId = line.productId || null;
    let unitPrice = money(line.unitPrice ?? 0);
    if (productId) {
      const [p] = await db.select().from(kpiProductsTable).where(eq(kpiProductsTable.id, productId)).limit(1);
      if (p) {
        productName = productName || p.name;
        productCode = productCode || p.code;
        if (!line.unitPrice) unitPrice = money(p.price);
      }
    }
    if (!productName) continue;
    const quantity = money(line.quantity ?? 1);
    const discount = money(line.discount ?? 0);
    const lineTotal = moneySub(moneyMul(unitPrice, quantity), discount);
    subtotal = moneyAdd(subtotal, lineTotal);
    items.push({ productId, productCode, productName, quantity, unitPrice, discount, lineTotal });
  }
  return { items, subtotal };
}

async function createOrder(input: {
  customerId: string;
  agentId: string;
  status: string;
  orderDate?: string;
  paymentType?: string;
  paymentDueDate?: string | null;
  paymentDueDays?: number | null;
  discount?: unknown;
  notes?: string;
  lines: LineIn[];
  createdBy: string;
}) {
  const { items, subtotal } = await buildItems(input.lines);
  if (!items.length) throw Object.assign(new Error("Kamida bitta mahsulot kerak."), { status: 400 });
  const discount = money(input.discount ?? 0);
  const total = moneySub(subtotal, discount);
  const number = await nextOrderNumber();
  const orderDate = input.orderDate || tashkentDate();
  let paymentDueDate = input.paymentDueDate || null;
  if (!paymentDueDate && input.paymentDueDays != null) {
    const due = new Date(`${orderDate}T12:00:00+05:00`);
    due.setDate(due.getDate() + Number(input.paymentDueDays));
    paymentDueDate = tashkentDate(due);
  }
  const [order] = await db.insert(kpiOrdersTable).values({
    number,
    customerId: input.customerId,
    agentId: input.agentId,
    status: input.status,
    orderDate,
    paymentType: input.paymentType || "deferred",
    paymentDueDate,
    paymentDueDays: input.paymentDueDays ?? null,
    subtotal,
    discount,
    total,
    notes: input.notes || "",
    createdBy: input.createdBy,
  }).returning();
  for (const item of items) {
    await db.insert(kpiOrderItemsTable).values({ orderId: order.id, ...item });
  }
  return order;
}

router.get("/kpi/orders", requireKpiAdmin(), async (req, res, next) => {
  try {
    await ensureKpiBootstrapped();
    const status = String(req.query.status ?? "").trim();
    const rows = await db.select().from(kpiOrdersTable)
      .where(status ? eq(kpiOrdersTable.status, status) : undefined)
      .orderBy(desc(kpiOrdersTable.orderDate), desc(kpiOrdersTable.createdAt))
      .limit(250);
    const agents = await db.select({ id: kpiAgentsTable.id, fullName: kpiAgentsTable.fullName }).from(kpiAgentsTable);
    const customers = await db.select({ id: kpiCustomersTable.id, name: kpiCustomersTable.name }).from(kpiCustomersTable);
    const aMap = new Map(agents.map((a) => [a.id, a.fullName]));
    const cMap = new Map(customers.map((c) => [c.id, c.name]));
    res.json(rows.map((r) => ({ ...r, agentName: aMap.get(r.agentId) || "—", customerName: cMap.get(r.customerId) || "—" })));
  } catch (error) {
    next(error);
  }
});

router.get("/kpi/orders/:id", requireKpiAdmin(), async (req, res, next) => {
  try {
    const [order] = await db.select().from(kpiOrdersTable).where(eq(kpiOrdersTable.id, String(req.params.id))).limit(1);
    if (!order) {
      res.status(404).json({ error: "Savdo topilmadi." });
      return;
    }
    const items = await db.select().from(kpiOrderItemsTable).where(eq(kpiOrderItemsTable.orderId, order.id));
    const calc = await db.select().from(kpiCalculationsTable).where(eq(kpiCalculationsTable.orderId, order.id)).limit(1);
    res.json({ ...order, items, kpi: calc[0] ?? null });
  } catch (error) {
    next(error);
  }
});

router.get("/kpi/agent/orders", requireKpiAgent(), async (_req, res, next) => {
  try {
    const agent = getKpiAgent(res);
    const rows = await db.select().from(kpiOrdersTable).where(eq(kpiOrdersTable.agentId, agent.id)).orderBy(desc(kpiOrdersTable.createdAt)).limit(200);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/orders", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
    const order = await createOrder({
      customerId: String(req.body?.customerId ?? ""),
      agentId: String(req.body?.agentId ?? ""),
      status: String(req.body?.status ?? "pending_approval"),
      orderDate: req.body?.orderDate,
      paymentType: req.body?.paymentType,
      paymentDueDate: req.body?.paymentDueDate,
      paymentDueDays: req.body?.paymentDueDays,
      discount: req.body?.discount,
      notes: String(req.body?.notes ?? ""),
      lines: Array.isArray(req.body?.lines) ? req.body.lines : [],
      createdBy: actor.id,
    });
    await recordAudit({ action: "kpi.order.created", entityType: "kpi_order", entityId: order.id, actorName: actor.name, details: order.number });
    res.status(201).json(order);
  } catch (error: unknown) {
    const status = (error as { status?: number }).status;
    if (status) {
      res.status(status).json({ error: (error as Error).message });
      return;
    }
    next(error);
  }
});

router.post("/kpi/agent/orders", requireKpiAgent(), async (req, res, next) => {
  try {
    const agent = getKpiAgent(res);
    const customerId = String(req.body?.customerId ?? "");
    const assign = await activeAssignment(customerId);
    if (!assign || assign.agentId !== agent.id) {
      res.status(403).json({ error: "Bu mijoz sizga biriktirilmagan." });
      return;
    }
    const [customer] = await db.select().from(kpiCustomersTable).where(eq(kpiCustomersTable.id, customerId)).limit(1);
    if (!customer || customer.status === "pending") {
      res.status(400).json({ error: "Mijoz admin tasdig‘idan o‘tmagan." });
      return;
    }
    const order = await createOrder({
      customerId,
      agentId: agent.id,
      status: "pending_approval",
      orderDate: req.body?.orderDate,
      paymentType: req.body?.paymentType,
      paymentDueDate: req.body?.paymentDueDate,
      paymentDueDays: req.body?.paymentDueDays,
      discount: 0,
      notes: String(req.body?.notes ?? ""),
      lines: Array.isArray(req.body?.lines) ? req.body.lines : [],
      createdBy: agent.id,
    });
    await recordAudit({ action: "kpi.order.submitted", entityType: "kpi_order", entityId: order.id, actorName: agent.fullName, details: order.number });
    res.status(201).json(order);
  } catch (error: unknown) {
    const status = (error as { status?: number }).status;
    if (status) {
      res.status(status).json({ error: (error as Error).message });
      return;
    }
    next(error);
  }
});

router.post("/kpi/orders/:id/confirm", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
    const id = String(req.params.id);
    const [order] = await db.select().from(kpiOrdersTable).where(eq(kpiOrdersTable.id, id)).limit(1);
    if (!order) {
      res.status(404).json({ error: "Savdo topilmadi." });
      return;
    }
    if (!["draft", "pending_approval"].includes(order.status)) {
      res.status(400).json({ error: "Bu holatda tasdiqlab bo‘lmaydi." });
      return;
    }
    const policy = await ensureDefaultPolicy(actor.id);
    const snap = snapshotPolicy(policy);
    const [updated] = await db.update(kpiOrdersTable).set({
      status: "confirmed",
      confirmedAt: new Date(),
      confirmedBy: actor.id,
      policyId: policy.id,
      policySnapshot: snap as unknown as Record<string, unknown>,
    }).where(eq(kpiOrdersTable.id, id)).returning();
    await refreshOrderKpi(id, actor.id);
    await recordAudit({ action: "kpi.order.confirmed", entityType: "kpi_order", entityId: id, actorName: actor.name, details: updated.number });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/orders/:id/reject", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
    const id = String(req.params.id);
    const [updated] = await db.update(kpiOrdersTable).set({
      status: "cancelled",
      cancelledAt: new Date(),
      cancelledBy: actor.id,
      notes: [String(req.body?.reason ?? ""), "Admin rad etdi"].filter(Boolean).join(" — "),
    }).where(eq(kpiOrdersTable.id, id)).returning();
    if (!updated) {
      res.status(404).json({ error: "Savdo topilmadi." });
      return;
    }
    await cancelOrderKpi(id, actor.id);
    await recordAudit({ action: "kpi.order.rejected", entityType: "kpi_order", entityId: id, actorName: actor.name, details: updated.number });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/orders/:id/cancel", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
    const id = String(req.params.id);
    const [updated] = await db.update(kpiOrdersTable).set({
      status: "cancelled",
      cancelledAt: new Date(),
      cancelledBy: actor.id,
    }).where(eq(kpiOrdersTable.id, id)).returning();
    if (!updated) {
      res.status(404).json({ error: "Savdo topilmadi." });
      return;
    }
    await cancelOrderKpi(id, actor.id);
    await recordAudit({ action: "kpi.order.cancelled", entityType: "kpi_order", entityId: id, actorName: actor.name, details: updated.number });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

/* ---------- Payments ---------- */
router.get("/kpi/payments", requireKpiAdmin(), async (_req, res, next) => {
  try {
    const rows = await db.select().from(kpiPaymentsTable).orderBy(desc(kpiPaymentsTable.createdAt)).limit(200);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/payments", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
    const orderId = String(req.body?.orderId ?? "");
    const amount = money(req.body?.amount ?? 0);
    const idempotencyKey = req.body?.idempotencyKey ? String(req.body.idempotencyKey) : null;
    if (!orderId || moneyCmp(amount, 0) <= 0) {
      res.status(400).json({ error: "orderId va musbat summa kerak." });
      return;
    }
    if (idempotencyKey) {
      const existing = await db.select().from(kpiPaymentsTable).where(eq(kpiPaymentsTable.idempotencyKey, idempotencyKey)).limit(1);
      if (existing[0]) {
        res.json(existing[0]);
        return;
      }
    }
    const [order] = await db.select().from(kpiOrdersTable).where(eq(kpiOrdersTable.id, orderId)).limit(1);
    if (!order || ["draft", "cancelled"].includes(order.status)) {
      res.status(400).json({ error: "To‘lov uchun savdo yaroqsiz." });
      return;
    }
    const autoConfirm = Boolean(req.body?.confirm ?? true);
    const [payment] = await db.insert(kpiPaymentsTable).values({
      orderId,
      amount,
      method: String(req.body?.method ?? "transfer"),
      reference: String(req.body?.reference ?? ""),
      notes: String(req.body?.notes ?? ""),
      status: autoConfirm ? "confirmed" : "pending",
      idempotencyKey,
      confirmedAt: autoConfirm ? new Date() : null,
      confirmedBy: autoConfirm ? actor.id : null,
      createdBy: actor.id,
    }).returning();
    if (autoConfirm) {
      await db.insert(kpiPaymentAllocationsTable).values({ paymentId: payment.id, orderId, amount });
      const paid = moneyAdd(order.paidAmount, amount);
      let status = order.status;
      if (moneyCmp(paid, order.total) >= 0) status = "paid";
      else if (moneyCmp(paid, 0) > 0) status = "partially_paid";
      await db.update(kpiOrdersTable).set({ paidAmount: paid, status }).where(eq(kpiOrdersTable.id, orderId));
      await refreshOrderKpi(orderId, actor.id);
    }
    await recordAudit({ action: "kpi.payment.created", entityType: "kpi_payment", entityId: payment.id, actorName: actor.name, details: `${amount} → ${order.number}` });
    res.status(201).json(payment);
  } catch (error: unknown) {
    if (String((error as { code?: string })?.code) === "23505") {
      res.status(409).json({ error: "Takroriy to‘lov (idempotency)." });
      return;
    }
    next(error);
  }
});

router.post("/kpi/payments/:id/confirm", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
    const id = String(req.params.id);
    const [payment] = await db.select().from(kpiPaymentsTable).where(eq(kpiPaymentsTable.id, id)).limit(1);
    if (!payment) {
      res.status(404).json({ error: "To‘lov topilmadi." });
      return;
    }
    if (payment.status === "confirmed") {
      res.json(payment);
      return;
    }
    const [order] = await db.select().from(kpiOrdersTable).where(eq(kpiOrdersTable.id, payment.orderId)).limit(1);
    if (!order) {
      res.status(404).json({ error: "Savdo topilmadi." });
      return;
    }
    const [updated] = await db.update(kpiPaymentsTable).set({
      status: "confirmed",
      confirmedAt: new Date(),
      confirmedBy: actor.id,
    }).where(eq(kpiPaymentsTable.id, id)).returning();
    await db.insert(kpiPaymentAllocationsTable).values({ paymentId: id, orderId: order.id, amount: payment.amount });
    const paid = moneyAdd(order.paidAmount, payment.amount);
    let status = order.status;
    if (moneyCmp(paid, order.total) >= 0) status = "paid";
    else if (moneyCmp(paid, 0) > 0) status = "partially_paid";
    await db.update(kpiOrdersTable).set({ paidAmount: paid, status }).where(eq(kpiOrdersTable.id, order.id));
    await refreshOrderKpi(order.id, actor.id);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

/* ---------- KPI policy + calculations ---------- */
router.get("/kpi/policy", requireKpiAdmin(), async (_req, res, next) => {
  try {
    const policy = await ensureDefaultPolicy();
    res.json(policy);
  } catch (error) {
    next(error);
  }
});

router.put("/kpi/policy", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
    let policy = await getActivePolicy();
    if (!policy) policy = await ensureDefaultPolicy(actor.id);
    const stages = Array.isArray(req.body?.stages) ? req.body.stages : policy.stages;
    await db.update(kpiPoliciesTable).set({
      name: String(req.body?.name ?? policy.name),
      baseType: String(req.body?.baseType ?? policy.baseType),
      startAnchor: String(req.body?.startAnchor ?? policy.startAnchor),
      warningDays: Number(req.body?.warningDays ?? policy.warningDays) || 2,
      notes: String(req.body?.notes ?? ""),
      active: true,
    }).where(eq(kpiPoliciesTable.id, policy.id));
    await db.delete(kpiStagesTable).where(eq(kpiStagesTable.policyId, policy.id));
    let order = 1;
    for (const stage of stages) {
      await db.insert(kpiStagesTable).values({
        policyId: policy.id,
        name: String(stage.name || `${order}-bosqich`),
        sortOrder: order,
        dayFrom: Number(stage.dayFrom) || 0,
        dayTo: Number(stage.dayTo) || 0,
        percent: money(stage.percent ?? 0),
      });
      order += 1;
    }
    await recordAudit({ action: "kpi.policy.updated", entityType: "kpi_policy", entityId: policy.id, actorName: actor.name });
    res.json(await getActivePolicy());
  } catch (error) {
    next(error);
  }
});

router.get("/kpi/calculations", requireKpiAdmin(), async (_req, res, next) => {
  try {
    const rows = await db.select().from(kpiCalculationsTable).orderBy(desc(kpiCalculationsTable.updatedAt)).limit(300);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.get("/kpi/agent/kpi", requireKpiAgent(), async (_req, res, next) => {
  try {
    const agent = getKpiAgent(res);
    const rows = await db.select().from(kpiCalculationsTable).where(eq(kpiCalculationsTable.agentId, agent.id)).orderBy(desc(kpiCalculationsTable.updatedAt)).limit(200);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.get("/kpi/agent/cabinet", requireKpiAgent(), async (_req, res, next) => {
  try {
    await ensureKpiBootstrapped();
    const agent = getKpiAgent(res);
    const dailyPlan = await ensureDailyVisitPlan(agent.id);
    const [agentRow] = await db.select().from(kpiAgentsTable).where(eq(kpiAgentsTable.id, agent.id)).limit(1);
    const policy = await ensureDefaultPolicy();
    const assigns = await db
      .select()
      .from(kpiCustomerAssignmentsTable)
      .where(and(eq(kpiCustomerAssignmentsTable.agentId, agent.id), eq(kpiCustomerAssignmentsTable.active, true)));
    const custIds = new Set(assigns.map((a) => a.customerId));
    const allCustomers = await db.select().from(kpiCustomersTable);
    const myCustomers = allCustomers.filter((c) => custIds.has(c.id) || c.createdByAgentId === agent.id);
    const cMap = new Map(allCustomers.map((c) => [c.id, c]));

    const orders = await db
      .select()
      .from(kpiOrdersTable)
      .where(eq(kpiOrdersTable.agentId, agent.id))
      .orderBy(desc(kpiOrdersTable.orderDate), desc(kpiOrdersTable.createdAt))
      .limit(200);
    const calcs = await db
      .select()
      .from(kpiCalculationsTable)
      .where(eq(kpiCalculationsTable.agentId, agent.id));
    const calcByOrder = new Map(calcs.map((c) => [c.orderId, c]));

    const today = tashkentDate();
    const visits = await db
      .select()
      .from(kpiVisitsTable)
      .where(eq(kpiVisitsTable.agentId, agent.id))
      .orderBy(desc(kpiVisitsTable.createdAt))
      .limit(500);
    const todayVisitMap = new Map<string, { at: string; lat: string | null; lng: string | null }>();
    for (const v of visits) {
      const day = tashkentDate(v.finishedAt || v.createdAt);
      if (day === today && v.status === "done" && !todayVisitMap.has(v.customerId)) {
        todayVisitMap.set(v.customerId, {
          at: (v.finishedAt || v.createdAt).toISOString(),
          lat: v.lat,
          lng: v.lng,
        });
      }
    }
    const visitPlanCount = dailyPlan.visitPlanCount || assigns.length || myCustomers.length;
    const salesPlan = money(agentRow?.salesPlan || 0);
    const period = defaultKpiPeriod();
    const monthSales = await agentPeriodSales(agent.id, period.from, period.to);
    const planPct = computePlanPct(monthSales, salesPlan);
    const visitPct =
      visitPlanCount > 0 ? Math.min(100, Math.round((todayVisitMap.size / visitPlanCount) * 100)) : 0;
    const locRows = await db
      .select()
      .from(kpiLocationEventsTable)
      .where(eq(kpiLocationEventsTable.agentId, agent.id))
      .orderBy(desc(kpiLocationEventsTable.recordedAt))
      .limit(500);
    const latestAgentLoc = locRows[0] ?? null;
    const todayTrack = locRows
      .filter((l) => tashkentDate(l.recordedAt) === today)
      .reverse()
      .map((l) => ({ lat: Number(l.lat), lng: Number(l.lng), at: l.recordedAt.toISOString() }));

    const addDays = (base: Date, days: number) => {
      const d = new Date(base);
      d.setDate(d.getDate() + days);
      return tashkentDate(d);
    };

    let totalSales = "0.00";
    let totalPaid = "0.00";
    let totalDue = "0.00";
    let kpiEarned = "0.00";
    let kpiPotential = "0.00";

    const debtByCustomer = new Map<string, string>();
    const orderDeals = orders.map((o) => {
      const due = moneySub(o.total, o.paidAmount);
      totalSales = moneyAdd(totalSales, o.total);
      totalPaid = moneyAdd(totalPaid, o.paidAmount);
      if (moneyCmp(due, 0) > 0) {
        totalDue = moneyAdd(totalDue, due);
        debtByCustomer.set(o.customerId, moneyAdd(debtByCustomer.get(o.customerId) || 0, due));
      }
      const anchor = o.confirmedAt ? new Date(o.confirmedAt) : new Date(`${o.orderDate}T09:00:00+05:00`);
      const snap = o.policySnapshot as { stages?: Array<{ name: string; percent: string | number; dayFrom: number; dayTo: number }> } | null;
      const stageSrc = snap?.stages?.length ? snap.stages : policy.stages || [];
      const stages = stageSrc.map((s) => ({
        name: s.name,
        percent: Number(s.percent),
        fromDate: addDays(anchor, s.dayFrom),
        untilDate: addDays(anchor, s.dayTo),
        ifFullPaidKpi: moneyPct(o.total, s.percent),
        onRemainingDebtKpi: moneyPct(due, s.percent),
      }));
      const k = calcByOrder.get(o.id);
      if (k) kpiEarned = moneyAdd(kpiEarned, k.kpiAmount);
      // Potential = current calc stage if known, else first stage
      const potentialStage =
        stages.find((s) => s.name === k?.stageName) ||
        stages.find((s) => Number(s.percent) === Number(k?.stagePercent)) ||
        stages[0];
      if (moneyCmp(due, 0) > 0 && potentialStage) {
        kpiPotential = moneyAdd(kpiPotential, potentialStage.onRemainingDebtKpi);
      }
      const cust = cMap.get(o.customerId);
      return {
        id: o.id,
        number: o.number.replace(/^MS-/, ""),
        orderDate: o.orderDate,
        customerId: o.customerId,
        customerName: cust?.name || "—",
        customerPhone: cust?.phone || "",
        customerAddress: cust?.address || "",
        total: o.total,
        paidAmount: o.paidAmount,
        dueAmount: due,
        status: o.status,
        currentStage: k?.stageName || stages[0]?.name || "1-bosqich",
        currentPercent: Number(k?.stagePercent ?? stages[0]?.percent ?? 0),
        daysRemaining: k?.daysRemaining ?? null,
        earnedKpi: k?.kpiAmount || "0.00",
        stages,
      };
    });

    const rawCustomerCards = myCustomers.map((c) => {
      const debt = debtByCustomer.get(c.id) || "0.00";
      const v = todayVisitMap.get(c.id);
      // Prefer saved store GPS over one-off visit coords for the map pin
      const adminGps = hasAdminGps(c);
      const geo = inferCoordinates(
        c.id,
        c.name,
        c.address,
        adminGps.ok ? adminGps.lat : c.lat || v?.lat,
        adminGps.ok ? adminGps.lng : c.lng || v?.lng,
      );
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        address: c.address,
        debt,
        lat: geo.lat,
        lng: geo.lng,
        exactGps: adminGps.ok,
        gpsSource: c.gpsSource || null,
        visitedToday: Boolean(v),
        visitedAt: v?.at || null,
      };
    });

    const customerCards = orderRouteStops(
      rawCustomerCards,
      latestAgentLoc ? Number(latestAgentLoc.lat) : null,
      latestAgentLoc ? Number(latestAgentLoc.lng) : null,
    );

    res.json({
      agent: {
        id: agent.id,
        fullName: agentRow?.fullName || agent.fullName,
        login: agent.login,
        phone: agentRow?.phone || "",
        salesPlan: agentRow?.salesPlan || "0.00",
        lat: latestAgentLoc ? Number(latestAgentLoc.lat) : null,
        lng: latestAgentLoc ? Number(latestAgentLoc.lng) : null,
        lastSeenAt: latestAgentLoc ? latestAgentLoc.recordedAt.toISOString() : null,
      },
      summary: {
        customersCount: myCustomers.length,
        debtorsCount: customerCards.filter((c) => Number(c.debt) > 0).length,
        visitedToday: todayVisitMap.size,
        visitPlanCount,
        visitPct,
        salesPlan,
        monthSales,
        planPct,
        totalSales,
        totalPaid,
        totalDue,
        kpiEarned,
        kpiPotential,
      },
      track: todayTrack,
      policyStages: policy.stages,
      customers: customerCards,
      deals: orderDeals,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/agent/visit", requireKpiAgent(), async (req, res, next) => {
  try {
    const agent = getKpiAgent(res);
    const customerId = String(req.body?.customerId ?? "");
    const notes = String(req.body?.notes ?? "");
    if (!customerId) {
      res.status(400).json({ error: "customerId kerak." });
      return;
    }
    const latN = Number(req.body?.lat);
    const lngN = Number(req.body?.lng);
    if (!Number.isFinite(latN) || !Number.isFinite(lngN) || Math.abs(latN) < 1 || Math.abs(lngN) < 1) {
      res.status(400).json({ error: "Bordim uchun jonli GPS kerak. Telefon GPS ni yoqing." });
      return;
    }
    await ensureDailyVisitPlan(agent.id);
    const assigns = await db
      .select()
      .from(kpiCustomerAssignmentsTable)
      .where(and(eq(kpiCustomerAssignmentsTable.agentId, agent.id), eq(kpiCustomerAssignmentsTable.active, true)));
    const allowed = new Set(assigns.map((a) => a.customerId));
    const [cust] = await db.select().from(kpiCustomersTable).where(eq(kpiCustomersTable.id, customerId)).limit(1);
    if (!cust || (!allowed.has(customerId) && cust.createdByAgentId !== agent.id)) {
      res.status(403).json({ error: "Bu mijoz sizga biriktirilmagan." });
      return;
    }
    const storeGps = hasAdminGps(cust);
    if (!storeGps.ok) {
      res.status(400).json({
        error: "Admin aniq manzil (lat/lng) belgilamagunicha Bordim mumkin emas.",
      });
      return;
    }
    const distM = distanceMeters(latN, lngN, storeGps.lat, storeGps.lng);
    if (distM > BORDIM_GEOFENCE_M) {
      res.status(400).json({
        error: `Siz belgilangan joydan ~${distM} m uzoqdasiz. Bordim faqat ${BORDIM_GEOFENCE_M} m ichida ruxsat etiladi.`,
        distanceM: distM,
        limitM: BORDIM_GEOFENCE_M,
      });
      return;
    }
    const lat = String(latN.toFixed(6));
    const lng = String(lngN.toFixed(6));
    const now = new Date();
    const today = tashkentDate();
    const [todayPlan] = await db
      .select()
      .from(kpiVisitPlansTable)
      .where(and(eq(kpiVisitPlansTable.agentId, agent.id), eq(kpiVisitPlansTable.planDate, today)))
      .limit(1);

    // Idempotent: already done today for this customer → refresh GPS/notes, no second row
    const priorDone = await db
      .select()
      .from(kpiVisitsTable)
      .where(
        and(
          eq(kpiVisitsTable.agentId, agent.id),
          eq(kpiVisitsTable.customerId, customerId),
          eq(kpiVisitsTable.status, "done"),
        ),
      )
      .orderBy(desc(kpiVisitsTable.createdAt))
      .limit(20);
    const alreadyDone = priorDone.find((v) => tashkentDate(v.finishedAt || v.createdAt) === today);

    let row;
    if (alreadyDone) {
      [row] = await db
        .update(kpiVisitsTable)
        .set({
          planId: alreadyDone.planId || todayPlan?.id || null,
          finishedAt: now,
          lat,
          lng,
          notes: notes || alreadyDone.notes,
          updatedAt: now,
        })
        .where(eq(kpiVisitsTable.id, alreadyDone.id))
        .returning();
    } else if (todayPlan) {
      const [planned] = await db
        .select()
        .from(kpiVisitsTable)
        .where(
          and(
            eq(kpiVisitsTable.planId, todayPlan.id),
            eq(kpiVisitsTable.customerId, customerId),
            eq(kpiVisitsTable.status, "planned"),
          ),
        )
        .limit(1);
      if (planned) {
        [row] = await db
          .update(kpiVisitsTable)
          .set({
            status: "done",
            startedAt: planned.startedAt || now,
            finishedAt: now,
            lat,
            lng,
            notes: notes || planned.notes,
            updatedAt: now,
          })
          .where(and(eq(kpiVisitsTable.id, planned.id), eq(kpiVisitsTable.status, "planned")))
          .returning();
      }
    }
    if (!row) {
      // Re-check race: another request may have finished the planned row
      const raced = await db
        .select()
        .from(kpiVisitsTable)
        .where(
          and(
            eq(kpiVisitsTable.agentId, agent.id),
            eq(kpiVisitsTable.customerId, customerId),
            eq(kpiVisitsTable.status, "done"),
          ),
        )
        .orderBy(desc(kpiVisitsTable.createdAt))
        .limit(10);
      const racedDone = raced.find((v) => tashkentDate(v.finishedAt || v.createdAt) === today);
      if (racedDone) {
        row = racedDone;
      } else {
        [row] = await db
          .insert(kpiVisitsTable)
          .values({
            planId: todayPlan?.id ?? null,
            agentId: agent.id,
            customerId,
            status: "done",
            startedAt: now,
            finishedAt: now,
            lat,
            lng,
            notes,
          })
          .returning();
      }
    }
    await db.insert(kpiLocationEventsTable).values({
      agentId: agent.id,
      lat,
      lng,
      accuracyM: req.body?.accuracy != null ? String(Math.round(Number(req.body.accuracy))) : null,
      source: "visit",
    });
    // Admin GPS is authoritative — Bordim must not overwrite store coordinates.
    res.status(201).json({ ...row, distanceM: distM, limitM: BORDIM_GEOFENCE_M });
  } catch (error) {
    next(error);
  }
});

/** Agent may propose a pin only when admin has not locked exact GPS. */
router.post("/kpi/agent/customers/:id/pin", requireKpiAgent(), async (req, res, next) => {
  try {
    const agent = getKpiAgent(res);
    const customerId = String(req.params.id);
    const latN = Number(req.body?.lat);
    const lngN = Number(req.body?.lng);
    if (!customerId) {
      res.status(400).json({ error: "customerId kerak." });
      return;
    }
    if (!Number.isFinite(latN) || !Number.isFinite(lngN) || Math.abs(latN) < 1 || Math.abs(lngN) < 1) {
      res.status(400).json({ error: "lat/lng kerak. Telefon GPS ni yoqing." });
      return;
    }
    const assigns = await db
      .select()
      .from(kpiCustomerAssignmentsTable)
      .where(and(eq(kpiCustomerAssignmentsTable.agentId, agent.id), eq(kpiCustomerAssignmentsTable.active, true)));
    const allowed = new Set(assigns.map((a) => a.customerId));
    const [cust] = await db.select().from(kpiCustomersTable).where(eq(kpiCustomersTable.id, customerId)).limit(1);
    if (!cust || (!allowed.has(customerId) && cust.createdByAgentId !== agent.id)) {
      res.status(403).json({ error: "Bu mijoz sizga biriktirilmagan." });
      return;
    }
    if (String(cust.gpsSource || "") === "admin") {
      res.status(403).json({
        error: "Bu mijozning aniq joyini faqat admin o‘zgartira oladi.",
      });
      return;
    }
    const lat = String(latN.toFixed(6));
    const lng = String(lngN.toFixed(6));
    const [row] = await db
      .update(kpiCustomersTable)
      .set({ lat, lng, gpsSource: "agent" })
      .where(eq(kpiCustomersTable.id, customerId))
      .returning();
    await db.insert(kpiLocationEventsTable).values({
      agentId: agent.id,
      lat,
      lng,
      accuracyM: req.body?.accuracy != null ? String(Math.round(Number(req.body.accuracy))) : null,
      source: "pin",
    });
    res.json({ ok: true, customer: row });
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/agent/location", requireKpiAgent(), async (req, res, next) => {
  try {
    const agent = getKpiAgent(res);
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) < 1 || Math.abs(lng) < 1) {
      res.status(400).json({ error: "lat/lng kerak." });
      return;
    }
    await ensureDailyVisitPlan(agent.id).catch(() => undefined);
    const [row] = await db
      .insert(kpiLocationEventsTable)
      .values({
        agentId: agent.id,
        lat: lat.toFixed(6),
        lng: lng.toFixed(6),
        accuracyM: req.body?.accuracy != null ? String(Math.round(Number(req.body.accuracy))) : null,
        source: String(req.body?.source ?? "live"),
      })
      .returning();
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

router.get("/kpi/agent/notifications", requireKpiAgent(), async (_req, res, next) => {
  try {
    const agent = getKpiAgent(res);
    const rows = await db
      .select()
      .from(kpiNotificationsTable)
      .where(eq(kpiNotificationsTable.agentId, agent.id))
      .orderBy(desc(kpiNotificationsTable.createdAt))
      .limit(50);
    res.json(
      rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        body: r.body,
        readAt: r.readAt ? r.readAt.toISOString() : null,
        meta: r.meta,
        createdAt: r.createdAt.toISOString(),
      })),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/agent/notifications/:id/read", requireKpiAgent(), async (req, res, next) => {
  try {
    const agent = getKpiAgent(res);
    const id = String(req.params.id);
    const [row] = await db
      .select()
      .from(kpiNotificationsTable)
      .where(and(eq(kpiNotificationsTable.id, id), eq(kpiNotificationsTable.agentId, agent.id)))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Bildirishnoma topilmadi." });
      return;
    }
    if (row.readAt) {
      res.json({
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        readAt: row.readAt.toISOString(),
        meta: row.meta,
        createdAt: row.createdAt.toISOString(),
      });
      return;
    }
    const [updated] = await db
      .update(kpiNotificationsTable)
      .set({ readAt: new Date() })
      .where(eq(kpiNotificationsTable.id, id))
      .returning();
    res.json({
      id: updated.id,
      type: updated.type,
      title: updated.title,
      body: updated.body,
      readAt: updated.readAt ? updated.readAt.toISOString() : null,
      meta: updated.meta,
      createdAt: updated.createdAt.toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

/** Road geometry proxy (agent + staff/admin). Avoids client SSL/CORS failures to public OSRM. */
router.get("/kpi/route", requireKpiAgentOrAdmin(), async (req, res, next) => {
  try {
    const fromLat = Number(req.query.fromLat);
    const fromLng = Number(req.query.fromLng);
    const toLat = Number(req.query.toLat);
    const toLng = Number(req.query.toLng);
    if (![fromLat, fromLng, toLat, toLng].every((n) => Number.isFinite(n))) {
      res.status(400).json({ error: "fromLat,fromLng,toLat,toLng kerak." });
      return;
    }
    const coords = `${fromLng.toFixed(6)},${fromLat.toFixed(6)};${toLng.toFixed(6)},${toLat.toFixed(6)}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false&alternatives=false`;
    let upstream: Response;
    try {
      upstream = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    } catch {
      res.status(502).json({
        ok: false,
        path: [
          [fromLat, fromLng],
          [toLat, toLng],
        ],
        distanceM: null,
        durationSec: null,
      });
      return;
    }
    if (!upstream.ok) {
      res.status(502).json({
        ok: false,
        path: [
          [fromLat, fromLng],
          [toLat, toLng],
        ],
        distanceM: null,
        durationSec: null,
      });
      return;
    }
    const data = (await upstream.json()) as {
      code?: string;
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: Array<[number, number]> };
      }>;
    };
    const route = data.routes?.[0];
    const geom = route?.geometry?.coordinates;
    if (data.code !== "Ok" || !geom?.length) {
      res.json({
        ok: false,
        path: [
          [fromLat, fromLng],
          [toLat, toLng],
        ],
        distanceM: null,
        durationSec: null,
      });
      return;
    }
    res.json({
      ok: true,
      path: geom.map(([lng, lat]) => [lat, lng]),
      distanceM: route?.distance != null ? Math.round(route.distance) : null,
      durationSec: route?.duration != null ? Math.round(route.duration) : null,
    });
  } catch {
    const fromLat = Number(req.query.fromLat);
    const fromLng = Number(req.query.fromLng);
    const toLat = Number(req.query.toLat);
    const toLng = Number(req.query.toLng);
    if ([fromLat, fromLng, toLat, toLng].every((n) => Number.isFinite(n))) {
      res.status(502).json({
        ok: false,
        path: [
          [fromLat, fromLng],
          [toLat, toLng],
        ],
        distanceM: null,
        durationSec: null,
      });
      return;
    }
    next(new Error("Marshrut hisoblanmadi."));
  }
});

router.get("/kpi/gps/overview", requireKpiAdmin(), async (req, res, next) => {
  try {
    await ensureKpiBootstrapped();
    const dateFilter = String(req.query.date ?? "").trim() || tashkentDate();
    const agentFilter = String(req.query.agentId ?? "").trim();

    const allAgents = await db.select().from(kpiAgentsTable).orderBy(asc(kpiAgentsTable.fullName));
    const agents = allAgents.filter((a) => a.login !== "ofis" && a.login !== "vanseling");
    const assigns = await db
      .select()
      .from(kpiCustomerAssignmentsTable)
      .where(eq(kpiCustomerAssignmentsTable.active, true));
    const assignByCustomer = new Map(assigns.map((a) => [a.customerId, a.agentId]));
    const customers = await db.select().from(kpiCustomersTable).limit(500);
    const orders = await db
      .select({
        customerId: kpiOrdersTable.customerId,
        total: kpiOrdersTable.total,
        paid: kpiOrdersTable.paidAmount,
      })
      .from(kpiOrdersTable)
      .where(sql`${kpiOrdersTable.status} not in ('draft','cancelled')`);

    const debtByCustomer = new Map<string, string>();
    for (const o of orders) {
      const due = moneySub(o.total, o.paid);
      if (moneyCmp(due, 0) > 0) {
        debtByCustomer.set(o.customerId, moneyAdd(debtByCustomer.get(o.customerId) || 0, due));
      }
    }

    const visits = await db
      .select()
      .from(kpiVisitsTable)
      .orderBy(desc(kpiVisitsTable.createdAt))
      .limit(800);

    const todayVisits = visits.filter(
      (v) => tashkentDate(v.finishedAt || v.createdAt) === dateFilter && v.status === "done",
    );

    // Wide recent window so each agent still has a last ping (was capped at 400 globally)
    const recentLocEvents = await db
      .select()
      .from(kpiLocationEventsTable)
      .orderBy(desc(kpiLocationEventsTable.recordedAt))
      .limit(2500);
    const lastLocByAgent = new Map<string, (typeof recentLocEvents)[number]>();
    for (const ev of recentLocEvents) {
      if (!lastLocByAgent.has(ev.agentId)) lastLocByAgent.set(ev.agentId, ev);
    }

    const agentMap = new Map(allAgents.map((a) => [a.id, a.fullName]));

    const agentPins = agents.map((a) => {
      const last = lastLocByAgent.get(a.id);
      const myVisitCustomers = new Set(
        todayVisits.filter((v) => v.agentId === a.id).map((v) => v.customerId),
      );
      const myCustomers = customers.filter(
        (c) => (assignByCustomer.get(c.id) || c.createdByAgentId) === a.id,
      );
      const myDebtors = myCustomers.filter((c) => Number(debtByCustomer.get(c.id) || 0) > 0);
      return {
        id: a.id,
        fullName: a.fullName,
        login: a.login,
        phone: a.phone,
        lat: last?.lat ? Number(last.lat) : null,
        lng: last?.lng ? Number(last.lng) : null,
        accuracyM: last?.accuracyM != null ? Number(last.accuracyM) : null,
        lastSeenAt: last?.recordedAt ? last.recordedAt.toISOString() : null,
        customersCount: myCustomers.length,
        debtorsCount: myDebtors.length,
        visitedToday: myVisitCustomers.size,
      };
    });

    const activeAgentId =
      agentFilter ||
      agentPins.find((a) => a.debtorsCount > 0)?.id ||
      agentPins.find((a) => a.customersCount > 0)?.id ||
      agentPins[0]?.id ||
      "";

    // Visited flags for selected agent's map only (not other agents' visits)
    const visitedByCustomer = new Map<string, { at: string; lat: string | null; lng: string | null; notes: string }>();
    for (const v of todayVisits) {
      if (activeAgentId && v.agentId !== activeAgentId) continue;
      if (!visitedByCustomer.has(v.customerId)) {
        visitedByCustomer.set(v.customerId, {
          at: (v.finishedAt || v.createdAt).toISOString(),
          lat: v.lat,
          lng: v.lng,
          notes: v.notes,
        });
      }
    }

    const selectedAgentLoc = activeAgentId ? lastLocByAgent.get(activeAgentId) : null;
    const rawPoints = customers
      .filter((c) => {
        const owner = assignByCustomer.get(c.id) || c.createdByAgentId || "";
        return owner === activeAgentId;
      })
      .slice(0, 200)
      .map((c) => {
        const owner = assignByCustomer.get(c.id) || c.createdByAgentId || "";
        const visit = visitedByCustomer.get(c.id);
        const debt = debtByCustomer.get(c.id) || "0.00";
        // Prefer saved store coords; exactGps only when admin locked the pin
        const adminGps = hasAdminGps(c);
        const geo = inferCoordinates(
          c.id,
          c.name,
          c.address,
          adminGps.ok ? adminGps.lat : c.lat,
          adminGps.ok ? adminGps.lng : c.lng,
        );
        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          address: c.address,
          agentId: owner || null,
          agentName: owner ? agentMap.get(owner) || "—" : "—",
          lat: geo.lat,
          lng: geo.lng,
          exactGps: adminGps.ok,
          gpsSource: c.gpsSource || null,
          debt,
          visitedToday: Boolean(visit),
          visitedAt: visit?.at || null,
          visitNotes: visit?.notes || "",
        };
      });

    const points = orderRouteStops(
      rawPoints,
      selectedAgentLoc ? Number(selectedAgentLoc.lat) : null,
      selectedAgentLoc ? Number(selectedAgentLoc.lng) : null,
    );

    const agentTrackRows = activeAgentId
      ? await db
          .select()
          .from(kpiLocationEventsTable)
          .where(eq(kpiLocationEventsTable.agentId, activeAgentId))
          .orderBy(desc(kpiLocationEventsTable.recordedAt))
          .limit(500)
      : [];
    const agentTrack = agentTrackRows
      .filter((e) => tashkentDate(e.recordedAt) === dateFilter)
      .reverse()
      .map((e) => ({ lat: Number(e.lat), lng: Number(e.lng), at: e.recordedAt.toISOString() }));

    const routeLog = todayVisits
      .filter((v) => !activeAgentId || v.agentId === activeAgentId)
      .map((v) => {
        const c = customers.find((x) => x.id === v.customerId);
        return {
          id: v.id,
          agentId: v.agentId,
          agentName: agentMap.get(v.agentId) || "—",
          customerId: v.customerId,
          customerName: c?.name || "—",
          address: c?.address || "",
          lat: v.lat ? Number(v.lat) : c?.lat ? Number(c.lat) : null,
          lng: v.lng ? Number(v.lng) : c?.lng ? Number(c.lng) : null,
          at: (v.finishedAt || v.createdAt).toISOString(),
          notes: v.notes,
        };
      });

    res.json({
      date: dateFilter,
      selectedAgentId: activeAgentId,
      agents: agentPins,
      points,
      routeLog,
      agentTrack,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/kpi/ledger", requireKpiAdmin(), async (_req, res, next) => {
  try {
    const rows = await db.select().from(kpiLedgerTable).orderBy(desc(kpiLedgerTable.createdAt)).limit(300);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/recalculate", requireKpiAdmin(), async (_req, res, next) => {
  try {
    const rows = await db.select({ id: kpiOrdersTable.id }).from(kpiOrdersTable)
      .where(sql`${kpiOrdersTable.status} not in ('draft','cancelled')`);
    for (const row of rows) await refreshOrderKpi(row.id);
    res.json({ updated: rows.length });
  } catch (error) {
    next(error);
  }
});

function num(value: unknown): number {
  const n = Number(String(value ?? 0).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function statusLabel(raw: string) {
  const s = String(raw || "").toLowerCase().trim();
  if (s === "confirmed") return "Tasdiqlangan";
  if (s === "paid") return "To'liq to'langan";
  if (s === "partially_paid" || s === "partial") return "Qisman to'langan";
  if (s === "pending" || s === "pending_approval") return "Kutilmoqda";
  if (s === "expired" || s === "overdue") return "Muddati o'tgan";
  if (s === "cancelled" || s === "canceled") return "Bekor qilingan";
  if (s === "active") return "Faol";
  if (s === "inactive") return "Nofaol";
  if (s === "draft") return "Qoralama";
  return raw || "—";
}

function stageLabel(raw: unknown) {
  const s = String(raw ?? "").trim();
  if (!s || s === "0%" || s === "0" || s.toLowerCase() === "none") return "—";
  if (/^\d+-bosqich$/i.test(s)) return s.replace(/bosqich/i, "bosqich");
  return s;
}

/* ---------- Export: styled XLSX (colors, wide columns, readable numbers) ---------- */
router.get("/kpi/export/:kind", requireKpiAdmin(), async (req, res, next) => {
  try {
    const kind = String(req.params.kind);
    const agents = await db.select().from(kpiAgentsTable);
    const agentName = new Map(agents.map((a) => [a.id, a.fullName]));
    const customers = await db.select().from(kpiCustomersTable).limit(5000);
    const customerName = new Map(customers.map((c) => [c.id, c.name]));
    const ordersLite = await db
      .select({ id: kpiOrdersTable.id, number: kpiOrdersTable.number })
      .from(kpiOrdersTable)
      .limit(5000);
    const orderNumber = new Map(ordersLite.map((o) => [o.id, o.number]));

    let sheetName = "Hisobot";
    let headers: string[] = [];
    let rows: Cell[][] = [];

    if (kind === "orders") {
      sheetName = "Savdolar";
      headers = ["Buyurtma", "Holat", "Agent", "Mijoz", "Jami", "To'langan", "Sana", "Muddat"];
      const data = await db.select().from(kpiOrdersTable).orderBy(desc(kpiOrdersTable.createdAt)).limit(2000);
      rows = data.map((r) => [
        r.number,
        statusLabel(r.status),
        agentName.get(r.agentId) || r.agentId,
        customerName.get(r.customerId) || r.customerId,
        num(r.total),
        num(r.paidAmount),
        r.orderDate,
        r.paymentDueDate || "",
      ]);
    } else if (kind === "payments") {
      sheetName = "To‘lovlar";
      headers = ["Buyurtma", "Summa", "Holat", "Usul", "Reference", "To‘lov sanasi"];
      const data = await db.select().from(kpiPaymentsTable).orderBy(desc(kpiPaymentsTable.createdAt)).limit(2000);
      rows = data.map((r) => [
        orderNumber.get(r.orderId) || r.orderId,
        num(r.amount),
        statusLabel(r.status),
        r.method,
        r.reference,
        r.paidAt ? r.paidAt.toISOString().slice(0, 19).replace("T", " ") : "",
      ]);
    } else if (kind === "kpi") {
      sheetName = "KPI";
      headers = ["Buyurtma", "Agent", "Savdo", "Foiz %", "KPI", "Holat", "Bosqich", "Kun"];
      const data = await db.select().from(kpiCalculationsTable).orderBy(desc(kpiCalculationsTable.updatedAt)).limit(2000);
      rows = data.map((r) => [
        orderNumber.get(r.orderId) || r.orderId,
        agentName.get(r.agentId) || r.agentId,
        num(r.baseAmount),
        num(r.stagePercent),
        num(r.kpiAmount),
        statusLabel(r.status),
        stageLabel(r.stageName),
        r.daysRemaining == null ? "" : Number(r.daysRemaining),
      ]);
    } else if (kind === "agents") {
      sheetName = "Agentlar";
      headers = ["F.I.Sh", "Login", "Telefon", "Holat", "Oylik reja"];
      const data = await db.select().from(kpiAgentsTable).orderBy(asc(kpiAgentsTable.fullName));
      rows = data.map((r) => [r.fullName, r.login, r.phone, statusLabel(r.status), num(r.salesPlan)]);
    } else if (kind === "customers") {
      sheetName = "Mijozlar";
      headers = ["Mijoz", "Telefon", "Manzil", "Lat", "Lng", "GPS", "Mas'ul agent", "Holat"];
      const assigns = await db
        .select()
        .from(kpiCustomerAssignmentsTable)
        .where(eq(kpiCustomerAssignmentsTable.active, true));
      const owner = new Map(assigns.map((a) => [a.customerId, a.agentId]));
      const data = await db.select().from(kpiCustomersTable).orderBy(asc(kpiCustomersTable.name)).limit(2000);
      rows = data.map((r) => [
        r.name,
        r.phone,
        r.address,
        r.lat != null ? num(r.lat) : "",
        r.lng != null ? num(r.lng) : "",
        r.gpsSource === "admin" ? "aniq" : r.gpsSource === "agent" ? "agent" : "taxminiy",
        agentName.get(owner.get(r.id) || "") || "",
        statusLabel(r.status),
      ]);
    } else {
      res.status(400).json({ error: "orders|payments|kpi|agents|customers" });
      return;
    }

    const buffer = buildXlsx([{ name: sheetName, headers, rows }]);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="kpi-${kind}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

export default router;
