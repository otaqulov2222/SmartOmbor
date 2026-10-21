import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pool } from "@workspace/db";
import { dataFile } from "./data-dir";
import { logger } from "./logger";

export type ColorLine = { name: string; quantity: number };

export type ShipmentLine = {
  id: string;
  factoryCode: string;
  sectionCode: string;
  productCode: string;
  model: string;
  size: string;
  pairs: number;
  boxes: number;
  quantity: number;
  price: number;
  priceType: string;
  colors: ColorLine[];
  note: string;
  productId: string | null;
  productName: string | null;
};

export type Shipment = {
  id: string;
  number: string;
  factoryId: string;
  date: string;
  status: "sent" | "accepted" | "declined";
  note: string;
  lines: ShipmentLine[];
  createdAt: string;
  moyskladId: string | null;
  moyskladNumber: string | null;
};

export type PartnerAccount = {
  id: string;
  name: string;
  code: string;
  catalogName: string;
  login: string;
  passwordHash: string;
  salt: string;
  passwordPlain: string | null;
  active: boolean;
  createdAt: string;
  counterpartyId: string | null;
  counterpartyName: string | null;
};

type Session = { token: string; factoryId: string; expiresAt: string };

type Store = {
  accounts: PartnerAccount[];
  shipments: Shipment[];
  sessions: Session[];
};

const filePath = dataFile("partners.json");
let memory: Store | null = null;

function emptyStore(): Store {
  return { accounts: [], shipments: [], sessions: [] };
}

function normalizeStore(value: unknown): Store {
  const parsed = value && typeof value === "object" ? value as Partial<Store> : {};
  return {
    accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
    shipments: Array.isArray(parsed.shipments) ? parsed.shipments : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
  };
}

function readFileStore(): Store {
  try {
    return normalizeStore(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return emptyStore();
  }
}

function writeFileStore(store: Store) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, filePath);
}

async function persistStore(store: Store) {
  await pool.query(
    "insert into partner_store (id, document, updated_at) values ('main', $1::jsonb, now()) on conflict (id) do update set document = excluded.document, updated_at = now()",
    [JSON.stringify(store)],
  );
}

