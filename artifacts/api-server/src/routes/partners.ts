import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { applyReceiptStock, findProductsByBarcode, findProductsByLabel, loadCatalog } from "../lib/catalog";
import { moysklad, moyskladSend, MoySkladError } from "../lib/moysklad";
import { recordAudit } from "../lib/audit";
import {
  accountFromToken,
  createAccount,
  createShipment,
  getAccount,
  linkShipmentLine,
  listAccounts,
  listShipments,
  loginFactory,
  markShipmentPosted,
  deleteAccount,
  deleteShipment,
  resetPassword,
  setShipmentStatus,
  updateShipment,
  updateAccount,
  suggestPassword,
} from "../lib/partners";

const router: IRouter = Router();

function fail(res: Response, error: unknown) {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 500;
  const message = error instanceof Error ? error.message : "error";
  res.status(status || 500).json({ error: message });
}

function bearer(req: Request) {
  const header = req.header("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function requireFactory(req: Request, res: Response, next: NextFunction) {
  const account = accountFromToken(bearer(req));
  if (!account) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.locals.factory = account;
  next();
}

router.get("/partner-alerts", (_req, res) => {
  const pending = listShipments().filter((item) => item.status === "sent").length;
  res.json({ pending });
});

router.get("/partner-factories", async (_req, res, next) => {
  try {
    const catalog = await loadCatalog();
    const grouped = new Map<string, { name: string; productCount: number; stock: number }>();
    for (const product of catalog.products) {
      const name = product.factory?.trim();
      if (!name) continue;
      const current = grouped.get(name) || { name, productCount: 0, stock: 0 };
      current.productCount += 1;
      current.stock += product.stock;
      grouped.set(name, current);
    }
    const accounts = listAccounts();
    const shipments = listShipments();
    const rows = [...grouped.values()]
      .map((row) => {
        const account = accounts.find((item) => item.catalogName === row.name || item.name === row.name) ?? null;
        const own = account ? shipments.filter((item) => item.factoryId === account.id) : [];
        return {
          ...row,
          account,
          shipmentCount: own.length,
          pendingCount: own.filter((item) => item.status === "sent").length,
          lastShipment: own[0]?.createdAt ?? null,
        };
      })
      .sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name));
    const extras = accounts
      .filter((account) => !rows.some((row) => row.account?.id === account.id))
      .map((account) => {
        const own = shipments.filter((item) => item.factoryId === account.id);
        return {
          name: account.name,
          productCount: 0,
          stock: 0,
          account,
          shipmentCount: own.length,
          pendingCount: own.filter((item) => item.status === "sent").length,
          lastShipment: own[0]?.createdAt ?? null,
        };
      });
    res.json({ items: [...rows, ...extras] });
  } catch (error) {
    next(error);
  }
});

router.post("/partner-factories", (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const code = String(req.body?.code ?? "").trim();
    const login = String(req.body?.login ?? "").trim();
    const catalogName = String(req.body?.catalogName ?? name).trim();
    const password = String(req.body?.password ?? "").trim() || suggestPassword();
    if (!name || !code || !login) {
      res.status(400).json({ error: "required" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: "password_short" });
      return;
    }
    const created = createAccount({ name, code, catalogName, login, password });
    void recordAudit({ action: "partner.created", entityType: "partner", entityId: created.account?.id, details: name });
    res.status(201).json(created);
  } catch (error) {
    fail(res, error);
  }
});

router.patch("/partner-factories/:id", (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const code = String(req.body?.code ?? "").trim();
    const login = String(req.body?.login ?? "").trim();
    const password = String(req.body?.password ?? "").trim();
    const updated = updateAccount(String(req.params.id), {
      name,
      code,
      login,
      password,
      ...( "counterpartyId" in (req.body ?? {}) ? { counterpartyId: String(req.body?.counterpartyId ?? ""), counterpartyName: String(req.body?.counterpartyName ?? "") } : {}),
    });
    void recordAudit({ action: "partner.updated", entityType: "partner", entityId: String(req.params.id), details: name || String(req.params.id) });
    res.json(updated);
  } catch (error) {
    fail(res, error);
  }
});

router.delete("/partner-factories/:id", (req, res) => {
  try {
    const removed = deleteAccount(String(req.params.id));
    void recordAudit({ action: "partner.deleted", entityType: "partner", entityId: String(req.params.id) });
    res.json(removed);
  } catch (error) {
    fail(res, error);
  }
});

