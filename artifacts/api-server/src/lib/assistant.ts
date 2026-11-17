import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dataFile } from "./data-dir";
import { logger } from "./logger";
import { officeSite, tashkentParts, todayBoard, workedMs } from "./office";
import { packSizeOf, ensurePachka, productPackSize } from "./supply-assortment";
import { listLocalPeople } from "../routes/local-auth";
import { moysklad, moyskladConfigured } from "./moysklad";
import { buildDavomatPdf } from "./assistant-pdf";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b";

type ChatMsg = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; name?: string; tool_calls?: ToolCall[] };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type AssistantFile = {
  id: string;
  name: string;
  mime: string;
  base64: string;
};

function groqKey() {
  return String(process.env.GROQ_API_KEY || process.env.GROQ_KEY || "").trim();
}

export function assistantConfigured() {
  return Boolean(groqKey());
}

const SYSTEM = `Siz — Smart Ombor (Bordo) nazorat agentisiz.
Asosiy kuch: shu loyiha — ombor, yuk xati, pachka, davomat, MoySklad, KPI, GPS, xodimlar.
Umumiy savollarga qisqa javob berishingiz mumkin, lekin Smart Ombor so‘rovlari ustuvor.

Til: foydalanuvchi tili (o‘zbekcha/ruscha). Format: qisqa xulosa + aniq faktlar. Ortiqcha ** / uzun kod bloki yo‘q. Parol/token/.env ko‘rsatmang.

QATIY:
- Sidebar: Dashboard → Mahsulotlar → Xodimlar → Davomat → KPI → GPS → Hamkor → Boshqalar
- Davomat dropdown: Davomat + Davomat hisobot
- Pachka: yuk xatidagi qo‘lda yozilgan son → MoySklad packs.quantity
- Ofis GPS: 41.219353, 69.272828 · 100 m

Tool:
- Yuk / kirim / pachka / davomat / xato → AVVAL mos tool.
- «Oxirgi kirim / MoySklad» → latest_kirim.
- PDF / hisobot fayl so‘ralsa → davomat_pdf. Base64, JVBERi0, kod bloki yoki «PDF-fayl» matnini JAVOBGA YOZMANg.
- PDF tool muvaffaqiyatli bo‘lsa: qisqa xulosa + «Yuklab olish tugmasini bosing» deng.
- Tool natijasidan aniq raqam/sana/status. «tekshira olmadim» demang.
- Admin “tuzat/yoz” desa fix_product_pachka.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "system_overview",
      description: "Tizim holati: ofis GPS, xodimlar soni, so‘nggi yuklar qisqacha, yordamchi sozlanganligi.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "find_shipment",
      description: "Yuk xatini raqam bo‘yicha topish (pachka/juft/qop/status/MoySklad id).",
      parameters: {
        type: "object",
        properties: { number: { type: "string", description: "Masalan 0066-013 yoki 0007-001" } },
        required: ["number"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "diagnose_pachka",
      description: "Yuk xati yoki mahsulot bo‘yicha pachka qoidasi: packSizeOf nima yozadi, MS dagi packs (agar productId bo‘lsa).",
      parameters: {
        type: "object",
        properties: {
          shipment_number: { type: "string" },
          product_id: { type: "string" },
          pachka: { type: "number" },
          pairs: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fix_product_pachka",
      description: "MoySklad mahsulotiga pachka (packs) yozish/yangilash. Faqat admin aniq so‘raganda.",
      parameters: {
        type: "object",
        properties: {
          product_id: { type: "string" },
          pachka: { type: "number", description: "Yoziladigan pachka soni (>1)" },
        },
        required: ["product_id", "pachka"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "office_today",
      description: "Bugungi davomat board: kelgan/kelmagan/kechikkan qisqacha.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "davomat_pdf",
      description: "Bugungi (yoki berilgan) davomat hisobotini haqiqiy PDF fayl qilib tayyorlash. PDF/hisobot/yuklab olish so‘ralganda chaqiring.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD, bo‘sh bo‘lsa bugun" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_staff",
      description: "Xodimlar ro‘yxati: ism, login, rol (parolsiz).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "supply_jobs",
      description: "So‘nggi lokal MoySklad kirim job holatlari (queue).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "latest_kirim",
      description: "Oxirgi/so‘nggi MoySklad kirim (supply) va Smart Ombor yuk xatlari. «Qaysi yuk oxirgi yozildi?» uchun.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Default 8, max 20" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recent_logs",
      description: "smart-ombor journal oxirgi ogohlantirish/xatolar (qisqa).",
      parameters: {
        type: "object",
        properties: { minutes: { type: "number", description: "Default 60" } },
      },
    },
  },
] as const;

function readPartners(): {
  shipments?: Array<Record<string, unknown>>;
  accounts?: Array<Record<string, unknown>>;
} {
  const file = dataFile("partners.json");
  if (!existsSync(file)) return { shipments: [], accounts: [] };
  try {
    return JSON.parse(readFileSync(file, "utf8")) as {
      shipments?: Array<Record<string, unknown>>;
      accounts?: Array<Record<string, unknown>>;
    };
  } catch {
    return { shipments: [], accounts: [] };
  }
}

function shipmentSortKey(s: Record<string, unknown>) {
  return String(s.createdAt || s.date || "");
}

function readSupplyJobs(): Record<string, unknown> {
  const file = dataFile("supply-jobs.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "system_overview") {
    const site = officeSite();
    const now = tashkentParts();
    const shipments = readPartners().shipments || [];
    const recent = [...shipments]
      .sort((a, b) => shipmentSortKey(b).localeCompare(shipmentSortKey(a)))
      .slice(0, 8)
      .map((s) => ({
        number: s.number,
        date: s.date,
        status: s.status,
        ms: s.moyskladNumber || s.moyskladId || null,
        lines: Array.isArray(s.lines) ? s.lines.length : 0,
      }));
    return {
      configured: assistantConfigured(),
      clock: now.clock,
      date: now.date,
      office: { name: site.name, lat: site.lat, lng: site.lng, radiusM: site.radiusM },
      staff: listLocalPeople().length,
      recentShipments: recent,
      pachkaRule: "Yuk xatidagi qo‘lda yozilgan pachka (>1) MoySkladga aynan shu son bilan yoziladi.",
    };
  }

  if (name === "find_shipment") {
    const needle = String(args.number || "").trim().toLowerCase();
    const shipments = readPartners().shipments || [];
    const hit = shipments.find((s) => String(s.number || "").toLowerCase() === needle)
      || shipments.find((s) => String(s.number || "").toLowerCase().includes(needle));
    if (!hit) return { found: false, number: needle };
    const lines = Array.isArray(hit.lines) ? hit.lines as Array<Record<string, unknown>> : [];
    return {
      found: true,
      number: hit.number,
      date: hit.date,
      status: hit.status,
      moyskladId: hit.moyskladId || null,
      moyskladNumber: hit.moyskladNumber || null,
      note: hit.note || "",
      lines: lines.map((line) => {
        const pachka = Number(line.pachka) || 0;
        const pairs = Number(line.pairs) || 0;
        return {
          productCode: line.productCode,
          size: line.size,
          pairs,
          pachka,
          boxes: line.boxes,
          productId: line.productId || null,
          packSizeOf: packSizeOf({ pachka, pairs }),
          willWriteToMs: packSizeOf({ pachka, pairs }) > 1,
        };
      }),
    };
  }

  if (name === "diagnose_pachka") {
    const shipmentNumber = String(args.shipment_number || "").trim();
    const productId = String(args.product_id || "").trim();
    const result: Record<string, unknown> = {
      rule: "packSizeOf: pachka>1 bo‘lsa shu son MS ga yoziladi; juft bilan tenglik endi to‘smaydi.",
    };
    if (shipmentNumber) {
      const found = await runTool("find_shipment", { number: shipmentNumber }) as Record<string, unknown>;
      result.shipment = found;
    }
    if (args.pachka != null || args.pairs != null) {
      const pachka = Number(args.pachka) || 0;
      const pairs = Number(args.pairs) || 0;
      result.manual = { pachka, pairs, packSizeOf: packSizeOf({ pachka, pairs }) };
    }
    if (productId) {
      try {
        const current = await productPackSize(productId);
        result.moyskladPackSize = current;
        result.productId = productId;
      } catch (error) {
        result.moyskladError = error instanceof Error ? error.message : String(error);
      }
    }
    return result;
  }

  if (name === "fix_product_pachka") {
    const productId = String(args.product_id || "").trim();
    const pachka = Math.round(Number(args.pachka) || 0);
    if (!productId || !(pachka > 1)) return { ok: false, error: "product_id va pachka>1 kerak" };
    const before = await productPackSize(productId).catch(() => 0);
    const saved = await ensurePachka(productId, pachka);
    const after = await productPackSize(productId).catch(() => 0);
    return {
      ok: Boolean(saved || after === pachka),
      productId,
      before,
      requested: pachka,
      after,
      packId: saved?.id || null,
    };
  }

  if (name === "office_today") {
    const people = listLocalPeople();
    const byId = new Map(people.map((p) => [p.id, p]));
    const site = officeSite();
    const rows = todayBoard().map((row) => ({
      name: byId.get(row.accountId)?.name || row.accountId,
      role: byId.get(row.accountId)?.role || "",
      inAt: row.inAt,
      outAt: row.outAt,
      excuse: row.excuse,
      workedMs: workedMs(row),
    }));
    const present = rows.filter((r) => r.inAt).length;
    return {
      office: { lat: site.lat, lng: site.lng, radiusM: site.radiusM },
      total: people.length,
      present,
      absent: people.length - present,
      rows: rows.slice(0, 40),
    };
  }

  if (name === "davomat_pdf") {
    const people = listLocalPeople();
    const byId = new Map(people.map((p) => [p.id, p]));
    const now = tashkentParts();
    const date = String(args.date || now.date || "").trim() || now.date;
    const board = todayBoard();
    const rows = board.map((row) => {
      const ms = workedMs(row);
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      return {
        name: byId.get(row.accountId)?.name || row.accountId,
        role: byId.get(row.accountId)?.role || "",
        inAt: row.inAt || null,
        outAt: row.outAt || null,
        status: row.inAt ? "Kelgan" : "Kelmagan",
        workedLabel: row.inAt ? `${h}s ${m}daq ${s}son` : "—",
      };
    });
    const present = rows.filter((r) => r.inAt).length;
    const pdf = await buildDavomatPdf({
      date,
      total: people.length,
      present,
      absent: Math.max(0, people.length - present),
      rows,
    });
    if (!pdf) {
      return { ok: false, error: "pdf_build_failed", date, total: people.length, present };
    }
    const fileName = `davomat-${date}.pdf`;
    return {
      ok: true,
      date,
      title: `Davomat hisobot – PDF (${date})`,
      total: people.length,
      present,
      absent: Math.max(0, people.length - present),
      rows: rows.slice(0, 40),
      file: {
        id: randomBytes(6).toString("hex"),
        name: fileName,
        mime: "application/pdf",
        base64: pdf.toString("base64"),
      },
      uiHint: "PDF tayyor. Javobda base64 yozmang — foydalanuvchiga Yuklab olish tugmasi chiqadi.",
    };
  }

  if (name === "list_staff") {
    return {
      items: listLocalPeople().map((p) => ({
        id: p.id,
        name: p.name,
        login: p.login,
        role: p.role,
      })),
    };
  }

  if (name === "supply_jobs") {
    const jobs = readSupplyJobs();
    const items = Object.entries(jobs)
      .map(([id, job]) => {
        const row = job as Record<string, unknown>;
        return {
          id,
          ...row,
          _sort: String(row.updatedAt || row.finishedAt || row.startedAt || row.createdAt || id),
        };
      })
      .sort((a, b) => String(b._sort).localeCompare(String(a._sort)))
      .slice(0, 20)
      .map(({ _sort, ...rest }) => rest);
    return { count: items.length, items };
  }

  if (name === "latest_kirim") {
    const limit = Math.min(20, Math.max(3, Math.round(Number(args.limit) || 8)));
    const partners = readPartners();
    const accounts = partners.accounts || [];
    const byFactory = new Map(accounts.map((a) => [String(a.id), String(a.name || a.code || a.id)]));
    const localShipments = [...(partners.shipments || [])]
      .sort((a, b) => shipmentSortKey(b).localeCompare(shipmentSortKey(a)))
      .slice(0, limit)
      .map((s) => ({
        number: s.number,
        date: s.date,
        createdAt: s.createdAt || null,
        status: s.status,
        factory: byFactory.get(String(s.factoryId)) || s.factoryId || null,
        moyskladId: s.moyskladId || null,
        moyskladNumber: s.moyskladNumber || null,
        posted: Boolean(s.moyskladId),
        lines: Array.isArray(s.lines) ? s.lines.length : 0,
      }));

    const posted = localShipments.filter((s) => s.posted);
    const latestLocalPosted = posted[0] || null;
    const latestLocalAny = localShipments[0] || null;

    let moyskladSupplies: Array<Record<string, unknown>> = [];
    let moyskladError: string | null = null;
    if (moyskladConfigured()) {
      try {
        const data = await moysklad<{
          rows?: Array<{
            id?: string;
            name?: string;
            moment?: string;
            created?: string;
            applicable?: boolean;
            sum?: number;
            agent?: { name?: string };
          }>;
        }>("/entity/supply?limit=12&order=moment,desc&expand=agent");
        moyskladSupplies = (data.rows || []).slice(0, limit).map((row) => ({
          id: row.id || null,
          number: row.name || null,
          moment: row.moment || row.created || null,
          agent: row.agent?.name || null,
          applicable: row.applicable ?? null,
          sum: typeof row.sum === "number" ? row.sum / 100 : null,
        }));
      } catch (error) {
        moyskladError = error instanceof Error ? error.message : String(error);
      }
    } else {
      moyskladError = "MOYSKLAD_TOKEN yo‘q";
    }

    const jobs = readSupplyJobs();
    const recentJobs = Object.entries(jobs)
      .map(([id, job]) => {
        const row = job as Record<string, unknown>;
        return {
          id,
          shipmentNumber: row.shipmentNumber || row.number || null,
          status: row.status || null,
          moyskladId: row.moyskladId || row.supplyId || null,
          updatedAt: row.updatedAt || row.finishedAt || row.startedAt || null,
        };
      })
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, 8);

    return {
      ok: true,
      latestLocalPosted,
      latestLocalAny,
      localShipments,
      moyskladLatest: moyskladSupplies[0] || null,
      moyskladSupplies,
      moyskladError,
      recentJobs,
      hint: "Oxirgi MoySklad kirim uchun moyskladLatest / latestLocalPosted ni ayting.",
    };
  }

  if (name === "recent_logs") {
    const minutes = Math.min(24 * 60, Math.max(5, Math.round(Number(args.minutes) || 60)));
    try {
      const raw = execSync(
        `journalctl -u smart-ombor --since "${minutes} minutes ago" -p warning..alert --no-pager -n 40 2>/dev/null || true`,
        { encoding: "utf8", timeout: 8000 },
      );
      const lines = raw.split(/\n/).map((l) => l.trim()).filter(Boolean).slice(-30);
      return { minutes, lines };
    } catch (error) {
      return { minutes, error: error instanceof Error ? error.message : String(error), lines: [] };
    }
  }

  return { error: `unknown_tool:${name}` };
}

function toolPayloadForModel(result: unknown): string {
  if (!result || typeof result !== "object") return JSON.stringify(result ?? null).slice(0, 12000);
  const clone = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  const file = clone.file;
  if (file && typeof file === "object") {
    const f = file as Record<string, unknown>;
    clone.file = {
      id: f.id,
      name: f.name,
      mime: f.mime,
      attached: true,
      bytes: typeof f.base64 === "string" ? Math.round((String(f.base64).length * 3) / 4) : 0,
      note: "Fayl UI da Yuklab olish tugmasi sifatida chiqadi. Base64 yozmang.",
    };
  }
  return JSON.stringify(clone).slice(0, 12000);
}

function extractFiles(result: unknown, into: AssistantFile[]) {
  if (!result || typeof result !== "object") return;
  const file = (result as { file?: AssistantFile }).file;
  if (!file?.base64 || !file.name) return;
  if (file.base64.length > 2_500_000) return;
  into.push({
    id: file.id || randomBytes(6).toString("hex"),
    name: String(file.name).slice(0, 120),
    mime: String(file.mime || "application/pdf"),
    base64: file.base64,
  });
}

function sanitizeAssistantReply(text: string): string {
  let out = String(text || "");
  out = out.replace(/```(?:text|pdf|base64|plaintext)?\s*JVBERi0[\s\S]*?```/gi, "");
  out = out.replace(/###\s*PDF[- ]?fayl[^\n]*\n?/gi, "");
  out = out.replace(/\bJVBERi0[A-Za-z0-9+/=\s]{40,}/g, "");
  out = out.replace(/data:application\/pdf;base64,[A-Za-z0-9+/=]+/gi, "");
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

async function groqChat(messages: ChatMsg[], tools = true) {
  const key = groqKey();
  if (!key) throw Object.assign(new Error("assistant_unconfigured"), { status: 503 });
  const body: Record<string, unknown> = {
    model: MODEL,
    temperature: 0.25,
    max_completion_tokens: 1800,
    messages,
  };
  if (tools) {
    body.tools = TOOLS;
    body.tool_choice = "auto";
  }
  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: { choices?: Array<{ message?: ChatMsg }>; error?: { message?: string } };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw Object.assign(new Error("groq_bad_json"), { status: 502, detail: text.slice(0, 200) });
  }
  if (!response.ok) {
    throw Object.assign(new Error(json.error?.message || "groq_error"), { status: response.status === 401 ? 503 : 502 });
  }
  return json.choices?.[0]?.message;
}

export async function runAssistantChat(input: {
  message: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}) {
  const message = String(input.message || "").trim().slice(0, 4000);
  if (message.length < 1) throw Object.assign(new Error("empty"), { status: 400 });

  const history = (input.history || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

  const messages: ChatMsg[] = [
    { role: "system", content: SYSTEM },
    ...history,
    { role: "user", content: message },
  ];

  const toolTrace: Array<{ name: string; ok: boolean }> = [];
  const files: AssistantFile[] = [];

  // Prefetch: yuk / kirim / pachka / davomat — model kutmasin.
  const shipmentMatch = message.match(/\b(\d{3,5}-\d{2,4})\b/);
  const lower = message.toLowerCase();
  const wantsKirim = /kirim|supply|приход|oxirgi yuk|so['‘`]?nggi yuk|oxirgi.*moy|moy\s*sklad.*yuk|yuk.*moy\s*sklad|последн.*(приход|наклад|поставк)|какой.*(приход|supply)/.test(lower)
    || (/oxirgi|so['‘`]?nggi|последн|eng oxir/.test(lower) && /yuk|kirim|supply|moy\s*sklad|moysklad|наклад/.test(lower));
  const wantsPachka = /pachka|пачк|packs?\.?quantity/.test(lower)
    && !wantsKirim;
  const wantsPdf = /pdf|пдф|yuklab|скач|hisobot.*fayl|файл.*отч|отч[её]т.*pdf/.test(lower);
  const wantsOffice = /davomat|посещаем|kelmagan|не приш|bugun kim|сегодня кто|hisobot|отч[её]т/.test(lower);
  const wantsErrors = /xato|ошибк|error|journal|log/.test(lower)
    && !wantsKirim;

  const pushPrefetch = async (name: string, args: Record<string, unknown>, id: string) => {
    try {
      const pre = await runTool(name, args);
      extractFiles(pre, files);
      toolTrace.push({ name, ok: true });
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [{
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      });
      messages.push({
        role: "tool",
        tool_call_id: id,
        name,
        content: toolPayloadForModel(pre),
      });
    } catch (error) {
      toolTrace.push({ name, ok: false });
      logger.warn({ err: error instanceof Error ? error.message : error, tool: name }, "assistant prefetch failed");
    }
  };

  if (wantsKirim) {
    await pushPrefetch("latest_kirim", { limit: 8 }, "prefetch_latest_kirim");
  }
  if (shipmentMatch) {
    await pushPrefetch("find_shipment", { number: shipmentMatch[1] }, "prefetch_shipment");
    if (/pachka|пачк/.test(lower)) {
      await pushPrefetch("diagnose_pachka", { shipment_number: shipmentMatch[1] }, "prefetch_pachka");
    }
  } else if (wantsPachka) {
    await pushPrefetch("diagnose_pachka", {}, "prefetch_pachka_rule");
  }
  if (wantsPdf) {
    await pushPrefetch("davomat_pdf", {}, "prefetch_davomat_pdf");
  } else if (wantsOffice) {
    await pushPrefetch("office_today", {}, "prefetch_office");
  }
  if (wantsErrors) await pushPrefetch("recent_logs", { minutes: 120 }, "prefetch_logs");

  const weak = (text: string) => {
    const t = text.trim().toLowerCase();
    return !t
      || t === "tekshira olmadim"
      || t === "tekshira olmadim."
      || t === "не смог проверить"
      || t === "не смог проверить."
      || t.length < 8;
  };

  for (let round = 0; round < 6; round += 1) {
    const reply = await groqChat(messages, true);
    if (!reply) break;
    const calls = reply.tool_calls || [];
    if (!calls.length) {
      const text = sanitizeAssistantReply(String(reply.content || "").trim());
      if (!weak(text) || !toolTrace.some((x) => x.ok)) {
        const finalText = text
          || (files.length ? `PDF tayyor: ${files[0].name}. Pastdagi Yuklab olish tugmasini bosing.` : "Javob bo‘sh qaytdi.");
        return { reply: finalText, model: MODEL, tools: toolTrace, files };
      }
      messages.push({
        role: "user",
        content: "Tool natijasi bor. Undan aniq fakt bilan javob bering. Base64 yozmang. «tekshira olmadim» demang.",
      });
      break;
    }
    messages.push({
      role: "assistant",
      content: reply.content || "",
      tool_calls: calls,
    });
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      let result: unknown;
      let ok = true;
      try {
        result = await runTool(call.function.name, args);
        extractFiles(result, files);
      } catch (error) {
        ok = false;
        result = { error: error instanceof Error ? error.message : String(error) };
        logger.warn({ tool: call.function.name, err: result }, "assistant tool failed");
      }
      toolTrace.push({ name: call.function.name, ok });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: toolPayloadForModel(result),
      });
    }
  }

  const fallback = await groqChat(messages, false);
  let text = sanitizeAssistantReply(String(fallback?.content || "").trim());
  if (weak(text) && toolTrace.some((x) => x.ok)) {
    messages.push({
      role: "user",
      content: "Qayta: tool natijasidagi raqam/sana/statusni ochiq yozing. Base64/kod blokini yozmang.",
    });
    const again = await groqChat(messages, false);
    text = sanitizeAssistantReply(String(again?.content || "").trim() || text);
  }
  // PDF so‘ralgan bo‘lsa — fayl bo‘lmasa majburiy yasaymiz (model toolni o‘tkazib yubormasin)
  if (wantsPdf && !files.length) {
    try {
      const forced = await runTool("davomat_pdf", {});
      extractFiles(forced, files);
      toolTrace.push({ name: "davomat_pdf", ok: Boolean((forced as { ok?: boolean })?.ok) });
    } catch (error) {
      toolTrace.push({ name: "davomat_pdf", ok: false });
      logger.warn({ err: error instanceof Error ? error.message : error }, "assistant forced pdf failed");
    }
  }

  if (files.length) {
    text = sanitizeAssistantReply(text);
    if (!text || /base64|JVBERi0|kod bloki/i.test(text) || text.length < 12) {
      const f = files[0];
      text = `Davomat PDF tayyor (${f.name}). Pastdagi **Yuklab olish** tugmasini bosing.`;
    } else if (!/yuklab|скач|download|tugma/i.test(text)) {
      text = `${text}\n\nPDF fayl tayyor — **Yuklab olish** tugmasini bosing.`;
    }
  }
  return {
    reply: text || "Tool natijasi bo‘yicha yakuniy javob olinmadi.",
    model: MODEL,
    tools: toolTrace,
    files,
  };
}
