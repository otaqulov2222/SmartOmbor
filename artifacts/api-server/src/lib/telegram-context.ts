import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./data-dir";
import { peekLastWatchdogReport } from "./supply-watchdog-state";

const FILE = dataFile("telegram-context.json");
const MAX = 12;

export type BotOutKind =
  | "kirim_nazorati"
  | "buyurtma_digest"
  | "turib_qolgan"
  | "server_billing"
  | "yordamchi"
  | "welcome"
  | "other";

type OutMsg = {
  kind: BotOutKind;
  at: number;
  whenLabel: string;
  plain: string;
};

type Store = { outs: OutMsg[] };

function empty(): Store {
  return { outs: [] };
}

function read(): Store {
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Store>;
    return { outs: Array.isArray(parsed.outs) ? parsed.outs.slice(-MAX) : [] };
  } catch {
    return empty();
  }
}

function write(store: Store) {
  mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ outs: store.outs.slice(-MAX) }));
  renameSync(tmp, FILE);
}

function tashkentLabel(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function stripHtml(text: string) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Bot admin chatga yuborgan har qanday muhim xabarni eslab qoladi. */
export function rememberBotOutbound(kind: BotOutKind, text: string) {
  const plain = stripHtml(text).slice(0, 4500);
  if (!plain) return;
  const store = read();
  store.outs.push({
    kind,
    at: Date.now(),
    whenLabel: tashkentLabel(),
    plain,
  });
  write(store);
}

export function lastBotOutbound(kind?: BotOutKind): OutMsg | null {
  const outs = read().outs;
  if (!outs.length) return null;
  if (!kind) return outs[outs.length - 1] || null;
  for (let i = outs.length - 1; i >= 0; i -= 1) {
    if (outs[i].kind === kind) return outs[i];
  }
  return null;
}

/**
 * Telegram yordamchi uchun kuchli kontekst — «yuqorida» ni chalkashtirmaslik.
 */
export function buildTelegramAssistantBundle(): string {
  const watch = peekLastWatchdogReport();
  const last = lastBotOutbound();
  const lastWatchOut = lastBotOutbound("kirim_nazorati");
  const lines = [
    "TELEGRAM KANAL QOIDALARI (QATIY):",
    "1) Bu chatda 2 xil xabar bor: (A) avtomatik tizim hisobotlari, (B) Yordamchi suhbat.",
    "2) «Yuqorida / tepada / oxirgi hisobot / qizil xabar / dublikat hisobot» → deyarli har doim KIRIM NAZORATI (MoySklad dublikat + dona).",
    "3) KIRIM NAZORATI ≠ kunlik brifing (davomat/savdo). Kunlik brifingni faqat aniq «bugun nima bo‘ldi / kunlik hisobot» desa bering.",
    "4) Taxmin qilib boshqa bo‘limga o‘tmang. Avval yuqoridagi avtomatik xabarni tanib oling.",
    "5) Javob o‘zbekcha, qisqa, aniq. Inglizcha status yozmang.",
  ];
  if (watch?.plain) {
    lines.push(
      "",
      "OXIRGI KIRIM NAZORATI SKANI:",
      `Vaqt: ${watch.when || "—"} · yuk: ${watch.scanned} · topilma: ${watch.findings}`,
      watch.plain.slice(0, 2200),
    );
  } else if (lastWatchOut) {
    lines.push("", "OXIRGI KIRIM NAZORATI (Telegram xabar):", lastWatchOut.plain.slice(0, 2200));
  }
  if (last && last.kind !== "kirim_nazorati") {
    lines.push("", `OXIRGI BOT XABARI (${last.kind}, ${last.whenLabel}):`, last.plain.slice(0, 800));
  }
  return lines.join("\n");
}
