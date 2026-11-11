import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const money = (name: string) => numeric(name, { precision: 18, scale: 2 });
const stamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const kpiTerritoriesTable = pgTable(
  "kpi_territories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    region: text("region").notNull().default(""),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by"),
    ...stamps,
  },
  (t) => ({ nameIdx: uniqueIndex("kpi_territories_name_uidx").on(t.name) }),
);

export const kpiAgentsTable = pgTable(
  "kpi_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: text("full_name").notNull(),
    phone: text("phone").notNull().default(""),
    login: text("login").notNull(),
    passwordHash: text("password_hash").notNull(),
    territoryId: uuid("territory_id").references(() => kpiTerritoriesTable.id),
    status: text("status").notNull().default("active"),
    startedAt: date("started_at", { mode: "string" }),
    salesPlan: money("sales_plan").notNull().default("0"),
    userId: text("user_id"),
    notes: text("notes").notNull().default(""),
    createdBy: text("created_by"),
    ...stamps,
  },
  (t) => ({
    loginIdx: uniqueIndex("kpi_agents_login_uidx").on(t.login),
    statusIdx: index("kpi_agents_status_idx").on(t.status),
  }),
);

export const kpiAgentSessionsTable = pgTable(
  "kpi_agent_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => kpiAgentsTable.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenIdx: uniqueIndex("kpi_agent_sessions_token_uidx").on(t.token),
    agentIdx: index("kpi_agent_sessions_agent_idx").on(t.agentId),
  }),
);

export const kpiCustomersTable = pgTable(
  "kpi_customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    stir: text("stir").notNull().default(""),
    contactName: text("contact_name").notNull().default(""),
    phone: text("phone").notNull().default(""),
    address: text("address").notNull().default(""),
    lat: numeric("lat", { precision: 10, scale: 7 }),
    lng: numeric("lng", { precision: 10, scale: 7 }),
    /** admin = exact meeting point; agent = unofficial; null = unknown/inferred */
    gpsSource: text("gps_source"),
    type: text("type").notNull().default("store"),
    status: text("status").notNull().default("pending"),
    contractNumber: text("contract_number").notNull().default(""),
    paymentTermsNote: text("payment_terms_note").notNull().default(""),
    notes: text("notes").notNull().default(""),
    createdByAgentId: uuid("created_by_agent_id").references(() => kpiAgentsTable.id),
    createdBy: text("created_by"),
    ...stamps,
  },
  (t) => ({
    nameIdx: index("kpi_customers_name_idx").on(t.name),
    statusIdx: index("kpi_customers_status_idx").on(t.status),
  }),
);

export const kpiCustomerAssignmentsTable = pgTable(
  "kpi_customer_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => kpiCustomersTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => kpiAgentsTable.id),
    active: boolean("active").notNull().default(true),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    unassignedAt: timestamp("unassigned_at", { withTimezone: true }),
    assignedBy: text("assigned_by"),
    note: text("note").notNull().default(""),
    ...stamps,
  },
  (t) => ({
    customerActiveIdx: index("kpi_assign_customer_active_idx").on(t.customerId, t.active),
    agentIdx: index("kpi_assign_agent_idx").on(t.agentId),
  }),
);

export const kpiProductsTable = pgTable(
  "kpi_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    unit: text("unit").notNull().default("dona"),
    price: money("price").notNull().default("0"),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by"),
    ...stamps,
  },
  (t) => ({ codeIdx: uniqueIndex("kpi_products_code_uidx").on(t.code) }),
);

export const kpiPoliciesTable = pgTable(
  "kpi_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    baseType: text("base_type").notNull().default("paid_amount"),
    startAnchor: text("start_anchor").notNull().default("order_confirmed"),
    warningDays: integer("warning_days").notNull().default(2),
    notes: text("notes").notNull().default(""),
    createdBy: text("created_by"),
    ...stamps,
  },
  (t) => ({ nameIdx: index("kpi_policies_name_idx").on(t.name) }),
);

export const kpiStagesTable = pgTable(
  "kpi_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => kpiPoliciesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(1),
    dayFrom: integer("day_from").notNull().default(0),
    dayTo: integer("day_to").notNull().default(7),
    percent: numeric("percent", { precision: 8, scale: 4 }).notNull().default("0"),
    ...stamps,
  },
  (t) => ({
    policyOrderIdx: index("kpi_stages_policy_order_idx").on(t.policyId, t.sortOrder),
  }),
);

export const kpiOrdersTable = pgTable(
  "kpi_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => kpiCustomersTable.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => kpiAgentsTable.id),
    status: text("status").notNull().default("draft"),
    orderDate: date("order_date", { mode: "string" }).notNull(),
    deliveryStatus: text("delivery_status").notNull().default("pending"),
    paymentType: text("payment_type").notNull().default("deferred"),
    paymentDueDate: date("payment_due_date", { mode: "string" }),
    paymentDueDays: integer("payment_due_days"),
    subtotal: money("subtotal").notNull().default("0"),
    discount: money("discount").notNull().default("0"),
    total: money("total").notNull().default("0"),
    paidAmount: money("paid_amount").notNull().default("0"),
    contractRef: text("contract_ref").notNull().default(""),
    invoiceRef: text("invoice_ref").notNull().default(""),
    notes: text("notes").notNull().default(""),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    policyId: uuid("policy_id").references(() => kpiPoliciesTable.id),
    policySnapshot: jsonb("policy_snapshot").$type<Record<string, unknown> | null>(),
    createdBy: text("created_by"),
    ...stamps,
  },
  (t) => ({
    numberIdx: uniqueIndex("kpi_orders_number_uidx").on(t.number),
    agentIdx: index("kpi_orders_agent_idx").on(t.agentId),
    statusIdx: index("kpi_orders_status_idx").on(t.status),
    customerIdx: index("kpi_orders_customer_idx").on(t.customerId),
  }),
);

