import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { dataFile } from "../lib/data-dir";

const router: IRouter = Router();
const FILE = dataFile("accounts.json");
const KNOWN_ROLES = ["super_admin", "manager", "sales_admin", "agent", "warehouse_manager", "warehouse_staff", "analyst", "accountant", "worker"] as const;

const ROLE_LABELS: Record<string, string> = {
  "rahbar / super admin": "super_admin",
  "rahbar": "super_admin",
  "super admin": "super_admin",
  "menejer": "manager",
  "savdo rahbari": "sales_admin",
  "savdo agenti": "agent",
  "agent": "agent",
  "ombor mudiri": "warehouse_manager",
  "ombor xodimi (sklad)": "warehouse_staff",
  "ombor xodimi": "warehouse_staff",
  "sklad": "warehouse_staff",
  "bugalter": "accountant",
  "tahlilchi": "analyst",
  "ofis xodimi": "worker",
};

const ACCESS_IDS = [
  "dashboard", "products", "stock", "scanner", "receipts", "transfers", "inventory",
  "partners", "employees", "my_cabinet", "office", "kpi", "gps", "my_kpi",
  "analytics", "reports", "settings", "audit",
] as const;
type AccessId = (typeof ACCESS_IDS)[number];

const ROLE_ACCESS: Record<string, AccessId[]> = {
  super_admin: [...ACCESS_IDS],
  manager: [...ACCESS_IDS],
  sales_admin: [
    "dashboard", "products", "partners", "employees", "my_cabinet", "office", "kpi", "gps",
    "analytics", "reports", "settings",
  ],
  warehouse_manager: [
    "partners", "products", "stock", "scanner", "receipts", "transfers", "inventory",
    "my_cabinet", "office", "analytics",
  ],
  warehouse_staff: [
    "partners", "products", "stock", "scanner", "receipts", "transfers", "inventory",
    "my_cabinet", "office",
  ],
  agent: ["my_kpi", "my_cabinet"],
  accountant: ["my_cabinet", "office", "reports", "analytics"],
  analyst: ["my_cabinet", "office", "analytics", "reports", "dashboard"],
  worker: ["my_cabinet"],
};

type Account = {
  id: string;
  name: string;
  login: string;
  password: string;
  role: string;
  phone?: string;
  permissions?: AccessId[];
};

function normalizeRole(value: string) {
  const role = value.trim().replace(/\s+/g, " ").slice(0, 48);
  if (role.length < 2) return "";
  const known = KNOWN_ROLES.find((item) => item === role);
  if (known) return known;
  const mapped = ROLE_LABELS[role.toLowerCase()];
  if (mapped) return mapped;
  return role;
}

function defaultsForRole(role: string): AccessId[] {
  if (ROLE_ACCESS[role]) return [...ROLE_ACCESS[role]];
  if (/agent|агент/i.test(role)) return [...ROLE_ACCESS.agent];
  if (/ombor|sklad|склад/i.test(role)) return [...ROLE_ACCESS.warehouse_staff];
  if (/admin|rahbar|menejer|direktor/i.test(role)) return [...ROLE_ACCESS.manager];
  return [...ROLE_ACCESS.worker];
}

function withLegacyOffice(list: AccessId[]): AccessId[] {
  // Eski «office» punch+hisobot edi — punch endi my_cabinet.
  if (list.includes("office") && !list.includes("my_cabinet")) return [...list, "my_cabinet"];
  return list;
}

function normalizePermissions(raw: unknown, role: string): AccessId[] {
  if (role === "super_admin") return [...ACCESS_IDS];
  const allow = new Set<string>(ACCESS_IDS);
  if (!Array.isArray(raw)) return withLegacyOffice(defaultsForRole(role));
  const picked = withLegacyOffice([...new Set(
    raw.map((v) => String(v).trim()).filter((v): v is AccessId => allow.has(v)),
  )]);
  return picked.length ? picked : withLegacyOffice(defaultsForRole(role));
}

