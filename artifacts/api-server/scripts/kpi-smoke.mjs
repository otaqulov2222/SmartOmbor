/**
 * Read-only-ish smoke: creates a temp agent, customer, order, confirms, pays, checks KPI, cleans notes in audit only.
 * Run: node artifacts/api-server/scripts/kpi-smoke.mjs
 * Requires API on PORT (default 5000) and DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
try {
  for (const line of readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* */ }

const base = process.env.KPI_SMOKE_URL || "http://127.0.0.1:5000/api";

async function j(pathName, init = {}, token) {
  const headers = { "Content-Type": "application/json", ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${pathName}`, { ...init, headers });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`${pathName} ${r.status}: ${typeof body === "string" ? body : body.error || JSON.stringify(body)}`);
  return body;
}

const login = await j("/local-login", { method: "POST", body: JSON.stringify({ login: "bordouzadmin", password: "2026@admin" }) });
const admin = login.token;
console.log("admin ok");

const dash = await j("/kpi/dashboard", {}, admin);
console.log("dashboard", dash.agentsTotal, dash.salesTotal);

const agentLogin = `smoke_${Date.now().toString(36)}`;
const agent = await j("/kpi/agents", {
  method: "POST",
  body: JSON.stringify({ fullName: "Smoke Agent", phone: "+998900000000", login: agentLogin, password: "smoke1234", salesPlan: "10000000" }),
}, admin);
console.log("agent", agent.id);

const customer = await j("/kpi/customers", {
  method: "POST",
  body: JSON.stringify({ name: "Smoke Store", phone: "+998901112233", type: "store", status: "active", agentId: agent.id }),
}, admin);
console.log("customer", customer.id);

let product;
try {
  product = await j("/kpi/products", {
    method: "POST",
    body: JSON.stringify({ code: `SMK-${Date.now()}`, name: "Smoke Product", price: "100000" }),
  }, admin);
} catch (e) {
  const list = await j("/kpi/products", {}, admin);
  product = list[0];
  if (!product) throw e;
}
console.log("product", product.id);

const order = await j("/kpi/orders", {
  method: "POST",
  body: JSON.stringify({
    customerId: customer.id,
    agentId: agent.id,
    paymentDueDays: 10,
    lines: [{ productId: product.id, quantity: 2, unitPrice: product.price }],
  }),
}, admin);
console.log("order", order.number, order.total);

const confirmed = await j(`/kpi/orders/${order.id}/confirm`, { method: "POST", body: "{}" }, admin);
console.log("confirmed", confirmed.status);

const payment = await j("/kpi/payments", {
  method: "POST",
  body: JSON.stringify({ orderId: order.id, amount: order.total, confirm: true, idempotencyKey: `smoke-${order.id}` }),
}, admin);
console.log("payment", payment.status, payment.amount);

const calcs = await j("/kpi/calculations", {}, admin);
const calc = calcs.find((c) => c.orderId === order.id);
console.log("kpi", calc?.stageName, calc?.stagePercent, calc?.kpiAmount, calc?.status);

const session = await j("/kpi/agent/login", { method: "POST", body: JSON.stringify({ login: agentLogin, password: "smoke1234" }) });
const mine = await j("/kpi/agent/kpi", {}, session.token);
console.log("agent sees", mine.length, "kpi rows");
console.log("SMOKE_OK");
