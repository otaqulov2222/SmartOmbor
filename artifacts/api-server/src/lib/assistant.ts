import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import dns from "node:dns";
import { dataFile } from "./data-dir";
import { logger } from "./logger";
import { officeSite, tashkentParts, todayBoard, workedMs, tabelDay, payrollMonth, payrollSettingsOf } from "./office";
import { packSizeOf, ensurePachka, productPackSize, pieceCount, receiptParts } from "./supply-assortment";
import { listLocalPeople } from "../routes/local-auth";
import { idFromHref, money, moysklad, moyskladAll, moyskladConfigured } from "./moysklad";
import { compactCode, findProductsByBarcode, findProductsByLabel, foldProductName, peekCatalog } from "./catalog";
import { orderRecommendations } from "./recommendations";
import { listAccounts } from "./partners";
import { exportDavomat, exportKirim, exportStaff } from "./assistant-export";
import {
  buildSalesSummaryReply,
  formatKpiAgentsReply,
  formatQty,
  formatStaffListReply,
  formatSum,
  isKpiAgentsIntent,
  isSalesSummaryIntent,
  isStaffListIntent,
  isTopSoldIntent,
  isUnsoldIntent,
  kpiFollowupReply,
  parseDaysWindow,
  portalLinksReply,
  resolveSalesDays,
  roleLabelUz,
  classifyAssistantIntent,
  finalizeAssistantReply,
  identityReply,
  isAttendanceIntent,
  isDailyBriefIntent,
  isIdentityIntent,
  isPayrollIntent,
  normalizeAssistantQuery,
  sanitizeAssistantReply,
  vagueGiveReply,
  wantsPortalLink,
  wantsVagueGive,
} from "./assistant-ux";

// Groq/Telegram uchun IPv4 birinchi (IPv6 timeout → "fetch failed").
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  /* ignore */
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b";

type ChatMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
  /** gpt-oss models sometimes put text here when content is empty */
  reasoning?: string;
};
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
Asosiy kuch: ombor, yuk xati, pachka, davomat, oylik, MoySklad, KPI, GPS, xodimlar.

TUSHUNISH (QATIY):
- Savolni ma’nosiga qarab javob bering. Orfografiya xato bo‘lsa ham (buyicha/bo‘yicha, toliq/to‘liq) tushuning.
- «bugungi kun hisoboti / nima boldi / holatlar» → kunlik brifing (yuk + savdo + davomat). KPI PDF emas.
- «bugun kim keldi / davomat» → davomat board.
- «oylik / maosh / jarima / avans» → oylik bo‘limi haqida aniq javob.
- «sen nima agentisan» → o‘zingizni qisqa tanishtiring, KPI havola bermang.
- Noaniq «ber/kere ber» → aniq variantlar so‘rang; uydirma fayl havolasi YO‘Q.

TIL (QATIY):
- Foydalanuvchi o‘zbekcha yozsa — FAQAT o‘zbekcha javob.
- Inglizcha so‘z/status YO‘Q: posted, accepted, lines, status, ok, error, true/false, recent_logs, shipment, supply, warehouse_staff, agent, worker, accountant.
- Lavozimlarni o‘zbekcha yozing: Ombor xodimi, Savdo agenti, Ofis xodimi, Bugalter, Menejer…
- O‘rniga: yozilgan, qabul qilingan, tovar qatorlari, holat, tayyor, xato, ha/yo‘q, oxirgi jurnal, yuk xati, kirim.
- «o‘rtacha / kunlik o‘rtacha» so‘ralganda jami bilan birga kunlik o‘rtachani ham yozing (jami ÷ kunlar).
- Portal/kirish so‘ralganda to‘liq havolani yozing (asosiy /, agent /agent, zavod /zavod) — gapni yarim ochiq qoldirmang.
- Markdown keng jadval YO‘Q (tor oynada buziladi). Faqat qisqa xulosa + bullet ro‘yxat.
- UUID / uzun id ko‘rsatmang. Ortiqcha ** kam. Parol/token/.env yo‘q.

QATIY:
- Sidebar: Dashboard → Mahsulotlar → Xodimlar → Davomat → Oylik → KPI → GPS → Hamkor → Boshqalar
- Pachka: yuk xatidagi qo‘lda yozilgan son → MoySklad packs.quantity
- Ofis GPS: 41.258556, 69.150964 · 150 m
- Ish vaqti default: 06:00–18:00, Dushanba dam (Se–Ya ish).

KPI bo‘limi (faqat KPI so‘ralganda):
- Boshqaruv / Agentlar / Savdo va to‘lov; 3 bosqich: shu kun 3%, 1–7 kun 2%, 8–15 kun 1%.
- Chatda uydirma KPI PDF/Excel havola bermang. Raqamlar: Dashboard → KPI.

