import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pool } from "@workspace/db";
import { dataFile } from "./data-dir";

const DEFAULT_OFFICE_LAT = Number(process.env.OFFICE_LAT) || 41.258556;
const DEFAULT_OFFICE_LNG = Number(process.env.OFFICE_LNG) || 69.150964;
const DEFAULT_OFFICE_RADIUS_M = Math.max(30, Number(process.env.OFFICE_RADIUS_M) || 150);
/** Binoda LTE GPS ko‘pincha 150–400 m accuracy beradi — 150 hard-limit ofisda blok qilardi. */
const DEFAULT_OFFICE_ACCURACY_M = Math.max(50, Number(process.env.OFFICE_ACCURACY_M) || 500);
/** Keldim → Ketdim orasidagi minimal vaqt (tasodifiy ikki marta bosish). */
const MIN_SHIFT_MS = 60_000;
/** Bir xodim uchun parallel punch so‘rovlarini bloklash. */
const punchLocks = new Set<string>();

export type OfficeSite = {
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  accuracyM: number;
  start: string;
  end: string;
};

function defaultSite(): OfficeSite {
  return {
    name: "Asosiy ofis",
    lat: DEFAULT_OFFICE_LAT,
    lng: DEFAULT_OFFICE_LNG,
    radiusM: DEFAULT_OFFICE_RADIUS_M,
    accuracyM: DEFAULT_OFFICE_ACCURACY_M,
    start: "09:00",
    end: "18:00",
  };
}

/** @deprecated — officeSite() dan foydalaning */
export const OFFICE_LAT = DEFAULT_OFFICE_LAT;
/** @deprecated — officeSite() dan foydalaning */
export const OFFICE_LNG = DEFAULT_OFFICE_LNG;
/** @deprecated — officeSite() dan foydalaning */
export const OFFICE_RADIUS_M = DEFAULT_OFFICE_RADIUS_M;
/** @deprecated — officeSite() dan foydalaning */
export const OFFICE_ACCURACY_M = DEFAULT_OFFICE_ACCURACY_M;

export type PunchMethod = "face" | "qr";
export type PunchKind = "in" | "out";
export type OfficeTaskStatus = "assigned" | "accepted" | "progress" | "review" | "done";
const TASK_STATUSES: OfficeTaskStatus[] = ["assigned", "accepted", "progress", "review", "done"];
export type OfficePriority = "low" | "normal" | "high" | "urgent";
export type OfficeExcuse = "" | "off" | "sick" | "vacation" | "trip" | "permit";
export type TabelStatus = "present" | "late" | "out_missing" | "absent" | "off" | "sick" | "vacation" | "trip" | "permit";
const EXCUSES: OfficeExcuse[] = ["", "off", "sick", "vacation", "trip", "permit"];

export type OfficePunch = {
  id: string;
  accountId: string;
  date: string;
  inAt: string | null;
  outAt: string | null;
  inMethod: PunchMethod | null;
  outMethod: PunchMethod | null;
  inLat: number | null;
  inLng: number | null;
  outLat: number | null;
  outLng: number | null;
  note: string;
  excuse: OfficeExcuse;
};

export type OfficeTask = {
  id: string;
  title: string;
  description: string;
  assignedTo: string[];
  dueDate: string;
  dueTime: string;
  priority: OfficePriority;
  status: OfficeTaskStatus;
  remind: boolean;
  remindBefore: "none" | "1h" | "1d" | "2d" | "1w";
  recurring: "" | "daily" | "weekly" | "monthly";
  acceptDeadline: boolean;
  visibility: "shared" | "private";
  comment: string;
  createdBy: string;
  createdAt: string;
  acceptedAt: string | null;
  doneAt: string | null;
  note: string;
};

type FaceRow = {
  hash?: string;
  hashes?: string[];
  /** face-api FaceRecognitionNet 128-d vektorlar. */
  descriptors?: number[][];
  enrolledAt: string;
};
/** Legacy aHash (eski enrolllar). Yangi oqim — descriptors. */
const FACE_MATCH_MAX = 16;
const FACE_UNIQUE_MAX = 12;
const FACE_HASH_KEEP = 6;
/** face-api tavsiya: < 0.6; biroz qattiqroq — peshona/fragment kamroq o‘tsin. */
const FACE_DESC_MATCH = 0.48;
const FACE_DESC_UNIQUE = 0.42;
const FACE_DESC_KEEP = 8;
type Store = {
  secret: string;
  site: OfficeSite;
  punches: OfficePunch[];
  faces: Record<string, FaceRow>;
  tasks: OfficeTask[];
  fiksa: Record<string, number>;
};

const FILE = dataFile("office.json");
let memory: Store | null = null;

