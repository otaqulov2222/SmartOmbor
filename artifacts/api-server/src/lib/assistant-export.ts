import { randomBytes } from "node:crypto";
import { buildDavomatPdf, type DavomatPdfRow } from "./assistant-pdf";
import { buildXlsx, type Cell } from "./xlsx-file";
import { listLocalPeople } from "../routes/local-auth";
import { tashkentParts, todayBoard, workedMs } from "./office";
import { dataFile } from "./data-dir";
import { existsSync, readFileSync } from "node:fs";

export type ExportFile = {
  id: string;
  name: string;
  mime: string;
  base64: string;
};

function clock(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("uz-UZ", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tashkent",
  });
}

function workedLabel(ms: number, hasIn: boolean) {
  if (!hasIn) return "—";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h} soat ${m} daq`;
}

export function davomatRows(): {
  date: string;
  total: number;
  present: number;
  absent: number;
  rows: DavomatPdfRow[];
} {
  const people = listLocalPeople();
  const byId = new Map(people.map((p) => [p.id, p]));
  const date = tashkentParts().date;
  const rows = todayBoard().map((row) => {
    const person = byId.get(row.accountId);
    return {
      name: person?.name || person?.login || "Xodim",
      role: person?.role || "",
      inAt: row.inAt || null,
      outAt: row.outAt || null,
      status: row.inAt ? "Kelgan" : "Kelmagan",
      workedLabel: workedLabel(workedMs(row), Boolean(row.inAt)),
    };
  });
  const present = rows.filter((r) => r.inAt).length;
  return {
    date,
    total: people.length,
    present,
    absent: Math.max(0, people.length - present),
    rows,
  };
}

function fileOf(name: string, mime: string, buf: Buffer): ExportFile {
  return {
    id: randomBytes(6).toString("hex"),
    name,
    mime,
    base64: buf.toString("base64"),
  };
}

export async function exportDavomat(format: "pdf" | "xlsx" | "csv") {
  const data = davomatRows();
  if (format === "pdf") {
    const pdf = await buildDavomatPdf(data);
    if (!pdf) return { ok: false as const, error: "pdf_build_failed", ...data };
    return {
      ok: true as const,
      kind: "davomat",
      format,
      title: `Davomat hisobot (${data.date})`,
      ...data,
      rows: data.rows.slice(0, 40),
      file: fileOf(`davomat-${data.date}.pdf`, "application/pdf", pdf),
      uiHint: "Fayl UI da Yuklab olish tugmasi. Base64 yozmang. UUID/kod ko‘rsatmang — ism bilan yozing.",
    };
  }

  const headers = ["#", "Xodim", "Rol", "Holat", "Kirish", "Chiqish", "Ishlagan"];
  const body: Cell[][] = data.rows.map((row, i) => [
    i + 1,
    row.name,
    row.role || "",
    row.status || "",
    clock(row.inAt),
    clock(row.outAt),
    row.workedLabel || "",
  ]);

  if (format === "csv") {
    const lines = [headers, ...body].map((line) =>
      line.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(";"),
    );
    const buf = Buffer.from(`\uFEFF${lines.join("\n")}`, "utf8");
    return {
      ok: true as const,
      kind: "davomat",
      format,
      title: `Davomat hisobot (${data.date})`,
      ...data,
      rows: data.rows.slice(0, 40),
      file: fileOf(`davomat-${data.date}.csv`, "text/csv;charset=utf-8", buf),
      uiHint: "Fayl UI da Yuklab olish. Base64 yozmang.",
    };
  }

  const xlsx = buildXlsx([{ name: "Davomat", headers, rows: body }]);
  return {
    ok: true as const,
    kind: "davomat",
    format,
    title: `Davomat hisobot (${data.date})`,
    ...data,
    rows: data.rows.slice(0, 40),
    file: fileOf(
      `davomat-${data.date}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xlsx,
    ),
    uiHint: "Fayl UI da Yuklab olish. Base64 yozmang.",
  };
}

export function exportKirim(format: "xlsx" | "csv" = "xlsx") {
  const file = dataFile("partners.json");
  let shipments: Array<Record<string, unknown>> = [];
  let accounts: Array<Record<string, unknown>> = [];
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        shipments?: Array<Record<string, unknown>>;
        accounts?: Array<Record<string, unknown>>;
      };
      shipments = raw.shipments || [];
      accounts = raw.accounts || [];
    } catch {
      /* ignore */
    }
  }
  const byFactory = new Map(accounts.map((a) => [String(a.id), String(a.name || a.code || a.id)]));
  const rows = [...shipments]
    .sort((a, b) => String(b.createdAt || b.date || "").localeCompare(String(a.createdAt || a.date || "")))
    .slice(0, 40)
    .map((s, i) => [
      i + 1,
      String(s.number || ""),
      String(s.date || ""),
      String(s.status || ""),
      byFactory.get(String(s.factoryId)) || String(s.factoryId || ""),
      s.moyskladId ? "Ha" : "Yo‘q",
      String(s.moyskladNumber || ""),
      Array.isArray(s.lines) ? s.lines.length : 0,
    ] as Cell[]);
  const headers = ["#", "Raqam", "Sana", "Status", "Zavod", "MS", "MS №", "Qator"];
  const date = tashkentParts().date;
  if (format === "csv") {
    const lines = [headers, ...rows].map((line) =>
      line.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(";"),
    );
    const buf = Buffer.from(`\uFEFF${lines.join("\n")}`, "utf8");
    return {
      ok: true as const,
      kind: "kirim",
      format,
      title: `Yuk/kirim ro‘yxati (${date})`,
      count: rows.length,
      file: fileOf(`kirim-${date}.csv`, "text/csv;charset=utf-8", buf),
      uiHint: "Fayl UI da Yuklab olish. Base64 yozmang.",
    };
  }
  const xlsx = buildXlsx([{ name: "Kirim", headers, rows }]);
  return {
    ok: true as const,
    kind: "kirim",
    format,
    title: `Yuk/kirim ro‘yxati (${date})`,
    count: rows.length,
    file: fileOf(
      `kirim-${date}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xlsx,
    ),
    uiHint: "Fayl UI da Yuklab olish. Base64 yozmang.",
  };
}

export function exportStaff(format: "xlsx" | "csv" = "xlsx") {
  const people = listLocalPeople();
  const headers = ["#", "Ism", "Login", "Rol"];
  const rows: Cell[][] = people.map((p, i) => [i + 1, p.name, p.login, p.role]);
  const date = tashkentParts().date;
  if (format === "csv") {
    const lines = [headers, ...rows].map((line) =>
      line.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(";"),
    );
    const buf = Buffer.from(`\uFEFF${lines.join("\n")}`, "utf8");
    return {
      ok: true as const,
      kind: "staff",
      format,
      title: `Xodimlar (${date})`,
      total: people.length,
      file: fileOf(`xodimlar-${date}.csv`, "text/csv;charset=utf-8", buf),
      uiHint: "Fayl UI da Yuklab olish. Base64 yozmang.",
    };
  }
  const xlsx = buildXlsx([{ name: "Xodimlar", headers, rows }]);
  return {
    ok: true as const,
    kind: "staff",
    format,
    title: `Xodimlar (${date})`,
    total: people.length,
    file: fileOf(
      `xodimlar-${date}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xlsx,
    ),
    uiHint: "Fayl UI da Yuklab olish. Base64 yozmang.",
  };
}