Tool:
- Yuk / kirim / pachka / davomat / xato → AVVAL mos tool.
- Fayl (PDF/Excel/CSV) → export_report. Base64 yozmang.
- Fayl tayyor: qisqa xulosa + «Yuklab olish tugmasini bosing» (faqat haqiqiy fayl bo‘lsa).
- Soxta markdown havola YO‘Q.
- «tekshira olmadim» demang. Admin “tuzat/yoz” desa fix_product_pachka.
- FAQAT so‘ralgan savolga javob bering. Tool nomini foydalanuvchiga yozmang.`;

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
      description: "Davomat PDF (export_report alias). PDF so‘ralganda chaqirish mumkin.",
      parameters: {
        type: "object",
        properties: { date: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "export_report",
      description: "Haqiqiy fayl tayyorlash: davomat/kirim/xodimlar → PDF yoki Excel/CSV. Yuklab olish, PDF, Excel so‘ralganda chaqiring.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["davomat", "kirim", "staff"], description: "Qaysi hisobot" },
          format: { type: "string", enum: ["pdf", "xlsx", "csv"], description: "Default: davomat=pdf, boshqalar=xlsx" },
        },
        required: ["kind"],
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
      name: "audit_shipment",
      description: "Yuk xatini MoySklad supply bilan to‘liq solishtirish: ombor, kontragent, qator/dona, pachka, kamchiliklar. Oxirgi yoki raqam bo‘yicha.",
      parameters: {
        type: "object",
        properties: {
          number: { type: "string", description: "Masalan 0066-015; bo‘sh = oxirgi yuk" },
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
  {
    type: "function",
    function: {
      name: "top_sold_products",
      description: "Belgilangan kun oralig‘ida MoySklad bo‘yicha eng ko‘p sotilgan tovarlar (dona + summa).",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Default 15, max 365" },
          limit: { type: "number", description: "Default 15, max 40" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unsold_products",
      description: "Belgilangan kun ichida sotilmagan (qoldiq bor, savdo 0) tovarlar.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Default 20, max 365" },
          limit: { type: "number", description: "Default 20, max 50" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sales_summary",
      description: "Bugungi yoki N kunlik savdo summasi/dona (MoySklad + katalog).",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "1=bugun, default 1, max 365" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "warehouse_overview",
      description: "Ombor holati: tovar soni, qoldiq, past/harakatsiz, bugungi savdo/kirim.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "low_stock_products",
      description: "Qoldig‘i past yoki tugagan tovarlar.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "Default 20" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Mahsulot qidiruv: kod, nom, barkod — qoldiq va narx.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "order_recommendations",
      description: "Buyurtma tavsiyalari — qoldiq yetarli bo‘lmagan tez sotiladigan tovarlar.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_factories",
      description: "Hamkor/zavod ro‘yxati va kutayotgan yuklar.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
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
    return exportDavomat("pdf");
  }

  if (name === "export_report") {
    const kind = String(args.kind || "davomat").toLowerCase();
    const formatRaw = String(args.format || "").toLowerCase();
    if (kind === "kirim" || kind === "yuk" || kind === "shipment") {
      const format = formatRaw === "csv" ? "csv" : "xlsx";
      return exportKirim(format);
    }
    if (kind === "staff" || kind === "xodim" || kind === "xodimlar") {
      const format = formatRaw === "csv" ? "csv" : "xlsx";
      return exportStaff(format);
    }
    const format = formatRaw === "xlsx" || formatRaw === "csv" || formatRaw === "pdf"
      ? formatRaw as "pdf" | "xlsx" | "csv"
      : "pdf";
    return exportDavomat(format);
  }

  if (name === "list_staff") {
    return {
      items: listLocalPeople().map((p) => ({
        id: p.id,
        name: p.name,
        login: p.login,
        role: p.role,
        roleLabel: roleLabelUz(p.role),
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
    const skipMs = Boolean(args.skipMs) || String(args.mode || "") === "fast";
    if (!skipMs && moyskladConfigured()) {
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
    } else if (!skipMs) {
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

  if (name === "audit_shipment") {
    const needle = String(args.number || "").trim().toLowerCase();
    const partners = readPartners();
    const accounts = partners.accounts || [];
    const byFactory = new Map(accounts.map((a) => [String(a.id), a]));
    const ships = [...(partners.shipments || [])].sort((a, b) => shipmentSortKey(b).localeCompare(shipmentSortKey(a)));
    const hit = needle
      ? ships.find((s) => String(s.number || "").toLowerCase() === needle)
        || ships.find((s) => String(s.number || "").toLowerCase().includes(needle))
      : ships[0];
    if (!hit) return { ok: false, error: "yuk_topilmadi", number: needle || null };

    const factory = byFactory.get(String(hit.factoryId)) as Record<string, unknown> | undefined;
    const localLines = Array.isArray(hit.lines) ? hit.lines as Array<Record<string, unknown>> : [];
    type LineLike = { pairs: number; boxes: number; quantity: number; colors: Array<{ name?: string; quantity: number }> };
    const expectedRows = localLines.map((line) => {
      const pairs = Number(line.pairs) || 0;
      const boxes = Number(line.boxes) || 0;
      const quantity = Number(line.quantity) || 0;
      const colors = Array.isArray(line.colors)
        ? (line.colors as Array<Record<string, unknown>>).map((c) => ({
          name: String(c.name || ""),
          quantity: Number(c.quantity) || 0,
        }))
        : [];
      const shape = { pairs, boxes, quantity, colors } as LineLike;
      const pieces = pieceCount(shape);
      const parts = receiptParts(shape);
      const pachka = Number(line.pachka) || 0;
      const expectedPack = packSizeOf({ pachka, pairs });
      return {
        productCode: String(line.productCode || ""),
        productName: String(line.productName || ""),
        productId: line.productId ? String(line.productId) : null,
        size: String(line.size || ""),
        pairs,
        boxes,
        pachka,
        pieces,
        msParts: parts.length,
        expectedPack,
        price: Number(line.price) || 0,
      };
    });
    const expectedTotal = expectedRows.reduce((sum, row) => sum + row.pieces, 0);
    const expectedMsPositions = expectedRows.reduce((sum, row) => sum + row.msParts, 0);
    const expectedWithPachka = expectedRows.filter((row) => row.expectedPack > 1 || row.pachka > 1);

    const supplyId = hit.moyskladId ? String(hit.moyskladId) : "";
    let ms: Record<string, unknown> | null = null;
    let positions: Array<Record<string, unknown>> = [];
    let msError: string | null = null;
    if (!supplyId) {
      msError = "MoySklad id yo‘q — hali yozilmagan yoki bog‘lanmagan";
    } else if (!moyskladConfigured()) {
      msError = "MOYSKLAD_TOKEN yo‘q";
    } else {
      try {
        ms = await moysklad<Record<string, unknown>>(
          `/entity/supply/${encodeURIComponent(supplyId)}?expand=agent,organization,store,project,contract`,
        );
        const pos = await moysklad<{ rows?: Array<Record<string, unknown>> }>(
          `/entity/supply/${encodeURIComponent(supplyId)}/positions?limit=100&expand=assortment`,
        );
        positions = pos.rows || [];
      } catch (error) {
        msError = error instanceof Error ? error.message : String(error);
      }
    }

    const actualQty = positions.map((row) => Math.round(Number(row.quantity) || 0));
    const actualTotal = actualQty.reduce((sum, qty) => sum + qty, 0);
    const issues: string[] = [];
    if (!supplyId) issues.push("MoySklad supply bog‘lanmagan");
    if (msError) issues.push(`MS o‘qish: ${msError}`);
    if (ms && ms.deleted) issues.push("MS hujjat o‘chirilgan");
    if (ms && ms.applicable === false) issues.push("MS hujjat hali o‘tkazilmagan (applicable=yo‘q)");
    if (supplyId && !msError) {
      // MS da rang/variant bo‘yicha qatorlar ajraladi — lokal model qatori emas, receiptParts bilan solishtiramiz.
      if (positions.length !== expectedMsPositions) {
        issues.push(
          `MS qator soni mos emas: kutildi ${expectedMsPositions} (rang/variant), MS da ${positions.length}`
          + ` (yuk xati model qatorlari: ${expectedRows.length})`,
        );
      }
      if (actualTotal !== expectedTotal) {
        issues.push(`Dona jami mos emas: yuk xati ${expectedTotal}, MS ${actualTotal}`);
      }
    }
    if (!(ms as { agent?: unknown } | null)?.agent) issues.push("MS da kontragent (agent) tanlanmagan");
    if (!(ms as { store?: unknown } | null)?.store) issues.push("MS da ombor (store) tanlanmagan");
    if (!(ms as { organization?: unknown } | null)?.organization) issues.push("MS da tashkilot (organization) tanlanmagan");

    const pachkaChecks: Array<Record<string, unknown>> = [];
    for (const row of expectedWithPachka.slice(0, 12)) {
      const want = row.expectedPack > 1 ? row.expectedPack : row.pachka;
      if (!row.productId) {
        pachkaChecks.push({ productCode: row.productCode, expected: want, ms: null, ok: false, note: "productId yo‘q" });
        issues.push(`${row.productCode}: productId yo‘q — pachka tekshirilmadi`);
        continue;
      }
      try {
        const msPack = await productPackSize(row.productId);
        const ok = msPack === want;
        pachkaChecks.push({ productCode: row.productCode, expected: want, ms: msPack, ok });
        if (!ok) issues.push(`${row.productCode}: pachka kutildi ${want}, MS da ${msPack}`);
      } catch (error) {
        pachkaChecks.push({
          productCode: row.productCode,
          expected: want,
          ms: null,
          ok: false,
          note: error instanceof Error ? error.message : String(error),
        });
        issues.push(`${row.productCode}: pachka o‘qilmadi`);
      }
    }

    const agentName = String((ms as { agent?: { name?: string } } | null)?.agent?.name || "") || null;
    const storeName = String((ms as { store?: { name?: string } } | null)?.store?.name || "") || null;
    const orgName = String((ms as { organization?: { name?: string } } | null)?.organization?.name || "") || null;

    return {
      ok: issues.length === 0,
      number: hit.number,
      date: hit.date,
      status: hit.status,
      factory: factory?.name || factory?.code || hit.factoryId || null,
      local: {
        lines: expectedRows.length,
        expectedMsPositions,
        pieces: expectedTotal,
        pachkaLines: expectedWithPachka.length,
        postedUnits: hit.postedUnitsTotal ?? hit.postedUnits ?? null,
        sample: expectedRows.slice(0, 8).map((r) => ({
          code: r.productCode,
          size: r.size,
          pairs: r.pairs,
          boxes: r.boxes,
          pachka: r.pachka,
          pieces: r.pieces,
          msParts: r.msParts,
        })),
      },
      moysklad: supplyId ? {
        id: supplyId,
        name: ms?.name || hit.moyskladNumber || null,
        applicable: ms?.applicable ?? null,
        sum: typeof ms?.sum === "number" ? Number(ms.sum) / 100 : null,
        agent: agentName,
        store: storeName,
        organization: orgName,
        positions: positions.length,
        pieces: actualTotal,
      } : null,
      pachkaChecks,
      issues,
      verdict: issues.length === 0
        ? "Mos: yuk xati va MoySklad bir xil, asosiy maydonlar tanlangan."
        : `Kamchiliklar: ${issues.length} ta.`,
    };
  }

  if (name === "recent_logs") {
    const minutes = Math.min(24 * 60, Math.max(5, Math.round(Number(args.minutes) || 60)));
    try {
      const raw = execSync(
        `journalctl -u smart-ombor --since "${minutes} minutes ago" -p warning..alert --no-pager -n 40 2>/dev/null || true`,
        { encoding: "utf8", timeout: 8000 },
      );
      const lines = raw
        .split(/\n/)
        .map((l) => l.trim())
        .filter((l) => Boolean(l) && !/^--\s*No entries\s*--$/i.test(l))
        .slice(-30);
      return { minutes, lines };
    } catch (error) {
      return { minutes, error: error instanceof Error ? error.message : String(error), lines: [] };
    }
  }

  if (name === "top_sold_products") {
    const days = Math.min(365, Math.max(1, Math.round(Number(args.days) || 15)));
    const limit = Math.min(40, Math.max(5, Math.round(Number(args.limit) || 15)));
    const to = tashkentParts().date;
    const toDate = new Date(`${to}T12:00:00+05:00`);
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - (days - 1));
    const from = tashkentParts(fromDate).date;
    const momentFrom = `${from} 00:00:00`;
    const momentTo = `${to} 23:59:59`;

    if (!moyskladConfigured()) {
      const catalog = peekCatalog();
      const ranked = [...(catalog?.products || [])]
        .map((p) => ({
          name: p.name,
          code: p.code,
          article: p.article,
          qty: days <= 7 ? p.sales7 : p.sales30,
          sum: null as number | null,
          source: days <= 7 ? "katalog_7kun" : "katalog_30kun",
        }))
        .filter((p) => p.qty > 0)
        .sort((a, b) => b.qty - a.qty)
        .slice(0, limit);
      return {
        ok: true,
        days,
        from,
        to,
        source: "katalog",
        note: "MoySklad ulanmagan — katalogdagi savdo maydonidan.",
        totalQty: ranked.reduce((s, r) => s + r.qty, 0),
        items: ranked,
      };
    }

    try {
      const profit = await moyskladAll<{
        assortment?: { meta?: { href?: string }; name?: string; code?: string; article?: string };
        sellQuantity?: number;
        sellSum?: number;
      }>(
        `/report/profit/byproduct?momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}`,
      );
      const items = [...profit.rows]
        .map((row) => ({
          name: row.assortment?.name || "Mahsulot",
          code: row.assortment?.code || null,
          article: row.assortment?.article || null,
          qty: Number(row.sellQuantity || 0),
          sum: money(row.sellSum),
        }))
        .filter((row) => row.qty > 0)
        .sort((a, b) => b.qty - a.qty || (b.sum || 0) - (a.sum || 0))
        .slice(0, limit);
      return {
        ok: true,
        days,
        from,
        to,
        source: "moysklad",
        totalQty: items.reduce((s, r) => s + r.qty, 0),
        totalSum: items.reduce((s, r) => s + (r.sum || 0), 0),
        items,
      };
    } catch (error) {
      const catalog = peekCatalog();
      const ranked = [...(catalog?.products || [])]
        .map((p) => ({
          name: p.name,
          code: p.code,
          article: p.article,
          qty: days <= 7 ? p.sales7 : p.sales30,
          sum: null as number | null,
        }))
        .filter((p) => p.qty > 0)
        .sort((a, b) => b.qty - a.qty)
        .slice(0, limit);
      return {
        ok: ranked.length > 0,
        days,
        from,
        to,
        source: "katalog_fallback",
        error: error instanceof Error ? error.message : String(error),
        note: ranked.length
          ? `MoySklad vaqtincha o‘qilmadi — katalog (${days <= 7 ? "7" : "30"} kun) bo‘yicha.`
          : "Savdo ma’lumoti olinmadi.",
        totalQty: ranked.reduce((s, r) => s + r.qty, 0),
        items: ranked,
      };
    }
  }

  if (name === "unsold_products") {
    const days = Math.min(365, Math.max(1, Math.round(Number(args.days) || 20)));
    const limit = Math.min(50, Math.max(5, Math.round(Number(args.limit) || 20)));
    const to = tashkentParts().date;
    const toDate = new Date(`${to}T12:00:00+05:00`);
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - (days - 1));
    const from = tashkentParts(fromDate).date;
    const catalog = peekCatalog();
    const stocked = [...(catalog?.products || [])].filter((p) => Number(p.stock || 0) > 0 || Number(p.available || 0) > 0);

    const soldIds = new Set<string>();
    let source = "katalog";
    if (moyskladConfigured()) {
      try {
        const profit = await moyskladAll<{
          assortment?: { meta?: { href?: string } };
          sellQuantity?: number;
        }>(
          `/report/profit/byproduct?momentFrom=${encodeURIComponent(`${from} 00:00:00`)}&momentTo=${encodeURIComponent(`${to} 23:59:59`)}`,
        );
        for (const row of profit.rows) {
          if (Number(row.sellQuantity || 0) <= 0) continue;
          const id = idFromHref(row.assortment?.meta?.href);
          if (id) soldIds.add(id);
        }
        source = "moysklad+katalog";
      } catch {
        source = "katalog_fallback";
      }
    }

    const items = stocked
      .filter((p) => {
        if (source.startsWith("moysklad")) return !soldIds.has(p.id);
        const sold = days <= 7 ? Number(p.sales7 || 0) : Number(p.sales30 || 0);
        return sold <= 0;
      })
      .map((p) => ({
        name: p.name,
        code: p.code,
        article: p.article,
        stock: Number(p.stock || 0),
        available: Number(p.available || 0),
        sales7: Number(p.sales7 || 0),
        sales30: Number(p.sales30 || 0),
      }))
      .sort((a, b) => b.stock - a.stock || b.available - a.available)
      .slice(0, limit);

    return {
      ok: true,
      days,
      from,
      to,
      source,
      total: items.length,
      stockedTotal: stocked.length,
      items,
      note: !catalog
        ? "Katalog hali yuklanmagan."
        : source === "katalog_fallback"
          ? "MoySklad savdosi o‘qilmadi — katalog savdosidan."
          : null,
    };
  }

  if (name === "sales_summary") {
    const days = Math.min(365, Math.max(1, Math.round(Number(args.days) || 1)));
    const catalog = peekCatalog();
    const to = tashkentParts().date;
    const toDate = new Date(`${to}T12:00:00+05:00`);
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - (days - 1));
    const from = tashkentParts(fromDate).date;
    if (days === 1) {
      // Katalog ba’zan qoralamani ham qo‘shardi — bugun uchun MS dan jonli o‘qiymiz
      if (moyskladConfigured()) {
        try {
          const filter = encodeURIComponent(`moment>=${to} 00:00:00;moment<=${to} 23:59:59`);
          const demands = await moyskladAll<{ name?: string; sum?: number; applicable?: boolean }>(
            `/entity/demand?filter=${filter}`,
          );
          const posted = (demands.rows || []).filter((r) => r.applicable !== false);
          const drafts = (demands.rows || []).filter((r) => r.applicable === false);
          const salesAmount = posted.reduce((s, r) => s + (money(r.sum) || 0), 0);
          const draftSalesAmount = drafts.reduce((s, r) => s + (money(r.sum) || 0), 0);
          return {
            ok: true,
            days: 1,
            from: to,
            to,
            salesAmount,
            draftSalesAmount,
            draftCount: drafts.length,
            draftNumbers: drafts.map((r) => r.name).filter(Boolean).slice(0, 8),
            incomingToday: catalog?.incomingToday ?? null,
            pendingTransfers: catalog?.pendingTransfers ?? null,
            source: "moysklad_demand",
          };
        } catch (error) {
          /* fall through to catalog */
        }
      }
      return {
        ok: true,
        days: 1,
        from: to,
        to,
        salesAmount: catalog?.salesToday ?? null,
        draftSalesAmount: catalog?.draftSalesToday ?? null,
        incomingToday: catalog?.incomingToday ?? null,
        pendingTransfers: catalog?.pendingTransfers ?? null,
        source: catalog ? "katalog" : "yoq",
      };
    }
    if (!moyskladConfigured()) {
      return { ok: false, days, from, to, error: "MoySklad ulanmagan", salesAmount: null, salesQty: null };
    }
    try {
      const profit = await moyskladAll<{ sellQuantity?: number; sellSum?: number }>(
        `/report/profit/byproduct?momentFrom=${encodeURIComponent(`${from} 00:00:00`)}&momentTo=${encodeURIComponent(`${to} 23:59:59`)}`,
      );
      const salesQty = profit.rows.reduce((s, r) => s + Number(r.sellQuantity || 0), 0);
      const salesAmount = profit.rows.reduce((s, r) => s + (money(r.sellSum) || 0), 0);
      return { ok: true, days, from, to, salesAmount, salesQty, source: "moysklad" };
    } catch (error) {
      return {
        ok: false,
        days,
        from,
        to,
        error: error instanceof Error ? error.message : String(error),
        salesAmount: null,
        salesQty: null,
      };
    }
  }

  if (name === "warehouse_overview") {
    const catalog = peekCatalog();
    if (!catalog) return { ok: false, error: "katalog_yuklanmagan" };
    const products = catalog.products || [];
    const stockUnits = products.reduce((s, p) => s + Number(p.stock || 0), 0);
    const stockValue = products.reduce((s, p) => s + Number(p.stock || 0) * Number(p.cost || p.salePrice || 0), 0);
    const low = products.filter((p) => p.stockStatus === "low").length;
    const out = products.filter((p) => p.stockStatus === "out").length;
    const nonMoving = products.filter((p) => p.stockStatus === "non_moving").length;
    const byWh = new Map<string, { name: string; units: number; products: number }>();
    for (const row of catalog.stockRows || []) {
      const id = row.warehouse.id;
      const cur = byWh.get(id) || { name: row.warehouse.name, units: 0, products: 0 };
      cur.units += Number(row.quantity || 0);
      if (Number(row.quantity || 0) > 0) cur.products += 1;
      byWh.set(id, cur);
    }
    return {
      ok: true,
      productCount: catalog.productCount || products.length,
      stockUnits,
      stockValue: Math.round(stockValue),
      lowStock: low,
      outOfStock: out,
      nonMoving,
      salesToday: catalog.salesToday,
      incomingToday: catalog.incomingToday,
      pendingTransfers: catalog.pendingTransfers,
      warehouses: [...byWh.values()].sort((a, b) => b.units - a.units).slice(0, 12),
      loadedAt: catalog.loadedAt || null,
    };
  }

  if (name === "low_stock_products") {
    const limit = Math.min(40, Math.max(5, Math.round(Number(args.limit) || 20)));
    const catalog = peekCatalog();
    if (!catalog) return { ok: false, error: "katalog_yuklanmagan", items: [] };
    const items = [...catalog.products]
      .filter((p) => p.stockStatus === "low" || p.stockStatus === "out")
      .sort((a, b) => {
        const rank = (s: string) => (s === "out" ? 0 : 1);
        return rank(a.stockStatus) - rank(b.stockStatus) || a.stock - b.stock;
      })
      .slice(0, limit)
      .map((p) => ({
        name: p.name,
        code: p.code,
        stock: p.stock,
        status: p.stockStatus === "out" ? "tugagan" : "past",
        sales30: p.sales30,
      }));
    return { ok: true, total: items.length, items };
  }

  if (name === "search_products") {
    const query = String(args.query || "").trim();
    const limit = Math.min(20, Math.max(3, Math.round(Number(args.limit) || 8)));
    const catalog = peekCatalog();
    if (!catalog) return { ok: false, error: "katalog_yuklanmagan", items: [] };
    if (!query) return { ok: false, error: "query_kerak", items: [] };
    let hits = findProductsByBarcode(catalog, query);
    if (!hits.length) hits = findProductsByLabel(catalog, query).products;
    if (!hits.length) {
      const q = foldProductName(query);
      const compact = compactCode(query);
      const rawLower = query.toLowerCase();
      const digits = query.replace(/\D+/g, " ").trim().split(/\s+/).filter((t) => t.length >= 3);
      hits = catalog.products.filter((p) => {
        const nameLower = String(p.name || "").toLowerCase();
        const codeLower = String(p.code || "").toLowerCase();
        const blob = foldProductName(`${p.name} ${p.code || ""} ${p.article || ""} ${p.factory || ""}`);
        if (rawLower && (nameLower.includes(rawLower) || codeLower.includes(rawLower))) return true;
        if (digits.length && digits.every((d) => nameLower.includes(d) || codeLower.includes(d) || String(p.article || "").includes(d))) return true;
        if (q && blob.includes(q)) return true;
        if (compact && compactCode(`${p.code || ""}${p.article || ""}`).includes(compact)) return true;
        return (p.barcodes || []).some((b) => compactCode(b).includes(compact));
      }).slice(0, limit * 3);
    }
    const items = hits.slice(0, limit).map((p) => {
      const rows = (catalog.stockRows || [])
        .filter((r) => r.product.id === p.id && Number(r.quantity || 0) > 0)
        .slice(0, 4)
        .map((r) => ({ warehouse: r.warehouse.name, qty: r.quantity }));
      return {
        name: p.name,
        code: p.code,
        article: p.article,
        stock: p.stock,
        available: p.available,
        salePrice: p.salePrice,
        cost: p.cost,
        status: p.stockStatus,
        warehouses: rows,
      };
    });
    return { ok: true, query, total: items.length, items };
  }

  if (name === "order_recommendations") {
    const limit = Math.min(30, Math.max(5, Math.round(Number(args.limit) || 15)));
    const catalog = peekCatalog();
    if (!catalog) return { ok: false, error: "katalog_yuklanmagan", items: [] };
    const lines = orderRecommendations(catalog).slice(0, limit);
    return {
      ok: true,
      total: lines.length,
      items: lines.map((l) => ({
        name: l.product.name,
        code: l.product.code,
        onHand: l.onHand,
        inTransit: l.inTransit,
        suggested: l.suggestedQuantity,
        daily: l.dailyAverage,
        reason: l.reason === "out_of_stock" ? "tugagan" : l.reason === "fast" ? "tez ketadi" : "qoldiq past",
      })),
    };
  }

  if (name === "list_factories") {
    const accounts = listAccounts();
    const shipments = readPartners().shipments || [];
    const pendingBy = new Map<string, number>();
    for (const s of shipments) {
      if (String(s.status || "") !== "sent") continue;
      const id = String(s.factoryId || "");
      pendingBy.set(id, (pendingBy.get(id) || 0) + 1);
    }
    const items = accounts.slice(0, 40).map((a: Record<string, unknown>) => ({
      name: a.name || a.code || a.id,
      code: a.code || null,
      pending: pendingBy.get(String(a.id)) || 0,
    }));
    const pendingTotal = [...pendingBy.values()].reduce((s, n) => s + n, 0);
    return { ok: true, total: items.length, pendingShipments: pendingTotal, items };
  }

  return { error: `unknown_tool:${name}` };
}

function localizeStatus(value: unknown): unknown {
  if (typeof value === "boolean") return value ? "ha" : "yo‘q";
  if (typeof value !== "string") return value;
  const v = value.trim().toLowerCase();
  const map: Record<string, string> = {
    posted: "yozilgan",
    accepted: "qabul qilingan",
    pending: "kutilmoqda",
    draft: "qoralama",
    done: "tayyor",
    success: "muvaffaqiyatli",
    failed: "xato",
    error: "xato",
    ok: "tayyor",
    true: "ha",
    false: "yo‘q",
    applicable: "tasdiqlangan",
  };
  return map[v] || value;
}

function localizeToolValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(localizeToolValue);
  if (!value || typeof value !== "object") return localizeStatus(value);
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === "base64") continue;
    const k = key === "lines" ? "tovarQatorlari"
      : key === "posted" ? "moySkladgaYozilgan"
        : key === "status" ? "holat"
          : key === "moyskladId" ? "moySkladId"
            : key === "moyskladNumber" ? "moySkladRaqami"
              : key === "recentJobs" ? "oxirgiVazifalar"
                : key === "moyskladError" ? "moySkladXato"
                  : key === "latestLocalPosted" ? "oxirgiYozilganYuk"
                    : key === "latestLocalAny" ? "oxirgiYuk"
                      : key === "localShipments" ? "mahalliyYuklar"
                        : key === "moyskladSupplies" ? "moySkladKirimlar"
                          : key === "moyskladLatest" ? "moySkladOxirgi"
                            : key;
    out[k] = key === "posted" || key === "applicable" || key === "status"
      ? localizeStatus(raw)
      : localizeToolValue(raw);
  }
  return out;
}

function toolPayloadForModel(result: unknown): string {
  if (!result || typeof result !== "object") return JSON.stringify(localizeStatus(result) ?? null).slice(0, 12000);
  const clone = localizeToolValue(JSON.parse(JSON.stringify(result))) as Record<string, unknown>;
  const file = clone.file;
  if (file && typeof file === "object") {
    const f = file as Record<string, unknown>;
    clone.file = {
      nom: f.name,
      turi: f.mime,
      biriktirilgan: true,
      bayt: typeof f.base64 === "string" ? Math.round((String(f.base64).length * 3) / 4) : 0,
      eslatma: "Fayl UI da Yuklab olish tugmasi. Base64 yozmang. Inglizcha so‘z ishlatmang.",
    };
  }
  clone.tilEslatma = "Javobni faqat o‘zbekcha yozing: posted→yozilgan, accepted→qabul qilingan, lines→tovar qatorlari.";
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


function detectExport(lower: string): { kind: "davomat" | "kirim" | "staff"; format: "pdf" | "xlsx" | "csv" } | null {
  const wantsDavomat = /davomat|посещаем/.test(lower);
  const wantsStaff = /xodim|staff|сотруд/.test(lower);
  const wantsKirim = /kirim\s*hisobot|yuk\s*(hisobot|excel|pdf)|shipment|приход|наклад/.test(lower)
    || (/kirim|yuklar|yuk\b/.test(lower) && /pdf|xlsx|excel|csv|yuklab|fayl|hisobot/.test(lower) && !wantsDavomat);
  // «bugungi kun hisobot / tizim hisobot» — fayl emas, kunlik brifing
  if (isDailyBriefIntent(lower) && !/pdf|пдф|xlsx|excel|csv/.test(lower)) {
    return null;
  }
  if (/hisobot/.test(lower) && /bugun|kun\s*buyicha|tizim|umumiy|nima\s*boldi|holat/.test(lower)
    && !wantsDavomat && !wantsKirim && !wantsStaff
    && !/pdf|пдф|xlsx|excel|csv/.test(lower)) {
    return null;
  }
  const explicitFile = /pdf|пдф|xlsx|excel|exel|csv|yuklab|скач|файл|fayl|export|скачать/.test(lower);
  const hisobotFile = /hisobot\s*(ber|chiqar|tayyor|ol)/.test(lower) && (wantsDavomat || wantsKirim || wantsStaff);
  if (!explicitFile && !hisobotFile) return null;
  const format: "pdf" | "xlsx" | "csv" = /xlsx|excel|exel/.test(lower)
    ? "xlsx"
    : /csv/.test(lower)
      ? "csv"
      : "pdf";
  if (wantsStaff) return { kind: "staff", format: format === "pdf" ? "xlsx" : format };
  if (wantsKirim && !wantsDavomat) return { kind: "kirim", format: format === "pdf" ? "xlsx" : format };
  if (wantsDavomat) return { kind: "davomat", format };
  // Aniq fayl so‘ralgan, lekin turi yo‘q — taxmin qilmaymiz
  return null;
}

function isShipmentTopic(lower: string): boolean {
  return /yuklar|yuk\b|yuk\s*xati|kirim|supply|moy\s*sklad|moysklad|наклад|отгруз|pachka|пачк|otgruz|prihod/.test(lower);
}

function isAuditIntent(lower: string): boolean {
  // Aniq tekshiruv buyruqlari
  if (/tekshir|solishtir|muammo|kamchilik|verify|audit|проверь|насколько\s*верно|xato\s*bormi/.test(lower)) {
    return true;
  }
  // «to‘g‘rimi / mosmi» — faqat yuk/kirim/pachka kontekstida (savdo tasdig‘i emas!)
  const confirm = /mosmi|mos\s*mi|to['‘`]?g['‘`]?\s*rimi|qanday yozilgan|tanlanganmi|tanlash kerak/.test(lower);
  if (!confirm) return false;
  return isShipmentTopic(lower) || /\b\d{3,5}-\d{2,4}\b/.test(lower);
}

