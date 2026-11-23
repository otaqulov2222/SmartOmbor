/**
 * Kirim nazorati — YAGONA to‘g‘ri izoh (Telegram/yordamchi uydirma gapirmasligi uchun).
 */

export function kirimNazoratiTruthPlain(): string {
  return [
    "TO‘G‘RI HOLAT (qisqa):",
    "",
    "1) Qizil hisobot — MoySklad kirimlarini dublikat va dona bo‘yicha tekshiradi. Kunlik davomat/KPI emas.",
    "",
    "2) Dublikat sababi asosan eski tizim logikasi: sticky moyskladId + qayta kirimda yangi hujjat ochish + zaif verify. Bu «xodim 2 marta bosgan» deb umuman tushuntirilmaydi.",
    "",
    "3) Dona farqi: yuk xati juft×qop jami ≠ MS pozitsiya jami; yoki dublikatlar MS ni shishirgan.",
    "",
    "4) Avto-o‘chirish YOQ — ataylab xavfsizlik. «Import sozlamasida yoqing» deb maslahat BERILMAYDI.",
    "",
    "5) Hujjat yo‘q (masalan 0007-004, holat sent, moyskladId yo‘q) = kirim hali yozilmagan. Bu «kontragent/ombor/tashkilot tanlanmagan» EMAS — ular faqat hujjat yaratilganda tanlanadi.",
    "",
    "6) Hozir: ombor «Qabul qilish» bosganda tizim o‘zi default ombor+kontragent bilan MoySkladga kirim yozadi.",
    "",
    "Yolg‘on/noto‘g‘ri gaplar (aytilmasin):",
    "• xodim qo‘lda bir necha marta import qilgani asosiy sabab",
    "• avto-o‘chirishni yoqing",
    "• hujjat yo‘q bo‘lsa ham agent/ombor/tashkilot tanlanmagan",
    "• bu KPI yoki kunlik brifing",
  ].join("\n");
}

export function kirimNazoratiTruthHtml(): string {
  return [
    "<b>To‘g‘ri holat</b>",
    "",
    "1) Qizil hisobot = <b>Kirim nazorati</b> (MS dublikat + dona). Kunlik/KPI emas.",
    "2) Dublikat asosan <b>eski sticky + qayta kirim</b> logikasidan. «Xodim 2 marta bosgan» asosiy sabab emas.",
    "3) Dona farqi = yuk juft×qop ≠ MS jami, yoki dublikat shishishi.",
    "4) Avto-o‘chirish YOQ — ataylab. Uni «yoqing» demaymiz.",
    "5) Hujjat yo‘q = kirim yozilmagan. Agent/ombor/tashkilot «tanlanmagan» emas.",
    "6) Endi qabul qilish → tizim o‘zi MS kirim yozadi.",
  ].join("\n");
}

export function isKirimTruthCheckAsk(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return /to'?g'?ri\s*(ma'?lumot|hisobot|javob)|toliq\s*(va\s*)?(to'?g'?ri|malumot)|rostmi|haqiqatmi|noto'?g'?ri\s*emasmi|togri\s*malumot|berayabsanmi|berayapsanmi/.test(t);
}

export function isKirimCauseAsk(text: string): boolean {
  const t = String(text || "").toLowerCase();
  if (/sabab\s*(nima|lari)?\s*\??$|^nega\b|^nima\s*uchun\b/.test(t.trim())) return true;
  return /sabab|nega\s*(bunaqa|chiq|bol|muammo)|muammo\s*nima|kelib\s*chiq|nima\s*uchun/.test(t)
    && /dublikat|dona|kirim|hisobot|ms|moy|nazorat|muammo|sticky|tanlan|bog'?lan/.test(t);
}

export function isBriefAckAsk(text: string): boolean {
  const t = String(text || "").toLowerCase().trim();
  if (t.length > 160) return false;
  return /^(ha\b|ok\b|tushundim|tushundingmi|shunday\s*qil|shundan\s*keyin|faqat\s*so'?ralgan|ortiqcha\s*(gap|so'?z)|juda\s*yaxshi)/.test(t)
    || /tushundingmi\s*\??$|shunday\s*javob\s*ber|ortiqcha\s*(so'?z|qo'?shimcha)|faqat\s*so'?ralgan/.test(t);
}
