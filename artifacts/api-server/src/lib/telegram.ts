import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./data-dir";
import { idleDays, loadCatalog, peekCatalog } from "./catalog";
import { textPdf } from "./report-pdf";
import { logger } from "./logger";
import { orderBasis, orderRecommendations, productTraits } from "./recommendations";
import { recommendationPdf, recommendationRows, recommendationXlsx } from "./reco-export";

const STATE_FILE = dataFile("telegram.json");
const HOUR = 19;

interface TelegramState {
  chatId: number | null;
  offset: number;
  sentOn: string | null;
  sentPdfOn: string | null;
}

function readState(): TelegramState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<TelegramState>;
    return { chatId: parsed.chatId ?? null, offset: parsed.offset ?? 0, sentOn: parsed.sentOn ?? null, sentPdfOn: parsed.sentPdfOn ?? null };
  } catch {
    return { chatId: null, offset: 0, sentOn: null, sentPdfOn: null };
  }
}

function writeState(state: TelegramState) {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, STATE_FILE);
}

function token() {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
}

async function telegram(method: string, body: Record<string, unknown>) {
  const key = token();
  if (!key) return null;
  const response = await fetch(`https://api.telegram.org/bot${key}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35_000),
  });
  if (!response.ok) {
    const detail = await response.text();
    logger.warn({ status: response.status, detail: detail.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot").slice(0, 240) }, "Telegram request failed");
    return null;
  }
  return response.json() as Promise<{ ok?: boolean; result?: unknown }>;
}

function pieces(value: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value).replace(/\u00a0|\u202f/g, " ");
}

function piecesDecimal(value: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1, minimumFractionDigits: 0 }).format(value).replace(/\u00a0|\u202f/g, " ");
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const COLOR_LABEL: Record<string, string> = {
  qora: "Qora",
  oq: "Oq",
  jigarrang: "Jigarrang",
  sariq: "Sariq",
  qizil: "Qizil",
  kok: "Ko‘k",
  yashil: "Yashil",
  kulrang: "Kulrang",
  bej: "Bej",
  pushti: "Pushti",
};

function modelTitle(name: string) {
  const colors = Object.values(COLOR_LABEL).map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const titled = name
    .replace(/\d{2}\s*[-–]\s*\d{2}/g, " ")
    .replace(new RegExp(`\\(\\s*(?:${colors})\\s*\\)`, "gi"), " ")
    .replace(new RegExp(`\\b(?:${colors})\\b`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
  return titled || name;
}

function tashkentParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { day: `${pick("day")}.${pick("month")}.${pick("year")}`, hour: Number(pick("hour")), stamp: `${pick("year")}-${pick("month")}-${pick("day")}` };
}

function titleMark(index: number, model: string) {
  return `<a href="https://smartombor.onrender.com/recommendations"><b>${String(index).padStart(2, "0")}   ${escapeHtml(model)}</b></a>`;
}

function orderCard(index: number, model: string, rows: ReturnType<typeof orderRecommendations>) {
  const sorted = [...rows].sort((a, b) => {
    const left = productTraits(a.product.name).size ?? "";
    const right = productTraits(b.product.name).size ?? "";
    return left.localeCompare(right, "uz");
  });
  const lines = sorted.map((line) => {
    const traits = productTraits(line.product.name);
    const size = traits.size ? escapeHtml(traits.size) : "o‘lchamsiz";
    const color = traits.color ? COLOR_LABEL[traits.color] : "";
    const identity = color ? `${size} · ${escapeHtml(color)}` : size;
    const marks = [
      line.product.code ? `kod <code>${escapeHtml(line.product.code)}</code>` : "",
      line.product.article ? `artikul ${escapeHtml(line.product.article)}` : "",
    ].filter(Boolean).join(" · ");
    const basis = orderBasis(line);
    return [
      `<b>${identity}</b>`,
      marks,
      `${basis.windowDays} kunda <b>${pieces(basis.sold)}</b> dona sotilgan.`,
      `Hozir qoldiq <b>${pieces(line.onHand)}</b> dona. Yo‘lda <b>${pieces(line.inTransit)}</b> dona.`,
      `Shu tezlikda qoldiq <b>${piecesDecimal(basis.coverDays)}</b> kunga yetadi.`,
      `${basis.coverTarget} kunlik qoldiq uchun <b>${pieces(basis.target)}</b> dona kerak.`,
      `<b>Buyurtma:</b> <code>${pieces(line.suggestedQuantity)} dona</code>`,
    ].filter(Boolean).join("\n");
  });
  const total = rows.reduce((sum, line) => sum + line.suggestedQuantity, 0);
  const foot = rows.length > 1 ? `\n\nShu modeldan jami buyurtma: <code>${pieces(total)} dona</code>` : "";
  return `<blockquote>${titleMark(index, model)}\n\n${lines.join("\n\n")}${foot}</blockquote>`;
}

function idleCard(index: number, name: string, code: string | null, stock: number, days: number) {
  const traits = productTraits(name);
  const color = traits.color ? COLOR_LABEL[traits.color] : "";
  const size = traits.size ? `${escapeHtml(traits.size)} · ` : "";
  const tone = color ? `${escapeHtml(color)} · ` : "";
  const mark = code ? `<code>${escapeHtml(code)}</code> · ` : "";
  const label = days >= 90 ? "90 kun savdosiz" : "30 kun savdosiz";
  return `<blockquote>${titleMark(index, modelTitle(name))}\n${size}${tone}${mark}qoldiq <code>${pieces(stock)} dona</code>\n<i>${label}</i></blockquote>`;
}

export function digestParts() {
  const catalog = peekCatalog();
  const when = tashkentParts();
  if (!catalog) return [`<b>Smart Ombor</b>\n${when.day}\n\nKatalog hali yuklanmagan.`];
  const lines = orderRecommendations(catalog).slice(0, 12);
  const total = lines.reduce((sum, line) => sum + line.suggestedQuantity, 0);
  const groups = new Map<string, typeof lines>();
  for (const line of lines) {
    const key = modelTitle(line.product.name);
    const list = groups.get(key) ?? [];
    list.push(line);
    groups.set(key, list);
  }
  const cards = [...groups.entries()].map(([model, rows], index) => orderCard(index + 1, model, rows));
  const parts: string[] = [];
  let current = lines.length
    ? ["<b>Smart Ombor</b>", when.day, "", `<a href="https://smartombor.onrender.com/recommendations"><b>Buyurtma</b></a>`, `Eng katta ${pieces(lines.length)} ta o‘lcham · ${pieces(groups.size)} ta model`, `Jami buyurtma: <code>${pieces(total)} dona</code>`, "", "Har bir miqdor shu o‘lchamning o‘z savdosidan olingan.", "Maqsad — omborda 30 kunga yetadigan qoldiq."].join("\n")
    : `<b>Smart Ombor</b>\n${when.day}\n\n<b>Buyurtma</b>\nBugun buyurtma talab qiladigan mahsulot yo‘q.`;
  for (const card of cards) {
    const next = `${current}\n\n${card}`;
    if (next.length > 3800) {
      parts.push(current);
      current = card;
    } else current = next;
  }
  parts.push(current);
  const idle = catalog.products
    .map((product) => ({ product, days: idleDays(product, catalog.salesCoverage) }))
    .filter((row) => row.days != null && row.days >= 30 && row.product.stock > 0)
    .sort((a, b) => (b.days ?? 0) - (a.days ?? 0) || b.product.stock - a.product.stock)
    .slice(0, 8);
  if (idle.length) {
    const stock = idle.reduce((sum, row) => sum + row.product.stock, 0);
    const idleCards = idle.map((row, index) => idleCard(index + 1, row.product.name, row.product.code, row.product.stock, row.days ?? 30));
    let idleText = ["<b>Smart Ombor</b>", when.day, "", "<b>Turib qolgan</b>", `${pieces(idle.length)} ta mahsulot · qoldiq <code>${pieces(stock)} dona</code>`, "Savdo kamida 30 kundan beri yo‘q, omborda esa qolgan."].join("\n");
    for (const card of idleCards) {
      const next = `${idleText}\n\n${card}`;
      if (next.length > 3800) {
        parts.push(idleText);
        idleText = card;
      } else idleText = next;
    }
    parts.push(idleText);
  }
  return parts;
}

const DOWNLOADS = {
  inline_keyboard: [[
    { text: "PDF yuklab olish", callback_data: "reco-pdf" },
    { text: "Excel yuklab olish", callback_data: "reco-xlsx" },
  ]],
};

async function send(chatId: number, text: string, markup?: typeof DOWNLOADS) {
  const result = await telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(markup ? { reply_markup: markup } : {}),
  });
  return Boolean(result && (result as { ok?: boolean }).ok !== false);
}

async function sendDigest(chatId: number) {
  const parts = digestParts();
  let sent = true;
  for (let index = 0; index < parts.length; index += 1) {
    sent = await send(chatId, parts[index], index === 0 ? DOWNLOADS : undefined) && sent;
  }
  return sent;
}

const WELCOME = "<b>Smart Ombor</b>\nUlandi.\n\nKechki buyurtma har kuni soat <b>19:00</b> da shu yerga keladi. Xabardagi tugma to‘liq PDF va Excel ro‘yxatni yuboradi.";

function daysBetween(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

function reportLines() {
  const catalog = peekCatalog();
  const when = tashkentParts();
  if (!catalog) return [`Sana ${when.day}`, "Katalog hali yuklanmagan."];
  const lines = [`Sana ${when.day}`, "", "Kelgan kirimlar"];
  const receipts = catalog.documents.filter((doc) => doc.kind === "receipt").slice(0, 12);
  if (!receipts.length) lines.push("Kirim hujjati yo‘q.");
  for (const doc of receipts) lines.push(`${doc.date.slice(0, 10)}   ${doc.number}   ${doc.itemCount} qator`);
  lines.push("", "Buyurtma");
  const orders = orderRecommendations(catalog).slice(0, 20);
  if (!orders.length) lines.push("Buyurtma talab qilinmaydi.");
  for (const line of orders) {
    const traits = productTraits(line.product.name);
    const basis = orderBasis(line);
    lines.push(`${line.product.name}   ${line.product.code || "—"}   ${traits.size || "—"}`);
    lines.push(`${basis.windowDays} kunda ${basis.sold} sotilgan. Qoldiq ${line.onHand}, yo‘lda ${line.inTransit}, ${basis.coverDays} kunga yetadi. ${basis.coverTarget} kunga ${basis.target} kerak, buyurtma ${line.suggestedQuantity}.`);
  }
  lines.push("", "Turib qolganlar");
  const idle = catalog.products
    .map((product) => ({ product, days: idleDays(product, catalog.salesCoverage) }))
    .filter((row) => row.days != null && row.days >= 30 && row.product.stock > 0)
    .sort((a, b) => (b.days ?? 0) - (a.days ?? 0) || b.product.stock - a.product.stock)
    .slice(0, 15);
  if (!idle.length) lines.push("30 kunda savdosi yo‘q qoldiq topilmadi.");
  for (const row of idle) {
    const label = row.days === 90 ? "90 kunda savdo yo‘q" : "30 kunda savdo yo‘q";
    lines.push(`${row.product.name}   ${row.product.code || "—"}   qoldiq ${row.product.stock}   ${label}`);
  }
  return lines;
}

async function sendFile(chatId: number, body: Buffer, filename: string, mime: string, caption: string) {
  const key = token();
  if (!key) return false;
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", caption);
  form.set("document", new Blob([body], { type: mime }), filename);
  const response = await fetch(`https://api.telegram.org/bot${key}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(35_000) });
  if (!response.ok) {
    const detail = await response.text();
    logger.warn({ status: response.status, detail: detail.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot").slice(0, 240) }, "Telegram file failed");
    return false;
  }
  return true;
}

async function sendRecommendationFile(chatId: number, kind: "pdf" | "xlsx") {
  const catalog = await loadCatalog();
  const rows = recommendationRows(catalog);
  const when = tashkentParts();
  const caption = `Tavsiyalar · ${rows.length} ta · to‘liq ro‘yxat · ${when.day}`;
  if (kind === "xlsx") {
    return sendFile(chatId, recommendationXlsx(catalog), `tavsiyalar-${when.stamp}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", caption);
  }
  const pdf = await recommendationPdf(catalog, `${when.day} · ${rows.length} ta tavsiya`);
  if (!pdf) return false;
  return sendFile(chatId, pdf, `tavsiyalar-${when.stamp}.pdf`, "application/pdf", caption);
}

let ticking = false;

async function tick() {
  if (ticking || !token()) return;
  ticking = true;
  try {
    const state = readState();
    const payload = await telegram("getUpdates", { offset: state.offset, timeout: 0, allowed_updates: ["message", "callback_query"] });
    const updates = Array.isArray(payload?.result) ? payload.result as Array<{ update_id: number; message?: { chat?: { id?: number }; text?: string }; callback_query?: { id: string; data?: string; message?: { chat?: { id?: number } } } }> : [];
    for (const update of updates) {
      state.offset = update.update_id + 1;
      const query = update.callback_query;
      if (query) {
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Fayl tayyorlanmoqda" });
        const chatId = query.message?.chat?.id;
        if (chatId && chatId === state.chatId && (query.data === "reco-pdf" || query.data === "reco-xlsx")) {
          await sendRecommendationFile(chatId, query.data === "reco-pdf" ? "pdf" : "xlsx");
        }
        continue;
      }
      const chatId = update.message?.chat?.id;
      if (!chatId) continue;
      const first = state.chatId == null;
      state.chatId = chatId;
      if (first || update.message?.text?.startsWith("/start")) {
        await send(chatId, WELCOME);
        await sendDigest(chatId);
        logger.info("Telegram chat linked");
      }
    }
    const now = tashkentParts();
    if (state.chatId && now.hour >= HOUR && state.sentOn !== now.stamp) {
      await sendDigest(state.chatId);
      state.sentOn = now.stamp;
    }
    if (state.chatId && now.hour >= HOUR) {
      if (!state.sentPdfOn) state.sentPdfOn = now.stamp;
      else if (daysBetween(state.sentPdfOn, now.stamp) >= 2) {
        const pdf = await textPdf(`Smart Ombor ${now.day}`, reportLines());
        if (pdf) {
          await sendFile(state.chatId, pdf, `smart-ombor-${now.stamp}.pdf`, "application/pdf", "Smart Ombor · 2 kunlik hisobot");
          state.sentPdfOn = now.stamp;
        }
      }
    }
    writeState(state);
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot") : "telegram";
    logger.warn({ err: message }, "Telegram tick failed");
  } finally {
    ticking = false;
  }
}

export async function sendPreview() {
  await loadCatalog();
  const state = readState();
  if (!state.chatId) return false;
  return sendDigest(state.chatId);
}

export function startTelegramDigest() {
  if (!token()) return;
  void tick();
  const timer = setInterval(() => { void tick(); }, 15_000);
  timer.unref?.();
}
