import { pool } from "@workspace/db";

const DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS kpi_territories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  region text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kpi_territories_name_uidx ON kpi_territories(name);
CREATE TABLE IF NOT EXISTS kpi_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  login text NOT NULL,
  password_hash text NOT NULL,
  territory_id uuid REFERENCES kpi_territories(id),
  status text NOT NULL DEFAULT 'active',
  started_at date,
  sales_plan numeric(18,2) NOT NULL DEFAULT 0,
  user_id text,
  notes text NOT NULL DEFAULT '',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kpi_agents_login_uidx ON kpi_agents(login);
CREATE INDEX IF NOT EXISTS kpi_agents_status_idx ON kpi_agents(status);
CREATE TABLE IF NOT EXISTS kpi_agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES kpi_agents(id) ON DELETE CASCADE,
  token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kpi_agent_sessions_token_uidx ON kpi_agent_sessions(token);
CREATE INDEX IF NOT EXISTS kpi_agent_sessions_agent_idx ON kpi_agent_sessions(agent_id);
CREATE TABLE IF NOT EXISTS kpi_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  stir text NOT NULL DEFAULT '',
  contact_name text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  lat numeric(10,7),
  lng numeric(10,7),
  type text NOT NULL DEFAULT 'store',
  status text NOT NULL DEFAULT 'pending',
  contract_number text NOT NULL DEFAULT '',
  payment_terms_note text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_by_agent_id uuid REFERENCES kpi_agents(id),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kpi_customers_name_idx ON kpi_customers(name);