function normalizeSite(raw: Partial<OfficeSite> | undefined): OfficeSite {
  const base = defaultSite();
  if (!raw || typeof raw !== "object") return base;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  const radiusM = Number(raw.radiusM);
  const accuracyM = Number(raw.accuracyM);
  return {
    name: String(raw.name || base.name).trim().slice(0, 80) || base.name,
    lat: Number.isFinite(lat) && Math.abs(lat) <= 90 && !(lat === 0 && lng === 0) ? lat : base.lat,
    lng: Number.isFinite(lng) && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0) ? lng : base.lng,
    radiusM: Number.isFinite(radiusM) ? Math.min(5000, Math.max(30, radiusM)) : base.radiusM,
    accuracyM: Number.isFinite(accuracyM) ? Math.min(2000, Math.max(50, accuracyM)) : base.accuracyM,
    start: /^\d{2}:\d{2}$/.test(String(raw.start || "")) ? String(raw.start) : base.start,
    end: /^\d{2}:\d{2}$/.test(String(raw.end || "")) ? String(raw.end) : base.end,
  };
}

function empty(): Store {
  return {
    secret: randomBytes(24).toString("hex"),
    site: defaultSite(),
    punches: [],
    faces: {},
    tasks: [],
    fiksa: {},
  };
}

function load(): Store {
  if (memory) return memory;
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Store>;
    memory = {
      secret: parsed.secret || randomBytes(24).toString("hex"),
      site: normalizeSite(parsed.site),
      punches: Array.isArray(parsed.punches)
        ? parsed.punches.map((row) => ({
            ...row,
            note: typeof row.note === "string" ? row.note : "",
            excuse: EXCUSES.includes(row.excuse as OfficeExcuse) ? (row.excuse as OfficeExcuse) : "",
          }))
        : [],
      faces: parsed.faces && typeof parsed.faces === "object" ? parsed.faces : {},
      tasks: Array.isArray(parsed.tasks)
        ? parsed.tasks.map((row) => ({
            ...row,
            status: TASK_STATUSES.includes(row.status) ? row.status : "assigned",
            remindBefore: (["none", "1h", "1d", "2d", "1w"] as const).includes(row.remindBefore as "1d")
              ? row.remindBefore
              : row.remind
                ? "1d"
                : "none",
            recurring: (["", "daily", "weekly", "monthly"] as const).includes(row.recurring as "weekly")
              ? row.recurring
              : "",
            acceptDeadline: Boolean(row.acceptDeadline),
            visibility: row.visibility === "private" ? "private" : "shared",
            comment: typeof row.comment === "string" ? row.comment : "",
          }))
        : [],
      fiksa: parsed.fiksa && typeof parsed.fiksa === "object" ? parsed.fiksa : {},
    };
  } catch {
    memory = empty();
    save(memory);
  }
  return memory;
}

function save(store: Store) {
  memory = store;
  mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, FILE);
  // Postgres sync — restart/hydrate eski site ni qayta yozib yubormasligi uchun
  void pool
    .query(
      "insert into partner_store (id, document, updated_at) values ('office', $1::jsonb, now()) on conflict (id) do update set document = excluded.document, updated_at = now()",
      [JSON.stringify(store)],
    )
    .catch((err) => {
      console.error("[office] partner_store save failed", err instanceof Error ? err.message : err);
    });
}

/** Site o‘zgarishini Postgresga darhol yozish (restart oldidan). */
export async function flushOfficeStore() {
  const store = load();
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(store));
  await pool.query(
    "insert into partner_store (id, document, updated_at) values ('office', $1::jsonb, now()) on conflict (id) do update set document = excluded.document, updated_at = now()",
    [JSON.stringify(store)],
  );
}

function activeAccountIdsFromDisk() {
  try {
    const raw = JSON.parse(readFileSync(dataFile("accounts.json"), "utf8")) as {
      accounts?: Array<{ id?: string }>;
    };
    return (Array.isArray(raw.accounts) ? raw.accounts : [])
      .map((row) => String(row?.id || "").trim())
      .filter(Boolean);
  } catch {
    return [] as string[];
  }
}

export async function hydrateOffice() {
  try {
    await pool.query(`
      create table if not exists partner_store (
        id text primary key,
        document jsonb not null,
        updated_at timestamptz not null default now()
      )
    `);
    const res = await pool.query<{ document: Partial<Store> }>(
      "select document from partner_store where id = 'office'",
    );
    const remote = res.rows[0]?.document;
    if (remote && (Array.isArray(remote.punches) || Array.isArray(remote.tasks))) {
      writeFileSync(FILE, JSON.stringify(remote));
      memory = null;
      load();
      const active = activeAccountIdsFromDisk();
      if (active.length) pruneOrphanFaces(active);
      return;
    }
    const current = load();
    await pool.query(
      "insert into partner_store (id, document, updated_at) values ('office', $1::jsonb, now()) on conflict (id) do update set document = excluded.document, updated_at = now()",
      [JSON.stringify(current)],
    );
    const active = activeAccountIdsFromDisk();
    if (active.length) pruneOrphanFaces(active);
  } catch {
    /* ignore */
  }
}

