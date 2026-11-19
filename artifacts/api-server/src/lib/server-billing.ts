/**
 * Server (VPS) to‘lov muddati — Telegram eslatma + muddat o‘tsa tizim qulfi.
 * Turib qolgan mahsulotlar digestiga o‘xshash: har kuni Toshkent vaqti bilan.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./data-dir";
import { logger } from "./logger";

const FILE = dataFile("server-billing.json");
const DEFAULT_PERIOD_DAYS = 30;
/** Eslatma: muddatdan 3/2/1 kun oldin + muddat kuni. */
const REMIND_DAYS = new Set([0, 1, 2, 3]);
const REMIND_HOUR = 10;

export type ServerBilling = {
  /** Oxirgi to‘lov sanasi YYYY-MM-DD (Toshkent). */
  paidAt: string | null;
  /** Keyingi to‘lov muddati YYYY-MM-DD. */
  nextDue: string | null;
  /** To‘lov oralig‘i (kun). */
  periodDays: number;
  /** Oxirgi eslatma yuborilgan kun stamp. */
  sentRemindOn: string | null;
  /** Oxirgi eslatmadagi qolgan kun (double-send oldini olish uchun). */
  sentRemindLeft: number | null;
  note: string;
  updatedAt: string | null;
};

function tashkentStamp(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function tashkentHour(date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Number(parts.find((p) => p.type === "hour")?.value || 0);
}

function addDays(stamp: string, days: number): string {
  const [y, m, d] = stamp.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days));
  return utc.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function empty(): ServerBilling {
  return {
    paidAt: null,
    nextDue: null,
    periodDays: DEFAULT_PERIOD_DAYS,
    sentRemindOn: null,
    sentRemindLeft: null,
    note: "",
    updatedAt: null,
  };
}

function read(): ServerBilling {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as Partial<ServerBilling>;
    const period = Number(raw.periodDays);
    return {
      paidAt: typeof raw.paidAt === "string" ? raw.paidAt : null,
      nextDue: typeof raw.nextDue === "string" ? raw.nextDue : null,
      periodDays: Number.isFinite(period) && period >= 7 ? Math.min(366, Math.round(period)) : DEFAULT_PERIOD_DAYS,
      sentRemindOn: typeof raw.sentRemindOn === "string" ? raw.sentRemindOn : null,
      sentRemindLeft: raw.sentRemindLeft == null ? null : Number(raw.sentRemindLeft),
      note: typeof raw.note === "string" ? raw.note.slice(0, 300) : "",
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    };
  } catch {
    return empty();
  }
}

function write(state: ServerBilling) {
  mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, FILE);
}

/** Env yoki fayldan muddat — env ustun. */
export function billingOf(): ServerBilling {
  const state = read();
  const envDue = String(process.env.SERVER_BILLING_DUE || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(envDue)) {
    state.nextDue = envDue;
  }
  const envPeriod = Number(process.env.SERVER_BILLING_PERIOD_DAYS || "");
  if (Number.isFinite(envPeriod) && envPeriod >= 7) {
    state.periodDays = Math.min(366, Math.round(envPeriod));
  }
  return state;
}

export function daysUntilDue(now = new Date()): number | null {
  const due = billingOf().nextDue;
  if (!due) return null;
  return daysBetween(tashkentStamp(now), due);
}

export function isBillingLocked(now = new Date()): boolean {
  const left = daysUntilDue(now);
  if (left == null) return false;
  return left < 0;
}

export function markServerPaid(input?: { paidAt?: string; periodDays?: number; note?: string }) {
  const today = tashkentStamp();
  const paidAt = /^\d{4}-\d{2}-\d{2}$/.test(String(input?.paidAt || ""))
    ? String(input!.paidAt)
    : today;
  const current = billingOf();
  const periodDays = input?.periodDays && input.periodDays >= 7
    ? Math.min(366, Math.round(input.periodDays))
    : current.periodDays || DEFAULT_PERIOD_DAYS;
  const nextDue = addDays(paidAt, periodDays);
  const next: ServerBilling = {
    ...current,
    paidAt,
    nextDue,
    periodDays,
    sentRemindOn: null,
    sentRemindLeft: null,
    note: String(input?.note || current.note || "").slice(0, 300),
    updatedAt: new Date().toISOString(),
  };
  write(next);
  logger.info({ paidAt, nextDue, periodDays }, "Server billing marked paid");
  return next;
}

