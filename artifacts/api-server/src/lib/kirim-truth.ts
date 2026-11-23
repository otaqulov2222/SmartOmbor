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

/** «Qanday tuzatamiz / nima qilamiz?» — tushundim deb yutib yuborilmasin */
export function isKirimFixAsk(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return /qanday\s*tuzat|tuzat(amiz|amz|ish|ilsin)|nima\s*qil(amiz|aylik|ish)|qanday\s*yech|yechamiz|qanday\s*toza|tozalaymiz|nima\s*qilish\s*kerak|qanday\s*hal/.test(t)
    || (/tuzat|yech|toza/.test(t) && /(?:bu|shu|hisobot|dublikat|dona|kirim|muammo|xato|qizil)/.test(t));
}

export function kirimNazoratiFixPlain(): string {
  return [
    "Janob, yuqoridagi Kirim nazorati xatolarini shunday tuzatamiz:",
    "",
    "1) Dublikat / «Dublikat tozalanmadi»",
    "   • MoySkladda shu raqamdagi ortiqcha kirim (supply) hujjatlarini oching.",
    "   • Noto‘g‘ri/dublikatini qo‘lda o‘chiring yoki bekor qiling (MS ruxsati bo‘lishi shart).",
    "   • Smart Omborda to‘g‘ri bitta hujjat qolsin; sticky bog‘ chalkash bo‘lsa — avval MS tozalang.",
    "",
    "2) «MS bor, dona mos emas» / «to‘g‘ri dona yo‘q»",
    "   • Yuk xatidagi juft×qop jami = MS kirimdagi dona jami bo‘lishi kerak.",
    "   • MS da packs.quantity / qatorlarni yuk xati bilan solishtiring; xato sonni tuzating.",
    "   • Dublikatlar donani shishirgan bo‘lsa — avval dublikatni olib tashlang, keyin donani tekshiring.",
    "",
    "3) Sticky / 404 / «yo‘qolgan sticky uzildi»",
    "   • ✅ bo‘lsa — tizim bog‘ni tozalagan, qo‘shimcha ish yo‘q.",
    "   • Hali qizil bo‘lsa — Hamkor → yuk → holatni tekshiring; kerak bo‘lsa qayta «Qabul qilish».",
    "",
    "4) Hujjat yo‘q (sent, moyskladId yo‘q)",
    "   • Ombor yukni tekshirib «Qabul qilish» bosadi — tizim o‘zi MS kirim yozadi.",
    "",
    "Muhim: avto-o‘chirishni «yoqing» demaymiz; taxmin bilan yangi kirim yaratilmaydi.",
    "Aniq yuk kerak bo‘lsa raqamni yozing (masalan 0044-004) — shu yuk bo‘yicha qadam beraman.",
  ].join("\n");
}

export function kirimNazoratiFixHtml(): string {
  return [
    "<b>Janob, qanday tuzatiladi</b>",
    "",
    "1) <b>Dublikat / tozalanmadi</b> — MoySkladda ortiqcha kirimni qo‘lda o‘chiring (ruxsat kerak). Bitta to‘g‘ri hujjat qolsin.",
    "2) <b>Dona mos emas</b> — yuk juft×qop = MS dona; packs.quantity ni tuzating. Avval dublikatni olib tashlang.",
    "3) <b>Sticky/404 ✅</b> — bog‘ tozalangan. Hali qizil bo‘lsa — yukni qayta qabul qiling.",
    "4) <b>Hujjat yo‘q</b> — «Qabul qilish» → tizim MS kirim yozadi.",
    "",
    "Avto-o‘chirishni yoqmaymiz. Aniq yuk raqamini yozsangiz — shu bo‘yicha qadam beraman.",
  ].join("\n");
}

export function isBriefAckAsk(text: string): boolean {
  const t = String(text || "").toLowerCase().trim();
  if (t.length > 80) return false;
  // Savol / buyruq — hech qachon «tushundim»ga tushmasin
  if (/[?]/.test(t)) return false;
  if (/qanday|nima|nega|sabab|tuzat|yech|tekshir|hisobot|dublikat|dona|kirim|ber|qil/.test(t)) return false;
  return /^(ha|ok|xa|tushundim|tushundingmi)\.?$/.test(t)
    || /^(juda\s*yaxshi|shunday\s*qil|shundan\s*keyin)\.?$/.test(t)
    || /^(faqat\s*so'?ralgan|ortiqcha\s*(gap|so'?z)).{0,40}$/.test(t)
    || /tushundingmi\s*\??$/.test(t);
}
