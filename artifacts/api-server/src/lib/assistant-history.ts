import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dataFile, dataDir } from "./data-dir";

const KEEP_MS = 10 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 80;
const MAX_MESSAGES = 200;
const FILE = "assistant-history.json";

export type HistoryFile = {
  id: string;
  name: string;
  mime: string;
  base64: string;
};

export type HistoryMsg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: number;
  tools?: Array<{ name: string; ok: boolean }>;
  files?: HistoryFile[];
};

export type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: HistoryMsg[];
};

export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  messageCount: number;
  preview: string;
};

type UserBucket = {
  messages?: HistoryMsg[];
  sessions?: ChatSession[];
};

type Store = {
  byUser: Record<string, UserBucket>;
};

function emptyStore(): Store {
  return { byUser: {} };
}

function load(): Store {
  const file = dataFile(FILE);
  if (!existsSync(file)) return emptyStore();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Store;
    if (!raw || typeof raw !== "object" || !raw.byUser) return emptyStore();
    return raw;
  } catch {
    return emptyStore();
  }
}

function save(store: Store) {
  try {
    mkdirSync(dataDir(), { recursive: true });
  } catch {
    /* ignore */
  }
  writeFileSync(dataFile(FILE), JSON.stringify(store), "utf8");
}

function userKey(login: string) {
  return String(login || "").trim().toLowerCase() || "unknown";
}

function newId() {
  return randomBytes(8).toString("hex");
}

function titleFrom(text: string) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "Yangi chat";
  const capped = clean.length > 42 ? `${clean.slice(0, 42)}…` : clean;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

function previewFrom(messages: HistoryMsg[]) {
  const last = [...messages].reverse().find((m) => String(m.content || "").trim());
  if (!last) return "";
  const clean = String(last.content).replace(/\s+/g, " ").trim();
  return clean.length > 64 ? `${clean.slice(0, 64)}…` : clean;
}

function toSummary(s: ChatSession): SessionSummary {
  return {
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    createdAt: s.createdAt,
    messageCount: (s.messages || []).length,
    preview: previewFrom(s.messages || []),
  };
}

function pruneSessions(sessions: ChatSession[], now = Date.now()): ChatSession[] {
  const min = now - KEEP_MS;
  return sessions
    .filter((s) => s && Number(s.updatedAt || s.createdAt) >= min)
    .map((s) => ({
      ...s,
      messages: (s.messages || [])
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
        .slice(-MAX_MESSAGES),
    }))
    .filter((s) => s.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS);
}

function migrateBucket(bucket: UserBucket | undefined, now = Date.now()): ChatSession[] {
  if (!bucket) return [];
  let sessions = Array.isArray(bucket.sessions) ? [...bucket.sessions] : [];
  if ((!sessions.length) && Array.isArray(bucket.messages) && bucket.messages.length) {
    const msgs = bucket.messages.filter((m) => m?.content?.trim());
    if (msgs.length) {
      const firstUser = msgs.find((m) => m.role === "user");
      sessions = [{
        id: newId(),
        title: titleFrom(firstUser?.content || msgs[0]?.content || "Chat"),
        createdAt: msgs[0]?.at || now,
        updatedAt: msgs[msgs.length - 1]?.at || now,
        messages: msgs.slice(-MAX_MESSAGES),
      }];
    }
  }
  return pruneSessions(sessions, now);
}

function ensureUser(store: Store, login: string): { key: string; sessions: ChatSession[] } {
  const key = userKey(login);
  const now = Date.now();
  const sessions = migrateBucket(store.byUser[key], now);
  store.byUser[key] = { sessions };
  return { key, sessions };
}

export function listAssistantSessions(login: string): SessionSummary[] {
  const store = load();
  const { key, sessions } = ensureUser(store, login);
  store.byUser[key] = { sessions };
  save(store);
  return sessions.map(toSummary);
}

export function getAssistantSession(login: string, sessionId: string): ChatSession | null {
  const store = load();
  const { key, sessions } = ensureUser(store, login);
  store.byUser[key] = { sessions };
  save(store);
  return sessions.find((s) => s.id === sessionId) || null;
}

