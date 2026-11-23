/**
 * SmartOmbor yordamchi — til, lavozim, savdo oynasi, portal.
 * Sof funksiyalar: unit-test qilinadi, Groq/MS ga bog‘liq emas.
 */

export const ROLE_LABEL_UZ: Record<string, string> = {
  super_admin: "Rahbar / Super Admin",
  manager: "Menejer",
  sales_admin: "Savdo rahbari",
  warehouse_manager: "Ombor mudiri",
  warehouse_staff: "Ombor xodimi",
  agent: "Savdo agenti",
  accountant: "Bugalter",
  analyst: "Tahlilchi",
  worker: "Ofis xodimi",
  kassir: "Kassir",
  cashier: "Kassir",
  marketolog: "Marketolog",
  marketer: "Marketolog",
};

export function roleLabelUz(role: unknown): string {
  const raw = String(role || "").trim();
  if (!raw) return "Xodim";
  const key = raw.toLowerCase().replace(/\s+/g, "_");
  if (ROLE_LABEL_UZ[key]) return ROLE_LABEL_UZ[key];
  if (ROLE_LABEL_UZ[raw]) return ROLE_LABEL_UZ[raw];
  if (/warehouse[_ ]?staff|ombor|sklad|склад/i.test(raw)) return "Ombor xodimi";
  if (/warehouse[_ ]?manager/i.test(raw)) return "Ombor mudiri";
  if (/sales[_ ]?admin/i.test(raw)) return "Savdo rahbari";
  if (/super[_ ]?admin/i.test(raw)) return "Rahbar / Super Admin";
  if (/^agent$|агент/i.test(raw)) return "Savdo agenti";
  if (/accountant|bugalter|бухгалтер/i.test(raw)) return "Bugalter";
  if (/kassir|cashier|кассир/i.test(raw)) return "Kassir";
  if (/marketolog|marketer|маркетолог/i.test(raw)) return "Marketolog";
  if (/^worker$|ofis\s*xodim/i.test(raw)) return "Ofis xodimi";
  if (/^manager$|menejer/i.test(raw)) return "Menejer";
  if (/analyst|tahlil/i.test(raw)) return "Tahlilchi";
  if (/[а-яёўқғҳʻ’'‘]|ombor|xodim|rahbar|bugalter|kassir|marketolog|menejer/i.test(raw)
    && !/^[a-z0-9_]+$/i.test(raw)) {
    return raw;
  }
  return raw.replace(/_/g, " ");
}

export function publicAppBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.PUBLIC_APP_URL || env.APP_URL || env.PUBLIC_URL || "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

export function portalLinksReply(env: NodeJS.ProcessEnv = process.env): string {
  const base = publicAppBase(env);
  const main = base ? `${base}/` : "Asosiy sayt (login sahifasi)";
  const agent = base ? `${base}/agent` : "/agent";
  const zavod = base ? `${base}/zavod` : "/zavod";
  return [
    "Xodimlar SmartOmbor portaliga shu havolalar orqali kiradi:",
    "",
    `• Asosiy tizim (login): ${main}`,
    `• Agent kabineti: ${agent}`,
    `• Zavod / hamkor kabineti: ${zavod}`,
    "",
    "Login va parol — «Xodimlar» bo‘limida beriladi. Har bir xodim o‘z login/paroli bilan kiradi.",
  ].join("\n");
}

export function wantsDailyAverage(lower: string): boolean {
  const t = String(lower || "").toLowerCase();
  return /o['‘'`´]?rtacha|ortacha|average|\bavg\b|kunlik\s*o['‘'`´]?rtacha|o['‘'`´]?rtacha\s*(savdo|summa|tushum)/.test(t);
}

export function wantsPortalLink(lower: string): boolean {
  const t = String(lower || "").toLowerCase();
  return (
    /qaysi\s*(link|havola|url)/.test(t)
    || /qayerdan\s*kir/.test(t)
    || /kirish\s*(link|havola|url|manzil)/.test(t)
    || /portal(ga)?\s*kir/.test(t)
    || /xodimlar?\s*.{0,40}(link|havola|kiradi|kirish)/.test(t)
    || /login\s*(link|url|havola|manzil)/.test(t)
    || /smart\s*ombor\s*portal/.test(t)
    || /sayt(ga)?\s*kir/.test(t)
    || /havola\s*(ber|ayt|yoz)/.test(t)
  );
}

export function parseDaysWindow(lower: string, fallback = 15): number {
  const t = String(lower || "").toLowerCase();
  const m = t.match(/(\d{1,3})\s*(kun|day|дн|дня|дней)/i)
    || t.match(/(?:oxirgi|so['‘`]?nggi|last|за)\s*(\d{1,3})/i);
  if (m) return Math.min(365, Math.max(1, Number(m[1])));
  if (/hafta|week|недел/.test(t)) return 7;
  // «bir oylik» — `\boy\b` «oylik»ni ushlamaydi
  if (/oylik|o['‘`]ylik|bir\s*oy|shu\s*oy|oy\s*davomida|\boy\b|month|месяц/.test(t)) return 30;
  return fallback;
}

export function isTopSoldIntent(lower: string): boolean {
  const t = String(lower || "").toLowerCase();
  if (isUnsoldIntent(t)) return false;
  if (/(eng\s*ko['‘`]?p|top|reyting|лидер).{0,40}(sot|savdo|tovar|продаж)/.test(t)) return true;
  if (/(sotilgan|продаж).{0,40}(tovar|mahsulot|товар)/.test(t)) return true;
  if (/(ko['‘`]?p\s*sotil|best.?sell|хит\s*продаж)/.test(t)) return true;
  if (/savdo\s*(reyting|top|hisobot)/.test(t)) return true;
  return false;
}

export function isUnsoldIntent(lower: string): boolean {
  const t = String(lower || "").toLowerCase();
  if (/sotilmay|sotilmayotgan|sotuvsiz|harakatsiz|yotib\s*qol|non.?mov|не\s*прод|без\s*продаж|неликвид|idle\s*stock/.test(t)) {
    return true;
  }
  if (/sotilmagan|sotilmay\s*turgan/.test(t) && /tovar|mahsulot|товар/.test(t)) return true;
  return false;
}

export function isSalesSummaryIntent(lower: string): boolean {
  const t = String(lower || "").toLowerCase();
  if (isTopSoldIntent(t) || isUnsoldIntent(t)) return false;
  if (wantsDailyAverage(t) && /savdo|tushum|summa|оборот|выручк/.test(t)) return true;
  if (/bugungi\s*savdo|kechagi\s*savdo|savdo\s*summa|qancha\s*savdo|tushum|оборот|выручк/.test(t)) return true;
  if (/savdo/.test(t) && /(bugun|kecha|hafta|oy|oylik|kun|summa|jami|necha|qancha|o['‘'`´]?rtacha|ortacha)/.test(t)) return true;
  return false;
}

/** Savdo so‘rovi uchun kunlar sonini aniqlash */
export function resolveSalesDays(lower: string): number {
  const t = String(lower || "").toLowerCase();
  const avgAsk = wantsDailyAverage(t);
  if (/kecha|вчера/.test(t)) return 2;
  if (/hafta|week|7\s*kun/.test(t)) return 7;
  if (/oylik|o['‘`]ylik|bir\s*oy|shu\s*oy|\boy\b|month|30\s*kun|месяц/.test(t)) return 30;
  return parseDaysWindow(t, /bugun|сегодня/.test(t) ? 1 : (avgAsk ? 30 : 7));
}

export function formatQty(n: number): string {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function formatSum(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(Number(n))) return null;
  return new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 0 }).format(Math.round(Number(n)));
}

export function buildSalesSummaryReply(input: {
  lower: string;
  days: number;
  from?: string;
  to?: string;
  salesAmount?: number | null;
  salesQty?: number | null;
  draftSalesAmount?: number | null;
  draftNumbers?: string[];
  incomingToday?: number | null;
}): string {
  const avgAsk = wantsDailyAverage(input.lower);
  const days = Math.max(1, Number(input.days) || 1);
  const amountNum = input.salesAmount != null ? Number(input.salesAmount) : null;
  const qtyNum = input.salesQty != null ? Number(input.salesQty) : null;
  const amount = amountNum != null && Number.isFinite(amountNum) ? formatSum(amountNum) : null;
  const qty = qtyNum != null && Number.isFinite(qtyNum) ? formatQty(qtyNum) : null;
  const range = input.from && input.to ? `(${input.from} — ${input.to})` : "";

  if (days <= 1) {
    const draftAmt = input.draftSalesAmount != null ? formatSum(Number(input.draftSalesAmount)) : null;
    const draftNums = Array.isArray(input.draftNumbers) ? input.draftNumbers.join(", ") : "";
    return [
      `Bugungi savdo: ${amount != null ? `${amount} so‘m` : "ma’lumot yo‘q"} (o‘tkazilgan).`,
      draftAmt && Number(input.draftSalesAmount) > 0
        ? `Qoralama: ${draftAmt} so‘m${draftNums ? ` · № ${draftNums}` : ""}.`
        : "",
      input.incomingToday != null ? `Bugungi kirim: ${formatQty(Number(input.incomingToday))} dona.` : "",
    ].filter(Boolean).join("\n");
  }

  const avgAmt = amountNum != null && Number.isFinite(amountNum)
    ? formatSum(amountNum / days)
    : null;
  const avgQty = qtyNum != null && Number.isFinite(qtyNum)
    ? formatQty(qtyNum / days)
    : null;

  if (avgAsk) {
    return [
      `Oxirgi ${days} kun ${range} — kunlik o‘rtacha savdo:`.replace(/\s+/g, " ").trim(),
      avgAmt != null ? `• Kunlik o‘rtacha: ${avgAmt} so‘m/kun` : "• Kunlik o‘rtacha hisoblanmadi",
      avgQty != null ? `• Kunlik o‘rtacha dona: ${avgQty}` : "",
      amount != null ? `• Jami summa: ${amount} so‘m` : "",
      qty != null ? `• Jami dona: ${qty}` : "",
    ].filter(Boolean).join("\n");
  }

  return [
    `Oxirgi ${days} kun ${range} savdo:`.replace(/\s+/g, " ").trim(),
    amount != null ? `• Summa: ${amount} so‘m` : "• Summa olinmadi",
    qty != null ? `• Dona: ${qty}` : "",
    avgAmt != null ? `• Kunlik o‘rtacha: ${avgAmt} so‘m/kun` : "",
  ].filter(Boolean).join("\n");
}

export function formatStaffListReply(rows: Array<{ name?: unknown; login?: unknown; role?: unknown; roleLabel?: unknown }>, onlyAgents = false): string {
  return [
    `${onlyAgents ? "Agentlar" : "Xodimlar"}: ${rows.length} ta.`,
    ...rows.slice(0, 30).map((p) => {
      const role = String(p.roleLabel || roleLabelUz(p.role));
      return `• ${p.name} — login: ${p.login} — lavozim: ${role}`;
    }),
    "",
    "Kirish havolalari: asosiy sayt /, agentlar /agent, zavod /zavod",
  ].join("\n");
}

export function localizeUzbekReply(text: string): string {
  let out = String(text || "");
  const pairs: Array<[RegExp, string]> = [
    [/\brecent[_ ]?logs?\b/gi, "oxirgi jurnal"],
    [/\blocalShipments?\b/gi, "mahalliy yuklar"],
    [/\bmoyskladLatest\b/gi, "MoySklad oxirgi kirim"],
    [/\bmoyskladSupplies\b/gi, "MoySklad kirimlar"],
    [/\blatestLocalPosted\b/gi, "oxirgi yozilgan yuk"],
    [/\blatestLocalAny\b/gi, "oxirgi yuk"],
    [/\bwarehouse_staff\b/gi, "Ombor xodimi"],
    [/\bwarehouse_manager\b/gi, "Ombor mudiri"],
    [/\bsales_admin\b/gi, "Savdo rahbari"],
    [/\bsuper_admin\b/gi, "Rahbar / Super Admin"],
    [/\(\s*agent\s*\)/gi, "(Savdo agenti)"],
    [/\(\s*worker\s*\)/gi, "(Ofis xodimi)"],
    [/\(\s*accountant\s*\)/gi, "(Bugalter)"],
    [/\(\s*manager\s*\)/gi, "(Menejer)"],
    [/\(\s*analyst\s*\)/gi, "(Tahlilchi)"],
    [/\(\s*marketolog\s*\)/gi, "(Marketolog)"],
    [/\(\s*cashier\s*\)/gi, "(Kassir)"],
    // «Javohir — agent» kabi qatorlar
    [/([—\-–•]|\s)\s*agent\b/gi, "$1 Savdo agenti"],
    [/\bposted\b/gi, "yozilgan"],
    [/\baccepted\b/gi, "qabul qilingan"],
    [/\bpending\b/gi, "kutilmoqda"],
    [/\bdraft\b/gi, "qoralama"],
    [/\bstatus\b/gi, "holat"],
    [/\blines\b/gi, "tovar qatorlari"],
    [/\bshipment\b/gi, "yuk xati"],
    [/\bsupply\b/gi, "kirim"],
    [/\berror\b/gi, "xato"],
    [/\bfailed\b/gi, "xato"],
    [/\bsuccess(ful)?\b/gi, "muvaffaqiyatli"],
    [/\btrue\b/gi, "ha"],
    [/\bfalse\b/gi, "yo‘q"],
    [/\bok\b/gi, "tayyor"],
    [/\bnull\b/gi, "yo‘q"],
    [/\bundefined\b/gi, "yo‘q"],
  ];
  for (const [re, to] of pairs) out = out.replace(re, to);
  return out;
}

/** So‘rovni bir xil shaklga keltirish (lotin variantlari, ortiqcha tinish). */
export function normalizeAssistantQuery(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[‘’ʻ`´]/g, "'")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .replace(/[?!.,;:]+$/g, "")
    .trim();
}

/** Haqiqiy tizim javabi — soxta KPI filtriga tushmasin. */
export function isTrustedLocalReply(text: string): boolean {
  const t = String(text || "").trim();
  return (
    /^Bugungi hisobot\s*—/i.test(t)
    || /^Hisobot\s*—/i.test(t)
    || /^Bugungi davomat:/i.test(t)
    || /^Davomat\s*\(/i.test(t)
    || /^Bugungi savdo:/i.test(t)
    || /^Bugungi\s*\(\d{4}-\d{2}-\d{2}\)\s*agentlar/i.test(t)
    || /^Oylik\s*\(/i.test(t)
    || /^Oxirgi\s+\d+\s+kun/i.test(t)
    || /^Xodimlar:\s*\d+/i.test(t)
    || /^Agentlar:\s*\d+/i.test(t)
    || /Pastdagi Yuklab olish tugmasini/i.test(t)
    || /Kirim nazorati/i.test(t)
    || /Yuqoridagi (avtomatik )?xabar|Yuqoridagi hisobot/i.test(t)
    || /MoySklad (yuk\/)?kirim|dublikat va dona/i.test(t)
  );
}

/** Soxta KPI PDF / bo‘sh **** havola javobi */
export function looksLikeFakeKpiDownload(text: string): boolean {
  const t = String(text || "");
  if (/Yuklab olish tugmasini/i.test(t)) return false;
  if (isTrustedLocalReply(t)) return false;
  const low = t.toLowerCase();
  if (!/kpi/.test(low)) return false;
  if (/pdf\s*shaklida|yuklab\s*olish\s*uchun|quyidagi\s*havola|hisobotini\s*yuklab/.test(low)) return true;
  if (/yuklab|pdf|havola/.test(low) && /\*{2,}|\[[^\]]*yuklab/i.test(t)) return true;
  return false;
}

/** Soxta «yuklab olish» markdown havolalarini olib tashlash */
export function stripFakeDownloadLinks(text: string): string {
  let out = String(text || "");
  if (looksLikeFakeKpiDownload(out)) {
    return kpiFollowupReply();
  }
  const before = out;
  // [KPI hisobotini yuklab olish](...) yoki [yuklab olish]
  out = out.replace(/\[[^\]]*?(yuklab|download|hisobot|pdf|excel|csv)[^\]]*?\]\([^)]*\)/gi, "");
  out = out.replace(/\[[^\]]*?(yuklab\s*olish|KPI\s*hisobot|download)[^\]]*?\](?!\()/gi, "");
  out = out.replace(/KPI[\s\S]{0,40}PDF[\s\S]{0,160}/gi, "");
  out = out.replace(/quyidagi\s*havolani\s*bosing\s*:?\s*/gi, "");
  out = out.replace(/yuklab\s*olish\s*uchun\s*\*{0,8}/gi, "");
  out = out.replace(/\*{2,}/g, "");
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (out !== before.trim() && /yuklab|pdf|hisobot|havola/i.test(before) && !/Yuklab olish tugmasini/i.test(out)) {
    if (!out || out.length < 40) return kpiFollowupReply();
    out = `${out}\n\nFayl kerak bo‘lsa aniq yozing: «davomat PDF», «xodimlar excel» yoki KPI raqamlari uchun Dashboard → KPI ga kiring.`;
  }
  return out;
}

/** Har qanday suhbatda foydalanuvchiga «Janob» deb murojaat. */
export function ensureJanobAddress(text: string): string {
  let t = String(text || "").trim();
  if (!t) return t;
  if (/\bjanob\b/i.test(t)) return t;
  if (/^(ha|xa|ok)\b\.?$/i.test(t)) return "Ha, janob.";
  if (/^(ha|xa|ok)\b\.?\s+/i.test(t)) return t.replace(/^(ha|xa|ok)\b\.?\s*/i, "Ha, janob. ");
  if (/^tushundim\b\.?$/i.test(t)) return "Tushundim, janob.";
  if (/^tushundim\b/i.test(t)) return t.replace(/^tushundim\b\.?\s*/i, "Tushundim, janob. ");
  return `Janob,\n${t}`;
}

export function sanitizeAssistantReply(text: string): string {
  let out = String(text || "");
  if (isTrustedLocalReply(out)) {
    out = localizeUzbekReply(out);
    return ensureJanobAddress(out.replace(/\n{3,}/g, "\n\n").trim());
  }
  if (looksLikeFakeKpiDownload(out)) {
    return kpiFollowupReply();
  }
  out = out.replace(/```[\s\S]*?```/g, (block) => {
    if (/JVBERi0|UEsDB|base64|PK\x03\x04/i.test(block) || block.length > 500) return "";
    return block;
  });
  out = out.replace(/###\s*PDF[- ]?fayl[^\n]*\n?/gi, "");
  out = out.replace(/\bJVBERi0[A-Za-z0-9+/=\s]{40,}/g, "");
  out = out.replace(/\bUEsDB[A-Za-z0-9+/=\s]{40,}/g, "");
  out = out.replace(/data:application\/(?:pdf|vnd\.[a-z0-9.-]+);base64,[A-Za-z0-9+/=]+/gi, "");
  out = stripFakeDownloadLinks(out);
  if (looksLikeFakeKpiDownload(out) || (/kpi/i.test(out) && /\*{2,}|yuklab\s*olish\s*uchun/i.test(out))) {
    return ensureJanobAddress(kpiFollowupReply());
  }
  // Tor UI: keng jadvalni olib tashlash — lekin login/portal/http jadvallarini saqlash
  out = out.replace(/(?:^\|.+\|[ \t]*$\n?)+/gm, (table) => {
    if (/https?:\/\/|\/agent|\/zavod|login|portal|havola/i.test(table)) return table;
    const first = table.split("\n").find((l) => l.includes("|")) || "";
    const cols = first.split("|").map((c) => c.trim()).filter(Boolean).length;
    const uuidHits = (table.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []).length;
    if (uuidHits >= 1 || cols >= 4) return "";
    return table;
  });
  // URL ichidagi UUID/tokenlarga tegmaymiz
  out = out.replace(/(https?:\/\/\S+)/gi, (url) => url);
  out = out.replace(/(?<![\/\w-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\/\w-])/gi, "xodim");
  out = localizeUzbekReply(out);
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return ensureJanobAddress(out);
}

/** AI o‘zi haqida / «sen nima agentisan» / «kim yaratdi» */
export function isIdentityIntent(lower: string): boolean {
  const t = normalizeAssistantQuery(lower);
  return (
    /sen\s*(nima|kim)|sani\s*kim|seni\s*kim|nimani?\s*agent|qanday\s*agent|kim\s*san|vazifang|nima\s*qila\s*olasan|nima\s*bilasan/.test(t)
    || /kim\s*yarat|yarat(di|gan|uvchi)|qanaqa\s*model|qanday\s*model|modelsan|qaysi\s*model|openai|gpt-?\d*/.test(t)
    || /who\s*are\s*you|what\s*can\s*you\s*do|who\s*(made|created|built)\s*you/.test(t)
  );
}

/** YYYY-MM-DD ± kun (UTC kalendar). */
export function shiftIsoDate(day: string, by: number): string {
  const [y, m, d] = String(day || "").split("-").map(Number);
  if (!y || !m || !d) return day;
  const dt = new Date(Date.UTC(y, m - 1, d + by));
  return dt.toISOString().slice(0, 10);
}

/** JS getUTCDay: 0=Ya … 6=Sh */
export function weekdayOfIso(day: string): number {
  const [y, m, d] = String(day || "").split("-").map(Number);
  if (!y || !m || !d) return 0;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const WEEKDAY_UZ = ["Yakshanba", "Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba"];

export function weekdayLabelUz(day: string): string {
  return WEEKDAY_UZ[weekdayOfIso(day)] || day;
}

/** Dam / dam olish / weekend / Shanba–Yakshanba so‘rovi. */
export function wantsWeekendBrief(lower: string): boolean {
  const t = normalizeAssistantQuery(lower);
  return (
    /\bshanba\b/.test(t)
    || /\byakshanba\b/.test(t)
    || /dam\s*olish/.test(t)
    || /dam\s*kun/.test(t)
    || /\bdamolish\b/.test(t)
    || /\bweekend\b/.test(t)
    || /выходн/.test(t)
  );
}

/** Matndan hisobot sanalarini ajratish. */
export function parseBriefDates(lower: string, today: string): string[] {
  const t = normalizeAssistantQuery(lower);
  const found: string[] = [];
  const push = (iso: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso) && !found.includes(iso)) found.push(iso);
  };

  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    push(`${m[1]}-${m[2]}-${m[3]}`);
  }
  for (const m of t.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = m[3];
    // 21.11.2026 → DD.MM; 11.21.2026 → MM.DD; ikkalasi ≤12 bo‘lsa UZ: DD.MM
    let dd: number;
    let mm: number;
    if (a > 12 && b >= 1 && b <= 12) {
      dd = a;
      mm = b;
    } else if (b > 12 && a >= 1 && a <= 12) {
      mm = a;
      dd = b;
    } else {
      dd = a;
      mm = b;
    }
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      push(`${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`);
    }
  }
  if (found.length) return found.sort();

  const wantSat = /\bshanba\b/.test(t);
  const wantSun = /\byakshanba\b/.test(t);
  const wantWeekendPhrase = /dam\s*olish|dam\s*kun|\bdamolish\b|\bweekend\b|выходн/.test(t);
  if (wantSat || wantSun || wantWeekendPhrase) {
    // «dam olish» → Shanba+Ya; faqat bitta kun nomi → shu kun; ikkalasi → ikkalasi
    const finalSat = wantWeekendPhrase || wantSat || (!wantSat && !wantSun);
    const finalSun = wantWeekendPhrase || wantSun || (!wantSat && !wantSun);

    const allMonth = /toliq|barcha|hamma/.test(t);
    if (allMonth) {
      const month = today.slice(0, 7);
      let cursor = `${month}-01`;
      while (cursor.startsWith(month) && cursor <= today) {
        const wd = weekdayOfIso(cursor);
        if ((finalSat && wd === 6) || (finalSun && wd === 0)) push(cursor);
        cursor = shiftIsoDate(cursor, 1);
      }
      return found;
    }
    // Eng yaqin o‘tgan/joriy dam juftligi
    const daysSinceSat = (weekdayOfIso(today) + 1) % 7;
    const sat = shiftIsoDate(today, -daysSinceSat);
    const sun = shiftIsoDate(sat, 1);
    if (finalSat) push(sat);
    if (finalSun) push(sun);
    return found;
  }

  if (/\bkecha\b|вчера/.test(t)) {
    push(shiftIsoDate(today, -1));
    return found;
  }

  push(today);
  return found;
}

/** Telegramdagi «yuqorida / bu hisobot» — kunlik brifing EMAS, kirim nazorati. */
export function isWatchdogReportAsk(lower: string): boolean {
  const t = normalizeAssistantQuery(lower);
  // Kontekst injeksiyasini e'tiborsiz qoldirish
  const head = (t.split("[telegram kontekst")[0]?.split("telegram kanal")[0] || t)
    .replace(/---[\s\S]*$/g, "")
    .trim();
  // Aniq boshqa domen — tegma
  if (/\bkpi\b|davomat|oylik|maosh|savdo\s*hisobot|agentlar\s*excel|bugungi\s*kun\s*hisobot/.test(head)) {
    if (!/kirim\s*nazorat|dublikat|dona\s*mos/.test(head)) return false;
  }
  if (/kirim\s*nazorat/.test(head)) return true;
  if (/qizil\s*(xabar|hisobot|ogoh)|dublikat(\s|\b)|dona\s*mos\s*emas/.test(head)) return true;
  // «bu nima buyicha hisobot» / «nima buyicha hisobot» / «hisobot nima»
  if (/nima\s*(buyicha|bo'?yicha)\s*hisobot|hisobot\s*nima|qanday\s*hisobot|bu\s+.*\bhisobot\b|shu\s+.*\bhisobot\b/.test(head)) {
    return true;
  }
  if (/yuqorida|tepada|avvalgi\s*xabar|oxirgi\s*(qizil|avto|bot)?\s*hisobot/.test(head)) return true;
  if (/^bu\s*nima\b|^nima\s*bu\b|^nima\s*edi\b/.test(head) && /hisobot|xabar|nazorat/.test(head)) return true;
  return false;
}

/** Bugungi / kunlik tizim hisoboti — «hisobot ber» vague emas. */
export function isDailyBriefIntent(lower: string): boolean {
  const t = normalizeAssistantQuery(lower);
  if (isIdentityIntent(t)) return false;
  if (isWatchdogReportAsk(t)) return false;
  // Aniq fayl so‘rovi emas
  if (/\b(pdf|xlsx|excel|csv)\b/.test(t) && /davomat|kirim|xodim|staff/.test(t)) return false;
  // Shanba/Yakshanba / dam olish / aniq sana + hisobot
  if (
    /hisobot|holat|xulosa|nima\s*boldi|davomat/.test(t)
    && (
      wantsWeekendBrief(t)
      || /\d{1,2}[./]\d{1,2}[./]\d{4}/.test(t)
      || /\d{4}-\d{2}-\d{2}/.test(t)
    )
    && !/\b(pdf|xlsx|excel|csv)\b/.test(t)
  ) {
    return true;
  }
  if (/kunlik\s*(hisobot|brif|xulosa)|tizim\s*(hisobot|xulosa|holat)|umumiy\s*(hisobot|holat|xulosa)/.test(t)) return true;
  if (/bugun(gi)?\s*(kun|hisobot|holat|xulosa)|kun\s*bo'?yicha|kun\s*buyicha/.test(t)) {
    if (/hisobot|xulosa|holat|nima\s*boldi|ayt|ber|toliq|qanday|nimalar/.test(t)) return true;
  }
  if (/nima\s*boldi|qanday\s*holat|nimalar\s*(boldi|bo'?ldi)|toliq\s*hisobot/.test(t) && /bugun|kun|tizim|umumiy/.test(t)) {
    return true;
  }
  if (
    /hisobot\s*(ber|chiqar|ayt|ol|kerak)/.test(t)
    && /bugun|kun|tizim|umumiy|toliq|holat|nima/.test(t)
    && !/davomat|посещаем|pdf|xlsx|excel/.test(t)
  ) {
    return true;
  }
  if (/^salom\b/.test(t) && /bugun|kun/.test(t) && /hisobot/.test(t) && !/davomat|pdf|xlsx/.test(t)) return true;
  // Qisqa: «bugun nima boldi?»
  if (/^bugun\s*(nima\s*boldi|holat|hisobot)?[!?.]*$/.test(t)) return true;
  return false;
}

/** Davomat / kim keldi */
export function isAttendanceIntent(lower: string): boolean {
  const t = normalizeAssistantQuery(lower);
  if (isDailyBriefIntent(t) && !/davomat|kelgan|kelmagan|kechik/.test(t)) return false;
  if (/bugun\s*kim|kim\s*keldi|kim\s*kelmagan|kelganlar|kelmaganlar|kechikkan/.test(t)) return true;
  if (/bugungi?\s*davomat|davomat\s*(holat|ro'?yxat|bugun)|сегодня\s*кто|кто\s*приш/.test(t)) return true;
  if (/davomat/.test(t) && /(bugun|holat|ro'?yxat|kim|stat|hozir|ber|ayt)/.test(t) && !/tushun|qanday\s*bolim|pdf|excel/.test(t)) {
    return true;
  }
  return false;
}

/** Oylik / maosh / jarima */
export function isPayrollIntent(lower: string): boolean {
  const t = normalizeAssistantQuery(lower);
  return /oylik|maosh|ish\s*haqi|jarima|avans|bonus|net\s*to'?lov|payroll|зарплат|оклад/.test(t);
}

export function wantsVagueGive(lower: string): boolean {
  const t = normalizeAssistantQuery(lower);
  // Aniq intentlar vague emas
  if (isDailyBriefIntent(t) || isAttendanceIntent(t) || isPayrollIntent(t) || isIdentityIntent(t)) return false;
  if (isSalesSummaryIntent(t) || isTopSoldIntent(t) || isUnsoldIntent(t) || isStaffListIntent(t)) return false;
  if (wantsPortalLink(t)) return false;
  // «kere ber», «kerak», qisqa buyruqlar — Groq ga umuman ketmasin
  if (/^(kere|kerak)(\s*ber)?[!?.]*$/.test(t)) return true;
  if (/^(ber|yubor|yoz|chiqar)[!?.]*$/.test(t)) return true;
  // Faqat qisqa/noaniq «hisobot ber» — batafsil so‘rov emas
  if (/hisobot\s*ber/.test(t) && (t.length > 40 || /bugun|kun|toliq|holat|nima/.test(t))) return false;
  return /yuklab\s*ber|pdf\s*ber|excel\s*ber|xlsx\s*ber|fayl\s*ber|hisobot\s*ber|kere\s*ber|kerak\s*ber/.test(t);
}

export function vagueGiveReply(prevAssistant = ""): string {
  // Faqat aniq KPI konteksti — «agent» so‘zi AI suhbatidan kelib qolmasin
  if (/kpi|dashboard\s*→\s*kpi|agentlar\s*\(|boshqaruv\s*\/\s*agentlar/i.test(prevAssistant)) {
    return kpiFollowupReply();
  }
  return [
    "Nima kerakligini aniq yozing. Masalan:",
    "• bugungi kun hisoboti",
    "• bugun kim keldi",
    "• oylik holati",
    "• oxirgi yukni tekshir",
    "• davomat PDF / kirim excel / agentlar excel",
    "• KPI raqamlari → Dashboard → KPI",
  ].join("\n");
}

/** Oxirgi to‘siq: soxta PDF / **** / uydirma havola hech qachon chiqmasin */
export function finalizeAssistantReply(text: string, hasFiles = false): string {
  const raw = String(text || "");
  if (isTrustedLocalReply(raw) || hasFiles) {
    return ensureJanobAddress(sanitizeAssistantReply(raw));
  }
  let out = sanitizeAssistantReply(raw);
  if (hasFiles) return ensureJanobAddress(out);
  if (looksLikeFakeKpiDownload(out) || (/kpi/i.test(out) && /pdf|yuklab\s*olish\s*uchun|\*{2,}/i.test(out))) {
    return ensureJanobAddress(kpiFollowupReply());
  }
  // Bo‘sh yoki faqat **** qolgan javob — umumiy yo‘l-yo‘riq (KPI emas, agar KPI yo‘q)
  if (!out.trim() || /^\*{2,}$/.test(out.trim()) || /yuklab\s*olish\s*uchun\s*\*{0,8}\s*$/i.test(out)) {
    return ensureJanobAddress(vagueGiveReply(""));
  }
  return ensureJanobAddress(out);
}

export function isKpiAgentsIntent(lower: string): boolean {
  const t = normalizeAssistantQuery(lower);
  if (isIdentityIntent(t) || isDailyBriefIntent(t) || isAttendanceIntent(t) || isWatchdogReportAsk(t)) return false;
  // «KPI» so‘zi bo‘lmasa — agentlar ro‘yxati KPI emas
  if (!/kpi/.test(t)) return false;
  return /agent|ro.?yxat|kim|bugun|yozilgan|bor|qaysi/.test(t);
}

export function identityReply(): string {
  return [
    "Janob, men Smart Ombor yordamchisiman.",
    "Meni Firdavs yaratgan — OpenAI yoki GPT emas.",
    "",
    "Yordam bera olaman:",
    "• bugungi umumiy hisobot (yuk, savdo, davomat)",
    "• yuk xati tekshiruvi / pachka / MoySklad",
    "• davomat, oylik, jarima",
    "• savdo, sotilmagan tovar, qoldiq",
    "• PDF/Excel hisobotlar",
    "",
    "Masalan yozing: «bugungi kun hisoboti» yoki «0066-015 tekshir».",
  ].join("\n");
}

export function formatKpiAgentsReply(rows: Array<{ name?: unknown; login?: unknown; role?: unknown }>, today: string): string {
  if (!rows.length) {
    return `Bugungi (${today}) kunga agentlar topilmadi. KPI raqamlari: Dashboard → KPI.`;
  }
  return [
    `Bugungi (${today}) agentlar (${rows.length} ta):`,
    ...rows.slice(0, 40).map((p) => `• ${p.name}${p.login ? ` — ${p.login}` : ""} — ${roleLabelUz(p.role)}`),
    "",
    "Aniq KPI raqamlari: Dashboard → KPI → Boshqaruv / Agentlar.",
    "Chatda soxta PDF havola bermayman. Excel kerak bo‘lsa: «agentlar excel» deb yozing.",
  ].join("\n");
}

export function kpiFollowupReply(): string {
  return [
    "KPI uchun soxta yuklab olish havolasi yo‘q.",
    "Aniq raqamlar: Dashboard → KPI → Boshqaruv / Agentlar.",
    "Ro‘yxatni Excel qilib bersam: «agentlar excel» deb yozing.",
  ].join("\n");
}

/** Staff ro‘yxati so‘rovi (loginlar, kimlar bor…) */
export function isStaffListIntent(lower: string): boolean {
  const t = normalizeAssistantQuery(lower);
  if (wantsPortalLink(t) || isKpiAgentsIntent(t) || isIdentityIntent(t) || isDailyBriefIntent(t)) return false;
  return /xodimlar\s*ro.?yxat|kimlar\s*bor|staff\s*list|loginlar|barcha\s*xodim|agentlar\s*ro.?yxat|xodimlar\s*login|login\s*parol|xodimlar\s*va\s*login|agentlar\s*excel/.test(t);
}

/**
 * Intent prioriteti (yuqoridan pastga).
 * Test va routing uchun: birinchi mos kelgan yo‘l.
 */
export type AssistantIntent =
  | "identity"
  | "watchdog_report"
  | "daily_brief"
  | "attendance"
  | "payroll"
  | "portal"
  | "staff"
  | "kpi_agents"
  | "vague_give"
  | "sales"
  | "top_sold"
  | "unsold"
  | "other";

export function classifyAssistantIntent(raw: string): AssistantIntent {
  const t = normalizeAssistantQuery(raw);
  if (isIdentityIntent(t)) return "identity";
  // Kunlik brifingdan OLDIN — aks holda «yuqorida hisobot» chalkashadi
  if (isWatchdogReportAsk(t)) return "watchdog_report";
  if (isDailyBriefIntent(t)) return "daily_brief";
  if (isAttendanceIntent(t)) return "attendance";
  if (isPayrollIntent(t)) return "payroll";
  if (wantsPortalLink(t)) return "portal";
  if (isKpiAgentsIntent(t)) return "kpi_agents";
  if (isStaffListIntent(t)) return "staff";
  if (isTopSoldIntent(t)) return "top_sold";
  if (isUnsoldIntent(t)) return "unsold";
  if (isSalesSummaryIntent(t)) return "sales";
  if (wantsVagueGive(t)) return "vague_give";
  return "other";
}
