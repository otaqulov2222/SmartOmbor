#!/usr/bin/env node
/**
 * Live kirim test: warehouses + already-posted + brand-new shipment create+supply.
 */
const BASE = process.env.API_BASE || "http://127.0.0.1:8080";
const LOGIN = process.env.FACTORY_LOGIN || "test2026";
const PASSWORD = process.env.FACTORY_PASSWORD || "2026test";

async function json(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function timed(label, fn) {
  const t0 = Date.now();
  const result = await fn();
  const ms = Date.now() - t0;
  return { label, ms, ...result };
}

const cases = [];

const wh = await timed("warehouses", async () => {
  const { status, body } = await json("/api/warehouses");
  if (status !== 200 || !Array.isArray(body) || !body[0]?.id) {
    return { ok: false, detail: `status=${status}` };
  }
  return { ok: true, storeId: body[0].id, count: body.length };
});
cases.push(wh);
console.log(JSON.stringify(wh));

const already = await timed("already-posted", async () => {
  const { status, body } = await json("/api/partner-factories/shipments/4a756869aed7bec6/supply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storeId: wh.storeId, counterpartyId: "000d20ce-001f-11f0-0a80-15d10012c2db", counterpartyName: "muzaffar test" }),
  });
  return { ok: status < 400 && (body.already || body.id), status, already: body.already, id: body.id };
});
cases.push(already);
console.log(JSON.stringify(already));

const login = await timed("factory-login", async () => {
  const { status, body } = await json("/api/factory/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
  });
  if (status !== 200 || !body.token) return { ok: false, status };
  return { ok: true, token: body.token, counterpartyId: body.account?.counterpartyId, counterpartyName: body.account?.counterpartyName };
});
cases.push({ label: login.label, ms: login.ms, ok: login.ok });
console.log(JSON.stringify({ label: login.label, ms: login.ms, ok: login.ok }));

if (!login.ok) {
  console.log(JSON.stringify({ verdict: { pass: false, reason: "login failed" } }, null, 2));
  process.exit(1);
}

const stamp = Date.now().toString().slice(-6);
const created = await timed("create-shipment", async () => {
  const { status, body } = await json("/api/factory/shipments", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${login.token}`,
    },
    body: JSON.stringify({
      date: new Date().toISOString().slice(0, 10),
      note: `speed-test ${stamp}`,
      lines: [
        {
          factoryCode: "888",
          sectionCode: "1020",
          productCode: `T${stamp}`,
          size: "36-40",
          pairs: 60,
          pachka: 6,
          boxes: 2,
          price: 25000,
          colors: [],
          markup: { Premium: 5, Exclusive: 10, Sale: 13 },
        },
        {
          factoryCode: "888",
          sectionCode: "1021",
          productCode: `U${stamp}`,
          size: "30-35",
          pairs: 30,
          pachka: 6,
          boxes: 1,
          price: 30000,
          colors: [],
          markup: { Premium: 5, Exclusive: 10, Sale: 13 },
        },
      ],
    }),
  });
  if (status >= 400 || !body.id) return { ok: false, status, detail: body.error || body };
  return { ok: true, shipmentId: body.id, number: body.number };
});
cases.push({ label: created.label, ms: created.ms, ok: created.ok, shipmentId: created.shipmentId, number: created.number });
console.log(JSON.stringify({ label: created.label, ms: created.ms, ok: created.ok, shipmentId: created.shipmentId, number: created.number }));

if (!created.ok) {
  console.log(JSON.stringify({ verdict: { pass: false, reason: "create shipment failed", detail: created.detail } }, null, 2));
  process.exit(1);
}

const supply = await timed("fresh-kirim", async () => {
  const { status, body } = await json(`/api/partner-factories/shipments/${created.shipmentId}/supply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      storeId: wh.storeId,
      counterpartyId: login.counterpartyId || "000d20ce-001f-11f0-0a80-15d10012c2db",
      counterpartyName: login.counterpartyName || "muzaffar test",
    }),
  });
  let payload = body;
  let pollMs = 0;
  if (payload.pending) {
    const pollStart = Date.now();
    for (;;) {
      const poll = await json(`/api/partner-factories/shipments/${created.shipmentId}/supply`);
      if (!poll.body.pending) {
        pollMs = Date.now() - pollStart;
        payload = poll.body;
        break;
      }
      if (Date.now() - pollStart > 90_000) {
        return { ok: false, status, detail: "poll timeout", pollMs: Date.now() - pollStart };
      }
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  const ok = Boolean(payload.id) && !payload.error;
  return {
    ok,
    status,
    pollMs,
    supplyId: payload.id,
    number: payload.number,
    already: payload.already,
    error: payload.error,
    detail: payload.detail,
  };
});
cases.push(supply);
console.log(JSON.stringify(supply));

const verdict = {
  warehousesUnder2s: wh.ok && wh.ms < 2000,
  alreadyPostedUnder1s: already.ok && already.ms < 1000,
  freshKirimUnder15s: supply.ok && supply.ms < 15_000,
  freshKirimUnder5s: supply.ok && supply.ms < 5000,
  warehouseMs: wh.ms,
  alreadyMs: already.ms,
  freshMs: supply.ms,
  supplyId: supply.supplyId,
  shipmentNumber: created.number,
  pass: Boolean(wh.ok && already.ok && supply.ok && wh.ms < 2000 && supply.ms < 15_000),
};

console.log(JSON.stringify({ verdict }, null, 2));
process.exit(verdict.pass ? 0 : 2);
