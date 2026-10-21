import { moyskladToken } from "./connection";
import { logger } from "./logger";

const BASE = "https://api.moysklad.ru/api/remap/1.2";

export class MoySkladError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly moyCode?: number,
    readonly parameter?: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

export function permissionDenied(error: unknown): boolean {
  if (!(error instanceof MoySkladError)) return false;
  if (error.moyCode === 1016 || error.moyCode === 1017 || error.moyCode === 1018 || error.moyCode === 1061) return true;
  return error.status === 403 || /нет прав|доступ запрещ|ruxsat yetarli emas|API ruxsati yo‘q/i.test(error.message);
}

export function moyskladConfigured(): boolean {
  return Boolean(moyskladToken());
}

interface ListMeta {
  size: number;
  limit: number;
  offset: number;
}

interface ListResponse<T> {
  meta: ListMeta;
  rows: T[];
}

export async function moyskladBinary(url: string): Promise<{ type: string; body: Buffer }> {
  const token = moyskladToken();
  if (!token) throw new MoySkladError("MOYSKLAD_TOKEN is not set", 503);
  const absolute = url.startsWith("http") ? url : `https://api.moysklad.ru${url}`;
  const first = await fetch(absolute, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
  });
  const location = first.status >= 300 && first.status < 400 ? first.headers.get("location") : null;
  const response = location ? await fetch(location, { method: "GET" }) : first;
  if (!response.ok) {
    throw new MoySkladError(`MoySklad image ${response.status}`, response.status);
  }
  return {
    type: response.headers.get("content-type") || "image/jpeg",
    body: Buffer.from(await response.arrayBuffer()),
  };
}

export async function moyskladSend<T>(path: string, body?: unknown, method: "POST" | "PUT" | "DELETE" = "POST"): Promise<T> {
  const token = moyskladToken();
  if (!token) throw new MoySkladError("MOYSKLAD_TOKEN is not set", 503);
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await takeSlot();
    try {
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json;charset=utf-8",
          ...(method === "DELETE" ? {} : { "Content-Type": "application/json" }),
        },
        ...(method === "DELETE" ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw parseMoySkladFailure(response.status, text, path, true);
      }
      if (response.status === 204) return {} as T;
      return (await response.json()) as T;
    } catch (error) {
      last = error;
      const retry = networkFailure(error) || temporaryMoySklad(error) || (error instanceof MoySkladError && error.status === 429);
      if (!retry || attempt === 5) throw error;
    } finally {
      freeSlot();
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelay(last, attempt)));
  }
  throw last;
}

const MAX_IN_FLIGHT = 2;
let inFlight = 0;
const waiters: Array<() => void> = [];

function takeSlot(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      inFlight += 1;
      resolve();
    });
  });
}

function freeSlot() {
  inFlight -= 1;
  const next = waiters.shift();
  if (next) next();
}

function networkFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof MoySkladError) return false;
  const cause = error.cause as { code?: string } | undefined;
  return error.message === "fetch failed" || cause?.code === "UND_ERR_CONNECT_TIMEOUT" || cause?.code === "ECONNRESET" || cause?.code === "ETIMEDOUT";
}

function temporaryMoySklad(error: unknown): boolean {
  return error instanceof MoySkladError && (error.status === 502 || error.status === 503 || error.status === 504);
}

function retryDelay(error: unknown, attempt: number) {
  if (error instanceof MoySkladError && error.status === 429) return 3000 * (attempt + 1);
  return 500 * (attempt + 1);
}

function parseMoySkladFailure(status: number, body: string, path?: string, log = false): MoySkladError {
  if (status === 429) {
    return new MoySkladError("MoySklad so‘rov limiti. 20 soniyadan keyin bir marta qayta bosing.", 429, undefined, undefined, path);
  }
  if (status === 502 || status === 503 || status === 504) {
    return new MoySkladError("MoySklad vaqtincha javob bermadi", status, undefined, undefined, path);
  }
  const trimmed = body.replace(/\s+/g, " ").trim();
  if (!trimmed || /<html|<!doctype/i.test(trimmed)) {
    return new MoySkladError(`MoySklad ${status}`, status, undefined, undefined, path);
  }
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ code?: number; error?: string; parameter?: string }> };
    const first = parsed.errors?.[0];
    const code = first?.code;
    const parameter = first?.parameter?.trim() || undefined;
    const text = first?.error?.trim();
    if (log) logger.warn({ path, status, moyCode: code, parameter }, "MoySklad write failed");
    let message = text ? text.slice(0, 160) : `MoySklad ${status}`;
    if (code === 1061) message = "MoySklad API ruxsati yo‘q";
    else if (code === 1016) message = "MoySkladda ruxsat yetarli emas";
    else if (code === 1017) message = "MoySkladda tahrirlashga ruxsat yo‘q";
    else if (code === 1018) message = parameter
      ? `MoySkladda ${parameter} yaratishga ruxsat yo‘q`
      : "MoySkladda yangi obyekt yaratishga ruxsat yo‘q";
    return new MoySkladError(message, status, code, parameter, path);
  } catch {
    return new MoySkladError(`MoySklad ${status}: ${trimmed.slice(0, 160)}`, status, undefined, undefined, path);
  }
}

export async function moysklad<T>(path: string): Promise<T> {
  const token = moyskladToken();
  if (!token) {
    throw new MoySkladError("MOYSKLAD_TOKEN is not set", 503);
  }

  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await takeSlot();
    try {
      const response = await fetch(`${BASE}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json;charset=utf-8",
          "Accept-Encoding": "gzip",
        },
      });

      if (!response.ok) {
        const body = await response.text();
        throw parseMoySkladFailure(response.status, body, path);
      }

      return (await response.json()) as T;
    } catch (error) {
      last = error;
      const retry = networkFailure(error) || temporaryMoySklad(error) || (error instanceof MoySkladError && error.status === 429);
      if (!retry || attempt === 5) throw error;
    } finally {
      freeSlot();
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelay(last, attempt)));
  }
  throw last;
}

export async function moyskladAll<T>(path: string): Promise<{ rows: T[]; size: number }> {
  const limit = 1000;
  const joiner = path.includes("?") ? "&" : "?";
  const first = await moysklad<ListResponse<T>>(`${path}${joiner}limit=${limit}&offset=0`);
  const size = first.meta.size;
  const rows = [...first.rows];
  if (rows.length === 0 || rows.length >= size) return { rows, size };
  const offsets: number[] = [];
  for (let offset = limit; offset < size; offset += limit) offsets.push(offset);
  const rest = await Promise.all(
    offsets.map((offset) => moysklad<ListResponse<T>>(`${path}${joiner}limit=${limit}&offset=${offset}`)),
  );
  for (const page of rest) rows.push(...page.rows);
  return { rows, size };
}

export function idFromHref(href: string | undefined): string {
  if (!href) return "";
  const clean = href.split("?")[0] ?? href;
  return clean.split("/").pop() ?? "";
}

export function money(value: number | undefined | null): number | null {
  if (value == null || Number.isNaN(value)) return null;
  return Math.round(value) / 100;
}