CREATE INDEX IF NOT EXISTS kpi_customers_status_idx ON kpi_customers(status);
CREATE TABLE IF NOT EXISTS kpi_customer_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES kpi_customers(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES kpi_agents(id),
  active boolean NOT NULL DEFAULT true,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  unassigned_at timestamptz,
  assigned_by text,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kpi_assign_customer_active_idx ON kpi_customer_assignments(customer_id, active);
CREATE INDEX IF NOT EXISTS kpi_assign_agent_idx ON kpi_customer_assignments(agent_id);
CREATE TABLE IF NOT EXISTS kpi_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  unit text NOT NULL DEFAULT 'dona',
  price numeric(18,2) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kpi_products_code_uidx ON kpi_products(code);
CREATE TABLE IF NOT EXISTS kpi_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  base_type text NOT NULL DEFAULT 'paid_amount',
  start_anchor text NOT NULL DEFAULT 'order_confirmed',
  warning_days integer NOT NULL DEFAULT 2,
  notes text NOT NULL DEFAULT '',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kpi_policies_name_idx ON kpi_policies(name);
CREATE TABLE IF NOT EXISTS kpi_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES kpi_policies(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 1,
  day_from integer NOT NULL DEFAULT 0,
  day_to integer NOT NULL DEFAULT 7,
  percent numeric(8,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kpi_stages_policy_order_idx ON kpi_stages(policy_id, sort_order);
CREATE TABLE IF NOT EXISTS kpi_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL,
  customer_id uuid NOT NULL REFERENCES kpi_customers(id),
  agent_id uuid NOT NULL REFERENCES kpi_agents(id),
  status text NOT NULL DEFAULT 'draft',
  order_date date NOT NULL,
  delivery_status text NOT NULL DEFAULT 'pending',
  payment_type text NOT NULL DEFAULT 'deferred',
  payment_due_date date,
  payment_due_days integer,
  subtotal numeric(18,2) NOT NULL DEFAULT 0,
  discount numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL DEFAULT 0,
  paid_amount numeric(18,2) NOT NULL DEFAULT 0,
  contract_ref text NOT NULL DEFAULT '',
  invoice_ref text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  confirmed_at timestamptz,
  confirmed_by text,
  cancelled_at timestamptz,
  cancelled_by text,
  policy_id uuid REFERENCES kpi_policies(id),
  policy_snapshot jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kpi_orders_number_uidx ON kpi_orders(number);
CREATE INDEX IF NOT EXISTS kpi_orders_agent_idx ON kpi_orders(agent_id);
CREATE INDEX IF NOT EXISTS kpi_orders_status_idx ON kpi_orders(status);
CREATE INDEX IF NOT EXISTS kpi_orders_customer_idx ON kpi_orders(customer_id);
CREATE TABLE IF NOT EXISTS kpi_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES kpi_orders(id) ON DELETE CASCADE,
  product_id uuid REFERENCES kpi_products(id),
  product_code text NOT NULL DEFAULT '',
  product_name text NOT NULL,
  quantity numeric(18,3) NOT NULL DEFAULT 1,
  unit_price numeric(18,2) NOT NULL DEFAULT 0,
  discount numeric(18,2) NOT NULL DEFAULT 0,
  line_total numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kpi_order_items_order_idx ON kpi_order_items(order_id);
CREATE TABLE IF NOT EXISTS kpi_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES kpi_orders(id),
  amount numeric(18,2) NOT NULL,
  paid_at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL DEFAULT 'transfer',
  reference text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  idempotency_key text,
  confirmed_at timestamptz,
  confirmed_by text,
  notes text NOT NULL DEFAULT '',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kpi_payments_order_idx ON kpi_payments(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS kpi_payments_idem_uidx ON kpi_payments(idempotency_key);
CREATE TABLE IF NOT EXISTS kpi_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES kpi_payments(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES kpi_orders(id),
  amount numeric(18,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kpi_alloc_payment_idx ON kpi_payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS kpi_alloc_order_idx ON kpi_payment_allocations(order_id);
CREATE TABLE IF NOT EXISTS kpi_calculations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES kpi_orders(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES kpi_agents(id),
  base_type text NOT NULL,
  base_amount numeric(18,2) NOT NULL DEFAULT 0,
  stage_name text NOT NULL DEFAULT '',
  stage_percent numeric(8,4) NOT NULL DEFAULT 0,
  kpi_amount numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  stage_day_from integer NOT NULL DEFAULT 0,
  stage_day_to integer NOT NULL DEFAULT 0,
  anchor_at timestamptz,
  stage_ends_at timestamptz,
  days_remaining integer,
  policy_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kpi_calc_order_uidx ON kpi_calculations(order_id);
CREATE INDEX IF NOT EXISTS kpi_calc_agent_idx ON kpi_calculations(agent_id);
CREATE INDEX IF NOT EXISTS kpi_calc_status_idx ON kpi_calculations(status);
CREATE TABLE IF NOT EXISTS kpi_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES kpi_orders(id),
  agent_id uuid REFERENCES kpi_agents(id),
  calculation_id uuid REFERENCES kpi_calculations(id),
  entry_type text NOT NULL,
  amount numeric(18,2) NOT NULL,
  reason text NOT NULL DEFAULT '',
  percent numeric(8,4),
  actor_id text,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kpi_ledger_agent_idx ON kpi_ledger(agent_id);
CREATE INDEX IF NOT EXISTS kpi_ledger_order_idx ON kpi_ledger(order_id);
CREATE TABLE IF NOT EXISTS kpi_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES kpi_agents(id),
  user_id text,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  read_at timestamptz,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kpi_notif_agent_idx ON kpi_notifications(agent_id);
CREATE INDEX IF NOT EXISTS kpi_notif_user_idx ON kpi_notifications(user_id);
CREATE TABLE IF NOT EXISTS kpi_visit_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES kpi_agents(id),
  plan_date date NOT NULL,
  notes text NOT NULL DEFAULT '',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kpi_visit_plans_agent_date_idx ON kpi_visit_plans(agent_id, plan_date);
CREATE TABLE IF NOT EXISTS kpi_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid REFERENCES kpi_visit_plans(id),
  agent_id uuid NOT NULL REFERENCES kpi_agents(id),
  customer_id uuid NOT NULL REFERENCES kpi_customers(id),
  status text NOT NULL DEFAULT 'planned',
  sort_order integer NOT NULL DEFAULT 0,
  planned_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  lat numeric(10,7),
  lng numeric(10,7),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kpi_visits_agent_idx ON kpi_visits(agent_id);
CREATE INDEX IF NOT EXISTS kpi_visits_status_idx ON kpi_visits(status);
CREATE TABLE IF NOT EXISTS kpi_location_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES kpi_agents(id),
  lat numeric(10,7) NOT NULL,
  lng numeric(10,7) NOT NULL,
  accuracy_m numeric(10,2),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'device',
  meta jsonb
);
CREATE INDEX IF NOT EXISTS kpi_location_agent_time_idx ON kpi_location_events(agent_id, recorded_at);
`;

let ready: Promise<void> | null = null;

export function ensureKpiSchema(): Promise<void> {
  if (!ready) {
    ready = pool
      .query(DDL)
      .then(() => undefined)
      .catch((err) => {
        ready = null;
        throw err;
      });
  }
  return ready;
}
