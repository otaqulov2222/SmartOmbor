import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./data-dir";

const FILE = dataFile("connection.json");
const BASE = "https://api.moysklad.ru/api/remap/1.2";

interface SavedConnection {
  token: string;
  companyName: string;
  savedAt: string;
}

let memory: SavedConnection | null | undefined;

function readFile(): SavedConnection | null {
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Partial<SavedConnection>;
    if (!parsed.token?.trim()) return null;
    return { token: parsed.token.trim(), companyName: parsed.companyName || "MoySklad", savedAt: parsed.savedAt || new Date().toISOString() };
  } catch {
    return null;
  }
}

function saved(): SavedConnection | null {
  if (memory === undefined) memory = readFile();
  return memory;
}

export function moyskladToken(): string | undefined {
  return saved()?.token || process.env.MOYSKLAD_TOKEN?.trim() || undefined;
}

export function connectionView() {
  const current = saved();
  if (current) {
    const tail = current.token.slice(-4);
    return { source: "saved" as const, companyName: current.companyName, masked: `•••• ${tail}`, savedAt: current.savedAt };
  }
  const envToken = process.env.MOYSKLAD_TOKEN?.trim();
  if (envToken) return { source: "environment" as const, companyName: null, masked: `•••• ${envToken.slice(-4)}`, savedAt: null };
  return { source: "none" as const, companyName: null, masked: null, savedAt: null };
}

export async function probeMoySklad(token: string): Promise<string> {
  const response = await fetch(`${BASE}/entity/organization?limit=1`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json;charset=utf-8",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error("rejected");
  const body = await response.json() as { rows?: Array<{ name?: string }> };
  return body.rows?.[0]?.name?.trim() || "MoySklad";
}

export function saveConnection(token: string, companyName: string) {
  const next = { token, companyName, savedAt: new Date().toISOString() };
  mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, FILE);
  memory = next;
}

export function clearConnection() {
  memory = null;
  try { unlinkSync(FILE); } catch { /* already absent */ }
}