/** Birinchi marta: bugun to‘lov qilindi deb yoziladi (mavjud nextDue bo‘lmasa). */
export function ensureBillingInitialized() {
  const state = billingOf();
  if (state.nextDue) return state;
  const envDue = String(process.env.SERVER_BILLING_DUE || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(envDue)) {
    const next = { ...state, nextDue: envDue, updatedAt: new Date().toISOString() };
    write(next);
    return next;
  }
  // Bugun to‘lov qilindi → keyingi muddat +periodDays
  return markServerPaid({ paidAt: tashkentStamp(), note: "avto: birinchi sozlash" });
}

export function billingStatus(now = new Date()) {
  const state = billingOf();
  const today = tashkentStamp(now);
  const left = daysUntilDue(now);
  return {
    ...state,
    today,
    daysLeft: left,
    locked: left != null && left < 0,
    remindHour: REMIND_HOUR,
    remindWindow: [3, 2, 1, 0],
  };
}

export function buildBillingReminderHtml(daysLeft: number, due: string): string {
  const dueLabel = due.split("-").reverse().join(".");
  if (daysLeft > 3) {
    return [
      "<b>Smart Ombor — server to‘lovi</b>",
      "",
      `Keyingi muddat: <b>${dueLabel}</b> (${daysLeft} kun qoldi).`,
    ].join("\n");
  }
  if (daysLeft === 3) {
    return [
      "<b>⚠️ Server to‘loviga 3 kun qoldi</b>",
      "",
      `Muddat: <b>${dueLabel}</b>`,
      "Shu kungacha to‘lov qiling.",
      "<b>To‘lov qilinmasa tizim to‘xtaydi.</b>",
    ].join("\n");
  }
  if (daysLeft === 2) {
    return [
      "<b>⚠️ Server to‘loviga 2 kun qoldi</b>",
      "",
      `Muddat: <b>${dueLabel}</b>`,
      "<b>To‘lov qilinmasa tizim to‘xtaydi.</b>",
    ].join("\n");
  }
  if (daysLeft === 1) {
    return [
      "<b>🚨 Server to‘loviga 1 kun qoldi</b>",
      "",
      `Muddat: <b>${dueLabel}</b> (ertaga).`,
      "<b>To‘lov qilinmasa tizim to‘xtaydi.</b>",
    ].join("\n");
  }
  if (daysLeft === 0) {
    return [
      "<b>🚨 Bugun — server to‘lovi muddati</b>",
      "",
      `Muddat: <b>${dueLabel}</b>`,
      "Bugun to‘lov qiling.",
      "<b>To‘lov qilinmasa tizim to‘xtaydi.</b>",
    ].join("\n");
  }
  const overdue = Math.abs(daysLeft);
  return [
    "<b>🛑 Server to‘lovi muddati o‘tdi</b>",
    "",
    `Muddat edi: <b>${dueLabel}</b> (${overdue} kun kechikkan).`,
    "<b>Tizim to‘xtatilgan.</b> To‘lov qilingandan keyin admin «server tolov» deb yozadi yoki Oylik/Sozlamadan belgilaydi.",
  ].join("\n");
}

/**
 * Soat 10:00 (Toshkent) — 3/2/1/0 kun qolganda yoki muddat o‘tganda eslatma.
 * Yozish emas — yuborilgach `markBillingReminded` chaqiring.
 */
export function peekBillingReminder(now = new Date()): { html: string; daysLeft: number; due: string } | null {
  ensureBillingInitialized();
  const state = billingOf();
  if (!state.nextDue) return null;
  const hour = tashkentHour(now);
  if (hour < REMIND_HOUR) return null;
  const today = tashkentStamp(now);
  const left = daysBetween(today, state.nextDue);
  const should = REMIND_DAYS.has(left) || left < 0;
  if (!should) return null;
  if (state.sentRemindOn === today && state.sentRemindLeft === left) return null;
  return { html: buildBillingReminderHtml(left, state.nextDue), daysLeft: left, due: state.nextDue };
}

export function markBillingReminded(daysLeft: number, now = new Date()) {
  const state = billingOf();
  write({
    ...state,
    sentRemindOn: tashkentStamp(now),
    sentRemindLeft: daysLeft,
    updatedAt: new Date().toISOString(),
  });
}

/** @deprecated peek + mark ishlating */
export function takeBillingReminder(now = new Date()) {
  const peek = peekBillingReminder(now);
  if (!peek) return null;
  markBillingReminded(peek.daysLeft, now);
  return peek;
}

export function billingFileExists() {
  return existsSync(FILE);
}

export { REMIND_HOUR, tashkentStamp as billingToday };
