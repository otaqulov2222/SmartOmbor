import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Router, type IRouter, type Request, type Response } from "express";
import { dataFile } from "../lib/data-dir";

const router: IRouter = Router();
const FILE = dataFile("accounts.json");
const ROLES = ["super_admin", "manager", "warehouse_manager", "warehouse_staff", "branch_manager", "analyst", "accountant", "worker"] as const;

type Account = { id: string; name: string; login: string; password: string; role: (typeof ROLES)[number] };
type Store = { secret: string; accounts: Account[] };

const sessions = new Map<string, string>();

function same(left: string, right: string) {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function write(store: Store) {
  mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, FILE);
}

function read(): Store {
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Store>;
    if (parsed.secret && Array.isArray(parsed.accounts)) return { secret: parsed.secret, accounts: parsed.accounts };
  } catch {
    /* first run */
  }
  const store: Store = {
    secret: randomBytes(24).toString("base64url"),
    accounts: [{ id: "admin", name: "Administrator", login: "bordouzadmin", password: "2026@admin", role: "super_admin" }],
  };
  write(store);
  return store;
}

function ensureAdmin(store: Store) {
  const admin = store.accounts.find((account) => account.login === "bordouzadmin");
  if (admin) {
    admin.password = "2026@admin";
    admin.role = "super_admin";
    if (!admin.name.trim()) admin.name = "Administrator";
    return;
  }
  store.accounts.unshift({ id: "admin", name: "Administrator", login: "bordouzadmin", password: "2026@admin", role: "super_admin" });
}

function actor(req: Request): Account | null {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const login = sessions.get(token);
  if (!login) return null;
  return read().accounts.find((account) => account.login === login) ?? null;
}

function requireAdmin(req: Request, res: Response): Account | null {
  const current = actor(req);
  if (!current) {
    res.status(401).json({ error: "invalid" });
    return null;
  }
  if (current.role !== "super_admin") {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return current;
}

router.post("/local-login", (req, res) => {
  const login = String(req.body?.login ?? "").trim();
  const password = String(req.body?.password ?? "");
  const store = read();
  ensureAdmin(store);
  write(store);
  const account = store.accounts.find((item) => item.login === login && same(item.password, password));
  if (!account) {
    res.status(401).json({ error: "invalid" });
    return;
  }
  const token = randomBytes(24).toString("base64url");
  sessions.set(token, account.login);
  res.json({ token, name: account.name, login: account.login, role: account.role });
});

router.get("/local-accounts", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(read().accounts.map(({ id, name, login, password, role }) => ({ id, name, login, password, role })));
});

router.post("/local-accounts", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const login = String(req.body?.login ?? "").trim();
  const password = String(req.body?.password ?? "");
  const name = String(req.body?.name ?? "").trim() || login;
  const role = String(req.body?.role ?? "");
  if (!login || password.length < 4 || !ROLES.includes(role as Account["role"])) {
    res.status(400).json({ error: "invalid" });
    return;
  }
  const store = read();
  if (store.accounts.some((account) => account.login === login)) {
    res.status(409).json({ error: "exists" });
    return;
  }
  store.accounts.push({ id: randomUUID(), name, login, password, role: role as Account["role"] });
  write(store);
  res.status(201).json(store.accounts.map(({ id, name: accountName, login: accountLogin, password: accountPassword, role: accountRole }) => ({ id, name: accountName, login: accountLogin, password: accountPassword, role: accountRole })));
});

router.delete("/local-accounts/:id", (req, res) => {
  const current = requireAdmin(req, res);
  if (!current) return;
  const store = read();
  const target = store.accounts.find((account) => account.id === req.params.id);
  if (!target || target.id === current.id || target.login === "bordouzadmin") {
    res.status(400).json({ error: "invalid" });
    return;
  }
  store.accounts = store.accounts.filter((account) => account.id !== target.id);
  write(store);
  for (const [token, login] of sessions) if (login === target.login) sessions.delete(token);
  res.json(store.accounts.map(({ id, name, login, password, role }) => ({ id, name, login, password, role })));
});

export default router;