router.post("/partner-factories/:id/password", (req, res) => {
  try {
    const password = String(req.body?.password ?? "").trim() || suggestPassword();
    if (password.length < 6) {
      res.status(400).json({ error: "password_short" });
      return;
    }
    res.json(resetPassword(String(req.params.id), password));
  } catch (error) {
    fail(res, error);
  }
});

router.get("/partner-factories/:id", (req, res) => {
  const account = getAccount(String(req.params.id));
  if (!account) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { passwordHash: _hash, salt: _salt, passwordPlain, ...safe } = account;
  res.json({ account: { ...safe, password: passwordPlain || null }, shipments: listShipments(account.id) });
});

function lineUnits(line: { pairs: number; quantity: number; colors: Array<{ quantity: number }> }) {
  if (line.pairs > 0) return line.pairs;
  if (line.quantity > 0) return line.quantity;
  return line.colors.reduce((sum, color) => sum + (color.quantity || 0), 0);
}

router.get("/counterparties", async (req, res, next) => {
  try {
    const search = String(req.query.search ?? "").trim();
    if (search.length < 2) {
      res.json({ items: [] });
      return;
    }
    const page = await moysklad<{ rows: Array<{ id?: string; name?: string }> }>(`/entity/counterparty?limit=15&search=${encodeURIComponent(search)}`);
    res.json({ items: page.rows.filter((row) => row.id && row.name).map((row) => ({ id: row.id, name: row.name })) });
  } catch (error) {
    next(error);
  }
});

router.get("/partner-factories/shipments/:id/matches", async (req, res, next) => {
  try {
    const shipment = listShipments().find((item) => item.id === String(req.params.id));
    if (!shipment) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const catalog = await loadCatalog();
    const lines = shipment.lines.map((line) => {
      const text = [line.productCode, line.model, line.size].filter(Boolean).join(" ");
      const found = new Map<string, { id: string; name: string; code: string | null; stock: number }>();
      for (const product of findProductsByBarcode(catalog, line.productCode)) {
        found.set(product.id, { id: product.id, name: product.name, code: product.code, stock: product.stock });
      }
      for (const product of findProductsByLabel(catalog, text).products) {
        found.set(product.id, { id: product.id, name: product.name, code: product.code, stock: product.stock });
      }
      return { id: line.id, products: found.size > 6 ? [] : [...found.values()] };
    });
    res.json({ lines });
  } catch (error) {
    next(error);
  }
});

router.post("/partner-factories/shipments/:id/lines/:lineId/link", async (req, res, next) => {
  try {
    const productId = String(req.body?.productId ?? "").trim();
    if (!productId) {
      res.json(linkShipmentLine(String(req.params.id), String(req.params.lineId), null));
      return;
    }
    const catalog = await loadCatalog();
    const product = catalog.products.find((item) => item.id === productId);
    if (!product) {
      res.status(400).json({ error: "product" });
      return;
    }
    res.json(linkShipmentLine(String(req.params.id), String(req.params.lineId), { id: product.id, name: product.name }));
  } catch (error) {
    fail(res, error);
  }
});