export async function hydratePartners() {
  await pool.query(`
    create table if not exists partner_store (
      id text primary key,
      document jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
  const result = await pool.query("select document from partner_store where id = 'main'");
  const remote = result.rows[0] ? normalizeStore(result.rows[0].document) : null;
  const hasRemote = Boolean(remote && (remote.accounts.length || remote.shipments.length || remote.sessions.length));
  memory = hasRemote && remote ? remote : readFileStore();
  writeFileStore(memory);
  if (!hasRemote) await persistStore(memory);
  logger.info({ accounts: memory.accounts.length, shipments: memory.shipments.length }, "Partner data loaded");
}

function load(): Store {
  memory ??= readFileStore();
  return memory;
}

function save(store: Store) {
  memory = store;
  writeFileStore(store);
  void persistStore(store).catch((error: unknown) => {
    logger.warn({ err: error instanceof Error ? error.message : "partner-store" }, "Partner data was not saved to the database");
  });
}

function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 32).toString("hex");
  return { salt, hash };
}

function passwordMatches(password: string, salt: string, expected: string) {
  const actual = scryptSync(password, salt, 32);
  const stored = Buffer.from(expected, "hex");
  if (actual.length !== stored.length) return false;
  return timingSafeEqual(actual, stored);
}

export function publicAccount(account: PartnerAccount) {
  return {
    id: account.id,
    name: account.name,
    code: account.code,
    catalogName: account.catalogName,
    login: account.login,
    active: account.active,
    createdAt: account.createdAt,
    counterpartyId: account.counterpartyId || null,
    counterpartyName: account.counterpartyName || null,
  };
}

export function listAccounts() {
  return load().accounts.map(account => ({ ...publicAccount(account), password: account.passwordPlain || null }));
}

export function getAccount(id: string) {
  return load().accounts.find((account) => account.id === id) ?? null;
}

export function createAccount(input: { name: string; code: string; catalogName: string; login: string; password: string }) {
  const store = load();
  const login = input.login.trim().toLowerCase();
  const code = input.code.trim().toUpperCase();
  if (store.accounts.some((account) => account.login === login)) {
    throw Object.assign(new Error("login_taken"), { status: 409 });
  }
  if (store.accounts.some((account) => account.code === code)) {
    throw Object.assign(new Error("code_taken"), { status: 409 });
  }
  const { salt, hash } = hashPassword(input.password);
  const account: PartnerAccount = {
    id: randomBytes(8).toString("hex"),
    name: input.name.trim(),
    code,
    catalogName: input.catalogName.trim() || input.name.trim(),
    login,
    passwordHash: hash,
    salt,
    passwordPlain: input.password,
    active: true,
    createdAt: new Date().toISOString(),
    counterpartyId: null,
    counterpartyName: null,
  };
  store.accounts.push(account);
  save(store);
  return { account: publicAccount(account), password: input.password };
}

export function updateAccount(id: string, input: { name: string; code: string; login: string; password?: string; counterpartyId?: string | null; counterpartyName?: string | null }) {
  const store = load();
  const account = store.accounts.find((item) => item.id === id);
  if (!account) throw Object.assign(new Error("not_found"), { status: 404 });
  const login = input.login.trim().toLowerCase();
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  if (!name || !code || !login) throw Object.assign(new Error("required"), { status: 400 });
  if (store.accounts.some((item) => item.id !== id && item.login === login)) {
    throw Object.assign(new Error("login_taken"), { status: 409 });
  }
  if (store.accounts.some((item) => item.id !== id && item.code === code)) {
    throw Object.assign(new Error("code_taken"), { status: 409 });
  }
  account.name = name;
  account.catalogName = name;
  account.code = code;
  account.login = login;
  if ("counterpartyId" in input) {
    account.counterpartyId = input.counterpartyId?.trim() || null;
    account.counterpartyName = input.counterpartyName?.trim() || null;
  }
  const password = input.password?.trim() || "";
  if (password) {
    if (password.length < 6) throw Object.assign(new Error("password_short"), { status: 400 });
    const next = hashPassword(password);
    account.passwordHash = next.hash;
    account.salt = next.salt;
    account.passwordPlain = password;
    store.sessions = store.sessions.filter((session) => session.factoryId !== id);
  }
  save(store);
  return { account: { ...publicAccount(account), password: account.passwordPlain }, password: account.passwordPlain };
}

export function deleteAccount(id: string) {
  const store = load();
  const account = store.accounts.find((item) => item.id === id);
  if (!account) throw Object.assign(new Error("not_found"), { status: 404 });
  store.accounts = store.accounts.filter((item) => item.id !== id);
  store.shipments = store.shipments.filter((item) => item.factoryId !== id);
  store.sessions = store.sessions.filter((item) => item.factoryId !== id);
  save(store);
  return { ok: true };
}

export function resetPassword(id: string, password: string) {
  const store = load();
  const account = store.accounts.find((item) => item.id === id);
  if (!account) throw Object.assign(new Error("not_found"), { status: 404 });
  const next = hashPassword(password);
  account.passwordHash = next.hash;
  account.salt = next.salt;
  account.passwordPlain = password;
  store.sessions = store.sessions.filter((session) => session.factoryId !== id);
  save(store);
  return { account: publicAccount(account), password };
}

export function loginFactory(login: string, password: string) {
  const store = load();
  const account = store.accounts.find((item) => item.login === login.trim().toLowerCase() && item.active);
  if (!account || !passwordMatches(password, account.salt, account.passwordHash)) {
    throw Object.assign(new Error("invalid_login"), { status: 401 });
  }
  const token = randomBytes(24).toString("hex");
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  store.sessions = store.sessions.filter((session) => session.expiresAt > new Date().toISOString() && session.factoryId !== account.id);
  store.sessions.push({ token, factoryId: account.id, expiresAt: expires });
  save(store);
  return { token, account: publicAccount(account) };
}

export function accountFromToken(token: string) {
  if (!token) return null;
  const store = load();
  const session = store.sessions.find((item) => item.token === token && item.expiresAt > new Date().toISOString());
  if (!session) return null;
  const account = store.accounts.find((item) => item.id === session.factoryId && item.active);
  return account ? publicAccount(account) : null;
}

function billableUnits(line: Pick<ShipmentLine, "pairs" | "boxes" | "quantity" | "colors">) {
  const pack = line.pairs > 0 ? line.pairs : 0;
  const colors = Array.isArray(line.colors) ? line.colors.filter((color) => color.name && color.quantity > 0) : [];
  if (pack > 0 && colors.length) return colors.reduce((sum, color) => sum + color.quantity * pack, 0);
  if (pack > 0 && line.boxes > 0) return pack * line.boxes;
  if (line.quantity > 0) return line.quantity;
  return pack;
}

function lineAmount(line: ShipmentLine) {
  return Math.round(billableUnits(line) * line.price);
}

export function shipmentView(shipment: Shipment) {
  const lines = Array.isArray(shipment.lines) ? shipment.lines : [];
  const pairs = lines.reduce((sum, line) => sum + billableUnits(line), 0);
  const boxes = lines.reduce((sum, line) => sum + (line.boxes || 0), 0);
  const amount = lines.reduce((sum, line) => sum + lineAmount(line), 0);
  return { ...shipment, lines, pairs, boxes, amount };
}

export function listShipments(factoryId?: string) {
  return load()
    .shipments.filter((shipment) => !factoryId || shipment.factoryId === factoryId)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .map(shipmentView);
}

function cleanLine(raw: Partial<ShipmentLine>, factoryCode: string): ShipmentLine {
  const colors = Array.isArray(raw.colors)
    ? raw.colors
        .map((color) => ({ name: String(color?.name ?? "").trim().toLocaleUpperCase("ru-RU"), quantity: Math.max(0, Number(color?.quantity) || 0) }))
        .filter((color) => color.name && color.quantity > 0)
    : [];
  const pairs = Math.max(0, Number(raw.pairs) || 0);
  const colorQty = colors.reduce((sum, color) => sum + color.quantity, 0);
  const quantity = Math.max(0, Number(raw.quantity) || 0) || (pairs > 0 ? 0 : colorQty);
  return {
    id: randomBytes(6).toString("hex"),
    factoryCode: String(raw.factoryCode || factoryCode).trim().toUpperCase(),
    sectionCode: String(raw.sectionCode ?? "").trim(),
    productCode: String(raw.productCode ?? "").trim(),
    model: String(raw.model ?? "").trim(),
    size: String(raw.size ?? "").trim(),
    pairs,
    boxes: Math.max(0, Number(raw.boxes) || 0),
    quantity,
    price: Math.max(0, Number(raw.price) || 0),
    priceType: ["Exclusive", "Premium", "Standard"].includes(String(raw.priceType ?? "")) ? String(raw.priceType) : "",
    colors,
    note: String(raw.note ?? "").trim(),
    productId: raw.productId ? String(raw.productId) : null,
    productName: raw.productId && raw.productName ? String(raw.productName).trim() : null,
  };
}

export function createShipment(factoryId: string, input: { date?: string; note?: string; lines: Partial<ShipmentLine>[] }) {
  const store = load();
  const account = store.accounts.find((item) => item.id === factoryId);
  if (!account) throw Object.assign(new Error("not_found"), { status: 404 });
  const lines = (input.lines ?? []).map((line) => cleanLine(line, account.code)).filter((line) => line.pairs > 0 || line.boxes > 0 || line.quantity > 0);
  if (!lines.length) throw Object.assign(new Error("empty"), { status: 400 });
  const seq = store.shipments.filter((item) => item.factoryId === factoryId).length + 1;
  const shipment: Shipment = {
    id: randomBytes(8).toString("hex"),
    number: `${account.code}-${String(seq).padStart(3, "0")}`,
    factoryId,
    date: input.date || new Date().toISOString().slice(0, 10),
    status: "sent",
    note: String(input.note ?? "").trim(),
    lines,
    createdAt: new Date().toISOString(),
    moyskladId: null,
    moyskladNumber: null,
  };
  store.shipments.push(shipment);
  save(store);
  return shipmentView(shipment);
}

export function reviseShipment(factoryId: string, id: string, input: { date?: string; note?: string; lines: Partial<ShipmentLine>[] }) {
  const store = load();
  const shipment = store.shipments.find((item) => item.id === id && item.factoryId === factoryId);
  if (!shipment) throw Object.assign(new Error("not_found"), { status: 404 });
  if (shipment.moyskladId || shipment.status === "accepted") throw Object.assign(new Error("posted"), { status: 409 });
  const updated = updateShipment(id, input);
  if (shipment.status === "declined") return setShipmentStatus(id, "sent");
  return updated;
}

export function updateShipment(id: string, input: { date?: string; note?: string; lines: Partial<ShipmentLine>[] }) {
  const store = load();
  const shipment = store.shipments.find((item) => item.id === id);
  if (!shipment) throw Object.assign(new Error("not_found"), { status: 404 });
  const account = store.accounts.find((item) => item.id === shipment.factoryId);
  if (!account) throw Object.assign(new Error("not_found"), { status: 404 });
  const lines = (input.lines ?? []).map((line) => {
    const next = cleanLine(line, account.code);
    const previous = shipment.lines.find((item) => item.id === line.id);
    if (previous) next.id = previous.id;
    if (!previous?.productId) return next;
    const same = previous.factoryCode === next.factoryCode && previous.sectionCode === next.sectionCode && previous.productCode === next.productCode && previous.model === next.model && previous.size === next.size;
    if (!same) return next;
    next.id = previous.id;
    next.productId = previous.productId;
    next.productName = previous.productName;
    return next;
  }).filter((line) => line.productCode || line.pairs > 0 || line.boxes > 0 || line.quantity > 0);
  if (!lines.length) throw Object.assign(new Error("empty"), { status: 400 });
  if (shipment.moyskladId) throw Object.assign(new Error("posted"), { status: 409 });
  if (input.date) shipment.date = String(input.date).slice(0, 10);
  shipment.note = String(input.note ?? shipment.note).trim();
  shipment.lines = lines;
  save(store);
  return shipmentView(shipment);
}

export function deleteShipment(id: string) {
  const store = load();
  const shipment = store.shipments.find((item) => item.id === id);
  if (!shipment) throw Object.assign(new Error("not_found"), { status: 404 });
  if (shipment.moyskladId) throw Object.assign(new Error("posted"), { status: 409 });
  const before = store.shipments.length;
  store.shipments = store.shipments.filter((item) => item.id !== id);
  if (store.shipments.length === before) throw Object.assign(new Error("not_found"), { status: 404 });
  save(store);
  return { ok: true };
}

export function linkExactShipmentLines(factoryId: string, match: (code: string) => { id: string; name: string } | null) {
  const store = load();
  let changed = false;
  for (const shipment of store.shipments) {
    if (shipment.factoryId !== factoryId || shipment.moyskladId) continue;
    for (const line of shipment.lines) {
      if (line.productId || !line.productCode.trim()) continue;
      const product = match(line.productCode);
      if (!product) continue;
      line.productId = product.id;
      line.productName = product.name;
      changed = true;
    }
  }
  if (changed) save(store);
}

export function linkShipmentLine(shipmentId: string, lineId: string, product: { id: string; name: string } | null) {
  const store = load();
  const shipment = store.shipments.find((item) => item.id === shipmentId);
  if (!shipment) throw Object.assign(new Error("not_found"), { status: 404 });
  if (shipment.moyskladId) throw Object.assign(new Error("posted"), { status: 409 });
  const line = shipment.lines.find((item) => item.id === lineId);
  if (!line) throw Object.assign(new Error("not_found"), { status: 404 });
  line.productId = product?.id ?? null;
  line.productName = product?.name ?? null;
  save(store);
  return shipmentView(shipment);
}

export function clearShipmentPosted(shipmentId: string) {
  const store = load();
  const shipment = store.shipments.find((item) => item.id === shipmentId);
  if (!shipment) throw Object.assign(new Error("not_found"), { status: 404 });
  shipment.moyskladId = null;
  shipment.moyskladNumber = null;
  save(store);
  return shipmentView(shipment);
}

export function markShipmentPosted(shipmentId: string, posted: { id: string; number: string }) {
  const store = load();
  const shipment = store.shipments.find((item) => item.id === shipmentId);
  if (!shipment) throw Object.assign(new Error("not_found"), { status: 404 });
  shipment.moyskladId = posted.id;
  shipment.moyskladNumber = posted.number;
  shipment.status = "accepted";
  save(store);
  return shipmentView(shipment);
}

export function setShipmentStatus(id: string, status: "sent" | "accepted" | "declined") {
  const store = load();
  const shipment = store.shipments.find((item) => item.id === id);
  if (!shipment) throw Object.assign(new Error("not_found"), { status: 404 });
  if (shipment.moyskladId && status !== "accepted") throw Object.assign(new Error("posted"), { status: 409 });
  shipment.status = status;
  save(store);
  return shipmentView(shipment);
}

export function suggestPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(10);
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
}
