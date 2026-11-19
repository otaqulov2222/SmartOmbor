/** Toshkent UTC+5 — default ofis: 06:00–18:00, Dushanba dam (Se–Ya ish). */
const TZ = "Asia/Tashkent";
const START_MIN = 6 * 60;
const END_MIN = 18 * 60;
/** getDay(): 0=Ya … 1=Du … 6=Sh */
const OFF_DAYS = new Set([1]);

export function isWithinWorkHours(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  // Dushanba = dam (Se–Ya ish)
  if (weekday === "Mon") return false;
  void OFF_DAYS;

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const mins = hour * 60 + minute;
  return mins >= START_MIN && mins < END_MIN;
}

export function workHoursLabel(): string {
  return "Ish soati: 06:00–18:00 (Toshkent), Dushanba dam (Se–Ya)";
}
