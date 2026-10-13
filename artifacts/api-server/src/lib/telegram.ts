import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { peekCatalog } from "./catalog";
import { logger } from "./logger";
import { orderRecommendations, productTraits } from "./recommendations";

const STATE_FILE = path.resolve(process.cwd(), "artifacts/api-server/data/telegram.json");
const HOUR = 19;

interface TelegramState {
  chatId: number | null;
  offset: number;
  sentOn: string | null;
}

function readState(): TelegramState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<TelegramState>;
    return { chatId: parsed.chatId ?? null, offset: parsed.offset ?? 0, sentOn: parsed.sentOn ?? null };
  } catch {
    return { chatId: null, offset: 0, sentOn: null };
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
  if (!response.ok) return null;
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
  if (reason === "out_of_stock") return "Qoldiq tugagan";
  if (reason === "fast") return "Yaxshi sotiladi";
  return "Qoldiq kam";
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

export function digestParts() {
  const catalog = peekCatalog();
  const when = tashkentParts();
  if (!catalog) return [`<b>Smart Ombor</b>\n${when.day}\n\nKatalog hali yuklanmagan.`];
  const lines = orderRecommendations(catalog).slice(0, 15);
  if (!lines.length) return [`<b>Smart Ombor</b>\nKechki buyurtma · ${when.day}\n\nBugun buyurtma talab qiladigan mahsulot topilmadi.`];
  const total = lines.reduce((sum, line) => sum + line.suggestedQuantity, 0);
  const header = [
    "<b>Smart Ombor</b>",
    `Kechki buyurtma · ${when.day}`,
    "",
    "Yaxshi sotilayotgan, qoldig‘i 30 kunga yetmaydigan mahsulotlar.",
    "",
    `<b>${pieces(lines.length)}</b> ta mahsulot  ·  jami <b>${pieces(total)}</b> dona`,
  ].join("\n");
  const cards = lines.map((line, index) => {
    const traits = productTraits(line.product.name);
    const sold = line.product.sales30 || line.product.sales7;
    const rows = [
      `<b>${String(index + 1).padStart(2, "0")}  ${escapeHtml(line.product.name)}</b>`,
      line.product.code ? `Kod · <code>${escapeHtml(line.product.code)}</code>` : "",
      traits.size ? `O‘lcham · <b>${escapeHtml(traits.size)}</b>` : "",
      traits.color ? `Rang · <b>${escapeHtml(COLOR_LABEL[traits.color] ?? traits.color)}</b>` : "",
      `Qoldiq · <b>${pieces(line.onHand)}</b>`,
      `30 kunda · <b>${pieces(sold)}</b> sotilgan`,
      `<b>Buyurtma · ${pieces(line.suggestedQuantity)} dona</b>`,
      `<i>${statusLabel(line.reason)}</i>`,
    ].filter(Boolean);
    return `<blockquote>${rows.join("\n")}</blockquote>`;
  });
  const parts: string[] = [];
  let current = header;
  for (const card of cards) {
    const next = `${current}\n\n${card}`;
    if (next.length > 3800) {
      parts.push(current);
      current = card;
    } else current = next;
  }
  parts.push(current);
  return parts;
}

async function send(chatId: number, text: string) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

const WELCOME = "<b>Smart Ombor</b>\nUlandi.\n\nKechki buyurtma har kuni soat <b>19:00</b> da shu yerga keladi.";

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
    writeState(state);
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot") : "telegram";
    logger.warn({ err: message }, "Telegram tick failed");
  } finally {
    ticking = false;
  }
}

export async function sendPreview() {
  const state = readState();
  if (!state.chatId) return false;
  for (const part of digestParts()) await send(state.chatId, part);
  return true;
}

export function startTelegramDigest() {
  if (!token()) return;
  void tick();
  const timer = setInterval(() => { void tick(); }, 15_000);
  timer.unref?.();
}