function publicAccount(account: Account) {
  const permissions = normalizePermissions(account.permissions, account.role);
  return {
    id: account.id,
    name: account.name,
    login: account.login,
    password: account.password,
    role: account.role,
    phone: account.phone || "",
    permissions,
  };
}
type Store = {
  secret: string;
  accounts: Account[];
  sessions: Record<string, string>;
  /** O‘chirilgan loginlar — SEED_AGENTS ularni qayta yaratmasin. */
  removedLogins?: string[];
  updatedAt?: number;
};

const sessions = new Map<string, string>();
let memory: Store | null = null;

function same(left: string, right: string) {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function normalizeStore(raw: Partial<Store> | null | undefined): Store | null {
  if (!raw?.secret || !Array.isArray(raw.accounts)) return null;
  return {
    secret: raw.secret,
    accounts: raw.accounts,
    sessions: raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {},
    removedLogins: Array.isArray(raw.removedLogins)
      ? [...new Set(raw.removedLogins.map((l) => String(l).toLowerCase().trim()).filter(Boolean))]
      : [],
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

/** Disk + DB farqida o‘chirishlar yo‘qolmasin: removedLogins birlashtiriladi. */
function mergeAccountStores(primary: Store, secondary: Store | null): Store {
  const removed = new Set<string>([
    ...(primary.removedLogins || []),
    ...(secondary?.removedLogins || []),
  ]);
  const byLogin = new Map<string, Account>();
  for (const a of secondary?.accounts || []) byLogin.set(a.login.toLowerCase(), a);
  for (const a of primary.accounts) byLogin.set(a.login.toLowerCase(), a);
  for (const login of removed) {
    if (login === "bordouzadmin") continue;
    byLogin.delete(login);
  }
  return {
    secret: primary.secret || secondary?.secret || randomBytes(24).toString("base64url"),
    accounts: [...byLogin.values()],
    sessions: { ...(secondary?.sessions || {}), ...primary.sessions },
    removedLogins: [...removed],
    updatedAt: Math.max(primary.updatedAt || 0, secondary?.updatedAt || 0, Date.now()),
  };
}

function writeFileOnly(store: Store) {
  memory = store;
  mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, FILE);
}

async function persistDb(store: Store) {
  await pool.query(
    "insert into partner_store (id, document, updated_at) values ('accounts', $1::jsonb, now()) on conflict (id) do update set document = excluded.document, updated_at = now()",
    [JSON.stringify(store)],
  );
}

function write(store: Store) {
  store.updatedAt = Date.now();
  writeFileOnly(store);
  void persistDb(store).catch(() => undefined);
}

async function writeReliable(store: Store) {
  store.updatedAt = Date.now();
  writeFileOnly(store);
  try {
    await persistDb(store);
  } catch {
    /* disk allaqachon yozilgan — keyingi hydrate merge qiladi */
  }
}

async function deactivateKpiAgent(login: string) {
  const key = login.trim().toLowerCase();
  if (!key || key === "bordouzadmin" || key === "ofis" || key === "vanseling") return;
  try {
    await pool.query(
      `update kpi_agents
       set status = 'inactive',
           notes = case
             when notes is null or notes = '' then 'removed-from-staff'
             when notes like '%removed-from-staff%' then notes
             else notes || ' | removed-from-staff'
           end
       where lower(login) = $1 and status <> 'inactive'`,
      [key],
    );
  } catch {
    /* KPI jadvali bo‘lmasa ham xodim o‘chishi kerak */
  }
}

async function reactivateKpiAgent(login: string) {
  const key = login.trim().toLowerCase();
  if (!key) return;
  try {
    await pool.query(
      `update kpi_agents
       set status = 'active',
           notes = replace(replace(coalesce(notes, ''), ' | removed-from-staff', ''), 'removed-from-staff', '')
       where lower(login) = $1 and status = 'inactive'`,
      [key],
    );
  } catch {
    /* ignore */
  }
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
    const res = await pool.query<{ document: Partial<Store>; updated_at: Date }>(
      "select document, updated_at from partner_store where id = 'accounts'",
    );
    const remoteRaw = res.rows[0]?.document;
    const remoteUpdated = res.rows[0]?.updated_at ? new Date(res.rows[0].updated_at).getTime() : 0;
    const remote = normalizeStore(remoteRaw);
    if (remote) remote.updatedAt = Math.max(remote.updatedAt || 0, remoteUpdated);

    let disk: Store | null = null;
    try {
      disk = normalizeStore(JSON.parse(readFileSync(FILE, "utf8")) as Partial<Store>);
      if (disk) {
        const mtime = statSync(FILE).mtimeMs;
        disk.updatedAt = Math.max(disk.updatedAt || 0, mtime);
      }
    } catch {
      disk = null;
    }

    if (remote && disk) {
      // Yangiroq manba asosiy; removedLogins ikkalasidan birlashadi.
      const primary = (disk.updatedAt || 0) >= (remote.updatedAt || 0) ? disk : remote;
      const secondary = primary === disk ? remote : disk;
      memory = mergeAccountStores(primary, secondary);
    } else if (remote) {
      memory = remote;
    } else if (disk) {
      memory = disk;
    } else {
      memory = readDisk();
    }

    ensureAdmin(memory);
    for (const [token, login] of Object.entries(memory.sessions)) sessions.set(token, login);
    await writeReliable(memory);
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
    const parsed = normalizeStore(JSON.parse(readFileSync(FILE, "utf8")) as Partial<Store>);
    if (parsed) return parsed;
  } catch {
    /* first run */
  }
  const store: Store = {
    secret: randomBytes(24).toString("base64url"),
    accounts: [{ id: "admin", name: "Administrator", login: "bordouzadmin", password: "2026@admin", role: "super_admin" }],
    sessions: {},
    removedLogins: [],
    updatedAt: Date.now(),
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
  if (!Array.isArray(store.removedLogins)) {
    store.removedLogins = [];
    changed = true;
  }
  const removed = new Set(store.removedLogins.map((l) => l.toLowerCase()));
  const before = store.accounts.length;
  store.accounts = store.accounts.filter(
    (a) => a.login.toLowerCase() === "bordouzadmin" || !removed.has(a.login.toLowerCase()),
  );
  if (store.accounts.length !== before) changed = true;

  const admin = store.accounts.find((account) => account.login === "bordouzadmin");
  if (admin) {
    // Parolni majburan qayta yozmaymiz — admin o‘zgartirgan bo‘lsa saqlanadi.
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
    if (removed.has(login.toLowerCase())) continue;
    const existing = store.accounts.find((a) => a.login.toLowerCase() === login);
    if (!existing) {
      store.accounts.push({
        id: `agent-${login}`,
        name,
        login,
        password: defaultPassword,
        role: "agent",
        phone: "",
        permissions: defaultsForRole("agent"),
      });
      changed = true;
    } else if (existing.password === "1234") {
      existing.password = defaultPassword;
      changed = true;
    }
  }
  return changed;
}

function markRemovedLogin(store: Store, login: string) {
  const key = login.trim().toLowerCase();
  if (!key) return;
  if (!Array.isArray(store.removedLogins)) store.removedLogins = [];
  if (!store.removedLogins.includes(key)) store.removedLogins.push(key);
}

function clearRemovedLogin(store: Store, login: string) {
  const key = login.trim().toLowerCase();
  if (!Array.isArray(store.removedLogins) || !key) return;
  store.removedLogins = store.removedLogins.filter((l) => l !== key);
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
  if (
    current.role !== "super_admin"
    && current.role !== "manager"
    && current.role !== "sales_admin"
    && current.role !== "warehouse_manager"
    && current.role !== "warehouse_staff"
  ) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return current;
}

/** Xodimlar bo‘limini boshqarish — faqat employees ruxsati yoki rahbar. */
function requireStaffManager(req: Request, res: Response): Account | null {
  const current = actor(req);
  if (!current) {
    res.status(401).json({ error: "invalid" });
    return null;
  }
  const perms = normalizePermissions(current.permissions, current.role);
  if (
    current.role === "super_admin"
    || current.role === "manager"
    || perms.includes("employees")
  ) {
    return current;
  }
  res.status(403).json({ error: "Xodimlar bo‘limiga ruxsat yo‘q." });
  return null;
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
  const permissions = normalizePermissions(account.permissions, account.role);
  // Login paytida saqlangan ruxsatlarni ham yangilab qo‘yamiz (eski akkauntlar).
  if (!Array.isArray(account.permissions) || account.permissions.length === 0) {
    account.permissions = permissions;
    write(store);
  }
  res.json({
    token,
    name: account.name,
    login: account.login,
    role: account.role,
    permissions,
  });
});

router.get("/local-accounts", (req, res) => {
  if (!requireStaffManager(req, res)) return;
  const store = read();
  if (ensureAdmin(store)) write(store);
  res.json(store.accounts.map(publicAccount));
});

router.post("/local-accounts", async (req, res) => {
  if (!requireStaffManager(req, res)) return;
  const login = String(req.body?.login ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const name = String(req.body?.name ?? "").trim() || login;
  const phone = String(req.body?.phone ?? "").trim();
  const role = normalizeRole(String(req.body?.role ?? ""));
  if (!login || password.length < 4 || !role) {
    res.status(400).json({ error: "Login, parol (min 4) va lavozim majburiy." });
    return;
  }
  const store = read();
  if (store.accounts.some((account) => account.login.toLowerCase() === login)) {
    res.status(409).json({ error: "Bu login band." });
    return;
  }
  clearRemovedLogin(store, login);
  const permissions = normalizePermissions(req.body?.permissions, role);
  store.accounts.push({ id: randomUUID(), name, login, password, role, phone, permissions });
  await writeReliable(store);
  await reactivateKpiAgent(login);
  res.status(201).json(store.accounts.map(publicAccount));
});

router.patch("/local-accounts/:id", async (req, res) => {
  if (!requireStaffManager(req, res)) return;
  const store = read();
  const target = store.accounts.find((account) => account.id === req.params.id);
  if (!target) {
    res.status(404).json({ error: "Xodim topilmadi." });
    return;
  }
  if (target.login === "bordouzadmin") {
    if (req.body?.name) target.name = String(req.body.name).trim() || target.name;
    target.role = "super_admin";
    target.permissions = [...ACCESS_IDS];
    await writeReliable(store);
    res.json(store.accounts.map(publicAccount));
    return;
  }
  const nextLogin = req.body?.login ? String(req.body.login).trim().toLowerCase() : target.login;
  if (nextLogin !== target.login && store.accounts.some((a) => a.id !== target.id && a.login.toLowerCase() === nextLogin)) {
    res.status(409).json({ error: "Bu login band." });
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
  if (req.body?.permissions != null) {
    target.permissions = normalizePermissions(req.body.permissions, target.role);
  }
  // Rol o‘zgarganda ruxsatlarni avtomatik reset qilmaymiz —
  // ular alohida «Ruxsatlar» orqali boshqariladi.
  if (req.body?.password && String(req.body.password).length >= 4) {
    target.password = String(req.body.password);
    forgetLogin(oldLogin);
  }
  await writeReliable(store);
  res.json(store.accounts.map(publicAccount));
});

router.delete("/local-accounts/:id", async (req, res) => {
  const current = requireStaffManager(req, res);
  if (!current) return;
  const store = read();
  const target = store.accounts.find((account) => account.id === req.params.id);
  if (!target || target.id === current.id || target.login === "bordouzadmin") {
    res.status(400).json({ error: "Bu xodimni o‘chirib bo‘lmaydi." });
    return;
  }
  markRemovedLogin(store, target.login);
  store.accounts = store.accounts.filter((account) => account.id !== target.id);
  await writeReliable(store);
  forgetLogin(target.login);
  await deactivateKpiAgent(target.login);
  res.json(store.accounts.map(publicAccount));
});

export default router;
