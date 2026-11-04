import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { dataFile } from "../lib/data-dir";

const router: IRouter = Router();
const FILE = dataFile("accounts.json");
const KNOWN_ROLES = ["super_admin", "manager", "sales_admin", "agent", "warehouse_manager", "warehouse_staff", "analyst", "accountant", "worker"] as const;

type Account = { id: string; name: string; login: string; password: string; role: string; phone?: string };

function normalizeRole(value: string) {
  const role = value.trim().replace(/\s+/g, " ").slice(0, 48);
  if (role.length < 2) return "";
  const known = KNOWN_ROLES.find((item) => item === role);
  return known || role;
}
type Store = { secret: string; accounts: Account[]; sessions: Record<string, string> };

const sessions = new Map<string, string>();
let memory: Store | null = null;

function same(left: string, right: string) {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function write(store: Store) {
  memory = store;
  mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, FILE);
  void pool
    .query(
      "insert into partner_store (id, document, updated_at) values ('accounts', $1::jsonb, now()) on conflict (id) do update set document = excluded.document, updated_at = now()",
      [JSON.stringify(store)],
    )
    .catch(() => undefined);
}

export async function hydrateLocalAccounts() {
  try {
    await pool.query(`
      create table if not exists partner_store (
        id text primary key,
        document jsonb not null,
        updated_at timestamptz not null default now()
      )
    `);
    const res = await pool.query<{ document: Partial<Store> }>(
      "select document from partner_store where id = 'accounts'",
    );
    const remote = res.rows[0]?.document;
    if (remote && remote.secret && Array.isArray(remote.accounts) && remote.accounts.length > 0) {
      memory = {
        secret: remote.secret,
        accounts: remote.accounts,
        sessions: remote.sessions && typeof remote.sessions === "object" ? remote.sessions : {},
      };
      ensureAdmin(memory);
      for (const [token, login] of Object.entries(memory.sessions)) sessions.set(token, login);
      write(memory);
      return;
    }
    const current = read();
    if (ensureAdmin(current)) write(current);
    else {
      await pool.query(
        "insert into partner_store (id, document, updated_at) values ('accounts', $1::jsonb, now()) on conflict (id) do update set document = excluded.document, updated_at = now()",
        [JSON.stringify(current)],
      );
    }
  } catch {
    /* ignore db init error */
  }
}

export function verifyLocalAgentCredentials(login: string, password: string): Account | null {
  const store = read();
  if (ensureAdmin(store)) write(store);
  const key = login.trim().toLowerCase();
  const account = store.accounts.find((a) => a.login.toLowerCase() === key && same(a.password, password));
  return account || null;
}

function readDisk(): Store {
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Store>;
    if (parsed.secret && Array.isArray(parsed.accounts)) {
      return { secret: parsed.secret, accounts: parsed.accounts, sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {} };
    }
  } catch {
    /* first run */
  }
  const store: Store = {
    secret: randomBytes(24).toString("base64url"),
    accounts: [{ id: "admin", name: "Administrator", login: "bordouzadmin", password: "2026@admin", role: "super_admin" }],
    sessions: {},
  };
  write(store);
  return store;
}

function read(): Store {
  if (!memory) memory = readDisk();
  return memory;
}

const SEED_AGENTS: Array<[string, string, string]> = [
  ["Oysha", "oysha", "Oysha@7492"],
  ["Shaxzod", "shaxzod", "Shaxzod@3816"],
  ["Farzona", "farzona", "Farzona@5924"],
  ["Elyor", "elyor", "Elyor@6183"],
  ["Abbos", "abbos", "Abbos@4729"],
  ["Baxodir", "baxodir", "Baxodir@8351"],
  ["Muzaffar", "muzaffar", "Muzaffar@2947"],
  ["Avliyo", "avliyo", "Avliyo@9164"],
  ["Gulzoda", "gulzoda", "Gulzoda@5382"],
  ["Nafisa", "nafisa", "Nafisa@6719"],
  ["Abdug'ani", "abdugani", "Abdugani@4268"],
  ["Nozim", "nozim", "Nozim@7835"],
  ["Farxod aka", "farxodaka", "Farxod@3591"],
];

/** Returns true when admin or default MoySklad agents were created or corrected. */
function ensureAdmin(store: Store): boolean {
  let changed = false;
  const admin = store.accounts.find((account) => account.login === "bordouzadmin");
  if (admin) {
    if (admin.password !== "2026@admin") {
      admin.password = "2026@admin";
      changed = true;
    }
    if (admin.role !== "super_admin") {
      admin.role = "super_admin";
      changed = true;
    }
    if (!admin.name.trim()) {
      admin.name = "Administrator";
      changed = true;
    }
  } else {
    store.accounts.unshift({ id: "admin", name: "Administrator", login: "bordouzadmin", password: "2026@admin", role: "super_admin" });
    changed = true;
  }
  for (const [name, login, defaultPassword] of SEED_AGENTS) {
    const existing = store.accounts.find((a) => a.login.toLowerCase() === login);
    if (!existing) {
      store.accounts.push({ id: `agent-${login}`, name, login, password: defaultPassword, role: "agent", phone: "" });
      changed = true;
    } else if (existing.password === "1234") {
      existing.password = defaultPassword;
      changed = true;
    }
  }
  return changed;
}

