import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { loadCatalog } from "../lib/catalog";
import {
  accountFromToken,
  createAccount,
  createShipment,
  getAccount,
  listAccounts,
  listShipments,
  loginFactory,
  deleteAccount,
  resetPassword,
  setShipmentStatus,
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
    res.status(201).json(createAccount({ name, code, catalogName, login, password }));
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
    res.json(updateAccount(String(req.params.id), { name, code, login, password }));
  } catch (error) {
    fail(res, error);
  }
});

router.delete("/partner-factories/:id", (req, res) => {
  try {
    res.json(deleteAccount(String(req.params.id)));
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

router.post("/partner-factories/shipments/:id/accept", (req, res) => {
  try {
    res.json(setShipmentStatus(String(req.params.id), "accepted"));
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
