import { moyskladToken } from "./connection";

const BASE = "https://api.moysklad.ru/api/remap/1.2";

export class MoySkladError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
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

export async function moysklad<T>(path: string): Promise<T> {
  const token = moyskladToken();
  if (!token) {
    throw new MoySkladError("MOYSKLAD_TOKEN is not set", 503);
  }

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
    throw new MoySkladError(
      `MoySklad ${response.status}: ${body.slice(0, 280)}`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

export async function moyskladAll<T>(path: string): Promise<{ rows: T[]; size: number }> {
  const rows: T[] = [];
  let offset = 0;
  const limit = 1000;
  let size = 0;

  for (;;) {
    const joiner = path.includes("?") ? "&" : "?";
    const page = await moysklad<ListResponse<T>>(
      `${path}${joiner}limit=${limit}&offset=${offset}`,
    );
    size = page.meta.size;
    rows.push(...page.rows);
    if (page.rows.length === 0 || rows.length >= size) break;
    offset += limit;
  }

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
