import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./data-dir";
import { idleDays, loadCatalog, peekCatalog } from "./catalog";
import { textPdf } from "./report-pdf";
import { logger } from "./logger";
import { orderRecommendations, productTraits } from "./recommendations";

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

function statusLabel(reason: string) {
  if (reason === "out_of_stock") return "tugagan";
  if (reason === "fast") return "tez ketadi";
  return "kam qoldiq";
}

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
    const tone = color ? ` · ${escapeHtml(color)}` : "";
    const code = line.product.code ? ` · <code>${escapeHtml(line.product.code)}</code>` : "";
    const article = line.product.article ? ` · ${escapeHtml(line.product.article)}` : "";
    return `${size}${tone}${code}${article}\nqoldiq <b>${pieces(line.onHand)}</b>  →  buyurtma <b>${pieces(line.suggestedQuantity)}</b>\n<i>${statusLabel(line.reason)}</i>`;
  });
  const total = rows.reduce((sum, line) => sum + line.suggestedQuantity, 0);
  const foot = rows.length > 1 ? `\n\nJami buyurtma · <b>${pieces(total)}</b>` : "";
  return `<blockquote><b>${String(index).padStart(2, "0")}   ${escapeHtml(model)}</b>\n${lines.join("\n\n")}${foot}</blockquote>`;
}

function idleCard(index: number, name: string, code: string | null, stock: number, days: number) {
  const traits = productTraits(name);
  const color = traits.color ? COLOR_LABEL[traits.color] : "";
  const size = traits.size ? `${escapeHtml(traits.size)} · ` : "";
  const tone = color ? `${escapeHtml(color)} · ` : "";
  const mark = code ? `<code>${escapeHtml(code)}</code> · ` : "";
  const label = days >= 90 ? "90 kun savdosiz" : "30 kun savdosiz";
  return `<blockquote><b>${String(index).padStart(2, "0")}   ${escapeHtml(modelTitle(name))}</b>\n${size}${tone}${mark}qoldiq <b>${pieces(stock)}</b>\n<i>${label}</i></blockquote>`;
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
    ? ["<b>Smart Ombor</b>", when.day, "", "<b>Buyurtma</b>", `${pieces(groups.size)} ta model · ${pieces(lines.length)} ta o‘lcham · <b>${pieces(total)}</b> dona`, "Sotiladi. Qoldig‘i 30 kunga yetmaydi."].join("\n")
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
    let idleText = ["<b>Smart Ombor</b>", when.day, "", "<b>Turib qolgan</b>", `${pieces(idle.length)} ta · qoldiq <b>${pieces(stock)}</b> dona`].join("\n");
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

async function send(chatId: number, text: string) {
  const result = await telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  return Boolean(result && (result as { ok?: boolean }).ok !== false);
}

const WELCOME = "<b>Smart Ombor</b>\nUlandi.\n\nKechki buyurtma har kuni soat <b>19:00</b> da shu yerga keladi. PDF hisobot har 2 kunda.";

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
    lines.push(`${line.product.name}   ${line.product.code || "—"}   ${traits.size || "—"}   ${line.suggestedQuantity} dona`);
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

async function sendPdf(chatId: number, body: Buffer, filename: string) {
  const key = token();
  if (!key) return;
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", "Smart Ombor · 2 kunlik hisobot");
  form.set("document", new Blob([body], { type: "application/pdf" }), filename);
  await fetch(`https://api.telegram.org/bot${key}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(35_000) });
}

let ticking = false;

async function tick() {
  if (ticking || !token()) return;
  ticking = true;
  try {
    const state = readState();
    const payload = await telegram("getUpdates", { offset: state.offset, timeout: 0, allowed_updates: ["message"] });
    const updates = Array.isArray(payload?.result) ? payload.result as Array<{ update_id: number; message?: { chat?: { id?: number }; text?: string } }> : [];
    for (const update of updates) {
      state.offset = update.update_id + 1;
      const chatId = update.message?.chat?.id;
      if (!chatId) continue;
      const first = state.chatId == null;
      state.chatId = chatId;
      if (first || update.message?.text?.startsWith("/start")) {
        await send(chatId, WELCOME);
        for (const part of digestParts()) await send(chatId, part);
        logger.info("Telegram chat linked");
      }
    }
    const now = tashkentParts();
    if (state.chatId && now.hour >= HOUR && state.sentOn !== now.stamp) {
      for (const part of digestParts()) await send(state.chatId, part);
      state.sentOn = now.stamp;
    }
    if (state.chatId && now.hour >= HOUR) {
      if (!state.sentPdfOn) state.sentPdfOn = now.stamp;
      else if (daysBetween(state.sentPdfOn, now.stamp) >= 2) {
        const pdf = await textPdf(`Smart Ombor ${now.day}`, reportLines());
        if (pdf) {
          await sendPdf(state.chatId, pdf, `smart-ombor-${now.stamp}.pdf`);
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
  let sent = true;
  for (const part of digestParts()) sent = await send(state.chatId, part) && sent;
  return sent;
}

export function startTelegramDigest() {
  if (!token()) return;
  void tick();
  const timer = setInterval(() => { void tick(); }, 15_000);
  timer.unref?.();
}