export const kpiOrderItemsTable = pgTable(
  "kpi_order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => kpiOrdersTable.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => kpiProductsTable.id),
    productCode: text("product_code").notNull().default(""),
    productName: text("product_name").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull().default("1"),
    unitPrice: money("unit_price").notNull().default("0"),
    discount: money("discount").notNull().default("0"),
    lineTotal: money("line_total").notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ orderIdx: index("kpi_order_items_order_idx").on(t.orderId) }),
);

export const kpiPaymentsTable = pgTable(
  "kpi_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => kpiOrdersTable.id),
    amount: money("amount").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
    method: text("method").notNull().default("transfer"),
    reference: text("reference").notNull().default(""),
    status: text("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by"),
    notes: text("notes").notNull().default(""),
    createdBy: text("created_by"),
    ...stamps,
  },
  (t) => ({
    orderIdx: index("kpi_payments_order_idx").on(t.orderId),
    idemIdx: uniqueIndex("kpi_payments_idem_uidx").on(t.idempotencyKey),
  }),
);

export const kpiPaymentAllocationsTable = pgTable(
  "kpi_payment_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => kpiPaymentsTable.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => kpiOrdersTable.id),
    amount: money("amount").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    paymentIdx: index("kpi_alloc_payment_idx").on(t.paymentId),
    orderIdx: index("kpi_alloc_order_idx").on(t.orderId),
  }),
);

export const kpiCalculationsTable = pgTable(
  "kpi_calculations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => kpiOrdersTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => kpiAgentsTable.id),
    baseType: text("base_type").notNull(),
    baseAmount: money("base_amount").notNull().default("0"),
    stageName: text("stage_name").notNull().default(""),
    stagePercent: numeric("stage_percent", { precision: 8, scale: 4 }).notNull().default("0"),
    kpiAmount: money("kpi_amount").notNull().default("0"),
    status: text("status").notNull().default("pending"),
    stageDayFrom: integer("stage_day_from").notNull().default(0),
    stageDayTo: integer("stage_day_to").notNull().default(0),
    anchorAt: timestamp("anchor_at", { withTimezone: true }),
    stageEndsAt: timestamp("stage_ends_at", { withTimezone: true }),
    daysRemaining: integer("days_remaining"),
    policySnapshot: jsonb("policy_snapshot").$type<Record<string, unknown> | null>(),
    ...stamps,
  },
  (t) => ({
    orderIdx: uniqueIndex("kpi_calc_order_uidx").on(t.orderId),
    agentIdx: index("kpi_calc_agent_idx").on(t.agentId),
    statusIdx: index("kpi_calc_status_idx").on(t.status),
  }),
);

export const kpiLedgerTable = pgTable(
  "kpi_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").references(() => kpiOrdersTable.id),
    agentId: uuid("agent_id").references(() => kpiAgentsTable.id),
    calculationId: uuid("calculation_id").references(() => kpiCalculationsTable.id),
    entryType: text("entry_type").notNull(),
    amount: money("amount").notNull(),
    reason: text("reason").notNull().default(""),
    percent: numeric("percent", { precision: 8, scale: 4 }),
    actorId: text("actor_id"),
    meta: jsonb("meta").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentIdx: index("kpi_ledger_agent_idx").on(t.agentId),
    orderIdx: index("kpi_ledger_order_idx").on(t.orderId),
  }),
);

export const kpiNotificationsTable = pgTable(
  "kpi_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").references(() => kpiAgentsTable.id),
    userId: text("user_id"),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    readAt: timestamp("read_at", { withTimezone: true }),
    meta: jsonb("meta").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentIdx: index("kpi_notif_agent_idx").on(t.agentId),
    userIdx: index("kpi_notif_user_idx").on(t.userId),
  }),
);

/** GPS / visits — schema ready for MVP-2 UI */
export const kpiVisitPlansTable = pgTable(
  "kpi_visit_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => kpiAgentsTable.id),
    planDate: date("plan_date", { mode: "string" }).notNull(),
    notes: text("notes").notNull().default(""),
    createdBy: text("created_by"),
    ...stamps,
  },
  (t) => ({
    agentDateUid: uniqueIndex("kpi_visit_plans_agent_date_uidx").on(t.agentId, t.planDate),
  }),
);

export const kpiVisitsTable = pgTable(
  "kpi_visits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id").references(() => kpiVisitPlansTable.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => kpiAgentsTable.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => kpiCustomersTable.id),
    status: text("status").notNull().default("planned"),
    sortOrder: integer("sort_order").notNull().default(0),
    plannedAt: timestamp("planned_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    lat: numeric("lat", { precision: 10, scale: 7 }),
    lng: numeric("lng", { precision: 10, scale: 7 }),
    notes: text("notes").notNull().default(""),
    ...stamps,
  },
  (t) => ({
    agentIdx: index("kpi_visits_agent_idx").on(t.agentId),
    statusIdx: index("kpi_visits_status_idx").on(t.status),
  }),
);

export const kpiLocationEventsTable = pgTable(
  "kpi_location_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => kpiAgentsTable.id),
    lat: numeric("lat", { precision: 10, scale: 7 }).notNull(),
    lng: numeric("lng", { precision: 10, scale: 7 }).notNull(),
    accuracyM: numeric("accuracy_m", { precision: 10, scale: 2 }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source").notNull().default("device"),
    meta: jsonb("meta").$type<Record<string, unknown> | null>(),
  },
  (t) => ({
    agentTimeIdx: index("kpi_location_agent_time_idx").on(t.agentId, t.recordedAt),
  }),
);