function isSalesConfirmIntent(lower: string): boolean {
  if (!/(sotilgan|savdo|sotuv|продаж)/.test(lower)) return false;
  return /to['‘`]?g['‘`]?\s*ri|rostmi|haqiqat|confirm|бұл\s*правиль|shu\s*ro.?yxat|bular/.test(lower);
}

function pickMessageText(msg: ChatMsg | undefined | null): string {
  if (!msg) return "";
  const content = String(msg.content || "").trim();
  if (content) return content;
  // Ba’zi modellarda javob reasoning ichida qoladi — oxirgi qismini olamiz.
  const reasoning = String(msg.reasoning || "").trim();
  if (!reasoning) return "";
  const parts = reasoning.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const last = parts[parts.length - 1] || reasoning;
  // Inglizcha o‘ylash matnini emas, oxirgi blokni qaytaramiz (ko‘pincha yakun).
  return last.slice(0, 4000);
}

/** Groq o‘chsa ham bo‘sh xato chiqmasin — mahalliy tushuntirish. */
function localGuideReply(lower: string): string | null {
  const ask = /tushun|nima|qanday|bolim|bo['‘`]?lim|ishla|farq|vhk|tushuntir|vazifa|maqsad|qoida/.test(lower);
  if (/kpi|boshqaruv|agentlar va|savdo va to['‘`]?lov|3 bosqich/.test(lower) && ask) {
    return [
      "KPI bo‘limi — agentlar savdosi va foiz hisobi.",
      "",
      "• Boshqaruv — umumiy rasm: agentlar, jami KPI, MS yangilash. Agentni bosib guruh/mijozlarni ko‘rasiz.",
      "• Agentlar va hamkorlar — agent bo‘yicha jami (mijozlar, kirim, chiqim, KPI). Mijozlar tabi — biriktirish.",
      "• Savdo va to‘lov — har bir jo‘natma: savdo, to‘langan, foiz, KPI, holat.",
      "• 3 bosqich qoidalari — shu kun 3%, 1–7 kun 2%, 8–15 kun 1% (asos: to‘langan summa).",
      "",
      "Login/parol — Xodimlar bo‘limida. KPI raqamlari shu KPI menyusida.",
    ].join("\n");
  }
  if (/davomat|ofis|keldim|ketdim|face|qr/.test(lower) && ask) {
    return [
      "Davomat — ofisga kelish/ketish nazorati.",
      "",
      "• Belgilash — Face ID yoki QR + GPS (ofis 150 m ichida).",
      "• Tarix — o‘z kelish/ketishlaringiz.",
      "• Sozlamalar — yuz bog‘lash.",
      "• Hisobot — rahbar uchun jadval, Excel/PDF.",
    ].join("\n");
  }
  if (/hamkor|zavod|factory|yuk xati|kirim qilish|pachka qoida/.test(lower) && ask) {
    return [
      "Hamkor / yuk xati:",
      "• Yuk xati yoziladi → «Kirim» → MoySklad supply.",
      "• Tanlanadi: tashkilot, ombor, kontragent (zavod).",
      "• Pachka (>1) mahsulot packs.quantity ga yoziladi.",
      "• Tekshirish: «oxirgi yukni tekshir» yoki «0066-015 tekshir».",
    ].join("\n");
  }
  if (/gps|marshrut|agent portal|joylashuv/.test(lower) && ask) {
    return [
      "GPS va marshrut — agentlar joylashuvi / tashriflar.",
      "Agent portal — agent o‘z kabineti (mijoz, tashrif, KPI).",
      "Ofis GPS (davomat): 41.258556, 69.150964 · 150 m.",
    ].join("\n");
  }
  if (wantsPortalLink(lower)) {
    return portalLinksReply();
  }
  if (/xodim|login|parol|lavozim|ruxsat/.test(lower) && ask) {
    return [
      "Xodimlar — akkauntlar (ism, login, parol, lavozim, ruxsat).",
      "",
      "• Qo‘shish / tahrirlash / o‘chirish shu yerda.",
      "• Agentlar ham shu ro‘yxatda; KPI raqamlari KPI bo‘limida.",
      "",
      portalLinksReply(),
    ].join("\n");
  }
  if (/meny|sidebar|bo['‘`]?limlar|qayerda|navigats/.test(lower)
    || (/tushun|nima qil/.test(lower) && /tizim|smart\s*ombor|loyih/.test(lower))) {
    return [
      "Asosiy menyu tartibi:",
      "Dashboard → Mahsulotlar → Xodimlar → Davomat → KPI → GPS → Hamkor → Boshqalar",
      "",
      "Buyruqlar: davomat PDF, oxirgi yukni tekshir, 0066-015, bugun kim keldi, xodimlar ro‘yxati, tizim holati.",
    ].join("\n");
  }
  if (/^salom|^assalom|^hello|^hi\b/.test(lower.trim())) {
    return "Salom! Ombor, davomat, KPI, yuk xati yoki hisobot bo‘yicha yordam beraman. Nima kerak?";
  }
  return null;
}

function formatAuditReply(audit: Record<string, unknown>): string {
  const local = (audit.local || {}) as Record<string, unknown>;
  const ms = (audit.moysklad || null) as Record<string, unknown> | null;
  const issues = Array.isArray(audit.issues) ? audit.issues as string[] : [];
  const pachka = Array.isArray(audit.pachkaChecks) ? audit.pachkaChecks as Array<Record<string, unknown>> : [];
  const badPachka = pachka.filter((row) => row.ok === false);
  const lines = [
    `Yuk xati ${audit.number} (${audit.date || "—"}) — ${audit.verdict || ""}`,
    `Zavod: ${audit.factory || "—"} · holat: ${localizeStatus(audit.status)}`,
  ];
  if (ms) {
    lines.push(
      `MS: ${ms.name || "—"} · ombor ${ms.store || "—"} · kontragent ${ms.agent || "—"}`,
      `Pozitsiya ${ms.positions || 0}/${local.expectedMsPositions || 0}, dona ${ms.pieces || 0}/${local.pieces || 0}`,
    );
  } else {
    lines.push("MoySklad hujjati topilmadi.");
  }
  if (badPachka.length) {
    lines.push("Pachka mos emas:");
    for (const row of badPachka.slice(0, 8)) {
      lines.push(`• ${row.productCode}: kutildi ${row.expected}, MS ${row.ms ?? "—"}`);
    }
  }
  if (issues.length) {
    lines.push("Kamchiliklar:");
    for (const issue of issues.slice(0, 10)) lines.push(`• ${issue}`);
  } else {
    lines.push("Kamchilik yo‘q.");
  }
  return lines.join("\n");
}

type AssistantResult = {
  reply: string;
  model: string;
  tools: Array<{ name: string; ok: boolean }>;
  files: AssistantFile[];
};

function offlineAssistantReply(input: {
  message: string;
  files: AssistantFile[];
  tools: Array<{ name: string; ok: boolean }>;
}): AssistantResult {
  const lower = input.message.toLowerCase();
  if (input.files.length) {
    const f = input.files[0];
    return {
      reply: `${f.name} tayyor. Pastdagi Yuklab olish tugmasini bosing.`,
      model: "local-offline",
      tools: input.tools,
      files: input.files,
    };
  }
  const guided = localGuideReply(lower);
  if (guided) {
    return {
      reply: finalizeAssistantReply(guided, false),
      model: "local-offline",
      tools: input.tools,
      files: input.files,
    };
  }
  return {
    reply: finalizeAssistantReply([
      "Hozir AI ulanishi sekin edi — lekin asosiy yordam mahalliy ishlayapti.",
      "",
      "So‘rashingiz mumkin: yuk tekshiruvi, davomat, savdo, sotilmagan/qoldiq past, ombor, buyurtma tavsiya, mahsulot qidiruv, hisobot.",
      "Xabarni qisqa qilib qayta yuboring.",
    ].join("\n"), false),
    model: "local-offline",
    tools: input.tools,
    files: input.files,
  };
}

function workedLabel(ms: number) {
  const totalMin = Math.max(0, Math.floor(Number(ms || 0) / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h} soat ${m} daq`;
  return `${m} daq`;
}

function isLowStockIntent(lower: string) {
  return /qoldiq\s*past|kam\s*qol|tugab|tugagan|low\s*stock|out\s*of\s*stock|мало\s*остат|закончил/.test(lower)
    || (/qoldiq|stock/.test(lower) && /(past|kam|tug|oz|мало)/.test(lower));
}

function isWarehouseIntent(lower: string) {
  return /ombor\s*holat|omborlar|stock\s*overview|jami\s*qoldiq|sklad\s*holat|склад\s*состоян/.test(lower)
    || (/ombor/.test(lower) && /(holat|qancha|jami|umumiy|nechta)/.test(lower));
}

function isRecoIntent(lower: string) {
  return /buyurtma\s*tavsiya|nimaga\s*buyurt|zakaz\s*ber|tavsiya\s*buyurt|рекоменд|что\s*заказать|order\s*reco/.test(lower)
    || (/buyurtma|zakaz/.test(lower) && /(tavsiya|kerak|nima|qaysi)/.test(lower));
}

function isFactoryIntent(lower: string) {
  return /zavodlar|hamkorlar\s*ro.?yxat|fabrika|factory\s*list|контрагент|partner\s*list/.test(lower)
    || (/zavod|hamkor|fabrika/.test(lower) && /(ro.?yxat|kim|qaysi|nechta|bor)/.test(lower));
}

function isProductSearchIntent(lower: string, raw: string) {
  if (/mahsulot\s*qidir|tovar\s*qidir|barkod|barcode|qoldiq\s*bor\s*mi|narxi\s*qancha/.test(lower)) return true;
  if (/(qoldiq|stock|narx|price|bormi|бор\s*ли).{0,20}(qancha|necha|\?)/.test(lower) && !isShipmentTopic(lower)) return true;
  // Kod/barkod o‘xshash so‘rov (yuk raqamisiz)
  if (!/\b\d{3,5}-\d{2,4}\b/.test(raw) && /(?:^|\s)(?:bordo\s+)?\d{3,8}(?:\s|$)/i.test(raw) && /(tovar|mahsulot|qoldiq|narx|kod|article|арт)/.test(lower)) {
    return true;
  }
  return false;
}

function extractSearchQuery(message: string, lower: string) {
  const m = message.match(/(?:qidir|top|ko['‘`]?rsat|bormi|qoldiq|narx)[:\s]+(.+)$/i)
    || message.match(/["«](.+?)["»]/)
    || message.match(/\b(\d{8,14})\b/)
    || message.match(/\b((?:bordo\s+)?\d{3,6}(?:\s+\d{2,6}){0,3})\b/i);
  if (m?.[1]) return m[1].trim();
  return message
    .replace(/mahsulot|tovar|qidir|ko['‘`]?rsat|bormi|qoldiq|narxi?|qancha|necha|ber|pls|please/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || lower.slice(0, 80);
}

function formatTopSoldReply(data: Record<string, unknown>) {
  const days = Number(data.days) || 15;
  const from = String(data.from || "");
  const to = String(data.to || "");
  const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
  if (!items.length) {
    return `Oxirgi ${days} kun (${from} — ${to}) ichida sotuv topilmadi.`;
  }
  const note = data.note ? `\n${data.note}` : "";
  const lines = items.slice(0, 20).map((row, i) => {
    const code = row.code ? ` · ${row.code}` : "";
    const sum = formatSum(row.sum as number | null);
    const sumPart = sum ? ` · ${sum} so‘m` : "";
    return `${i + 1}) ${row.name}${code}: ${formatQty(Number(row.qty))} dona${sumPart}`;
  });
  return [
    `Oxirgi ${days} kun (${from} — ${to}) — eng ko‘p sotilganlar:`,
    ...lines,
    `Jami (ro‘yxat): ${formatQty(Number(data.totalQty) || 0)} dona.`,
  ].join("\n") + note;
}

function formatUnsoldReply(data: Record<string, unknown>) {
  const days = Number(data.days) || 20;
  const from = String(data.from || "");
  const to = String(data.to || "");
  const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
  if (data.note && !items.length && String(data.note).includes("yuklanmagan")) {
    return "Katalog hali tayyor emas. Bir ozdan keyin qayta so‘rang.";
  }
  if (!items.length) {
    return `Oxirgi ${days} kun (${from} — ${to}) ichida qoldiq bor, lekin sotilmagan tovar topilmadi.`;
  }
  const lines = items.slice(0, 25).map((row, i) => {
    const code = row.code ? ` · ${row.code}` : "";
    const stock = formatQty(Number(row.stock || row.available || 0));
    return `${i + 1}) ${row.name}${code}: qoldiq ${stock}`;
  });
  const extra = data.note ? `\n${data.note}` : "";
  return [
    `Oxirgi ${days} kun (${from} — ${to}) — sotilmagan (qoldiq bor):`,
    ...lines,
    `Ko‘rsatildi: ${items.length} ta.`,
  ].join("\n") + extra;
}

function clockLabel(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat("uz-UZ", {
    timeZone: "Asia/Tashkent",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** Buyruq/vazifa — Groq kutmasdan tool + mahalliy matn (tez va barqaror). Barcha asosiy stsenariylar. */
async function tryFastLocalTask(
  message: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
): Promise<AssistantResult | null> {
  const lower = normalizeAssistantQuery(message);
  const intent = classifyAssistantIntent(lower);
  const tools: Array<{ name: string; ok: boolean }> = [];
  const files: AssistantFile[] = [];
  const shipmentMatch = message.match(/\b(\d{3,5}-\d{2,4})\b/);
  const shipmentNo = shipmentMatch?.[1] || "";
  const auditAsk = isAuditIntent(lower);
  const shipTopic = isShipmentTopic(lower);
  const prevAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content || "";
  const prevWasSales = /eng ko['‘`]?p sotilgan|sotilganlar:|dona ·|savdo hisobot/i.test(prevAssistant);
  const prevWasUnsold = /sotilmagan \(qoldiq bor\)|harakatsiz/i.test(prevAssistant);
  const prevWasKpi = /KPI|Dashboard\s*→\s*KPI|agentlar\s*\(|Boshqaruv\s*\/\s*Agentlar/i.test(prevAssistant);

  const run = async (name: string, args: Record<string, unknown> = {}) => {
    try {
      const result = await runTool(name, args);
      extractFiles(result, files);
      tools.push({ name, ok: true });
      return result;
    } catch (error) {
      tools.push({ name, ok: false });
      logger.warn({ tool: name, err: error instanceof Error ? error.message : error }, "fast-local tool failed");
      return null;
    }
  };

  const doAudit = async (number?: string) => {
    const audit = await run("audit_shipment", number ? { number } : {}) as Record<string, unknown> | null;
    if (!audit || audit.error === "yuk_topilmadi") {
      return { reply: "Tekshirish uchun yuk xati topilmadi.", model: "local-fast", tools, files } satisfies AssistantResult;
    }
    return { reply: formatAuditReply(audit), model: "local-fast", tools, files } satisfies AssistantResult;
  };

  // 0) Oldingi ro‘yxatni tasdiqlash — auditga tushmasin
  if (isSalesConfirmIntent(lower) || ((prevWasSales || prevWasUnsold) && /to['‘`]?g['‘`]?\s*ri|rostmi|haqiqat|bular|shu\s*ro.?yxat/.test(lower))) {
    const reply = prevWasUnsold
      ? "Ha. Bu belgilangan kun ichida sotuvi bo‘lmagan, lekin qoldig‘i bor tovarlar."
      : "Ha. Bu MoySklad savdo hisobotidan olingan eng ko‘p sotilgan tovarlar — yuk xati yoki kirim emas.";
    return { reply, model: "local-fast", tools, files };
  }

  // 0-) O‘zini tanishtirish — KPI/agent trapiga tushmasin
  if (intent === "identity" || isIdentityIntent(lower)) {
    return { reply: identityReply(), model: "local-fast", tools, files };
  }

  // 0a) Bugungi tizim hisoboti — «hisobot ber» vague/KPI yo‘liga tushmasin
  if (intent === "daily_brief" || isDailyBriefIntent(lower)) {
    const today = tashkentParts().date;
    const sales = await run("sales_summary", { days: 1 }) as Record<string, unknown> | null;
    const board = await run("office_today", {}) as Record<string, unknown> | null;
    const kirim = await run("latest_kirim", { limit: 20, skipMs: true }) as Record<string, unknown> | null;
    const local = Array.isArray(kirim?.localShipments) ? kirim!.localShipments as Array<Record<string, unknown>> : [];
    const todays = local.filter((s) => String(s.date || "") === today);
    const posted = todays.filter((s) => {
      const p = s.moySkladgaYozilgan ?? s.posted;
      return p === true || p === "ha" || p === "yozilgan";
    });
    const unposted = todays.filter((s) => !posted.includes(s));
    const people = listLocalPeople();
    const tabel = tabelDay(today, people.map((p) => ({ id: p.id, name: p.name, login: p.login, role: p.role })));
    const late = (tabel.items || []).filter((r) => r.status === "late" || Number(r.lateIn || 0) > 0);
    const present = Array.isArray(board?.rows) ? (board!.rows as Array<Record<string, unknown>>).filter((r) => r.inAt) : [];
    const logs = await run("recent_logs", { minutes: 180 }) as { lines?: string[] } | null;
    const logLines = (logs?.lines || []).slice(-5);
    const salesAmt = sales?.salesAmount != null ? formatSum(Number(sales.salesAmount)) : null;

    // Tezkor audit faqat bugungi yuklar uchun (qisqa)
    const auditLines: string[] = [];
    for (const s of todays.slice(0, 6)) {
      const audit = await run("audit_shipment", { number: String(s.number) }) as Record<string, unknown> | null;
      if (!audit || audit.error) {
        auditLines.push(`• ${s.number}: tekshirib bo‘lmadi`);
        continue;
      }
      const issues = Array.isArray(audit.issues) ? audit.issues as string[] : [];
      auditLines.push(`• ${audit.number}: ${issues.length ? `kamchilik ${issues.length}` : "OK"}`);
    }

    const reply = [
      `Bugungi hisobot — ${today}`,
      "",
      "1) Yuk / kirim",
      todays.length
        ? [
          `• Jami: ${todays.length} ta · MS ga yozilgan: ${posted.length} · yozilmagan: ${unposted.length}`,
          ...todays.map((s) => {
            const p = s.moySkladgaYozilgan ?? s.posted;
            const holat = p === true || p === "ha" || p === "yozilgan" ? "MS ga yozilgan" : "MS yo‘q";
            return `  – ${s.number} · ${localizeStatus(s.status)} · ${holat} · ${s.lines || s.tovarQatorlari || 0} qator`;
          }),
          auditLines.length ? `• Tekshiruv:\n${auditLines.join("\n")}` : "",
        ].filter(Boolean).join("\n")
        : "• Bugun yuk xati yo‘q.",
      "",
      "2) Savdo",
      `• O‘tkazilgan: ${salesAmt != null ? `${salesAmt} so‘m` : "ma’lumot yo‘q"}`,
      sales?.draftSalesAmount != null && Number(sales.draftSalesAmount) > 0
        ? `• Qoralama: ${formatSum(Number(sales.draftSalesAmount))} so‘m${Array.isArray(sales.draftNumbers) && sales.draftNumbers.length ? ` · № ${(sales.draftNumbers as string[]).join(", ")}` : ""}`
        : "",
      sales?.incomingToday != null ? `• Bugungi kirim: ${formatQty(Number(sales.incomingToday))} dona` : "",
      "",
      "3) Davomat",
      `• Xodimlar: ${board?.total ?? people.length} · kelgan: ${board?.present ?? present.length} · kelmagan: ${board?.absent ?? "—"} · kechikkan: ${late.length}`,
      "",
      "4) Ogohlantirishlar",
      logLines.length
        ? logLines.map((l) => `• ${l.slice(0, 140)}`).join("\n")
        : "• Oxirgi 3 soatda ogohlantirish/xato yo‘q.",
      "",
      unposted.length
        ? `Diqqat: ${unposted.length} ta yuk hali MS ga yozilmagan.`
        : todays.length
          ? "Xulosa: bugungi yuklar MS ga yozilgan, asosiy tekshiruvlar OK."
          : "Xulosa: kunlik holat yig‘ildi.",
    ].filter((line, i, arr) => !(line === "" && arr[i - 1] === "")).join("\n");

    return { reply, model: "local-fast", tools, files };
  }

  // 0a1) Oylik / maosh / jarima qisqa holat
  if (intent === "payroll" || isPayrollIntent(lower)) {
    try {
      const month = tashkentParts().date.slice(0, 7);
      const people = listLocalPeople().map((p) => ({ id: p.id, name: p.name, login: p.login, role: p.role }));
      const pay = payrollMonth(month, people);
      const site = officeSite();
      const settings = payrollSettingsOf();
      const top = [...pay.people].sort((a, b) => Math.abs(b.fineTotal) - Math.abs(a.fineTotal)).slice(0, 5);
      const reply = [
        `Oylik (${month}) — qisqa holat`,
        "",
        `• Ish vaqti: ${site.start}–${site.end} · dam kunlari: ${(site.offDays || []).map((d) => ["Ya", "Du", "Se", "Ch", "Pa", "Ju", "Sh"][d]).join(", ") || "—"}`,
        `• Ish kunlari: ${pay.workdays} · kechikish jarimasi: ${settings.latePenaltyPct}% kunlik`,
        `• Xodimlar: ${pay.summary.headcount} · oylik fondi: ${formatSum(pay.summary.salaryFund) || 0} so‘m`,
        `• Jarimalar: ${formatSum(pay.summary.fineTotal) || 0} · avans: ${formatSum(pay.summary.advancesTotal) || 0} · bonus: ${formatSum(pay.summary.adjustmentsTotal) || 0}`,
        `• Yakuniy to‘lov: ${formatSum(pay.summary.netTotal) || 0} so‘m`,
        top.some((p) => p.fineTotal)
          ? ["", "Eng ko‘p jarima:", ...top.filter((p) => p.fineTotal).map((p) => `• ${p.name}: ${formatSum(p.fineTotal)} so‘m (kelmagan ${p.absentDays}, kechik ${p.lateDays})`)].join("\n")
          : "",
        "",
        "Batafsil: Dashboard → Oylik. Excel/PDF shu bo‘limdan yuklanadi.",
      ].filter(Boolean).join("\n");
      return { reply, model: "local-fast", tools, files };
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : error }, "payroll brief failed");
      return {
        reply: "Oylik hisobini hozir ochib bo‘lmadi. Dashboard → Oylik bo‘limiga kiring.",
        model: "local-fast",
        tools,
        files,
      };
    }
  }

  // 0a2) Davomat board (kunlik brifingdan keyin, vague dan oldin)
  if (intent === "attendance" || isAttendanceIntent(lower)) {
    const board = await run("office_today", {}) as Record<string, unknown> | null;
    if (!board) return { reply: "Davomat board olinmadi.", model: "local-fast", tools, files };
    const rows = Array.isArray(board.rows) ? board.rows as Array<Record<string, unknown>> : [];
    const present = rows.filter((r) => r.inAt);
    const absent = Number(board.absent) || Math.max(0, Number(board.total || 0) - present.length);
    const people = listLocalPeople();
    const byId = new Map(people.map((p) => [p.id, p.name]));
    const day = tashkentParts().date;
    const tabel = tabelDay(day, people.map((p) => ({ id: p.id, name: p.name, login: p.login, role: p.role })));
    const late = (tabel.items || []).filter((r) => r.status === "late" || Number(r.lateIn || 0) > 0);
    const onlyLate = /kechik/.test(lower);
    if (onlyLate) {
      return {
        reply: late.length
          ? [`Bugun kechikkanlar (${late.length}):`, ...late.slice(0, 20).map((r) => `• ${r.name}: ${r.inHm || "—"} (+${r.lateIn || 0} daq)`)].join("\n")
          : "Bugun kechikkan yo‘q.",
        model: "local-fast",
        tools,
        files,
      };
    }
    return {
      reply: [
        `Bugungi davomat: jami ${board.total}, kelgan ${board.present ?? present.length}, kelmagan ${absent}, kechikkan ${late.length}.`,
        ...present.slice(0, 15).map((r) => {
          const rawName = String(r.name || "");
          const name = (/^[0-9a-f-]{36}$/i.test(rawName) ? byId.get(rawName) : rawName) || "xodim";
          return `• ${name}: ${clockLabel(String(r.inAt || ""))} → ${r.outAt ? clockLabel(String(r.outAt)) : "ketmagan"} (${workedLabel(Number(r.workedMs || 0))})`;
        }),
        absent ? `Kelmaganlar: ${absent} ta (batafsil Dashboard → Davomat).` : "",
      ].filter(Boolean).join("\n"),
      model: "local-fast",
      tools,
      files,
    };
  }

  // 0b) «kere ber» / qisqa buyruq — Groq ga UMUMAN ketmaydi (soxta PDF yo‘q)
  if (intent === "vague_give" || wantsVagueGive(lower)) {
    if (/excel|xlsx/.test(lower) || (/fayl/.test(lower) && (prevWasKpi || /agent/i.test(prevAssistant)))) {
      await run("export_report", { kind: "staff", format: "xlsx" });
      if (files.length) {
        return {
          reply: finalizeAssistantReply(`${files[0].name} tayyor. Pastdagi Yuklab olish tugmasini bosing.`, true),
          model: "local-fast",
          tools,
          files,
        };
      }
    }
    return {
      reply: vagueGiveReply(prevAssistant || (prevWasKpi ? "KPI" : "")),
      model: "local-fast",
      tools,
      files,
    };
  }

  // 0c) KPI agentlar ro‘yxati (Groq uydirma + «— agent» bo‘lmasin)
  if (isKpiAgentsIntent(lower) || (/agentlar/.test(lower) && /kpi|bugun|ro.?yxat/.test(lower))) {
    const data = await run("list_staff", {}) as { items?: Array<Record<string, unknown>> } | null;
    const items = data?.items || [];
    const agents = items.filter((p) => /agent/i.test(String(p.role || "")));
    const today = tashkentParts().date;
    return {
      reply: formatKpiAgentsReply(agents, today),
      model: "local-fast",
      tools,
      files,
    };
  }

  // agentlar excel
  if (/agentlar?\s*(excel|xlsx|fayl)|excel.*agent/.test(lower)) {
    await run("export_report", { kind: "staff", format: "xlsx" });
    if (files.length) {
      return {
        reply: `Agentlar/xodimlar fayli tayyor (${files[0].name}). Pastdagi Yuklab olish tugmasini bosing.`,
        model: "local-fast",
        tools,
        files,
      };
    }
  }

  // 1) Fayl / hisobot (faqat aniq davomat/kirim/xodim + fayl)
  const exportWanted = detectExport(lower);
  if (exportWanted) {
    await run("export_report", exportWanted);
    if (files.length) {
      const f = files[0];
      const kindLabel = exportWanted.kind === "kirim" ? "Kirim"
        : exportWanted.kind === "staff" ? "Xodimlar"
          : "Davomat";
      return {
        reply: `${kindLabel} hisoboti tayyor (${f.name}). Pastdagi Yuklab olish tugmasini bosing.`,
        model: "local-fast",
        tools,
        files,
      };
    }
    return {
      reply: "Hisobotni tayyorlab bo‘lmadi. Bir ozdan keyin qayta urinib ko‘ring.",
      model: "local-fast",
      tools,
      files,
    };
  }

  // 2) Aniq yuk raqami: tekshir → audit; aks holda qisqa + pachka
  if (shipmentNo) {
    if (auditAsk || /to['‘`]?liq|ms\b|moy\s*sklad|moysklad/.test(lower)) {
      return doAudit(shipmentNo);
    }
    const found = await run("find_shipment", { number: shipmentNo }) as Record<string, unknown> | null;
    if (!found || !found.found) {
      return {
        reply: `Yuk xati topilmadi: ${shipmentNo}. Raqamni tekshirib qayta yozing.`,
        model: "local-fast",
        tools,
        files,
      };
    }
    const lines = Array.isArray(found.lines) ? found.lines as Array<Record<string, unknown>> : [];
    const withPachka = lines.filter((l) => Number(l.pachka) > 1 || Number(l.packSizeOf) > 1);
    const bullets = withPachka.slice(0, 8).map((l) => {
      const code = String(l.productCode || "tovar");
      const pachka = Number(l.pachka) || Number(l.packSizeOf) || 0;
      const pairs = Number(l.pairs) || 0;
      const write = l.willWriteToMs ? "MS ga yoziladi" : "MS ga yozilmaydi";
      return `• ${code}: pachka ${pachka}, juft ${pairs} — ${write}`;
    });
    if (/pachka|пачк|tuzat|yoz/.test(lower)) {
      await run("diagnose_pachka", { shipment_number: shipmentNo });
    }
    return {
      reply: [
        `Yuk xati ${found.number}: holat — ${localizeStatus(found.status)}, sana ${found.date || "—"}.`,
        found.moyskladNumber ? `MoySklad: ${found.moyskladNumber}` : "MoySkladga hali yozilmagan.",
        `Tovar qatorlari: ${lines.length}.`,
        bullets.length ? "Pachka qatorlari:\n" + bullets.join("\n") : "Pachka (>1) qatorlari yo‘q.",
      ].join("\n"),
      model: "local-fast",
      tools,
      files,
    };
  }

  // 3) Audit: oxirgi / bugungi / yolg‘iz «tekshir» (qisqa matnni avtomatik audit qilmaymiz)
  const wantsLatestAudit = auditAsk && (
    shipTopic
    || /oxirgi|so['‘`]?nggi|bugun|last|сегодня|последн/.test(lower)
    || /^(tekshir(ib\s*ber)?|solishtir|muammo\s*bormi|verify|audit)[\s?.!]*$/i.test(lower.trim())
  );
  const wantsTodayAll = auditAsk && /bugun|сегодня/.test(lower) && /hamma|barcha|all|yuklar/.test(lower);
  if (wantsTodayAll) {
    const data = await run("latest_kirim", { limit: 12, skipMs: true }) as Record<string, unknown> | null;
    const local = Array.isArray(data?.localShipments) ? data!.localShipments as Array<Record<string, unknown>> : [];
    const today = tashkentParts().date;
    const todays = local.filter((s) => String(s.date || "") === today).slice(0, 5);
    if (!todays.length) {
      return { reply: `Bugun (${today}) yuk xati topilmadi.`, model: "local-fast", tools, files };
    }
    const parts: string[] = [`Bugungi yuklar tekshiruvi (${todays.length} ta):`];
    for (const s of todays) {
      const audit = await run("audit_shipment", { number: String(s.number) }) as Record<string, unknown> | null;
      if (!audit || audit.error) {
        parts.push(`• ${s.number}: tekshirib bo‘lmadi`);
        continue;
      }
      const issues = Array.isArray(audit.issues) ? audit.issues as string[] : [];
      parts.push(`• ${audit.number}: ${issues.length ? `kamchilik ${issues.length}` : "OK"} — ${audit.verdict}`);
    }
    // Eng oxirgisini to‘liq
    const full = await run("audit_shipment", { number: String(todays[0].number) }) as Record<string, unknown> | null;
    if (full && !full.error) {
      parts.push("", "Oxirgi yuk batafsil:", formatAuditReply(full));
    }
    return { reply: parts.join("\n"), model: "local-fast", tools, files };
  }
  if (wantsLatestAudit) {
    return doAudit();
  }

  // 4) MS ga yozilmagan / xato vazifalar
  if (/yozilmagan|post\s*qilinmagan|ms\s*yo.?q|bog.?lanmagan|unposted|не\s*провед/.test(lower)
    && (shipTopic || /ms\b|moy\s*sklad|moysklad|yuk/.test(lower))) {
    const data = await run("latest_kirim", { limit: 15, skipMs: true }) as Record<string, unknown> | null;
    const local = Array.isArray(data?.localShipments) ? data!.localShipments as Array<Record<string, unknown>> : [];
    const open = local.filter((s) => !(s.posted === true || s.moySkladgaYozilgan === true || s.moySkladgaYozilgan === "ha" || s.posted === "yozilgan"));
    return {
      reply: open.length
        ? ["MS ga yozilmagan yuklar:", ...open.slice(0, 10).map((s) => `• ${s.number} · ${s.date} · ${localizeStatus(s.status)}`)].join("\n")
        : "Oxirgi ro‘yxatda MS ga yozilmagan yuk yo‘q.",
      model: "local-fast",
      tools,
      files,
    };
  }
  if (/supply.?job|yuk vazifa|kirim vazifa|pending|xato vazifa|job\s*error|failed\s*job/.test(lower)
    || (/xato|error|failed/.test(lower) && /kirim|yuk|supply/.test(lower))) {
    const data = await run("supply_jobs", {}) as { count?: number; items?: Array<Record<string, unknown>> } | null;
    const items = data?.items || [];
    const bad = items.filter((j) => /error|fail|pending/i.test(String(j.status || "")));
    const focus = bad.length ? bad : items;
    return {
      reply: [
        `Yuk/kirim vazifalari: ${items.length} (muammoli: ${bad.length})`,
        ...focus.slice(0, 10).map((j) => `• ${j.shipmentNumber || j.id} — ${localizeStatus(j.status)}${j.error || j.detail ? `: ${j.error || j.detail}` : ""}`),
      ].join("\n"),
      model: "local-fast",
      tools,
      files,
    };
  }

  // 5) Sotilmagan / harakatsiz tovarlar
  if (isUnsoldIntent(lower)) {
    const days = parseDaysWindow(lower, 20);
    const data = await run("unsold_products", { days, limit: 20 }) as Record<string, unknown> | null;
    if (!data) {
      return { reply: "Sotilmagan tovarlar ro‘yxatini olib bo‘lmadi.", model: "local-fast", tools, files };
    }
    return { reply: formatUnsoldReply(data), model: "local-fast", tools, files };
  }

  // 5b) Eng ko‘p sotilgan tovarlar
  if (isTopSoldIntent(lower)) {
    const days = parseDaysWindow(lower, 15);
    const data = await run("top_sold_products", { days, limit: 15 }) as Record<string, unknown> | null;
    if (!data) {
      return { reply: "Savdo reytingini olib bo‘lmadi. Bir ozdan keyin qayta urinib ko‘ring.", model: "local-fast", tools, files };
    }
    return { reply: formatTopSoldReply(data), model: "local-fast", tools, files };
  }

  // 5c) Savdo summasi / kunlik o‘rtacha
  if (isSalesSummaryIntent(lower)) {
    const days = resolveSalesDays(lower);
    const data = await run("sales_summary", { days }) as Record<string, unknown> | null;
    if (!data) return { reply: "Savdo summasini olib bo‘lmadi.", model: "local-fast", tools, files };
    return {
      reply: buildSalesSummaryReply({
        lower,
        days,
        from: data.from != null ? String(data.from) : undefined,
        to: data.to != null ? String(data.to) : undefined,
        salesAmount: data.salesAmount != null ? Number(data.salesAmount) : null,
        salesQty: data.salesQty != null ? Number(data.salesQty) : null,
        draftSalesAmount: data.draftSalesAmount != null ? Number(data.draftSalesAmount) : null,
        draftNumbers: Array.isArray(data.draftNumbers) ? (data.draftNumbers as string[]) : undefined,
        incomingToday: data.incomingToday != null ? Number(data.incomingToday) : null,
      }),
      model: "local-fast",
      tools,
      files,
    };
  }

  // 5d) Qoldiq past / tugagan
  if (isLowStockIntent(lower)) {
    const data = await run("low_stock_products", { limit: 20 }) as Record<string, unknown> | null;
    const items = Array.isArray(data?.items) ? data!.items as Array<Record<string, unknown>> : [];
    if (!items.length) {
      return { reply: data?.error === "katalog_yuklanmagan" ? "Katalog hali tayyor emas." : "Qoldig‘i past/tugagan tovar topilmadi.", model: "local-fast", tools, files };
    }
    return {
      reply: [
        "Qoldiq past / tugagan:",
        ...items.slice(0, 20).map((p, i) => `${i + 1}) ${p.name}${p.code ? ` · ${p.code}` : ""}: ${p.status}, qoldiq ${formatQty(Number(p.stock))}`),
      ].join("\n"),
      model: "local-fast",
      tools,
      files,
    };
  }

  // 5e) Ombor holati
  if (isWarehouseIntent(lower)) {
    const data = await run("warehouse_overview", {}) as Record<string, unknown> | null;
    if (!data || data.error) {
      return { reply: "Ombor holati olinmadi (katalog yuklanmagan bo‘lishi mumkin).", model: "local-fast", tools, files };
    }
    const wh = Array.isArray(data.warehouses) ? data.warehouses as Array<Record<string, unknown>> : [];
    return {
      reply: [
        `Ombor: ${data.productCount} kartochka, qoldiq ${formatQty(Number(data.stockUnits))} dona.`,
        `Past: ${data.lowStock}, tugagan: ${data.outOfStock}, harakatsiz: ${data.nonMoving}.`,
        `Bugun: savdo ${formatSum(Number(data.salesToday)) || 0} so‘m, kirim ${formatQty(Number(data.incomingToday || 0))}.`,
        wh.length ? "Omborlar:\n" + wh.slice(0, 8).map((w) => `• ${w.name}: ${formatQty(Number(w.units))} dona`).join("\n") : "",
      ].filter(Boolean).join("\n"),
      model: "local-fast",
      tools,
      files,
    };
  }

  // 5f) Buyurtma tavsiya
  if (isRecoIntent(lower)) {
    const data = await run("order_recommendations", { limit: 15 }) as Record<string, unknown> | null;
    const items = Array.isArray(data?.items) ? data!.items as Array<Record<string, unknown>> : [];
    if (!items.length) {
      return { reply: data?.error === "katalog_yuklanmagan" ? "Katalog hali tayyor emas." : "Hozircha buyurtma tavsiyasi yo‘q.", model: "local-fast", tools, files };
    }
    return {
      reply: [
        "Buyurtma tavsiyalari:",
        ...items.slice(0, 15).map((p, i) => `${i + 1}) ${p.name}${p.code ? ` · ${p.code}` : ""}: buyurtma ${formatQty(Number(p.suggested))} (qoldiq ${formatQty(Number(p.onHand))}, ${p.reason})`),
      ].join("\n"),
      model: "local-fast",
      tools,
      files,
    };
  }

  // 5g) Zavod / hamkor
  if (isFactoryIntent(lower)) {
    const data = await run("list_factories", {}) as Record<string, unknown> | null;
    const items = Array.isArray(data?.items) ? data!.items as Array<Record<string, unknown>> : [];
    return {
      reply: [
        `Hamkor/zavodlar: ${data?.total || items.length} ta. Kutayotgan yuk: ${data?.pendingShipments || 0}.`,
        ...items.slice(0, 20).map((a) => `• ${a.name}${a.code ? ` (${a.code})` : ""}${Number(a.pending) > 0 ? ` — kutayotgan ${a.pending}` : ""}`),
      ].join("\n"),
      model: "local-fast",
      tools,
      files,
    };
  }

  // 5h) Mahsulot qidiruv
  if (isProductSearchIntent(lower, message)) {
    const query = extractSearchQuery(message, lower);
    const data = await run("search_products", { query, limit: 8 }) as Record<string, unknown> | null;
    const items = Array.isArray(data?.items) ? data!.items as Array<Record<string, unknown>> : [];
    if (!items.length) {
      return { reply: `«${query}» bo‘yicha mahsulot topilmadi.`, model: "local-fast", tools, files };
    }
    return {
      reply: [
        `Qidiruv: ${query}`,
        ...items.map((p, i) => {
          const price = p.salePrice != null ? ` · ${formatSum(Number(p.salePrice))} so‘m` : "";
          const wh = Array.isArray(p.warehouses) && p.warehouses.length
            ? " · " + (p.warehouses as Array<Record<string, unknown>>).map((w) => `${w.warehouse}: ${formatQty(Number(w.qty))}`).join(", ")
            : "";
          return `${i + 1}) ${p.name}${p.code ? ` · ${p.code}` : ""}: qoldiq ${formatQty(Number(p.stock))}${price}${wh}`;
        }),
      ].join("\n"),
      model: "local-fast",
      tools,
      files,
    };
  }

  // 6a) Bugungi yuklar ro‘yxati (faqat shu kun — Groq aralashtirmasin)
  if (!auditAsk && /bugun|сегодня/.test(lower) && /yuk|kirim|наклад/.test(lower)) {
    const data = await run("latest_kirim", { limit: 20, skipMs: true }) as Record<string, unknown> | null;
    const local = Array.isArray(data?.localShipments) ? data!.localShipments as Array<Record<string, unknown>> : [];
    const today = tashkentParts().date;
    const todays = local.filter((s) => String(s.date || "") === today);
    if (!todays.length) {
      return { reply: `Bugun (${today}) yuk xati yo‘q.`, model: "local-fast", tools, files };
    }
    return {
      reply: [
        `Bugungi yuklar (${today}): ${todays.length} ta.`,
        ...todays.slice(0, 15).map((s) => {
          const posted = s.moySkladgaYozilgan ?? s.posted;
          const holat = posted === true || posted === "ha" || posted === "yozilgan" ? "MS ga yozilgan" : "MS yo‘q";
          return `• ${s.number} · ${localizeStatus(s.status)} · ${holat} · ${s.lines || s.tovarQatorlari || 0} qator`;
        }),
      ].join("\n"),
      model: "local-fast",
      tools,
      files,
    };
  }

  // 6) Oxirgi kirim ro‘yxati (tekshir emas)
  const wantsKirimList = /oxirgi|so['‘`]?nggi|последн|eng oxir|list|ro.?yxat/.test(lower)
    && /yuk|kirim|supply|наклад|moy\s*sklad|moysklad/.test(lower)
    && !auditAsk;
  if (wantsKirimList || (/kirim|supply|приход/.test(lower) && /qaysi|qanaqa|nima\s*bor/.test(lower))) {
    const data = await run("latest_kirim", { limit: 8, skipMs: true }) as Record<string, unknown> | null;
    if (!data) return { reply: "Kirim ma’lumotini olib bo‘lmadi.", model: "local-fast", tools, files };
    const local = Array.isArray(data.localShipments) ? data.localShipments as Array<Record<string, unknown>> : [];
    return {
      reply: [
        "Oxirgi kirim/yuklar:",
        ...local.slice(0, 8).map((s) => {
          const posted = s.moySkladgaYozilgan ?? s.posted;
          const holat = posted === true || posted === "ha" || posted === "yozilgan" ? "MS ga yozilgan" : "mahalliy";
          return `• ${s.number} · ${s.date || "—"} · ${holat} · ${s.lines || s.tovarQatorlari || 0} qator`;
        }),
      ].join("\n"),
      model: "local-fast",
      tools,
      files,
    };
  }

  // 7) Davomat — yuqorida (0a2) qayta ishlangan; bu yerda dublikat yo‘q

  // 8a) Portal / kirish havolasi
  if (wantsPortalLink(lower)) {
    return { reply: portalLinksReply(), model: "local-fast", tools, files };
  }

  // 8) Xodimlar
  if (isStaffListIntent(lower)) {
    const data = await run("list_staff", {}) as { items?: Array<Record<string, unknown>> } | null;
    const items = data?.items || [];
    const onlyAgents = /\bagent/.test(lower) && !/xodim/.test(lower);
    const rows = onlyAgents ? items.filter((p) => /agent/i.test(String(p.role || ""))) : items;
    return {
      reply: formatStaffListReply(rows, onlyAgents),
      model: "local-fast",
      tools,
      files,
    };
  }

  // 9) Journal / xato
  if (/journal|лог|loglar|server xato|oxirgi xato|warning|ogohlantirish/.test(lower)
    || (/xato|error/.test(lower) && /server|tizim|journal|log/.test(lower))) {
    const data = await run("recent_logs", { minutes: 120 }) as { lines?: string[]; minutes?: number; error?: string } | null;
    const lines = data?.lines || [];
    return {
      reply: lines.length
        ? [`Oxirgi ${data?.minutes || 120} daq jurnal:`, ...lines.slice(-15).map((l) => `• ${l.slice(0, 180)}`)].join("\n")
        : "Oxirgi 120 daqiqada ogohlantirish/xato yo‘q.",
      model: "local-fast",
      tools,
      files,
    };
  }

  // 10) Tizim holati
  if (/tizim holat|system overview|umumiy holat|server holat|yordamchi holat|ishlayaptimi/.test(lower)) {
    const data = await run("system_overview", {}) as Record<string, unknown> | null;
    if (!data) return { reply: "Tizim holati olinmadi.", model: "local-fast", tools, files };
    const office = (data.office || {}) as Record<string, unknown>;
    const recent = Array.isArray(data.recentShipments) ? data.recentShipments as Array<Record<string, unknown>> : [];
    return {
      reply: [
        `Vaqt: ${data.date || "—"} ${data.clock || ""}`.trim(),
        `Ofis GPS: ${office.lat}, ${office.lng} · ${office.radiusM} m`,
        `Xodimlar: ${data.staff}`,
        `Yordamchi: ${(data.configured ? "ulangan" : "sozlanmagan")}`,
        recent.length ? "Oxirgi yuklar:\n" + recent.slice(0, 5).map((s) => `• ${s.number} · ${s.date} · ${localizeStatus(s.status)}`).join("\n") : "",
      ].filter(Boolean).join("\n"),
      model: "local-fast",
      tools,
      files,
    };
  }

  // 11) Tushuntirishlar
  const guided = localGuideReply(lower);
  if (guided) {
    return { reply: guided, model: "local-guide", tools, files };
  }

  // 12) Yolg‘iz «tekshir» / «muammo bormi» — default: oxirgi yuk auditi
  if (auditAsk) {
    return doAudit();
  }

  return null;
}

async function groqChat(messages: ChatMsg[], tools = true) {
  const key = groqKey();
  if (!key) throw Object.assign(new Error("assistant_unconfigured"), { status: 503 });
  const body: Record<string, unknown> = {
    model: MODEL,
    temperature: 0.25,
    // gpt-oss reasoning tokenlarni ham yeydi — yetarli joy qoldiramiz
    max_completion_tokens: 4096,
    messages,
  };
  if (/gpt-oss/i.test(MODEL)) {
    body.reasoning_effort = "low";
  }
  if (tools) {
    body.tools = TOOLS;
    body.tool_choice = "auto";
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 28_000);
    try {
      const response = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await response.text();
      let json: {
        choices?: Array<{ message?: ChatMsg & { reasoning?: string } }>;
        error?: { message?: string };
      };
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        throw Object.assign(new Error("groq_bad_json"), { status: 502, detail: text.slice(0, 200) });
      }
      if (!response.ok) {
        throw Object.assign(new Error(json.error?.message || "groq_error"), {
          status: response.status === 401 ? 503 : 502,
        });
      }
      const msg = json.choices?.[0]?.message;
      if (msg && !String(msg.content || "").trim() && msg.reasoning) {
        msg.content = pickMessageText(msg);
      }
      return msg;
    } catch (error) {
      lastErr = error;
      const msg = error instanceof Error ? error.message : String(error);
      const retryable = /fetch failed|aborted|ETIMEDOUT|ECONNRESET|ENOTFOUND|network|timeout/i.test(msg)
        || (typeof error === "object" && error && "cause" in error);
      if (!retryable || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 350 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  const detail = lastErr instanceof Error
    ? `${lastErr.message}${lastErr.cause ? ` (${String((lastErr.cause as { code?: string }).code || lastErr.cause)})` : ""}`
    : String(lastErr);
  throw Object.assign(new Error("groq_unreachable"), { status: 502, detail });
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

  // Avvalo tez mahalliy yo‘l: buyruq/vazifa/tushuntirish — Groq kutmaydi.
  const fast = await tryFastLocalTask(message, history);
  if (fast) {
    return {
      ...fast,
      reply: finalizeAssistantReply(fast.reply, Array.isArray(fast.files) && fast.files.length > 0),
    };
  }

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
  const exportWanted = detectExport(lower);
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
  if (exportWanted) {
    await pushPrefetch("export_report", exportWanted, "prefetch_export_report");
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

  const finishWithFiles = (text: string, model = MODEL) => {
    if (files.length) {
      const f = files[0];
      return {
        reply: finalizeAssistantReply(`${f.name} tayyor. Pastdagi Yuklab olish tugmasini bosing.`, true),
        model,
        tools: toolTrace,
        files,
      };
    }
    return { reply: finalizeAssistantReply(text, false), model, tools: toolTrace, files };
  };

  try {
    for (let round = 0; round < 3; round += 1) {
      const reply = await groqChat(messages, true);
      if (!reply) break;
      const calls = reply.tool_calls || [];
      if (!calls.length) {
        const text = sanitizeAssistantReply(pickMessageText(reply));
        if (!weak(text) || !toolTrace.some((x) => x.ok)) {
          const finalText = text
            || (files.length ? `PDF tayyor: ${files[0].name}. Pastdagi Yuklab olish tugmasini bosing.` : "Javob bo‘sh qaytdi.");
          return finishWithFiles(finalText);
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
    let text = sanitizeAssistantReply(pickMessageText(fallback));
    if (weak(text) && toolTrace.some((x) => x.ok)) {
      messages.push({
        role: "user",
        content: "Qayta: tool natijasidagi raqam/sana/statusni ochiq yozing. Base64/kod blokini yozmang.",
      });
      const again = await groqChat(messages, false);
      text = sanitizeAssistantReply(pickMessageText(again) || text);
    }
    // Fayl so‘ralgan bo‘lsa — yo‘q bo‘lsa majburiy yasaymiz
    if (exportWanted && !files.length) {
      try {
        const forced = await runTool("export_report", exportWanted);
        extractFiles(forced, files);
        toolTrace.push({ name: "export_report", ok: Boolean((forced as { ok?: boolean })?.ok) });
      } catch (error) {
        toolTrace.push({ name: "export_report", ok: false });
        logger.warn({ err: error instanceof Error ? error.message : error }, "assistant forced export failed");
      }
    }

    return finishWithFiles(text || "Tool natijasi bo‘yicha yakuniy javob olinmadi.");
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    logger.warn({ err: code }, "assistant groq failed — offline reply");
    if (exportWanted && !files.length) {
      try {
        const forced = await runTool("export_report", exportWanted);
        extractFiles(forced, files);
        toolTrace.push({ name: "export_report", ok: Boolean((forced as { ok?: boolean })?.ok) });
      } catch {
        toolTrace.push({ name: "export_report", ok: false });
      }
    }
    return offlineAssistantReply({ message, files, tools: toolTrace });
  }
}
