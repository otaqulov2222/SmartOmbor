import { normalizeAssistantQuery } from "./assistant-ux";
import { peekLastWatchdogReport } from "./supply-watchdog-state";
import { lastBotOutbound } from "./telegram-context";

/**
 * QATTIY TELEGRAM SHLYUZ
 * Oxirgi avto-hisobot (kirim nazorati) bor bo‘lsa:
 * «bu nima / hisobot / yuqorida / shu xabar» hech qachon KPI/davomat/kunlik brifingga o‘tmaydi.
 * Taxmin yo‘q — faqat aniq boshqa domen so‘ralganda shlyuz ochiladi.
 */

function hasKirimNazoratiContext(): boolean {
  const watch = peekLastWatchdogReport();
  if (watch?.plain) return true;
  const out = lastBotOutbound("kirim_nazorati");
  return Boolean(out?.plain);
}

/** Aniq boshqa bo‘lim — shlyuzdan o‘tkazamiz. */
function isExplicitOtherDomain(t: string): boolean {
  if (/\bkpi\b/.test(t) && /agent|raqam|dashboard|excel|boshqaruv/.test(t)) return true;
  if (/bugun(gi)?\s*(kun\s*)?(hisobot|holat|nima\s*boldi)|kunlik\s*(hisobot|brif)/.test(t)) return true;
  if (/davomat|kim\s*keldi|kelmagan|kechik/.test(t)) return true;
  if (/oylik|maosh|jarima|avans|payroll/.test(t)) return true;
  if (/\b\d{3,5}-\d{2,4}\b/.test(t) && /tekshir|pachka|status|holat|audit/.test(t)) return true;
  if (/server\s*tolov|\/new|\/clear|\/start|\/yordam/.test(t)) return true;
  if (/agentlar\s*excel|xodimlar\s*(excel|pdf|ro.?yxat)/.test(t)) return true;
  return false;
}

/** Foydalanuvchi oxirgi avto-xabarni so‘rayaptimi? */
function asksAboutLastAutoMessage(t: string): boolean {
  if (/kirim\s*nazorat|dublikat|dona\s*mos|qizil\s*(xabar|hisobot)/.test(t)) return true;
  if (/\bhisobot\b/.test(t)) return true;
  if (/yuqorida|tepada|avvalgi\s*xabar|oxirgi\s*xabar|shu\s*xabar|bu\s*xabar/.test(t)) return true;
  if (/nima\s*(buyicha|bo'?yicha)|buyicha\s*hisobot|bo'?yicha\s*hisobot/.test(t)) return true;
  if (/^(bu|shu)\b/.test(t) && /nima|qanday|hisobot|xabar|edi/.test(t)) return true;
  if (/^nima\s*(bu|edi|u)\b/.test(t)) return true;
  if (/tushuntir|nima\s*degani|nima\s*haqida|neg(a|e)\s*(bunaqa|qizil|yubor)/.test(t)) return true;
  // Qisqa ishora: «bu nima?», «nima bu», «shu?»
  if (t.length <= 48 && /^(bu|shu|nima|va\s*shu|undoq|bunaqa)\b/.test(t)) return true;
  return false;
}

export type TelegramHardRoute = "explain_kirim_nazorati" | null;

/**
 * Groq/KPI/kunlik brifingdan OLDIN chaqiriladi.
 * null = oddiy yordamchi yo‘li.
 */
export function telegramHardRoute(userText: string): TelegramHardRoute {
  const t = normalizeAssistantQuery(userText);
  if (!t) return null;
  if (isExplicitOtherDomain(t)) return null;
  if (!hasKirimNazoratiContext()) return null;
  if (asksAboutLastAutoMessage(t)) return "explain_kirim_nazorati";
  return null;
}

/** Xavfsizlik to‘ri: javob KPI trapiga o‘xshasa va kontekst kirim bo‘lsa — rad. */
export function looksLikeWrongKpiTrap(reply: string): boolean {
  const t = String(reply || "");
  return /KPI uchun soxta yuklab|Dashboard\s*→\s*KPI|agentlar excel/i.test(t)
    && !/Kirim nazorati|dublikat|dona mos/i.test(t);
}