router.post("/partner-factories/shipments/:id/supply", async (req, res, next) => {
  try {
    const shipment = listShipments().find((item) => item.id === String(req.params.id));
    if (!shipment) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (shipment.moyskladId) {
      res.status(409).json({ error: "posted" });
      return;
    }
    const account = getAccount(shipment.factoryId);
    const positions = shipment.lines.map((line) => ({ line, quantity: lineUnits(line) })).filter((item) => item.quantity > 0);
    if (!positions.length || positions.some((item) => !item.line.productId)) {
      res.status(400).json({ error: "unlinked" });
      return;
    }
    const catalog = await loadCatalog();
    if (positions.some((item) => !catalog.products.some((product) => product.id === item.line.productId))) {
      res.status(400).json({ error: "product" });
      return;
    }
    const storeId = String(req.body?.storeId ?? "").trim();
    const store = catalog.warehouses.find((item) => item.id === storeId) || (catalog.warehouses.length === 1 ? catalog.warehouses[0] : null);
    if (!store) {
      res.status(400).json({ error: "store" });
      return;
    }
    const agentName = account?.counterpartyName?.trim() || account?.catalogName?.trim() || account?.name?.trim() || "";
    const [organization, agents, currencies] = await Promise.all([
      moysklad<{ rows: Array<{ meta: { href: string; type: string; mediaType: string } }> }>("/entity/organization?limit=1"),
      moysklad<{ rows: Array<{ name?: string; meta: { href: string; type: string; mediaType: string } }> }>(`/entity/counterparty?limit=100&filter=name=${encodeURIComponent(agentName)}`),
      moysklad<{ rows: Array<{ isoCode?: string; meta: { href: string; type: string; mediaType: string } }> }>("/entity/currency?limit=100"),
    ]);
    const namedAgent = agents.rows.find((row) => row.name === agentName);
    const currency = currencies.rows.find((row) => row.isoCode === "UZS");
    const company = organization.rows[0];
    const base = "https://api.moysklad.ru/api/remap/1.2";
    const meta = (href: string, type: string) => ({ href, type, mediaType: "application/json" });
    let agentMeta = namedAgent?.meta ?? null;
    if (account?.counterpartyId) {
      try {
        const saved = await moysklad<{ meta: { href: string; type: string; mediaType: string }; name?: string }>(`/entity/counterparty/${encodeURIComponent(account.counterpartyId)}`);
        agentMeta = saved.meta;
      } catch {
        agentMeta = null;
      }
    }
    if (!agentMeta || !currency || !company) {
      res.status(400).json({ error: agentMeta ? "currency" : "agent" });
      return;
    }
    const created = await moyskladSend<{ id: string; name?: string }>("/entity/supply", {
      name: shipment.number,
      moment: `${shipment.date} 12:00:00`,
      applicable: true,
      organization: { meta: company.meta },
      agent: { meta: agentMeta },
      store: { meta: meta(`${base}/entity/store/${store.id}`, "store") },
      rate: { currency: { meta: currency.meta } },
      positions: positions.map((item) => ({
        quantity: item.quantity,
        price: Math.round(item.line.price * 100),
        assortment: { meta: meta(`${base}/entity/product/${item.line.productId}`, "product") },
      })),
    });
    applyReceiptStock(positions.map((item) => ({ productId: item.line.productId || "", warehouseId: store.id, quantity: item.quantity })));
    const saved = markShipmentPosted(shipment.id, { id: created.id, number: created.name || shipment.number });
    void recordAudit({ action: "shipment.posted", entityType: "shipment", entityId: shipment.id, details: created.name || shipment.number });
    res.status(201).json({ id: created.id, number: created.name || shipment.number, shipment: saved });
  } catch (error) {
    if (error instanceof MoySkladError) {
      res.status(error.status >= 400 && error.status < 500 ? 400 : 502).json({ error: "rejected" });
      return;
    }
    next(error);
  }
});

router.post("/partner-factories/shipments/:id/accept", (req, res) => {
  try {
    const accepted = setShipmentStatus(String(req.params.id), "accepted");
    void recordAudit({ action: "shipment.accepted", entityType: "shipment", entityId: String(req.params.id) });
    res.json(accepted);
  } catch (error) {
    fail(res, error);
  }
});

router.post("/partner-factories/shipments/:id/decline", (req, res) => {
  try {
    const declined = setShipmentStatus(String(req.params.id), "declined");
    void recordAudit({ action: "shipment.declined", entityType: "shipment", entityId: String(req.params.id) });
    res.json(declined);
  } catch (error) {
    fail(res, error);
  }
});

router.post("/partner-factories/shipments/:id/reopen", (req, res) => {
  try {
    res.json(setShipmentStatus(String(req.params.id), "sent"));
  } catch (error) {
    fail(res, error);
  }
});

router.patch("/partner-factories/shipments/:id", (req, res) => {
  try {
    res.json(updateShipment(String(req.params.id), {
      date: req.body?.date,
      note: req.body?.note,
      lines: Array.isArray(req.body?.lines) ? req.body.lines : [],
    }));
  } catch (error) {
    fail(res, error);
  }
});

router.delete("/partner-factories/shipments/:id", (req, res) => {
  try {
    res.json(deleteShipment(String(req.params.id)));
  } catch (error) {
    fail(res, error);
  }
});

router.post("/factory/login", (req, res) => {
  try {
    res.json(loginFactory(String(req.body?.login ?? ""), String(req.body?.password ?? "")));
  } catch (error) {
    fail(res, error);
  }
});

router.get("/factory/me", requireFactory, (_req, res) => {
  const account = res.locals.factory;
  res.json({ account, shipments: listShipments(account.id) });
});

router.post("/factory/shipments", requireFactory, (req, res) => {
  try {
    const shipment = createShipment(res.locals.factory.id, {
      date: req.body?.date,
      note: req.body?.note,
      lines: Array.isArray(req.body?.lines) ? req.body.lines : [],
    });
    res.status(201).json(shipment);
  } catch (error) {
    fail(res, error);
  }
});

export default router;
