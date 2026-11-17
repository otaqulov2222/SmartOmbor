import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dataFile } from "./data-dir";
import { logger } from "./logger";
import { officeSite, tashkentParts, todayBoard, workedMs } from "./office";
import { packSizeOf, ensurePachka, productPackSize } from "./supply-assortment";
import { listLocalPeople } from "../routes/local-auth";
import { moysklad, moyskladConfigured } from "./moysklad";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b";

type ChatMsg = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; name?: string; tool_calls?: ToolCall[] };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

function groqKey() {
  return String(process.env.GROQ_API_KEY || process.env.GROQ_KEY || "").trim();
}

export function assistantConfigured() {
  return Boolean(groqKey());
}

const SYSTEM = `Siz — Smart Ombor to‘liq sun’iy intellekt nazorat agentisiz (Bordo).
Til: foydalanuvchi qaysi tilda yozsa (o‘zbekcha yoki ruscha) — shu tilda bemalol, tabiiy muloqot qiling.
Format: qisqa xulosa + aniq faktlar. Markdown jadval / ortiqcha ** kam. Parol/token/.env ko‘rsatmang.

QATIY shartnoma:
- Sidebar: Dashboard → Mahsulotlar → Xodimlar → Davomat → KPI → GPS → Hamkor → Boshqalar
- Davomat dropdown: Davomat + Davomat hisobot; oddiy xodim faqat Mening kabinetim
- Pachka: yuk xatidagi qo‘lda yozilgan son → MoySklad packs.quantity (juft teng bo‘lsa ham)
- Ofis GPS: 41.219353, 69.272828 · 100 m

Majburiy:
- Yuk / kirim / MoySklad supply / pachka / davomat / xato so‘ralganda AVVAL mos tool chaqiring.
- «Oxirgi kirim / so‘nggi yuk / MoySkladga yozilgan oxirgi» → latest_kirim.
- Tool natijasi bo‘lsa — undan aniq javob bering (raqam, sana, status, MS id). «tekshira olmadim» demang.
- Faqat tool xato qaytarsa yoki bo‘sh bo‘lsa — sababini ayting.
- Admin aniq “tuzat/yoz/исправь/запиши” desa fix_product_pachka.`;

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

  // Prefetch: yuk / kirim / pachka / davomat — model kutmasin.
  const shipmentMatch = message.match(/\b(\d{3,5}-\d{2,4})\b/);
  const lower = message.toLowerCase();
  const wantsKirim = /kirim|supply|приход|oxirgi yuk|so['‘`]?nggi yuk|oxirgi.*moy|moy\s*sklad.*yuk|yuk.*moy\s*sklad|последн.*(приход|наклад|поставк)|какой.*(приход|supply)/.test(lower)
    || (/oxirgi|so['‘`]?nggi|последн|eng oxir/.test(lower) && /yuk|kirim|supply|moy\s*sklad|moysklad|наклад/.test(lower));
  const wantsPachka = /pachka|пачк|packs?\.?quantity/.test(lower)
    && !wantsKirim;
  const wantsOffice = /davomat|посещаем|kelmagan|не приш|bugun kim|сегодня кто/.test(lower);
  const wantsErrors = /xato|ошибк|error|journal|log/.test(lower)
    && !wantsKirim;

  const pushPrefetch = async (name: string, args: Record<string, unknown>, id: string) => {
    try {
      const pre = await runTool(name, args);
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
        content: JSON.stringify(pre).slice(0, 12000),
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
  if (wantsOffice) await pushPrefetch("office_today", {}, "prefetch_office");
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
      const text = String(reply.content || "").trim();
      if (!weak(text) || !toolTrace.some((x) => x.ok)) {
        return { reply: text || "Javob bo‘sh qaytdi.", model: MODEL, tools: toolTrace };
      }
      messages.push({
        role: "user",
        content: "Tool natijasi bor. Undan aniq fakt bilan javob bering. «tekshira olmadim» demang.",
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
        content: JSON.stringify(result).slice(0, 12000),
      });
    }
  }

  const fallback = await groqChat(messages, false);
  let text = String(fallback?.content || "").trim();
  if (weak(text) && toolTrace.some((x) => x.ok)) {
    messages.push({
      role: "user",
      content: "Qayta: tool natijasidagi raqam/sana/statusni ochiq yozing.",
    });
    const again = await groqChat(messages, false);
    text = String(again?.content || "").trim() || text;
  }
  return {
    reply: text || "Tool natijasi bo‘yicha yakuniy javob olinmadi.",
    model: MODEL,
    tools: toolTrace,
  };
}
