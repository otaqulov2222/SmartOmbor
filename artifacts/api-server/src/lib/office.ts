import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./data-dir";

export const OFFICE_LAT = 41.258556;
export const OFFICE_LNG = 69.150964;
export const OFFICE_RADIUS_M = 100;
export const OFFICE_ACCURACY_M = 150;

export type PunchMethod = "face" | "qr";
export type PunchKind = "in" | "out";
export type OfficeTaskStatus = "assigned" | "accepted" | "done";
export type OfficePriority = "low" | "normal" | "high" | "urgent";

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
  createdBy: string;
  createdAt: string;
  acceptedAt: string | null;
  doneAt: string | null;
  note: string;
};

type FaceRow = { hash: string; enrolledAt: string };
type Store = {
  secret: string;
  punches: OfficePunch[];
  faces: Record<string, FaceRow>;
  tasks: OfficeTask[];
  fiksa: Record<string, number>;
};

const FILE = dataFile("office.json");
let memory: Store | null = null;

function empty(): Store {
  return { secret: randomBytes(24).toString("hex"), punches: [], faces: {}, tasks: [], fiksa: {} };
}

function load(): Store {
  if (memory) return memory;
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Store>;
    memory = {
      secret: parsed.secret || randomBytes(24).toString("hex"),
      punches: Array.isArray(parsed.punches) ? parsed.punches : [],
      faces: parsed.faces && typeof parsed.faces === "object" ? parsed.faces : {},
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
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

export function officeDistance(lat: number, lng: number) {
  return metersBetween(lat, lng, OFFICE_LAT, OFFICE_LNG);
}

export function insideOffice(lat: number, lng: number, accuracy?: number) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Number.isFinite(accuracy) && Number(accuracy) > OFFICE_ACCURACY_M) return false;
  return officeDistance(lat, lng) <= OFFICE_RADIUS_M;
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

export function faceEnrolled(accountId: string) {
  return Boolean(load().faces[accountId]?.hash);
}

export function enrollFace(accountId: string, hash: string) {
  const clean = hash.trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(clean)) throw Object.assign(new Error("face"), { status: 400 });
  const store = load();
  store.faces[accountId] = { hash: clean, enrolledAt: new Date().toISOString() };
  save(store);
}

export function faceMatches(accountId: string, hash: string) {
  const saved = load().faces[accountId]?.hash;
  if (!saved) return false;
  return hamming(saved, hash) <= 14;
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
  qrToken?: string;
}) {
  if (!insideOffice(input.lat, input.lng, input.accuracy)) {
    throw Object.assign(new Error("radius"), { status: 403 });
  }
  if (input.method === "face") {
    if (!faceEnrolled(input.accountId)) throw Object.assign(new Error("enroll"), { status: 409 });
    if (!faceMatches(input.accountId, String(input.faceHash || ""))) throw Object.assign(new Error("face"), { status: 403 });
  } else if (input.method === "qr") {
    if (!qrTokenOk(String(input.qrToken || ""))) throw Object.assign(new Error("qr"), { status: 403 });
  } else {
    throw Object.assign(new Error("method"), { status: 400 });
  }
  const store = load();
  const day = tashkentParts().date;
  const now = new Date().toISOString();
  let row = store.punches.find((item) => item.accountId === input.accountId && item.date === day);
  if (!row) {
    row = {
      id: randomUUID(),
      accountId: input.accountId,
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
    };
    store.punches.push(row);
  }
  if (input.kind === "in") {
    if (row.inAt) throw Object.assign(new Error("already-in"), { status: 409 });
    row.inAt = now;
    row.inMethod = input.method;
    row.inLat = input.lat;
    row.inLng = input.lng;
  } else {
    if (!row.inAt) throw Object.assign(new Error("need-in"), { status: 409 });
    if (row.outAt) throw Object.assign(new Error("already-out"), { status: 409 });
    row.outAt = now;
    row.outMethod = input.method;
    row.outLat = input.lat;
    row.outLng = input.lng;
  }
  save(store);
  return row;
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
  remind: boolean;
  createdBy: string;
}) {
  const title = input.title.trim();
  const assignedTo = [...new Set(input.assignedTo.map((id) => id.trim()).filter(Boolean))];
  if (!title || !assignedTo.length) throw Object.assign(new Error("task"), { status: 400 });
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) ? input.dueDate : tashkentParts().date;
  const dueTime = /^\d{2}:\d{2}$/.test(input.dueTime) ? input.dueTime : "18:00";
  const priority = ["low", "normal", "high", "urgent"].includes(input.priority) ? input.priority : "normal";
  const store = load();
  const task: OfficeTask = {
    id: randomUUID(),
    title,
    description: input.description.trim(),
    assignedTo,
    dueDate,
    dueTime,
    priority,
    status: "assigned",
    remind: Boolean(input.remind),
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
    acceptedAt: null,
    doneAt: null,
    note: "",
  };
  store.tasks.unshift(task);
  save(store);
  return task;
}

