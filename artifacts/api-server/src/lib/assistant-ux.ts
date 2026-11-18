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

/** Soxta KPI PDF / bo‘sh **** havola javobi */
export function looksLikeFakeKpiDownload(text: string): boolean {
  const t = String(text || "");
  if (/Yuklab olish tugmasini/i.test(t)) return false;
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

export function sanitizeAssistantReply(text: string): string {
  let out = String(text || "");
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
    return kpiFollowupReply();
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
  return out;
}

export function wantsVagueGive(lower: string): boolean {
  const t = String(lower || "").toLowerCase().trim();
  return /^(kere|kerak)\s*ber\b|^ber\b|^yubor\b|yuklab\s*ber|pdf\s*ber|excel\s*ber|xlsx\s*ber|fayl\s*ber|hisobot\s*ber|kere\s*ber|kerak\s*ber/.test(t);
}

export function isKpiAgentsIntent(lower: string): boolean {
  const t = String(lower || "").toLowerCase();
  if (!/kpi/.test(t)) return false;
  return /agent|ro.?yxat|kim|bugun|yozilgan|bor|qaysi/.test(t);
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
  const t = String(lower || "").toLowerCase();
  if (wantsPortalLink(t)) return false;
  if (isKpiAgentsIntent(t)) return false;
  return /xodimlar\s*ro.?yxat|kimlar\s*bor|staff\s*list|loginlar|barcha\s*xodim|agentlar\s*ro.?yxat|xodimlar\s*login|login\s*parol|xodimlar\s*va\s*login|agentlar\s*excel/.test(t);
}