function remember(token: string, login: string) {
  sessions.set(token, login);
  const store = read();
  store.sessions[token] = login;
  write(store);
}

function forgetLogin(login: string) {
  const store = read();
  let changed = false;
  for (const [token, owner] of sessions) {
    if (owner !== login) continue;
    sessions.delete(token);
    delete store.sessions[token];
    changed = true;
  }
  if (changed) write(store);
}

const loaded = read();
if (ensureAdmin(loaded)) write(loaded);
for (const [token, login] of Object.entries(loaded.sessions)) sessions.set(token, login);

function actor(req: Request): Account | null {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const login = sessions.get(token);
  if (!login) return null;
  return read().accounts.find((account) => account.login === login) ?? null;
}

export function localActor(req: Request): Account | null {
  return actor(req);
}

export function requireLocalUser(req: Request, res: Response): Account | null {
  const current = actor(req);
  if (!current) {
    res.status(401).json({ error: "invalid" });
    return null;
  }
  return current;
}

export function requireLocalAdmin(req: Request, res: Response): Account | null {
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

export function requireOfficeDirector(req: Request, res: Response): Account | null {
  const current = actor(req);
  if (!current) {
    res.status(401).json({ error: "invalid" });
    return null;
  }
  if (current.role !== "super_admin" && current.role !== "manager") {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return current;
}

export function listLocalPeople() {
  return read().accounts.map(({ id, name, login, role }) => ({ id, name, login, role }));
}

function requireAdmin(req: Request, res: Response): Account | null {
  return requireLocalAdmin(req, res);
}

router.post("/local-login", (req, res) => {
  const login = String(req.body?.login ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const store = read();
  if (ensureAdmin(store)) write(store);
  const account = store.accounts.find((item) => item.login.toLowerCase() === login && same(item.password, password));
  if (!account) {
    res.status(401).json({ error: "invalid" });
    return;
  }
  const token = randomBytes(24).toString("base64url");
  remember(token, account.login);
  res.json({ token, name: account.name, login: account.login, role: account.role });
});

router.get("/local-accounts", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  const store = read();
  if (ensureAdmin(store)) write(store);
  res.json(store.accounts.map(({ id, name, login, password, role, phone }) => ({ id, name, login, password, role, phone: phone || "" })));
});

router.post("/local-accounts", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  const login = String(req.body?.login ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const name = String(req.body?.name ?? "").trim() || login;
  const phone = String(req.body?.phone ?? "").trim();
  const role = normalizeRole(String(req.body?.role ?? ""));
  if (!login || password.length < 4 || !role) {
    res.status(400).json({ error: "invalid" });
    return;
  }
  const store = read();
  if (store.accounts.some((account) => account.login.toLowerCase() === login)) {
    res.status(409).json({ error: "exists" });
    return;
  }
  store.accounts.push({ id: randomUUID(), name, login, password, role, phone });
  write(store);
  res.status(201).json(store.accounts.map(({ id, name: accountName, login: accountLogin, password: accountPassword, role: accountRole, phone: accountPhone }) => ({ id, name: accountName, login: accountLogin, password: accountPassword, role: accountRole, phone: accountPhone || "" })));
});

router.patch("/local-accounts/:id", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  const store = read();
  const target = store.accounts.find((account) => account.id === req.params.id);
  if (!target) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (target.login === "bordouzadmin") {
    if (req.body?.name) target.name = String(req.body.name).trim() || target.name;
    write(store);
    res.json(store.accounts);
    return;
  }
  const nextLogin = req.body?.login ? String(req.body.login).trim().toLowerCase() : target.login;
  if (nextLogin !== target.login && store.accounts.some((a) => a.id !== target.id && a.login.toLowerCase() === nextLogin)) {
    res.status(409).json({ error: "exists" });
    return;
  }
  const oldLogin = target.login;
  target.login = nextLogin;
  if (req.body?.name != null) target.name = String(req.body.name).trim() || target.login;
  if (req.body?.phone != null) target.phone = String(req.body.phone).trim();
  if (req.body?.role) {
    const r = normalizeRole(String(req.body.role));
    if (r) target.role = r;
  }
  if (req.body?.password && String(req.body.password).length >= 4) {
    target.password = String(req.body.password);
    forgetLogin(oldLogin);
  }
  write(store);
  res.json(store.accounts.map(({ id, name, login, password, role, phone }) => ({ id, name, login, password, role, phone: phone || "" })));
});

router.delete("/local-accounts/:id", (req, res) => {
  const current = requireOfficeDirector(req, res);
  if (!current) return;
  const store = read();
  const target = store.accounts.find((account) => account.id === req.params.id);
  if (!target || target.id === current.id || target.login === "bordouzadmin") {
    res.status(400).json({ error: "invalid" });
    return;
  }
  store.accounts = store.accounts.filter((account) => account.id !== target.id);
  write(store);
  forgetLogin(target.login);
  res.json(store.accounts.map(({ id, name, login, password, role, phone }) => ({ id, name, login, password, role, phone: phone || "" })));
});

export default router;
