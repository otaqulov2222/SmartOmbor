import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DavomatPdfRow = {
  name: string;
  role?: string;
  inAt?: string | null;
  outAt?: string | null;
  workedLabel?: string;
  status?: string;
};

function fontFile(name: string) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "artifacts/smart-ombor/src/assets/fonts", name),
    path.resolve(here, "../../smart-ombor/src/assets/fonts", name),
    path.resolve(here, "../../../smart-ombor/src/assets/fonts", name),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
  ];
  return candidates.find((item) => existsSync(item)) ?? null;
}

function clock(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tashkent" });
}

type PdfDoc = {
  page: { width: number; height: number };
  registerFont: (name: string, src: string) => void;
  font: (name: string) => PdfDoc;
  fontSize: (size: number) => PdfDoc;
  fillColor: (color: string) => PdfDoc;
  text: (value: string, x?: number, y?: number, options?: { width?: number; lineBreak?: boolean }) => PdfDoc;
  moveDown: (n?: number) => void;
  rect: (x: number, y: number, w: number, h: number) => { fill: (color: string) => void };
  save: () => void;
  restore: () => void;
  addPage: () => void;
  on: (event: "data" | "end" | "error", handler: (chunk?: Buffer) => void) => void;
  end: () => void;
  y: number;
};

export async function buildDavomatPdf(input: {
  date: string;
  total: number;
  present: number;
  absent: number;
  rows: DavomatPdfRow[];
}): Promise<Buffer | null> {
  const regular = fontFile("Roboto-Regular.ttf") || fontFile("DejaVuSans.ttf");
  const bold = fontFile("Roboto-Bold.ttf") || regular;
  if (!regular) return null;

  const loaded = await import("pdfkit");
  const PDFDocument = (loaded.default ?? loaded) as new (options: { margin: number; size: string }) => PdfDoc;
  const doc = new PDFDocument({ margin: 36, size: "A4" });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk?: Buffer) => { if (chunk) chunks.push(chunk); });
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", () => reject(new Error("pdf")));
  });

  doc.registerFont("Body", regular);
  doc.registerFont("Head", bold || regular);

  doc.font("Head").fontSize(16).fillColor("#1d39c4").text("Smart Ombor — Davomat hisobot");
  doc.moveDown(0.25);
  doc.font("Body").fontSize(10).fillColor("#64748b").text(`Sana: ${input.date}`);
  doc.moveDown(0.5);
  doc.font("Body").fontSize(11).fillColor("#0f172a")
    .text(`Umumiy: ${input.total}   ·   Kelgan: ${input.present}   ·   Kelmagan: ${input.absent}`);
  doc.moveDown(0.7);

  const headers = ["#", "Xodim", "Rol", "Holat", "Kirish", "Chiqish", "Ishlagan"];
  const cols = [28, 150, 70, 70, 55, 55, 70];
  const startX = 36;
  let y = doc.y;

  const paint = (cells: string[], header: boolean) => {
    let x = startX;
    const h = 22;
    if (header) {
      doc.save();
      doc.rect(startX, y, cols.reduce((a, b) => a + b, 0), h).fill("#2f54eb");
      doc.restore();
    }
    doc.font(header ? "Head" : "Body").fontSize(8).fillColor(header ? "#ffffff" : "#0f172a");
    cells.forEach((cell, i) => {
      doc.text(cell || "—", x + 4, y + 6, { width: cols[i] - 8, lineBreak: false });
      x += cols[i];
    });
    y += h;
    if (y > doc.page.height - 48) {
      doc.addPage();
      y = 36;
    }
  };

  paint(headers, true);
  input.rows.forEach((row, index) => {
    paint([
      String(index + 1),
      row.name || "—",
      row.role || "—",
      row.status || (row.inAt ? "Kelgan" : "Kelmagan"),
      clock(row.inAt),
      clock(row.outAt),
      row.workedLabel || "—",
    ], false);
  });

  doc.end();
  return done.catch(() => null);
}
