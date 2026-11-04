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
  kpiOrderItemsTable,
  kpiOrdersTable,
  kpiPaymentsTable,
  kpiPaymentAllocationsTable,
  kpiPoliciesTable,
  kpiProductsTable,
  kpiStagesTable,
  kpiTerritoriesTable,
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
} from "../lib/kpi/auth";
import {
  cancelOrderKpi,
  ensureDefaultPolicy,
  getActivePolicy,
  refreshOrderKpi,
  snapshotPolicy,
} from "../lib/kpi/engine";
import { ensureKpiSchema } from "../lib/kpi/ddl";
import { ensureKpiBootstrapped, syncKpiFromMoySklad } from "../lib/kpi/ms-sync";
import { money, moneyAdd, moneyCmp, moneyMul, moneyPct, moneySub } from "../lib/kpi/money";

const router: IRouter = Router();

router.use("/kpi", (_req, _res, next) => {
  ensureKpiSchema().then(() => next()).catch(next);
});

router.post("/kpi/sync", requireKpiAdmin(), async (_req, res, next) => {
  try {
    const result = await syncKpiFromMoySklad(true);
    res.json({ ok: true, ...result });
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

function csvEscape(value: unknown) {
  const s = String(value ?? "");
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
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
router.get("/kpi/dashboard", requireKpiAdmin(), async (_req, res, next) => {
  try {
    await ensureDefaultPolicy();
    await ensureKpiBootstrapped();
    const [agentsAfter] = await db.select({ total: sql<number>`count(*)::int`, active: sql<number>`count(*) filter (where ${kpiAgentsTable.status} = 'active')::int` }).from(kpiAgentsTable);
    const [customers] = await db.select({ total: sql<number>`count(*)::int`, pending: sql<number>`count(*) filter (where ${kpiCustomersTable.status} = 'pending')::int` }).from(kpiCustomersTable);
    const [orders] = await db.select({
      sales: sql<string>`coalesce(sum(${kpiOrdersTable.total}) filter (where ${kpiOrdersTable.status} not in ('draft','cancelled')), 0)`,
      paid: sql<string>`coalesce(sum(${kpiOrdersTable.paidAmount}) filter (where ${kpiOrdersTable.status} not in ('draft','cancelled')), 0)`,
      pendingConfirm: sql<number>`count(*) filter (where ${kpiOrdersTable.status} = 'pending_approval')::int`,
      overdue: sql<number>`count(*) filter (where ${kpiOrdersTable.status} = 'overdue')::int`,
    }).from(kpiOrdersTable);
    const [kpi] = await db.select({
      accrued: sql<string>`coalesce(sum(${kpiCalculationsTable.kpiAmount}) filter (where ${kpiCalculationsTable.status} in ('confirmed','partial','pending')), 0)`,
      confirmed: sql<string>`coalesce(sum(${kpiCalculationsTable.kpiAmount}) filter (where ${kpiCalculationsTable.status} = 'confirmed'), 0)`,
      pending: sql<string>`coalesce(sum(${kpiCalculationsTable.kpiAmount}) filter (where ${kpiCalculationsTable.status} = 'pending'), 0)`,
      expired: sql<string>`coalesce(sum(${kpiCalculationsTable.kpiAmount}) filter (where ${kpiCalculationsTable.status} = 'expired'), 0)`,
    }).from(kpiCalculationsTable);
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
router.get("/kpi/agents", requireKpiAdmin(), async (_req, res, next) => {
  try {
    await ensureKpiBootstrapped();
    const agents = await db.select().from(kpiAgentsTable).orderBy(asc(kpiAgentsTable.fullName));
    const out = [];
    for (const agent of agents) {
      const [cust] = await db.select({ n: sql<number>`count(*)::int` }).from(kpiCustomerAssignmentsTable)
        .where(and(eq(kpiCustomerAssignmentsTable.agentId, agent.id), eq(kpiCustomerAssignmentsTable.active, true)));
      const [sales] = await db.select({
        total: sql<string>`coalesce(sum(${kpiOrdersTable.total}), 0)`,
      }).from(kpiOrdersTable).where(and(eq(kpiOrdersTable.agentId, agent.id), sql`${kpiOrdersTable.status} not in ('draft','cancelled')`));
      const [kpi] = await db.select({
        total: sql<string>`coalesce(sum(${kpiCalculationsTable.kpiAmount}), 0)`,
      }).from(kpiCalculationsTable).where(and(eq(kpiCalculationsTable.agentId, agent.id), sql`${kpiCalculationsTable.status} in ('confirmed','partial','pending')`));
      out.push({
        id: agent.id,
        fullName: agent.fullName,
        phone: agent.phone,
        login: agent.login,
        status: agent.status,
        territoryId: agent.territoryId,
        startedAt: agent.startedAt,
        salesPlan: agent.salesPlan,
        notes: agent.notes,
        customers: cust?.n ?? 0,
        salesTotal: money(sales?.total),
        kpiTotal: money(kpi?.total),
        createdAt: agent.createdAt,
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

router.post("/kpi/customers", requireKpiAdmin(), async (req, res, next) => {
  try {
    const actor = getKpiActor(res);
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
      status: String(req.body?.status ?? "active"),
      contractNumber: String(req.body?.contractNumber ?? ""),
      paymentTermsNote: String(req.body?.paymentTermsNote ?? ""),
      notes: String(req.body?.notes ?? ""),
      createdBy: actor.id,
    }).returning();
    if (req.body?.agentId) {
      await db.insert(kpiCustomerAssignmentsTable).values({
        customerId: row.id,
        agentId: String(req.body.agentId),
        active: true,
        assignedBy: actor.id,
      });
    }
    await recordAudit({ action: "kpi.customer.created", entityType: "kpi_customer", entityId: row.id, actorName: actor.name, details: name });
    res.status(201).json(row);
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
    if (req.body?.lat !== undefined) patch.lat = req.body.lat == null ? null : String(req.body.lat);
    if (req.body?.lng !== undefined) patch.lng = req.body.lng == null ? null : String(req.body.lng);
    const [row] = await db.update(kpiCustomersTable).set(patch).where(eq(kpiCustomersTable.id, id)).returning();
    if (!row) {
      res.status(404).json({ error: "Mijoz topilmadi." });
      return;
    }
    await recordAudit({ action: "kpi.customer.updated", entityType: "kpi_customer", entityId: id, actorName: actor.name, details: row.name });
    res.json(row);
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
      .limit(100);
    const todayDone = new Set(
      visits
        .filter((v) => v.createdAt.toISOString().slice(0, 10) === today && v.status === "done")
        .map((v) => v.customerId),
    );

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
      const stages = (policy.stages || []).map((s) => ({
        name: s.name,
        percent: Number(s.percent),
        fromDate: addDays(anchor, s.dayFrom),
        untilDate: addDays(anchor, s.dayTo),
        ifFullPaidKpi: moneyPct(o.total, s.percent),
        onRemainingDebtKpi: moneyPct(due, s.percent),
      }));
      const k = calcByOrder.get(o.id);
      if (k) kpiEarned = moneyAdd(kpiEarned, k.kpiAmount);
      if (moneyCmp(due, 0) > 0 && stages[0]) {
        kpiPotential = moneyAdd(kpiPotential, stages[0].onRemainingDebtKpi);
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

    const customerCards = myCustomers.map((c) => {
      const debt = debtByCustomer.get(c.id) || "0.00";
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        address: c.address,
        debt,
        visitedToday: todayDone.has(c.id),
      };
    }).sort((a, b) => Number(b.debt) - Number(a.debt));

    res.json({
      agent: {
        id: agent.id,
        fullName: agentRow?.fullName || agent.fullName,
        login: agent.login,
        phone: agentRow?.phone || "",
        salesPlan: agentRow?.salesPlan || "0.00",
      },
      summary: {
        customersCount: myCustomers.length,
        debtorsCount: customerCards.filter((c) => Number(c.debt) > 0).length,
        visitedToday: todayDone.size,
        totalSales,
        totalPaid,
        totalDue,
        kpiEarned,
        kpiPotential,
      },
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
    const lat = req.body?.lat != null && Number.isFinite(Number(req.body.lat)) ? String(Number(req.body.lat).toFixed(6)) : null;
    const lng = req.body?.lng != null && Number.isFinite(Number(req.body.lng)) ? String(Number(req.body.lng).toFixed(6)) : null;
    const [row] = await db
      .insert(kpiVisitsTable)
      .values({
        agentId: agent.id,
        customerId,
        status: "done",
        startedAt: new Date(),
        finishedAt: new Date(),
        lat,
        lng,
        notes,
      })
      .returning();
    if (lat && lng) {
      await db.insert(kpiLocationEventsTable).values({
        agentId: agent.id,
        lat,
        lng,
        accuracyM: req.body?.accuracy != null ? String(Math.round(Number(req.body.accuracy))) : null,
        source: "visit",
      });
      // If customer has no coordinates yet, save visit spot as store location
      const [cust] = await db.select().from(kpiCustomersTable).where(eq(kpiCustomersTable.id, customerId)).limit(1);
      if (cust && (!cust.lat || !cust.lng)) {
        await db.update(kpiCustomersTable).set({ lat, lng }).where(eq(kpiCustomersTable.id, customerId));
      }
    }
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

router.post("/kpi/agent/location", requireKpiAgent(), async (req, res, next) => {
  try {
    const agent = getKpiAgent(res);
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(400).json({ error: "lat/lng kerak." });
      return;
    }
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

    const locEvents = await db
      .select()
      .from(kpiLocationEventsTable)
      .orderBy(desc(kpiLocationEventsTable.recordedAt))
      .limit(400);
    const visits = await db
      .select()
      .from(kpiVisitsTable)
      .orderBy(desc(kpiVisitsTable.createdAt))
      .limit(300);

    const todayVisits = visits.filter((v) => v.createdAt.toISOString().slice(0, 10) === dateFilter);
    const visitedByCustomer = new Map<string, { at: string; lat: string | null; lng: string | null; notes: string }>();
    for (const v of todayVisits) {
      if (!visitedByCustomer.has(v.customerId)) {
        visitedByCustomer.set(v.customerId, {
          at: v.createdAt.toISOString(),
          lat: v.lat,
          lng: v.lng,
          notes: v.notes,
        });
      }
    }

    const lastLocByAgent = new Map<string, typeof locEvents[number]>();
    for (const ev of locEvents) {
      if (!lastLocByAgent.has(ev.agentId)) lastLocByAgent.set(ev.agentId, ev);
    }

    const agentMap = new Map(allAgents.map((a) => [a.id, a.fullName]));

    const agentPins = agents.map((a) => {
      const last = lastLocByAgent.get(a.id);
      const myVisits = todayVisits.filter((v) => v.agentId === a.id);
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
        accuracyM: last?.accuracyM ? Number(last.accuracyM) : null,
        lastSeenAt: last?.recordedAt ? last.recordedAt.toISOString() : null,
        customersCount: myCustomers.length,
        debtorsCount: myDebtors.length,
        visitedToday: myVisits.length,
      };
    });

    const points = customers
      .filter((c) => {
        const owner = assignByCustomer.get(c.id) || c.createdByAgentId || "";
        if (agentFilter && owner !== agentFilter) return false;
        return Boolean(c.lat && c.lng) || Number(debtByCustomer.get(c.id) || 0) > 0 || visitedByCustomer.has(c.id);
      })
      .slice(0, 200)
      .map((c) => {
        const owner = assignByCustomer.get(c.id) || c.createdByAgentId || "";
        const visit = visitedByCustomer.get(c.id);
        const debt = debtByCustomer.get(c.id) || "0.00";
        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          address: c.address,
          agentId: owner || null,
          agentName: owner ? agentMap.get(owner) || "—" : "—",
          lat: c.lat ? Number(c.lat) : visit?.lat ? Number(visit.lat) : null,
          lng: c.lng ? Number(c.lng) : visit?.lng ? Number(visit.lng) : null,
          debt,
          visitedToday: Boolean(visit),
          visitedAt: visit?.at || null,
          visitNotes: visit?.notes || "",
        };
      });

    const routeLog = todayVisits
      .filter((v) => !agentFilter || v.agentId === agentFilter)
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
          at: v.createdAt.toISOString(),
          notes: v.notes,
        };
      });

    res.json({
      date: dateFilter,
      agents: agentPins,
      points,
      routeLog,
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

/* ---------- Export ---------- */
router.get("/kpi/export/:kind", requireKpiAdmin(), async (req, res, next) => {
  try {
    const kind = String(req.params.kind);
    let header: string[] = [];
    let lines: string[][] = [];
    if (kind === "orders") {
      header = ["number", "status", "agent_id", "customer_id", "total", "paid", "order_date", "due_date"];
      const rows = await db.select().from(kpiOrdersTable).orderBy(desc(kpiOrdersTable.createdAt)).limit(2000);
      lines = rows.map((r) => [r.number, r.status, r.agentId, r.customerId, r.total, r.paidAmount, r.orderDate, r.paymentDueDate || ""]);
    } else if (kind === "payments") {
      header = ["id", "order_id", "amount", "status", "method", "reference", "paid_at"];
      const rows = await db.select().from(kpiPaymentsTable).orderBy(desc(kpiPaymentsTable.createdAt)).limit(2000);
      lines = rows.map((r) => [r.id, r.orderId, r.amount, r.status, r.method, r.reference, r.paidAt?.toISOString() || ""]);
    } else if (kind === "kpi") {
      header = ["order_id", "agent_id", "base", "percent", "kpi_amount", "status", "stage", "days_remaining"];
      const rows = await db.select().from(kpiCalculationsTable).orderBy(desc(kpiCalculationsTable.updatedAt)).limit(2000);
      lines = rows.map((r) => [r.orderId, r.agentId, r.baseAmount, r.stagePercent, r.kpiAmount, r.status, r.stageName, String(r.daysRemaining ?? "")]);
    } else if (kind === "agents") {
      header = ["full_name", "login", "phone", "status", "sales_plan"];
      const rows = await db.select().from(kpiAgentsTable).orderBy(asc(kpiAgentsTable.fullName));
      lines = rows.map((r) => [r.fullName, r.login, r.phone, r.status, r.salesPlan]);
    } else if (kind === "customers") {
      header = ["name", "type", "phone", "status", "address"];
      const rows = await db.select().from(kpiCustomersTable).orderBy(asc(kpiCustomersTable.name)).limit(2000);
      lines = rows.map((r) => [r.name, r.type, r.phone, r.status, r.address]);
    } else {
      res.status(400).json({ error: "orders|payments|kpi|agents|customers" });
      return;
    }
    const body = [header, ...lines].map((row) => row.map(csvEscape).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="kpi-${kind}.csv"`);
    res.send("\uFEFF" + body);
  } catch (error) {
    next(error);
  }
});

export default router;
