/** Toshkent (UTC+5) kalendar sanalari — KPI/MS filter uchun. */

export type KpiPreset =
  | "today"
  | "yesterday"
  | "week"
  | "last_week"
  | "month"
  | "last_month"
  | "days7"
  | "days30"
  | "quarter"
  | "year"
  | "custom";

export const KPI_PRESETS: Array<{ id: KpiPreset; label: string }> = [
  { id: "today", label: "Bugun" },
  { id: "yesterday", label: "Kecha" },
  { id: "week", label: "Shu hafta" },
  { id: "last_week", label: "O‘tgan hafta" },
  { id: "month", label: "Shu oy" },
  { id: "last_month", label: "O‘tgan oy" },
  { id: "days7", label: "7 kun" },
  { id: "days30", label: "30 kun" },
  { id: "quarter", label: "Chorak" },
  { id: "year", label: "Yil" },
  { id: "custom", label: "Maxsus" },
];

export function tashkentYmd(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** YYYY-MM-DD → Date at Tashkent noon (UTC) for weekday math. */
function ymdToUtcNoon(ymd: string) {
  return new Date(`${ymd}T07:00:00.000Z`); // Tashkent 12:00 ≈ UTC 07:00
}

function addDaysYmd(ymd: string, days: number) {
  const dt = ymdToUtcNoon(ymd);
  dt.setUTCDate(dt.getUTCDate() + days);
  return tashkentYmd(dt);
}

function mondayOf(ymd: string) {
  const dt = ymdToUtcNoon(ymd);
  const dow = dt.getUTCDay(); // 0 Sun … 6 Sat
  const offset = dow === 0 ? -6 : 1 - dow;
  return addDaysYmd(ymd, offset);
}

function monthStart(ymd: string) {
  return `${ymd.slice(0, 7)}-01`;
}

function monthEnd(ymd: string) {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const firstNext = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
  return addDaysYmd(firstNext, -1);
}

function quarterStart(ymd: string) {
  const y = ymd.slice(0, 4);
  const m = Number(ymd.slice(5, 7));
  const q0 = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(q0).padStart(2, "0")}-01`;
}

export function periodFromPreset(preset: string, now = new Date()) {
  const today = tashkentYmd(now);
  const id = (KPI_PRESETS.some((p) => p.id === preset) ? preset : "month") as KpiPreset;
  let from = today;
  let to = today;
  switch (id) {
    case "today":
      from = today;
      to = today;
      break;
    case "yesterday":
      from = addDaysYmd(today, -1);
      to = from;
      break;
    case "week":
      from = mondayOf(today);
      to = today;
      break;
    case "last_week": {
      const thisMon = mondayOf(today);
      from = addDaysYmd(thisMon, -7);
      to = addDaysYmd(thisMon, -1);
      break;
    }
    case "month":
      from = monthStart(today);
      to = today;
      break;
    case "last_month": {
      const thisStart = monthStart(today);
      to = addDaysYmd(thisStart, -1);
      from = monthStart(to);
      break;
    }
    case "days7":
      from = addDaysYmd(today, -6);
      to = today;
      break;
    case "days30":
      from = addDaysYmd(today, -29);
      to = today;
      break;
    case "quarter":
      from = quarterStart(today);
      to = today;
      break;
    case "year":
      from = `${today.slice(0, 4)}-01-01`;
      to = today;
      break;
    case "custom":
    default:
      from = monthStart(today);
      to = today;
      break;
  }
  const meta = KPI_PRESETS.find((p) => p.id === id);
  return {
    from,
    to,
    preset: id,
    label: `${meta?.label || id}: ${from} — ${to}`,
  };
}

export function resolveKpiPeriod(input: {
  from?: unknown;
  to?: unknown;
  preset?: unknown;
}) {
  const presetRaw = String(input.preset || "").trim().toLowerCase();
  if (presetRaw && presetRaw !== "custom" && KPI_PRESETS.some((p) => p.id === presetRaw)) {
    return periodFromPreset(presetRaw);
  }
  let from = String(input.from || "").slice(0, 10);
  let to = String(input.to || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return periodFromPreset("month");
  }
  if (from > to) {
    const swap = from;
    from = to;
    to = swap;
  }
  return {
    from,
    to,
    preset: "custom" as KpiPreset,
    label: `Maxsus: ${from} — ${to}`,
  };
}

export function defaultKpiPeriod() {
  return periodFromPreset("month");
}

export function matchPreset(from: string, to: string): KpiPreset {
  for (const p of KPI_PRESETS) {
    if (p.id === "custom") continue;
    const hit = periodFromPreset(p.id);
    if (hit.from === from && hit.to === to) return p.id;
  }
  return "custom";
}
