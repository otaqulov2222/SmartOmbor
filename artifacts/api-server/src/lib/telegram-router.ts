import { normalizeAssistantQuery } from "./assistant-ux";
import {
  isBriefAckAsk,
  isKirimCauseAsk,
  isKirimFixAsk,
  isKirimTruthCheckAsk,
  kirimNazoratiFixHtml,
  kirimNazoratiFixPlain,
  kirimNazoratiTruthHtml,
  kirimNazoratiTruthPlain,
} from "./kirim-truth";
import { peekLastWatchdogReport } from "./supply-watchdog-state";
import { lastBotOutbound } from "./telegram-context";

/**
 * QATTIY TELEGRAM SHLYUZ — uydirma sabab/KPI/kunlik brifing yo‘q.
 * «Tushundim» bilan savolni yutib yubormaslik.
 */

function hasKirimNazoratiContext(): boolean {
  const watch = peekLastWatchdogReport();
  if (watch?.plain) return true;
  return Boolean(lastBotOutbound("kirim_nazorati")?.plain);
}

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

function asksAboutLastAutoMessage(t: string): boolean {
  if (/kirim\s*nazorat|dublikat|dona\s*mos|qizil\s*(xabar|hisobot)/.test(t)) return true;
  if (/\bhisobot\b/.test(t) && !/to'?g'?ri|toliq|rostmi|haqiqat/.test(t)) return true;
  if (/yuqorida|tepada|avvalgi\s*xabar|oxirgi\s*xabar|shu\s*xabar|bu\s*xabar/.test(t)) return true;
  if (/nima\s*(buyicha|bo'?yicha)|buyicha\s*hisobot|bo'?yicha\s*hisobot/.test(t)) return true;
  // «buni/bunisi/shu» — \b «buni» ni sindirmasin
  if (/^(bu|shu)\w*\b/.test(t) && /nima|qanday|hisobot|xabar|edi|tuzat|yech/.test(t)) return true;
  if (/^nima\s*(bu|edi|u)\b/.test(t)) return true;
  if (/tushuntir|nima\s*degani|nima\s*haqida/.test(t)) return true;
  if (t.length <= 48 && /^(bu|shu)\w*\b|^(nima|va\s*shu|undoq|bunaqa)\b/.test(t)) return true;
  return false;
}

export type TelegramHardRoute =
  | "explain_kirim_nazorati"
  | "kirim_truth"
  | "kirim_cause"
  | "kirim_fix"
  | "brief_ack"
  | "identity"
  | null;

export function telegramHardRoute(userText: string): TelegramHardRoute {
  const t = normalizeAssistantQuery(userText);
  if (!t) return null;

  // «Qanday tuzatamiz?» — AVVAL (tushundim/ack yutib yubormasin)
  if (isKirimFixAsk(t)) return "kirim_fix";

  // Identitet — faqat aniq «kim/model» (oddiy «qanday tuzat» emas)
  if (
    /kim\s*yarat|yarat(di|gan)\b|qanaqa\s*model|qanday\s*model|modelsan|sani\s*kim|seni\s*kim|sen\s*(nima|kim)\b|openai|gpt-?\d*/.test(t)
    || /who\s*(are|made|created|built)\s*you/.test(t)
  ) {
    return "identity";
  }

  // Qisqa tasdiq — faqat haqiqiy ack (savol bo‘lsa yo‘q)
  if (isBriefAckAsk(t)) return "brief_ack";

  // «To‘g‘ri/to‘liq malumotmi?»
  if (isKirimTruthCheckAsk(t)) return "kirim_truth";

  // «Sabab nima?»
  if (isKirimCauseAsk(t)) return "kirim_cause";

  if (isExplicitOtherDomain(t)) return null;
  if (!hasKirimNazoratiContext()) return null;
  if (asksAboutLastAutoMessage(t)) return "explain_kirim_nazorati";
  return null;
}

export function telegramHardReply(route: Exclude<TelegramHardRoute, null>, userText: string): { html: string; plain: string } {
  if (route === "identity") {
    const plain = [
      "Janob, men Smart Ombor yordamchisiman.",
      "Meni Firdavs yaratgan — OpenAI yoki GPT emas.",
    ].join("\n");
    return { html: plain, plain };
  }
  if (route === "brief_ack") {
    const plain = /tushundingmi|shunday\s*javob|faqat\s*so'?ralgan|ortiqcha/.test(userText.toLowerCase())
      ? "Ha, janob. Faqat so‘ralganiga qisqa va to‘g‘ri javob beraman."
      : "Ha, janob.";
    return { html: plain, plain };
  }
  if (route === "kirim_fix") {
    const last = peekLastWatchdogReport();
    const headHtml = kirimNazoratiFixHtml();
    const headPlain = kirimNazoratiFixPlain();
    if (!last?.plain) return { html: headHtml, plain: headPlain };
    const extraHtml = `\n\n<b>Oxirgi skan</b>: ${last.when || "—"} · ${last.scanned} yuk · ${last.findings} topilma`;
    const extraPlain = `\n\nOxirgi skan (${last.when || "—"}): ${last.scanned} yuk, ${last.findings} topilma.`;
    return { html: headHtml + extraHtml, plain: headPlain + extraPlain };
  }
  if (route === "kirim_truth" || route === "kirim_cause") {
    return { html: kirimNazoratiTruthHtml(), plain: kirimNazoratiTruthPlain() };
  }
  // explain — truth + oxirgi skan + qisqa tuzatish
  const last = peekLastWatchdogReport();
  const head = kirimNazoratiTruthHtml();
  const plainHead = kirimNazoratiTruthPlain();
  const fixHint = "\n\n<b>Tuzatish:</b> «qanday tuzatamiz» deb yozing — qadamma-qadam yo‘l beraman.";
  const fixHintPlain = "\n\nTuzatish uchun: «qanday tuzatamiz» deb yozing.";
  if (!last?.plain) {
    return { html: head + fixHint, plain: plainHead + fixHintPlain };
  }
  const extra = [
    "",
    `<b>Oxirgi skan</b>: ${last.when || "—"} · ${last.scanned} yuk · ${last.findings} topilma`,
    `<pre>${String(last.plain).replace(/&/g, "&amp;").replace(/</g, "&lt;").slice(0, 1800)}</pre>`,
    fixHint,
  ].join("\n");
  return {
    html: `${head}\n${extra}`,
    plain: `${plainHead}\n\nOxirgi skan (${last.when || "—"}):\n${last.plain.slice(0, 1800)}${fixHintPlain}`,
  };
}

export function looksLikeWrongKpiTrap(reply: string): boolean {
  const t = String(reply || "");
  return /KPI uchun soxta yuklab|Dashboard\s*→\s*KPI|agentlar excel/i.test(t)
    && !/Kirim nazorati|dublikat|dona mos/i.test(t);
}

/** Groq «hammasi to‘g‘ri» deb yolg‘on tasdiqlasa. */
export function looksLikeFalseTruthStamp(reply: string): boolean {
  return /to'?liq va to'?g'?ri|ma'?lumot.*to'?liq va to'?g'?ri|hisobot.*to'?liq va to'?g'?ri/i.test(reply)
    && !/yolg'?on|noto'?g'?ri gaplar|ataylab xavfsizlik/i.test(reply);
}

/** «Ha, janob, tushundim» — savolga javob emas. */
export function looksLikeUselessAck(reply: string): boolean {
  const t = String(reply || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (t.length > 80) return false;
  return /^(ha[,.]?\s*)?(janob[,.]?\s*)?(tushundim|ok|xa|ha)\.?$/.test(t)
    || /^ha,\s*janob,?\s*tushundim\.?$/.test(t)
    || /^(janob,?\s*)?tushundim\.?$/.test(t);
}