export function tashkentParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(value);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${pick("year")}-${pick("month")}-${pick("day")}`,
    time: `${pick("hour")}:${pick("minute")}:${pick("second")}`,
    clock: `${pick("hour")}:${pick("minute")}:${pick("second")}`,
    hm: `${pick("hour")}:${pick("minute")}`,
  };
}

export function metersBetween(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earth = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function officeSite(): OfficeSite {
  return { ...load().site };
}

export function setOfficeSite(input: {
  lat: number;
  lng: number;
  radiusM?: number;
  accuracyM?: number;
  name?: string;
  start?: string;
  end?: string;
}) {
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw Object.assign(new Error("geo"), { status: 400 });
  }
  if (lat === 0 && lng === 0) throw Object.assign(new Error("geo"), { status: 400 });
  const store = load();
  store.site = normalizeSite({
    ...store.site,
    lat,
    lng,
    radiusM: input.radiusM ?? store.site.radiusM,
    accuracyM: input.accuracyM ?? store.site.accuracyM,
    name: input.name ?? store.site.name,
    start: input.start ?? store.site.start,
    end: input.end ?? store.site.end,
  });
  save(store);
  return officeSite();
}

export function officeDistance(lat: number, lng: number) {
  const site = officeSite();
  return metersBetween(lat, lng, site.lat, site.lng);
}

export function geoPayloadOk(lat: number, lng: number, accuracy?: number) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  // Null Island / aniq 0,0 — spoof yoki bo‘sh payload.
  if (lat === 0 && lng === 0) return false;
  const acc = Number(accuracy);
  const maxAcc = officeSite().accuracyM;
  // Real GPS always reports accuracy > 0. Missing/0 means spoofed or stale client payload.
  if (!Number.isFinite(acc) || acc <= 0 || acc > maxAcc) return false;
  return true;
}

export function insideOffice(lat: number, lng: number, accuracy?: number) {
  if (!geoPayloadOk(lat, lng, accuracy)) return false;
  const acc = Number(accuracy);
  const site = officeSite();
  const dist = officeDistance(lat, lng);
  // Nuqta radius ichida — ofisda. Accuracy doirasini radiusga “sig‘dirish” binoda 40–80 m
  // masofani ham blok qilardi (masalan 44 m + accuracy/2).
  if (dist <= site.radiusM) return true;
  // Chegaraga yaqin + yaxshi aniqlik — biroz soft buffer (GPS drift).
  if (acc <= 80 && dist <= site.radiusM + 20) return true;
  return false;
}

function hamming(left: string, right: string) {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (a.length !== 16 || b.length !== 16 || !/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) return 64;
  let n = 0;
  for (let i = 0; i < 16; i += 1) {
    let x = Number.parseInt(a[i], 16) ^ Number.parseInt(b[i], 16);
    while (x) {
      n += x & 1;
      x >>= 1;
    }
  }
  return n;
}

function normalizeFaceHash(value: unknown) {
  const clean = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{16}$/.test(clean) ? clean : "";
}

function normalizeDescriptor(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 128) return null;
  const out: number[] = [];
  for (const item of value) {
    const n = Number(item);
    if (!Number.isFinite(n)) return null;
    out.push(Math.round(n * 1e6) / 1e6);
  }
  return out;
}

function euclidean(a: number[], b: number[]) {
  if (a.length !== b.length) return 99;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function faceHashesOf(row: FaceRow | undefined) {
  if (!row) return [] as string[];
  const list = [...(Array.isArray(row.hashes) ? row.hashes : []), row.hash || ""]
    .map(normalizeFaceHash)
    .filter(Boolean);
  return [...new Set(list)];
}

function faceDescriptorsOf(row: FaceRow | undefined) {
  if (!row || !Array.isArray(row.descriptors)) return [] as number[][];
  return row.descriptors.map(normalizeDescriptor).filter((item): item is number[] => Boolean(item));
}

export function faceEnrolled(accountId: string) {
  const row = load().faces[accountId];
  return faceDescriptorsOf(row).length > 0 || faceHashesOf(row).length > 0;
}

/** Xodim o‘chirilganda Face ID ham o‘chadi. */
export function clearFace(accountId: string) {
  const id = String(accountId || "").trim();
  if (!id) return false;
  const store = load();
  if (!store.faces[id]) return false;
  delete store.faces[id];
  save(store);
  return true;
}

/** O‘chirilgan akkauntlarning Face ID si “taken” bermasligi uchun. */
export function pruneOrphanFaces(activeAccountIds: string[]) {
  const active = new Set(activeAccountIds.map((id) => String(id || "").trim()).filter(Boolean));
  const store = load();
  let changed = 0;
  for (const id of Object.keys(store.faces)) {
    if (active.has(id)) continue;
    delete store.faces[id];
    changed += 1;
  }
  if (changed) save(store);
  return changed;
}

function bestDescriptorDistance(probe: number[], gallery: number[][]) {
  let best = 99;
  for (const item of gallery) {
    const d = euclidean(probe, item);
    if (d < best) best = d;
  }
  return best;
}

function assertDescriptorsNotTaken(
  store: Store,
  accountId: string,
  probes: number[][],
  activeIds?: Set<string>,
) {
  for (const [id, row] of Object.entries(store.faces)) {
    if (id === accountId) continue;
    if (activeIds && !activeIds.has(id)) continue;
    const gallery = faceDescriptorsOf(row);
    if (!gallery.length) continue;
    for (const probe of probes) {
      if (bestDescriptorDistance(probe, gallery) <= FACE_DESC_UNIQUE) {
        throw Object.assign(new Error("taken"), { status: 409 });
      }
    }
  }
}

function assertHashesNotTaken(
  store: Store,
  accountId: string,
  cleaned: string[],
  activeIds?: Set<string>,
) {
  for (const [id, row] of Object.entries(store.faces)) {
    if (id === accountId) continue;
    if (activeIds && !activeIds.has(id)) continue;
    for (const saved of faceHashesOf(row)) {
      for (const probe of cleaned) {
        if (hamming(saved, probe) <= FACE_UNIQUE_MAX) {
          throw Object.assign(new Error("taken"), { status: 409 });
        }
      }
    }
  }
}

function dedupeDescriptors(list: number[][]) {
  const out: number[][] = [];
  for (const item of list) {
    if (out.some((saved) => euclidean(saved, item) < 0.12)) continue;
    out.push(item);
    if (out.length >= FACE_DESC_KEEP) break;
  }
  return out;
}

export function enrollFace(
  accountId: string,
  input: {
    hashes?: string | string[];
    descriptors?: number[][];
    replace?: boolean;
    activeAccountIds?: string[];
  },
) {
  const descriptors = dedupeDescriptors(
    (Array.isArray(input.descriptors) ? input.descriptors : [])
      .map(normalizeDescriptor)
      .filter((item): item is number[] => Boolean(item)),
  );
  const cleaned = [...new Set(
    (Array.isArray(input.hashes) ? input.hashes : input.hashes != null ? [input.hashes] : [])
      .map(normalizeFaceHash)
      .filter(Boolean),
  )].slice(0, FACE_HASH_KEEP);
  if (!descriptors.length && !cleaned.length) throw Object.assign(new Error("face"), { status: 400 });
  const replace = Boolean(input.replace);
  if (!replace && faceEnrolled(accountId)) throw Object.assign(new Error("exists"), { status: 409 });
  if (Array.isArray(input.activeAccountIds)) pruneOrphanFaces(input.activeAccountIds);
  const store = load();
  const activeIds = Array.isArray(input.activeAccountIds)
    ? new Set(input.activeAccountIds.map((id) => String(id || "").trim()).filter(Boolean))
    : undefined;
  if (descriptors.length) assertDescriptorsNotTaken(store, accountId, descriptors, activeIds);
  if (cleaned.length) assertHashesNotTaken(store, accountId, cleaned, activeIds);
  const prev = store.faces[accountId];
  const prevDesc = replace ? faceDescriptorsOf(prev) : [];
  const mergedDesc = descriptors.length
    ? dedupeDescriptors([...descriptors, ...prevDesc])
    : faceDescriptorsOf(prev);
  const prevHash = replace ? faceHashesOf(prev) : [];
  const mergedHash = cleaned.length
    ? [...new Set([...cleaned, ...prevHash])].slice(0, FACE_HASH_KEEP)
    : (descriptors.length ? [] : faceHashesOf(prev));
  store.faces[accountId] = {
    hash: mergedHash[0],
    hashes: mergedHash.length ? mergedHash : undefined,
    descriptors: mergedDesc.length ? mergedDesc : undefined,
    enrolledAt: new Date().toISOString(),
  };
  save(store);
}

/** Muvaffaqiyatli punchdan keyin yangi namunalarni qo‘shib, keyingi urinishlar barqaror bo‘lsin. */
export function rememberFace(
  accountId: string,
  input: { hashes?: string | string[]; descriptors?: number[][] },
) {
  if (!faceEnrolled(accountId)) return;
  const store = load();
  const prev = store.faces[accountId];
  const probes = dedupeDescriptors(
    (Array.isArray(input.descriptors) ? input.descriptors : [])
      .map(normalizeDescriptor)
      .filter((item): item is number[] => Boolean(item)),
  );
  const hashProbes = [...new Set(
    (Array.isArray(input.hashes) ? input.hashes : input.hashes != null ? [input.hashes] : [])
      .map(normalizeFaceHash)
      .filter(Boolean),
  )];
  if (!probes.length && !hashProbes.length) return;
  try {
    if (probes.length) assertDescriptorsNotTaken(store, accountId, probes);
    if (hashProbes.length) assertHashesNotTaken(store, accountId, hashProbes);
  } catch {
    return;
  }
  const mergedDesc = probes.length
    ? dedupeDescriptors([...probes, ...faceDescriptorsOf(prev)])
    : faceDescriptorsOf(prev);
  const mergedHash = hashProbes.length
    ? [...new Set([...hashProbes, ...faceHashesOf(prev)])].slice(0, FACE_HASH_KEEP)
    : faceHashesOf(prev);
  store.faces[accountId] = {
    hash: mergedHash[0],
    hashes: mergedHash.length ? mergedHash : undefined,
    descriptors: mergedDesc.length ? mergedDesc : undefined,
    enrolledAt: prev?.enrolledAt || new Date().toISOString(),
  };
  save(store);
}

export function faceMatchDistance(accountId: string, descriptor: number[]) {
  const gallery = faceDescriptorsOf(load().faces[accountId]);
  if (!gallery.length) return null;
  const probe = normalizeDescriptor(descriptor);
  if (!probe) return null;
  return bestDescriptorDistance(probe, gallery);
}

export function faceMatches(
  accountId: string,
  input: { hashes?: string | string[]; descriptors?: number[][] },
) {
  const row = load().faces[accountId];
  const gallery = faceDescriptorsOf(row);
  const probes = (Array.isArray(input.descriptors) ? input.descriptors : [])
    .map(normalizeDescriptor)
    .filter((item): item is number[] => Boolean(item));
  if (gallery.length && probes.length) {
    return probes.some((probe) => bestDescriptorDistance(probe, gallery) <= FACE_DESC_MATCH);
  }
  // Legacy aHash — faqat descriptor yo‘q eski profil uchun.
  if (gallery.length) return false;
  const saved = faceHashesOf(row);
  if (!saved.length) return false;
  const hashProbes = [...new Set(
    (Array.isArray(input.hashes) ? input.hashes : input.hashes != null ? [input.hashes] : [])
      .map(normalizeFaceHash)
      .filter(Boolean),
  )];
  if (!hashProbes.length) return false;
  return hashProbes.some((probe) => saved.some((item) => hamming(item, probe) <= FACE_MATCH_MAX));
}

function wallToken(secret: string) {
  const sign = createHmac("sha256", secret).update("bordo-office-wall-v1").digest("hex").slice(0, 16);
  return `BORDO-OFFICE-${sign}`;
}

export function currentQrToken() {
  const store = load();
  return { token: wallToken(store.secret), kind: "wall" as const, office: "Asosiy ofis" };
}

export function qrTokenOk(token: string) {
  const store = load();
  const value = token.trim().replace(/^https?:\/\/\S*?(BORDO-OFFICE-[0-9a-f]+).*$/i, "$1");
  return value === wallToken(store.secret);
}

export function todayPunch(accountId: string) {
  const day = tashkentParts().date;
  return load().punches.find((row) => row.accountId === accountId && row.date === day) ?? null;
}

export function punch(input: {
  accountId: string;
  kind: PunchKind;
  method: PunchMethod;
  lat: number;
  lng: number;
  accuracy?: number;
  faceHash?: string;
  faceHashes?: string[];
  faceDescriptors?: number[][];
  qrToken?: string;
}) {
  const accountId = String(input.accountId || "").trim();
  if (!accountId) throw Object.assign(new Error("auth"), { status: 401 });
  if (input.kind !== "in" && input.kind !== "out") {
    throw Object.assign(new Error("kind"), { status: 400 });
  }
  if (input.method !== "face" && input.method !== "qr") {
    throw Object.assign(new Error("method"), { status: 400 });
  }
  if (!geoPayloadOk(input.lat, input.lng, input.accuracy)) {
    throw Object.assign(new Error("geo"), { status: 400 });
  }
  if (!insideOffice(input.lat, input.lng, input.accuracy)) {
    throw Object.assign(new Error("radius"), { status: 403 });
  }
  if (punchLocks.has(accountId)) {
    throw Object.assign(new Error("busy"), { status: 429 });
  }
  punchLocks.add(accountId);
  try {
    const faceHashes = [
      ...(Array.isArray(input.faceHashes) ? input.faceHashes : []),
      String(input.faceHash || ""),
    ];
    const faceDescriptors = Array.isArray(input.faceDescriptors) ? input.faceDescriptors : [];
    if (input.method === "face") {
      if (!faceEnrolled(accountId)) throw Object.assign(new Error("enroll"), { status: 409 });
      if (!faceMatches(accountId, { hashes: faceHashes, descriptors: faceDescriptors })) {
        throw Object.assign(new Error("face"), { status: 403 });
      }
    } else if (!qrTokenOk(String(input.qrToken || ""))) {
      throw Object.assign(new Error("qr"), { status: 403 });
    }

    const store = load();
    const day = tashkentParts().date;
    const nowIso = new Date().toISOString();
    let row = store.punches.find((item) => item.accountId === accountId && item.date === day);
    if (!row) {
      row = emptyPunch(accountId, day);
      store.punches.push(row);
    }

    if (input.kind === "in") {
      if (row.inAt) throw Object.assign(new Error("already-in"), { status: 409 });
      if (row.outAt) throw Object.assign(new Error("already-out"), { status: 409 });
      row.inAt = nowIso;
      row.inMethod = input.method;
      row.inLat = input.lat;
      row.inLng = input.lng;
      // Ofisga keldi — dam/kasallik belgisini yechamiz (real punch ustun).
      if (row.excuse) row.excuse = "";
    } else {
      if (!row.inAt) throw Object.assign(new Error("need-in"), { status: 409 });
      if (row.outAt) throw Object.assign(new Error("already-out"), { status: 409 });
      const inMs = Date.parse(row.inAt);
      if (Number.isFinite(inMs) && Date.now() - inMs < MIN_SHIFT_MS) {
        throw Object.assign(new Error("too-soon"), { status: 409 });
      }
      row.outAt = nowIso;
      row.outMethod = input.method;
      row.outLat = input.lat;
      row.outLng = input.lng;
    }
    save(store);
    if (input.method === "face" && (faceDescriptors.length || faceHashes.some(Boolean))) {
      try {
        rememberFace(accountId, { hashes: faceHashes, descriptors: faceDescriptors });
      } catch { /* ignore */ }
    }
    return row;
  } finally {
    punchLocks.delete(accountId);
  }
}

export function punchesFor(accountId: string, from: string, to: string) {
  return load().punches
    .filter((row) => row.accountId === accountId && row.date >= from && row.date <= to)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.inAt || "").localeCompare(a.inAt || ""));
}

export function todayBoard() {
  const day = tashkentParts().date;
  return load().punches.filter((row) => row.date === day);
}

function shiftDay(day: string, by: number) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + by));
  return dt.toISOString().slice(0, 10);
}

export function rangeDays(kind: "day" | "week" | "month") {
  const today = tashkentParts().date;
  if (kind === "day") return { from: today, to: today };
  if (kind === "week") return { from: shiftDay(today, -6), to: today };
  return { from: `${today.slice(0, 8)}01`, to: today };
}

export function workedMs(row: OfficePunch, now = Date.now()) {
  if (!row.inAt) return 0;
  const start = Date.parse(row.inAt);
  const end = row.outAt ? Date.parse(row.outAt) : now;
  return Math.max(0, end - start);
}

export function listOfficeTasks(accountId?: string, director = false) {
  const rows = load().tasks.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (director) return rows;
  return rows.filter((row) => row.assignedTo.includes(accountId || ""));
}

export function createOfficeTask(input: {
  title: string;
  description: string;
  assignedTo: string[];
  dueDate: string;
  dueTime: string;
  priority: OfficePriority;
  remind?: boolean;
  remindBefore?: string;
  recurring?: string;
  acceptDeadline?: boolean;
  visibility?: string;
  comment?: string;
  createdBy: string;
  splitAssignees?: boolean;
}) {
  const title = input.title.trim().slice(0, 200);
  const assignedTo = [...new Set(input.assignedTo.map((id) => id.trim()).filter(Boolean))];
  if (!title || !assignedTo.length) throw Object.assign(new Error("task"), { status: 400 });
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) ? input.dueDate : tashkentParts().date;
  const dueTime = /^\d{2}:\d{2}$/.test(input.dueTime) ? input.dueTime : "18:00";
  const priority = ["low", "normal", "high", "urgent"].includes(input.priority) ? input.priority : "normal";
  const remindBefore = (["none", "1h", "1d", "2d", "1w"] as const).includes(input.remindBefore as "1d")
    ? (input.remindBefore as OfficeTask["remindBefore"])
    : input.remind === false
      ? "none"
      : "1d";
  const recurring = (["", "daily", "weekly", "monthly"] as const).includes(input.recurring as "weekly")
    ? (input.recurring as OfficeTask["recurring"])
    : "";
  const store = load();
  const groups = input.splitAssignees === false ? [assignedTo] : assignedTo.map((id) => [id]);
  const created: OfficeTask[] = [];
  for (const group of groups) {
    const task: OfficeTask = {
      id: randomUUID(),
      title,
      description: input.description.trim().slice(0, 2000),
      assignedTo: group,
      dueDate,
      dueTime,
      priority,
      status: "assigned",
      remind: remindBefore !== "none",
      remindBefore,
      recurring,
      acceptDeadline: Boolean(input.acceptDeadline),
      visibility: input.visibility === "private" ? "private" : "shared",
      comment: String(input.comment || "").trim().slice(0, 500),
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      acceptedAt: null,
      doneAt: null,
      note: "",
    };
    store.tasks.unshift(task);
    created.push(task);
  }
  save(store);
  return created.length === 1 ? created[0] : created;
}

export function updateOfficeTask(id: string, accountId: string, director: boolean, patch: { status?: string; note?: string }) {
  const store = load();
  const task = store.tasks.find((row) => row.id === id);
  if (!task) throw Object.assign(new Error("not_found"), { status: 404 });
  if (!director && !task.assignedTo.includes(accountId)) throw Object.assign(new Error("forbidden"), { status: 403 });
  if (patch.note != null && director) task.note = patch.note.trim().slice(0, 500);
  if (patch.status != null) {
    const next = !director && patch.status === "done" ? "review" : patch.status;
    if (!TASK_STATUSES.includes(next as OfficeTaskStatus)) throw Object.assign(new Error("status"), { status: 400 });
    if (director) {
      task.status = next as OfficeTaskStatus;
    } else if (next === "accepted" && task.status === "assigned") {
      task.status = "accepted";
      task.acceptedAt = new Date().toISOString();
    } else if (next === "progress" && (task.status === "accepted" || task.status === "assigned")) {
      task.status = "progress";
      if (!task.acceptedAt) task.acceptedAt = new Date().toISOString();
    } else if (next === "review" && (task.status === "accepted" || task.status === "progress" || task.status === "assigned")) {
      task.status = "review";
      if (!task.acceptedAt) task.acceptedAt = new Date().toISOString();
    } else {
      throw Object.assign(new Error("status"), { status: 400 });
    }
    if (task.status === "accepted" && !task.acceptedAt) task.acceptedAt = new Date().toISOString();
    if (task.status === "done") task.doneAt = new Date().toISOString();
  }
  save(store);
  return task;
}

export function fiksaOf(accountId: string) {
  return Math.max(0, Number(load().fiksa[accountId]) || 0);
}

function hmOf(iso: string | null) {
  if (!iso) return "";
  return tashkentParts(new Date(iso)).hm;
}

function minutesBetween(left: string, right: string) {
  const [lh, lm] = left.split(":").map(Number);
  const [rh, rm] = right.split(":").map(Number);
  return lh * 60 + lm - (rh * 60 + rm);
}

export type TabelPerson = { id: string; name: string; login: string; role: string };

function weekendOf(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function tabelStatus(row: OfficePunch | undefined, inHm: string, weekend: boolean, start: string): TabelStatus {
  if (!row?.inAt) {
    if (row?.excuse && row.excuse !== "") return row.excuse;
    return weekend ? "off" : "absent";
  }
  if (!row.outAt) return "out_missing";
  if (inHm && minutesBetween(inHm, start) > 0) return "late";
  return "present";
}

function emptyPunch(accountId: string, day: string): OfficePunch {
  return {
    id: randomUUID(),
    accountId,
    date: day,
    inAt: null,
    outAt: null,
    inMethod: null,
    outMethod: null,
    inLat: null,
    inLng: null,
    outLat: null,
    outLng: null,
    note: "",
    excuse: "",
  };
}

export function setTabelMark(input: { accountId: string; date: string; excuse?: string; note?: string }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw Object.assign(new Error("date"), { status: 400 });
  if (input.date > tashkentParts().date) throw Object.assign(new Error("future"), { status: 400 });
  const store = load();
  let row = store.punches.find((item) => item.accountId === input.accountId && item.date === input.date);
  if (!row) {
    row = emptyPunch(input.accountId, input.date);
    store.punches.push(row);
  }
  if (input.excuse != null) {
    const value = String(input.excuse) as OfficeExcuse;
    if (!EXCUSES.includes(value)) throw Object.assign(new Error("excuse"), { status: 400 });
    row.excuse = value;
  }
  if (input.note != null) row.note = String(input.note).trim().slice(0, 400);
  save(store);
  return row;
}

export function tabelDay(day: string, people: TabelPerson[], start = "09:00", end = "18:00") {
  const punches = load().punches.filter((row) => row.date === day);
  const byId = new Map(punches.map((row) => [row.accountId, row]));
  const weekend = weekendOf(day);
  const items = people.map((person, index) => {
    const row = byId.get(person.id);
    const inHm = hmOf(row?.inAt ?? null);
    const outHm = hmOf(row?.outAt ?? null);
    const status = tabelStatus(row, inHm, weekend, start);
    return {
      n: index + 1,
      accountId: person.id,
      date: day,
      name: person.name,
      login: person.login,
      role: person.role,
      status,
      weekend,
      excuse: row?.excuse || "",
      inAt: row?.inAt ?? null,
      outAt: row?.outAt ?? null,
      inHm,
      outHm,
      workedMs: row ? workedMs(row, row.outAt ? Date.parse(row.outAt) : Date.now()) : 0,
      lateIn: inHm ? Math.max(0, minutesBetween(inHm, start)) : 0,
      earlyIn: inHm ? Math.max(0, minutesBetween(start, inHm)) : 0,
      earlyOut: outHm ? Math.max(0, minutesBetween(end, outHm)) : 0,
      overtime: outHm ? Math.max(0, minutesBetween(outHm, end)) : 0,
      note: row?.note || "",
      inMethod: row?.inMethod ?? null,
      outMethod: row?.outMethod ?? null,
      inLat: row?.inLat ?? null,
      inLng: row?.inLng ?? null,
      outLat: row?.outLat ?? null,
      outLng: row?.outLng ?? null,
    };
  });
  const came = items.filter((row) => row.status === "present" || row.status === "late" || row.status === "out_missing").length;
  return {
    date: day,
    start,
    end,
    weekend,
    stats: {
      total: items.length,
      came,
      absent: items.filter((row) => row.status === "absent").length,
      late: items.filter((row) => row.lateIn > 0).length,
      off: items.filter((row) => row.status === "off" || row.status === "sick" || row.status === "vacation" || row.status === "trip" || row.status === "permit").length,
      waiting: items.filter((row) => row.status === "out_missing").length,
    },
    items,
  };
}

function peopleSummary(items: Array<ReturnType<typeof tabelDay>["items"][number] & { date?: string }>, people: TabelPerson[]) {
  return people.map((person) => {
    const rows = items.filter((row) => row.accountId === person.id);
    return {
      accountId: person.id,
      name: person.name,
      login: person.login,
      role: person.role,
      days: rows.length,
      came: rows.filter((row) => row.status === "present" || row.status === "late" || row.status === "out_missing").length,
      absent: rows.filter((row) => row.status === "absent").length,
      late: rows.filter((row) => row.lateIn > 0).length,
      off: rows.filter((row) => row.status === "off" || row.status === "sick" || row.status === "vacation" || row.status === "trip" || row.status === "permit").length,
      waiting: rows.filter((row) => row.status === "out_missing").length,
      workedMs: rows.reduce((sum, row) => sum + row.workedMs, 0),
      lateMin: rows.reduce((sum, row) => sum + row.lateIn, 0),
      earlyOut: rows.reduce((sum, row) => sum + row.earlyOut, 0),
      overtime: rows.reduce((sum, row) => sum + row.overtime, 0),
    };
  });
}

export function tabelRange(from: string, to: string, people: TabelPerson[], start = "09:00", end = "18:00") {
  const begin = from <= to ? from : to;
  const endDay = from <= to ? to : from;
  const days = [];
  let cursor = begin;
  while (cursor <= endDay && days.length < 62) {
    days.push(tabelDay(cursor, people, start, end));
    cursor = shiftDay(cursor, 1);
  }
  const items = days.flatMap((day) => day.items.map((row) => ({ ...row, date: day.date })));
  const stats = days.reduce(
    (acc, day) => ({
      total: people.length,
      came: acc.came + day.stats.came,
      absent: acc.absent + day.stats.absent,
      late: acc.late + day.stats.late,
      off: acc.off + day.stats.off,
      waiting: acc.waiting + day.stats.waiting,
    }),
    { total: people.length, came: 0, absent: 0, late: 0, off: 0, waiting: 0 },
  );
  return { from: begin, to: endDay, start, end, stats, items, people: peopleSummary(items, people) };
}