export function updateOfficeTask(id: string, accountId: string, director: boolean, patch: { status?: OfficeTaskStatus; note?: string }) {
  const store = load();
  const task = store.tasks.find((row) => row.id === id);
  if (!task) throw Object.assign(new Error("not_found"), { status: 404 });
  if (!director && !task.assignedTo.includes(accountId)) throw Object.assign(new Error("forbidden"), { status: 403 });
  if (patch.note != null && director) task.note = patch.note.trim().slice(0, 500);
  if (patch.status === "accepted" && task.status === "assigned") {
    task.status = "accepted";
    task.acceptedAt = new Date().toISOString();
  } else if (patch.status === "done" && (task.status === "accepted" || director)) {
    task.status = "done";
    task.doneAt = new Date().toISOString();
  } else if (patch.status && director) {
    task.status = patch.status;
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

export function tabelDay(day: string, people: TabelPerson[], start = "09:00", end = "18:00") {
  const punches = load().punches.filter((row) => row.date === day);
  const byId = new Map(punches.map((row) => [row.accountId, row]));
  const items = people.map((person, index) => {
    const row = byId.get(person.id);
    const inHm = hmOf(row?.inAt ?? null);
    const outHm = hmOf(row?.outAt ?? null);
    const status = !row?.inAt ? "absent" : row.outAt ? "present" : "out_missing";
    return {
      n: index + 1,
      accountId: person.id,
      name: person.name,
      login: person.login,
      role: person.role,
      status,
      inAt: row?.inAt ?? null,
      outAt: row?.outAt ?? null,
      inHm,
      outHm,
      workedMs: row ? workedMs(row, row.outAt ? Date.parse(row.outAt) : Date.now()) : 0,
      lateIn: inHm ? Math.max(0, minutesBetween(inHm, start)) : 0,
      earlyIn: inHm ? Math.max(0, minutesBetween(start, inHm)) : 0,
      earlyOut: outHm ? Math.max(0, minutesBetween(end, outHm)) : 0,
      lateOut: outHm ? Math.max(0, minutesBetween(outHm, end)) : 0,
      note: row?.note || "",
      inMethod: row?.inMethod ?? null,
      outMethod: row?.outMethod ?? null,
    };
  });
  const came = items.filter((row) => row.status !== "absent").length;
  const [year, month, date] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  const absent = items.length - came;
  return {
    date: day,
    start,
    end,
    stats: {
      total: items.length,
      came,
      absent,
      late: items.filter((row) => row.lateIn > 0).length,
      off: weekend ? absent : 0,
      waiting: items.filter((row) => row.status === "out_missing").length,
    },
    items,
  };
}

export function tabelRange(from: string, to: string, people: TabelPerson[], start = "09:00", end = "18:00") {
  const days = [];
  let cursor = from;
  while (cursor <= to && days.length < 40) {
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
  return { from, to, start, end, stats, items };
}