export function createAssistantSession(login: string): ChatSession {
  const store = load();
  const now = Date.now();
  const { key, sessions } = ensureUser(store, login);
  const session: ChatSession = {
    id: newId(),
    title: "Yangi chat",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  // empty sessions are not persisted via prune — keep in memory response only
  store.byUser[key] = { sessions };
  save(store);
  return session;
}

export function mergeAssistantSessions(login: string): SessionSummary[] {
  const store = load();
  const now = Date.now();
  const { key, sessions } = ensureUser(store, login);
  if (sessions.length <= 1) {
    store.byUser[key] = { sessions };
    save(store);
    return sessions.map(toSummary);
  }
  const ordered = [...sessions].sort((a, b) => a.createdAt - b.createdAt);
  const first = ordered[0];
  const mergedMsgs = ordered
    .flatMap((s) => s.messages || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
    .slice(-MAX_MESSAGES);
  const firstUser = mergedMsgs.find((m) => m.role === "user");
  const merged: ChatSession = {
    id: first.id,
    title: titleFrom(firstUser?.content || first.title || "Chat"),
    createdAt: first.createdAt || mergedMsgs[0]?.at || now,
    updatedAt: mergedMsgs[mergedMsgs.length - 1]?.at || now,
    messages: mergedMsgs,
  };
  const next = pruneSessions([merged], now);
  store.byUser[key] = { sessions: next };
  save(store);
  return next.map(toSummary);
}

export function appendToSession(
  login: string,
  sessionId: string | null | undefined,
  items: Array<{
    role: "user" | "assistant";
    content: string;
    tools?: Array<{ name: string; ok: boolean }>;
    files?: HistoryFile[];
  }>,
  opts?: { forceNew?: boolean },
): { session: ChatSession; sessions: SessionSummary[] } {
  const store = load();
  const now = Date.now();
  const { key, sessions } = ensureUser(store, login);
  const forceNew = Boolean(opts?.forceNew);
  let session = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  // ChatGPT usuli: sessionId yo‘q bo‘lsa ham oxirgi chatga yozamiz — yangi faqat forceNew
  if (!session && !forceNew && sessions.length > 0) {
    session = sessions[0];
  }
  if (!session) {
    session = {
      id: newId(),
      title: "Yangi chat",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    sessions.unshift(session);
  }

  const stamped: HistoryMsg[] = items
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
    .map((m, i) => ({
      id: `${now}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      role: m.role,
      content: String(m.content).slice(0, 8000),
      at: now + i,
      tools: Array.isArray(m.tools) ? m.tools.slice(0, 20) : undefined,
      files: Array.isArray(m.files)
        ? m.files
          .filter((f) => f?.base64 && f?.name && String(f.base64).length < 2_500_000)
          .slice(0, 3)
          .map((f) => ({
            id: String(f.id || `${now}-f`),
            name: String(f.name).slice(0, 120),
            mime: String(f.mime || "application/pdf"),
            base64: String(f.base64),
          }))
        : undefined,
    }));

  session.messages = [...(session.messages || []), ...stamped].slice(-MAX_MESSAGES);
  session.updatedAt = now;
  const firstUser = session.messages.find((m) => m.role === "user");
  if (firstUser) session.title = titleFrom(firstUser.content);

  const next = pruneSessions(
    sessions.map((s) => (s.id === session!.id ? session! : s)),
    now,
  );
  store.byUser[key] = { sessions: next };
  for (const [k, row] of Object.entries(store.byUser)) {
    if (k === key) continue;
    store.byUser[k] = { sessions: migrateBucket(row, now) };
    if (!store.byUser[k].sessions?.length) delete store.byUser[k];
  }
  save(store);
  const fresh = next.find((s) => s.id === session!.id) || session;
  return {
    session: fresh,
    sessions: next.map(toSummary),
  };
}

export function deleteAssistantSession(login: string, sessionId: string) {
  const store = load();
  const { key, sessions } = ensureUser(store, login);
  store.byUser[key] = { sessions: sessions.filter((s) => s.id !== sessionId) };
  save(store);
}

export function clearAssistantHistory(login: string) {
  const store = load();
  delete store.byUser[userKey(login)];
  save(store);
}

export function historyRetentionDays() {
  return 10;
}

export function getAssistantHistory(login: string): HistoryMsg[] {
  const sessions = listAssistantSessions(login);
  if (!sessions.length) return [];
  const full = getAssistantSession(login, sessions[0].id);
  return full?.messages || [];
}

export function appendAssistantHistory(
  login: string,
  items: Array<{ role: "user" | "assistant"; content: string; tools?: Array<{ name: string; ok: boolean }> }>,
): HistoryMsg[] {
  return appendToSession(login, null, items).session.messages;
}
