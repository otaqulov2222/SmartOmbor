import { existsSync } from "node:fs";

const FONT = "C:/Windows/Fonts/arial.ttf";

export async function textPdf(title: string, lines: string[]): Promise<Buffer | null> {
  if (!existsSync(FONT)) return null;
  let PDFDocument: new (options: { margin: number; size: string }) => {
    font: (src: string) => { fontSize: (n: number) => void };
    text: (value: string, options?: { align?: string }) => void;
    moveDown: (n?: number) => void;
    end: () => void;
    on: (event: "data" | "end" | "error", handler: (chunk?: Buffer) => void) => void;
  };
  try {
    const loaded = await import("pdfkit");
    PDFDocument = (loaded.default ?? loaded) as typeof PDFDocument;
  } catch {
    return null;
  }
  const doc = new PDFDocument({ margin: 48, size: "A4" });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk?: Buffer) => { if (chunk) chunks.push(chunk); });
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", () => reject(new Error("pdf")));
  });
  doc.font(FONT).fontSize(16);
  doc.text(title);
  doc.moveDown(0.6);
  doc.font(FONT).fontSize(11);
  for (const line of lines) doc.text(line || " ");
  doc.end();
  return done.catch(() => null);
}
