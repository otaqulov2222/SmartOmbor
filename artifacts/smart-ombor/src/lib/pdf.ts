import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { Lang } from '@/i18n';
import robotoBold from '@/assets/fonts/Roboto-Bold.ttf';
import robotoRegular from '@/assets/fonts/Roboto-Regular.ttf';
import { formatCell, type BuiltReport } from '@/lib/report';
import type { Cell, Sheet } from '@/lib/xlsx';

const BLUE: [number, number, number] = [47, 84, 235];
const INK: [number, number, number] = [15, 27, 45];
const MUTED: [number, number, number] = [100, 116, 139];
const SOFT: [number, number, number] = [238, 242, 255];
const LINE: [number, number, number] = [213, 219, 227];

let fonts: { regular: string; bold: string } | null = null;

async function fileBase64(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('font');
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

async function loadFonts() {
  if (fonts) return fonts;
  const [regular, bold] = await Promise.all([fileBase64(robotoRegular), fileBase64(robotoBold)]);
  fonts = { regular, bold };
  return fonts;
}

function shown(lang: Lang, cell: Cell) {
  if (cell == null || cell === '') return '';
  return formatCell(lang, cell);
}

function paintHeader(doc: jsPDF, report: BuiltReport) {
  const width = doc.internal.pageSize.getWidth();
  doc.setFillColor(...BLUE);
  doc.rect(0, 0, width, 2.2, 'F');
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...BLUE);
  doc.text('Smart Ombor', 8, 8);
  doc.setTextColor(...INK);
  doc.setFontSize(13);
  doc.text(report.title, 8, 14);
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text(report.periodLabel, width - 8, 8, { align: 'right' });
  doc.text(report.generatedAt, width - 8, 13, { align: 'right' });
}

function columnWidths(sheet: Sheet, lang: Lang, usable: number) {
  const numeric = sheet.headers.map((_, index) => sheet.rows.some(row => typeof row[index] === 'number'));
  const natural = sheet.headers.map((header, index) => {
    let longest = header.length;
    const sample = Math.min(sheet.rows.length, 40);
    for (let row = 0; row < sample; row += 1) {
      const length = shown(lang, sheet.rows[row]?.[index]).length;
      if (length > longest) longest = length;
    }
    return Math.min(numeric[index] ? 28 : 52, Math.max(numeric[index] ? 14 : 18, longest * 1.7));
  });
  const sum = natural.reduce((total, width) => total + width, 0) || 1;
  const widths = sum > usable ? natural.map(width => (width / sum) * usable) : natural;
  if (sum < usable) {
    const textIndex = numeric.findIndex(value => !value);
    const grow = textIndex === -1 ? widths.length - 1 : numeric.reduce((best, isNumber, index) => (!isNumber && natural[index] >= natural[best] ? index : best), textIndex);
    widths[grow] += usable - sum;
  }
  return { numeric, widths };
}

function drawSheet(doc: jsPDF, sheet: Sheet, report: BuiltReport, lang: Lang, startY: number) {
  const usable = doc.internal.pageSize.getWidth() - 16;
  const { numeric, widths } = columnWidths(sheet, lang, usable);
  const columnStyles = Object.fromEntries(widths.map((cellWidth, index) => [index, {
    cellWidth,
    halign: numeric[index] ? 'right' as const : 'left' as const,
  }]));
  autoTable(doc, {
    head: [sheet.headers],
    body: sheet.rows.map(row => sheet.headers.map((_, index) => shown(lang, row[index]))),
    startY,
    margin: { top: 18, right: 8, bottom: 10, left: 8 },
    tableWidth: usable,
    theme: 'grid',
    showHead: 'everyPage',
    rowPageBreak: 'auto',
    styles: {
      font: 'Roboto',
      fontStyle: 'normal',
      fontSize: 8,
      cellPadding: { top: 1.3, right: 1.6, bottom: 1.3, left: 1.6 },
      textColor: INK,
      lineColor: LINE,
      lineWidth: 0.12,
      overflow: 'linebreak',
      valign: 'middle',
    },
    headStyles: {
      font: 'Roboto',
      fontStyle: 'bold',
      fillColor: BLUE,
      textColor: 255,
      fontSize: 7.5,
      valign: 'middle',
    },
    alternateRowStyles: { fillColor: SOFT },
    columnStyles,
    didDrawPage: () => paintHeader(doc, report),
  });
  return (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? startY;
}

export async function downloadReportPdf(filename: string, report: BuiltReport, lang: Lang) {
  const font = await loadFonts();
  const widest = Math.max(1, ...report.sheets.map(sheet => sheet.headers.length));
  const doc = new jsPDF({ orientation: widest > 8 ? 'landscape' : 'portrait', unit: 'mm', format: 'a4', compress: true });
  doc.addFileToVFS('Roboto-Regular.ttf', font.regular);
  doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
  doc.addFileToVFS('Roboto-Bold.ttf', font.bold);
  doc.addFont('Roboto-Bold.ttf', 'Roboto', 'bold');
  doc.setFont('Roboto', 'normal');
  paintHeader(doc, report);
  let cursor = 18;
  report.sheets.forEach(sheet => {
    const pageHeight = doc.internal.pageSize.getHeight();
    if (cursor > pageHeight - 28) {
      doc.addPage();
      paintHeader(doc, report);
      cursor = 18;
    }
    if (report.sheets.length > 1) {
      doc.setFont('Roboto', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...BLUE);
      doc.text(sheet.name, 8, cursor + 4);
      cursor += 6;
    }
    cursor = drawSheet(doc, sheet, report, lang, cursor) + 7;
  });
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(`${page} / ${pages}`, doc.internal.pageSize.getWidth() - 8, doc.internal.pageSize.getHeight() - 4.5, { align: 'right' });
  }
  const blob = new Blob([doc.output('arraybuffer')], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
