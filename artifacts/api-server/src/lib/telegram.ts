import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./data-dir";
import { idleDays, loadCatalog, peekCatalog } from "./catalog";
import { textPdf } from "./report-pdf";
import { buildXlsx } from "./xlsx-file";
import { logger } from "./logger";
import { orderBasis, orderRecommendations, productTraits } from "./recommendations";
import { recommendationPdf, recommendationRows, recommendationXlsx } from "./reco-export";

const STATE_FILE = dataFile("telegram.json");
const NOON = 11;
const SITE = "https://bordoombor.uz";

interface TelegramState {
  chatId: number | null;
  offset: number;
  sentOn: string | null;
  sentNoonOn: string | null;
  sentPdfOn: string | null;
  groupId: number | null;
  orderThreadId: number | null;
  idleThreadId: number | null;
}

function readState(): TelegramState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<TelegramState>;
    return {
      chatId: parsed.chatId ?? null,
      offset: parsed.offset ?? 0,
      sentOn: parsed.sentOn ?? null,
      sentNoonOn: parsed.sentNoonOn ?? null,
      sentPdfOn: parsed.sentPdfOn ?? null,
      groupId: parsed.groupId ?? null,
      orderThreadId: parsed.orderThreadId ?? null,
      idleThreadId: parsed.idleThreadId ?? null,
    };
  } catch {
    return { chatId: null, offset: 0, sentOn: null, sentNoonOn: null, sentPdfOn: null, groupId: null, orderThreadId: null, idleThreadId: null };
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

function productLink(id: string) {
  return `${SITE}/products?product=${encodeURIComponent(id)}`;
}

function titleMark(index: number, model: string, href: string) {
  return `<a href="${href}"><b>${String(index).padStart(2, "0")}   ${escapeHtml(model)}</b></a>`;
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
      `<a href="${productLink(line.product.id)}"><b>${identity}</b></a>`,
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
  const href = sorted.length === 1 ? productLink(sorted[0].product.id) : `${SITE}/products?search=${encodeURIComponent(model)}`;
  return `<blockquote>${titleMark(index, model, href)}\n\n${lines.join("\n\n")}${foot}</blockquote>`;
}

function idleCard(index: number, name: string, code: string | null, stock: number, days: number, productId: string) {
  const traits = productTraits(name);
  const color = traits.color ? COLOR_LABEL[traits.color] : "";
  const size = traits.size ? `${escapeHtml(traits.size)} · ` : "";
  const tone = color ? `${escapeHtml(color)} · ` : "";
  const mark = code ? `<code>${escapeHtml(code)}</code> · ` : "";
  const label = days >= 90 ? "90 kun savdosiz" : "30 kun savdosiz";
  return `<blockquote>${titleMark(index, modelTitle(name), productLink(productId))}\n${size}${tone}${mark}qoldiq <code>${pieces(stock)} dona</code>\n<i>${label}</i></blockquote>`;
}

function topicKind(name: string) {
  const text = name.toLowerCase();
  if (text.includes("turib")) return "idle" as const;
  if (text.includes("zakaz") || text.includes("zakas") || text.includes("buyurt")) return "order" as const;
  return null;
}

type ForumMessage = {
  chat?: { id?: number; type?: string; is_forum?: boolean };
  message_thread_id?: number;
  text?: string;
  is_topic_message?: boolean;
  forum_topic_created?: { name?: string };
  reply_to_message?: { message_thread_id?: number; forum_topic_created?: { name?: string } };
};

function rememberForum(state: TelegramState, message: ForumMessage | undefined) {
  if (!message?.chat?.id || message.chat.id > 0) return false;
  const name = message.forum_topic_created?.name || message.reply_to_message?.forum_topic_created?.name || "";
  const thread = message.message_thread_id || message.reply_to_message?.message_thread_id;
  const forum = Boolean(message.chat.is_forum || message.forum_topic_created || message.is_topic_message || thread);
  if (forum) state.groupId = message.chat.id;
  const kind = topicKind(name) || topicKind(message.text || "");
  if (!kind || !thread) return false;
  if (kind === "order") state.orderThreadId = thread;
  if (kind === "idle") state.idleThreadId = thread;
  state.groupId = message.chat.id;
  return true;
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
    ? ["<b>Smart Ombor</b>", when.day, "", `<a href="${SITE}/recommendations"><b>Buyurtma</b></a>`, `Eng katta ${pieces(lines.length)} ta o‘lcham · ${pieces(groups.size)} ta model`, `Jami buyurtma: <code>${pieces(total)} dona</code>`, "", "Har bir miqdor shu o‘lchamning o‘z savdosidan olingan.", "Maqsad — omborda 30 kunga yetadigan qoldiq."].join("\n")
    : `<b>Smart Ombor</b>\n${when.day}\n\n<b>Buyurtma</b>\nBugun buyurtma talab qiladigan mahsulot yo‘q.`;
  for (const card of cards) {
    const next = `${current}\n\n${card}`;
    if (next.length > 3800) {
      parts.push(current);
      current = `<b>Buyurtma, davomi</b>\n\n${card}`;
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
    const idleCards = idle.map((row, index) => idleCard(index + 1, row.product.name, row.product.code, row.product.stock, row.days ?? 30, row.product.id));
    let idleText = ["<b>Smart Ombor</b>", when.day, "", "<b>Turib qolgan</b>", `${pieces(idle.length)} ta mahsulot · qoldiq <code>${pieces(stock)} dona</code>`, "Savdo kamida 30 kundan beri yo‘q, omborda esa qolgan."].join("\n");
    for (const card of idleCards) {
      const next = `${idleText}\n\n${card}`;
      if (next.length > 3800) {
        parts.push(idleText);
        idleText = `<b>Turib qolgan, davomi</b>\n\n${card}`;
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

const IDLE_DOWNLOADS = {
  inline_keyboard: [[
    { text: "PDF yuklab olish", callback_data: "idle-pdf" },
    { text: "Excel yuklab olish", callback_data: "idle-xlsx" },
  ]],
};

async function send(chatId: number, text: string, markup?: typeof DOWNLOADS, threadId?: number | null) {
  if (chatId < 0 && (!threadId || threadId === 1)) return false;
  const result = await telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(threadId ? { message_thread_id: threadId } : {}),
    ...(markup ? { reply_markup: markup } : {}),
  });
  return Boolean(result && (result as { ok?: boolean }).ok !== false);
}

function orderAndIdleParts() {
  const parts = digestParts();
  const orders: string[] = [];
  const idle: string[] = [];
  let idleMode = false;
  for (const part of parts) {
    if (part.includes("<b>Turib qolgan</b>")) idleMode = true;
    if (idleMode) idle.push(part);
    else orders.push(part);
  }
  return { orders, idle };
}

async function sendParts(chatId: number, parts: string[], threadId: number | null, markup?: typeof DOWNLOADS) {
  let sent = true;
  for (let index = 0; index < parts.length; index += 1) {
    sent = await send(chatId, parts[index], markup && index === parts.length - 1 ? markup : undefined, threadId) && sent;
  }
  return sent;
}

async function sendDigest(state: TelegramState) {
  const { orders, idle } = orderAndIdleParts();
  const group = state.groupId;
  const jobs: Array<Promise<boolean>> = [];
  if (group && state.orderThreadId && orders.length) jobs.push(sendParts(group, orders, state.orderThreadId, DOWNLOADS));
  if (group && state.idleThreadId && idle.length) jobs.push(sendParts(group, idle, state.idleThreadId, IDLE_DOWNLOADS));
  if (!group && state.chatId) {
    if (orders.length) jobs.push(sendParts(state.chatId, orders, null, DOWNLOADS));
    if (idle.length) jobs.push(sendParts(state.chatId, idle, null, IDLE_DOWNLOADS));
  }
  logger.info({ orders: orders.length, idle: idle.length }, "Telegram digest parts");
  if (!jobs.length) return false;
  const results = await Promise.all(jobs);
  return results.every(Boolean);
}

function claimDigest(stamp: string) {
  const file = dataFile(`digest-${stamp}.lock`);
  try {
    writeFileSync(file, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

const WELCOME = "<b>Smart Ombor</b>\nUlandi.\n\nXabar har kuni soat <b>11:00</b> da keladi. Mahsulot nomini bossangiz, tizimda shu mahsulot ochiladi.";

async function sendFile(chatId: number, body: Buffer, filename: string, mime: string, caption: string, threadId?: number | null) {
  const key = token();
  if (!key || (chatId < 0 && (!threadId || threadId === 1))) return false;
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (threadId) form.set("message_thread_id", String(threadId));
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

function idleList(catalog: NonNullable<ReturnType<typeof peekCatalog>>) {
  return catalog.products
    .map((product) => ({ product, days: idleDays(product, catalog.salesCoverage) }))
    .filter((row): row is { product: typeof row.product; days: number } => row.days != null && row.days >= 30 && row.product.stock > 0)
    .sort((a, b) => b.days - a.days || b.product.stock - a.product.stock);
}

async function sendIdleFile(chatId: number, kind: "pdf" | "xlsx", threadId?: number | null) {
  const catalog = await loadCatalog();
  const rows = idleList(catalog);
  const when = tashkentParts();
  const caption = `Turib qolganlar · ${rows.length} ta · to‘liq ro‘yxat · ${when.day}`;
  if (kind === "xlsx") {
    const body = buildXlsx([{
      name: "Turib qolganlar",
      headers: ["Nomi", "O‘lcham", "Rang", "Kod", "Qoldiq", "Savdosiz, kun"],
      rows: rows.map((row) => {
        const traits = productTraits(row.product.name);
        const color = traits.color ? COLOR_LABEL[traits.color] ?? "" : "";
        return [row.product.name, traits.size ?? "", color, row.product.code || row.product.article || "", row.product.stock, row.days];
      }),
    }]);
    return sendFile(chatId, body, `turib-qolgan-${when.stamp}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", caption, threadId);
  }
  const lines = rows.map((row, index) => {
    const traits = productTraits(row.product.name);
    const label = row.days >= 90 ? "90 kun savdosiz" : "30 kun savdosiz";
    return `${index + 1}. ${row.product.name}   ${row.product.code || "—"}   ${traits.size || "—"}   qoldiq ${row.product.stock}   ${label}`;
  });
  const pdf = await textPdf(`Turib qolganlar · ${when.day} · ${rows.length} ta`, lines.length ? lines : ["30 kunda savdosi yo‘q qoldiq topilmadi."]);
  if (!pdf) return false;
  return sendFile(chatId, pdf, `turib-qolgan-${when.stamp}.pdf`, "application/pdf", caption, threadId);
}

async function sendRecommendationFile(chatId: number, kind: "pdf" | "xlsx", threadId?: number | null) {
  const catalog = await loadCatalog();
  const rows = recommendationRows(catalog);
  const when = tashkentParts();
  const caption = `Tavsiyalar · ${rows.length} ta · to‘liq ro‘yxat · ${when.day}`;
  if (kind === "xlsx") {
    return sendFile(chatId, recommendationXlsx(catalog), `tavsiyalar-${when.stamp}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", caption, threadId);
  }
  const pdf = await recommendationPdf(catalog, `${when.day} · ${rows.length} ta tavsiya`);
  if (!pdf) return false;
  return sendFile(chatId, pdf, `tavsiyalar-${when.stamp}.pdf`, "application/pdf", caption, threadId);
}

let ticking = false;

async function tick() {
  if (ticking || !token()) return;
  ticking = true;
  try {
    const state = readState();
    const hadTopics = Boolean(state.groupId && state.orderThreadId && state.idleThreadId);
    const payload = await telegram("getUpdates", { offset: state.offset, timeout: 0, allowed_updates: ["message", "callback_query", "my_chat_member"] });
    const updates = Array.isArray(payload?.result) ? payload.result as Array<{ update_id: number; message?: ForumMessage; my_chat_member?: { chat?: { id?: number; type?: string; is_forum?: boolean } }; callback_query?: { id: string; data?: string; message?: ForumMessage } }> : [];
    for (const update of updates) {
      state.offset = update.update_id + 1;
      if (update.my_chat_member?.chat?.is_forum && update.my_chat_member.chat.id) state.groupId = update.my_chat_member.chat.id;
      const query = update.callback_query;
      if (query) {
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Fayl tayyorlanmoqda" });
        rememberForum(state, query.message);
        const chatId = query.message?.chat?.id;
        const thread = query.message?.message_thread_id ?? state.orderThreadId;
        if (chatId && (chatId === state.chatId || chatId === state.groupId) && (query.data === "reco-pdf" || query.data === "reco-xlsx" || query.data === "idle-pdf" || query.data === "idle-xlsx")) {
          const idleFile = query.data.startsWith("idle-");
          const kind = query.data.endsWith("pdf") ? "pdf" : "xlsx";
          if (idleFile) await sendIdleFile(chatId, kind, thread);
          else await sendRecommendationFile(chatId, kind, thread);
        }
        continue;
      }
      const message = update.message;
      rememberForum(state, message);
      const chatId = message?.chat?.id;
      if (!chatId || chatId < 0) continue;
      const first = state.chatId == null;
      state.chatId = chatId;
      if (first || message?.text?.startsWith("/start")) {
        await send(chatId, WELCOME);
        await sendDigest(state);
        logger.info("Telegram chat linked");
      }
    }
    const hasTopics = Boolean(state.groupId && state.orderThreadId && state.idleThreadId);
    if (!hadTopics && hasTopics) {
      await loadCatalog();
      const sent = await sendDigest(state);
      logger.info({ sent, order: state.orderThreadId, idle: state.idleThreadId }, "Telegram topics linked");
    }
    const now = tashkentParts();
    const linked = Boolean(state.chatId || hasTopics);
    const missedEarlier = now.hour > NOON && state.sentNoonOn != null && state.sentNoonOn !== now.stamp;
    const due = linked && now.hour >= NOON && state.sentNoonOn !== now.stamp && (now.hour === NOON || missedEarlier);
    if (due && claimDigest(now.stamp)) {
      await loadCatalog();
      const sent = await sendDigest(state);
      if (sent) state.sentNoonOn = now.stamp;
      else {
        try { unlinkSync(dataFile(`digest-${now.stamp}.lock`)); } catch { /* retry next tick */ }
      }
      logger.info({ day: now.stamp, sent }, "Daily Telegram digest");
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
  if (!state.chatId && !(state.groupId && (state.orderThreadId || state.idleThreadId))) return false;
  return sendDigest(state);
}

export async function sendIdlePreview() {
  await loadCatalog();
  const state = readState();
  if (!state.groupId || !state.idleThreadId) return false;
  const { idle } = orderAndIdleParts();
  return sendParts(state.groupId, idle, state.idleThreadId, IDLE_DOWNLOADS);
}

export function startTelegramDigest() {
  if (process.env.TELEGRAM_DIGEST !== "vps" || !token()) return;
  void tick();
  const timer = setInterval(() => { void tick(); }, 15_000);
  timer.unref?.();
}
