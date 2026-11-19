/**
 * Agent GPS kuzatuvi — ish soati (Toshkent).
 * Default ofis bilan bir xil: 06:00–18:00, Dushanba dam (ENV bilan o‘zgartirish mumkin).
 */
export type AgentWorkHours = {
  start: string; // HH:MM
  end: string;
  /** getDay(): 0=Ya … 6=Sh. Default Dushanba. */
  offDays: number[];
  tz: "Asia/Tashkent";
};

export type WatchStatus = "live" | "away" | "silent" | "no_signal" | "off_hours";

const DEFAULT_START = process.env.SMART_OMBOR_AGENT_WORK_START || "06:00";
const DEFAULT_END = process.env.SMART_OMBOR_AGENT_WORK_END || "18:00";
const DEFAULT_OFF_DAYS = (process.env.SMART_OMBOR_AGENT_OFF_DAYS || "1")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);

export function agentWorkHours(): AgentWorkHours {
  return {
    start: String(DEFAULT_START).slice(0, 5),
    end: String(DEFAULT_END).slice(0, 5),
    offDays: DEFAULT_OFF_DAYS.length ? DEFAULT_OFF_DAYS : [1],
    tz: "Asia/Tashkent",
  };
}

function parseHm(hm: string): number {
  const [h, m] = String(hm || "0:0")
    .split(":")
    .map((x) => Number(x));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

export function tashkentClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "00";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  const hm = `${get("hour")}:${get("minute")}`;
  return { ymd, hm, minutes: parseHm(hm) };
}

export function isWithinWorkHours(now = new Date(), hours = agentWorkHours()): boolean {
  const clock = tashkentClock(now);
  const weekday = new Date(
    `${clock.ymd}T12:00:00+05:00`,
  ).getDay();
  if (hours.offDays.includes(weekday)) return false;
  const { minutes } = clock;
  const start = parseHm(hours.start);
  const end = parseHm(hours.end);
  if (end <= start) {
    // tun orqali smena
    return minutes >= start || minutes < end;
  }
  return minutes >= start && minutes < end;
}

/**
 * live ≤5 daqiqa (heartbeat 12s + tarmoq kechikishi);
 * away ≤20; silent = bugun ping bor lekin uzilgan; no_signal = bugun umuman yo‘q.
 */
export function resolveWatchStatus(input: {
  lastSeenAt: Date | string | null | undefined;
  hadPingToday: boolean;
  withinWorkHours: boolean;
  now?: Date;
}): WatchStatus {
  if (!input.withinWorkHours) return "off_hours";
  if (!input.lastSeenAt) return "no_signal";
  const at = input.lastSeenAt instanceof Date ? input.lastSeenAt : new Date(input.lastSeenAt);
  if (!Number.isFinite(at.getTime())) return input.hadPingToday ? "silent" : "no_signal";
  const age = (input.now || new Date()).getTime() - at.getTime();
  if (age >= 0 && age <= 5 * 60_000) return "live";
  if (age >= 0 && age <= 20 * 60_000) return "away";
  if (input.hadPingToday) return "silent";
  return "no_signal";
}

export function isNativeWatchSource(source?: string | null): boolean {
  const s = String(source || "").toLowerCase();
  return s === "native" || s === "heartbeat";
}

export function watchStatusLabel(status: WatchStatus, source?: string | null): string {
  const native = isNativeWatchSource(source);
  switch (status) {
    case "live":
      return native ? "Fon GPS" : "Jonli GPS";
    case "away":
      return native ? "Fon GPS (yaqinda)" : "Yaqinda";
    case "silent":
      return "Aloqa uzilgan";
    case "no_signal":
      return "GPS yo‘q";
    case "off_hours":
      return "Ish soati tashqarida";
    default:
      return status;
  }
}
