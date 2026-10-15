import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Catalog } from "./catalog";
import { orderBasis, orderRecommendations, productTraits, type OrderLine } from "./recommendations";
import { buildXlsx, type Cell } from "./xlsx-file";

const HEADERS = ["Nomi", "O‘lcham", "Rang", "Kod", "Mavjud", "Yo‘lda", "Kunlik o‘rtacha", "Yetkazish, kun", "Tavsiya miqdori", "Sabab"];

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

function reasonText(line: OrderLine) {
  const basis = orderBasis(line);
  return `${basis.windowDays} kunda ${basis.sold} dona sotilgan. Qoldiq ${line.onHand}, yo‘lda ${line.inTransit}. ${basis.coverDays} kunga yetadi. ${basis.coverTarget} kunga ${basis.target} kerak, buyurtma ${line.suggestedQuantity}`;
}

export function recommendationRows(catalog: Catalog): Cell[][] {
  return orderRecommendations(catalog).map((line) => {
    const traits = productTraits(line.product.name);
    return [
      line.product.name,
      traits.size ?? "",
      traits.color ? COLOR_LABEL[traits.color] ?? "" : "",
      line.product.code || line.product.article || "",
      line.onHand,
      line.inTransit,
      line.dailyAverage,
      line.leadTimeDays,
      line.suggestedQuantity,
      reasonText(line),
    ];
  });
}

export function recommendationXlsx(catalog: Catalog) {
  const rows = recommendationRows(catalog);
  return buildXlsx([{ name: "Xarid tavsiyalari", headers: HEADERS, rows }]);
}

function fontFile(name: string) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "artifacts/smart-ombor/src/assets/fonts", name),
    path.resolve(here, "../../smart-ombor/src/assets/fonts", name),
    path.resolve(here, "../../../smart-ombor/src/assets/fonts", name),
  ];
  return candidates.find((item) => existsSync(item)) ?? null;
}

export async function recommendationPdf(catalog: Catalog, title: string): Promise<Buffer | null> {
  const regular = fontFile("Roboto-Regular.ttf");
  const bold = fontFile("Roboto-Bold.ttf");
  if (!regular || !bold) return null;
  const loaded = await import("pdfkit");
  const PDFDocument = (loaded.default ?? loaded) as new (options: { margin: number; size: string; layout: string }) => PdfDoc;
  const doc = new PDFDocument({ margin: 28, size: "A4", layout: "landscape" });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk?: Buffer) => { if (chunk) chunks.push(chunk); });
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", () => reject(new Error("pdf")));
  });
  doc.registerFont("Roboto", regular);
  doc.registerFont("RobotoBold", bold);
  const rows = recommendationRows(catalog);
  const widths = [118, 42, 48, 62, 42, 38, 52, 48, 52, 230];
  const pageWidth = doc.page.width - 56;
  const scale = pageWidth / widths.reduce((sum, width) => sum + width, 0);
  const cols = widths.map((width) => width * scale);
  let y = 28;
  const drawHeader = () => {
    doc.font("RobotoBold").fontSize(13).fillColor("#2f54eb").text("Smart Ombor", 28, y, { lineBreak: false });
    doc.font("Roboto").fontSize(9).fillColor("#64748b").text(title, 28, y + 16, { lineBreak: false });
    y += 36;
    const headHeight = rowHeight(doc, cols, HEADERS, true);
    doc.save();
    doc.rect(28, y, pageWidth, headHeight).fill("#2f54eb");
    doc.restore();
    paintRow(doc, cols, y, HEADERS, true);
    y += headHeight;
  };
  drawHeader();
  rows.forEach((row, index) => {
    const text = row.map((cell) => cell == null ? "" : String(cell));
    const height = rowHeight(doc, cols, text, false);
    if (y + height > doc.page.height - 28) {
      doc.addPage();
      y = 28;
      drawHeader();
    }
    if (index % 2 === 1) {
      doc.save();
      doc.rect(28, y, pageWidth, height).fill("#eef2ff");
      doc.restore();
    }
    paintRow(doc, cols, y, text, false);
    y += height;
  });
  doc.end();
  return done.catch(() => null);
}

type PdfDoc = {
  page: { width: number; height: number };
  registerFont: (name: string, src: string) => void;
  font: (name: string) => PdfDoc;
  fontSize: (size: number) => PdfDoc;
  fillColor: (color: string) => PdfDoc;
  text: (value: string, x: number, y: number, options?: { width?: number; height?: number; lineBreak?: boolean }) => PdfDoc;
  heightOfString: (value: string, options: { width: number }) => number;
  rect: (x: number, y: number, w: number, h: number) => { fill: (color: string) => void };
  save: () => void;
  restore: () => void;
  addPage: () => void;
  on: (event: "data" | "end" | "error", handler: (chunk?: Buffer) => void) => void;
  end: () => void;
};

function rowHeight(doc: PdfDoc, cols: number[], cells: string[], header: boolean) {
  doc.font(header ? "RobotoBold" : "Roboto").fontSize(header ? 7 : 8);
  const tallest = cells.reduce((max, cell, index) => Math.max(max, doc.heightOfString(cell || " ", { width: cols[index] - 8 })), 12);
  return tallest + 8;
}

function paintRow(doc: PdfDoc, cols: number[], y: number, cells: string[], header: boolean) {
  let x = 28;
  doc.font(header ? "RobotoBold" : "Roboto").fontSize(header ? 7 : 8).fillColor(header ? "#ffffff" : "#0f1b2d");
  cells.forEach((cell, index) => {
    doc.text(cell || " ", x + 4, y + 4, { width: cols[index] - 8 });
    x += cols[index];
  });
}
