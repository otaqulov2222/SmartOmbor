import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import robotoBold from '@/assets/fonts/Roboto-Bold.ttf';
import robotoRegular from '@/assets/fonts/Roboto-Regular.ttf';
import { downloadXlsx, type Sheet } from '@/lib/xlsx';

export type PayFine = {
  date: string;
  kind: 'absent' | 'late';
  lateMin: number;
  autoAmount: number;
  amount: number;
  overridden: boolean;
  note: string;
};
export type PayAdvance = { amount: number; date: string; note: string };
export type PayAdjustment = { amount: number; note: string; kind: string };
export type PayPerson = {
  name: string;
  login: string;
  role: string;
  monthly: number;
  daily: number;
  workdays: number;
  absentDays: number;
  lateDays: number;
  presentDays: number;
  fineTotal: number;
  advancesTotal: number;
  adjustmentsTotal: number;
  net: number;
  fines: PayFine[];
  advances: PayAdvance[];
  adjustments: PayAdjustment[];
};
export type PayMonth = {
  month: string;
  from: string;
  to: string;
  workdays: number;
  latePenaltyPct: number;
  summary: {
    headcount: number;
    salaryFund: number;
    fineTotal: number;
    advancesTotal: number;
    adjustmentsTotal: number;
    netTotal: number;
  };
  people: PayPerson[];
};

export type PayLabels = {
  title: string;
  employee: string;
  login: string;
  role: string;
  monthly: string;
  daily: string;
  workdays: string;
  absent: string;
  late: string;
  present: string;
  fines: string;
  advances: string;
  bonus: string;
  net: string;
  auto: string;
  note: string;
  amount: string;
  date: string;
  kind: string;
  summary: string;
  period: string;
  latePct: string;
};

function bufToB64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, i + size));
  }
  return btoa(binary);
}

let pdfFonts: { regular: string; bold: string } | null = null;
async function loadPdfFonts() {
  if (pdfFonts) return pdfFonts;
  const [regular, bold] = await Promise.all([
    fetch(robotoRegular).then((r) => r.arrayBuffer()),
    fetch(robotoBold).then((r) => r.arrayBuffer()),
  ]);
  pdfFonts = { regular: bufToB64(regular), bold: bufToB64(bold) };
  return pdfFonts;
}

async function makePdfDoc(landscape = false) {
  const fonts = await loadPdfFonts();
  const doc = new jsPDF({
    orientation: landscape ? 'landscape' : 'portrait',
    unit: 'mm',
    format: 'a4',
  });
  doc.addFileToVFS('Roboto-Regular.ttf', fonts.regular);
  doc.addFileToVFS('Roboto-Bold.ttf', fonts.bold);
  doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
  doc.addFont('Roboto-Bold.ttf', 'Roboto', 'bold');
  return doc;
}

function safeName(value: string) {
  return value.replace(/[^\w\-а-яА-ЯёЁўқғҳʼ' ]+/gi, '').trim().replace(/\s+/g, '-') || 'oylik';
}

function kindLabel(kind: string, labels: PayLabels) {
  if (kind === 'absent') return labels.absent;
  if (kind === 'late') return labels.late;
  if (kind === 'bonus') return labels.bonus;
  if (kind === 'deduct') return labels.bonus;
  return kind;
}

export function exportMonthExcel(data: PayMonth, labels: PayLabels) {
  const peopleSheet: Sheet = {
    name: labels.title.slice(0, 28) || 'Oylik',
    headers: [
      labels.employee,
      labels.login,
      labels.role,
      labels.monthly,
      labels.daily,
      labels.absent,
      labels.late,
      labels.fines,
      labels.advances,
      labels.bonus,
      labels.net,
    ],
    rows: data.people.map((p) => [
      p.name,
      p.login,
      p.role,
      p.monthly,
      p.daily,
      p.absentDays,
      p.lateDays,
      p.fineTotal,
      p.advancesTotal,
      p.adjustmentsTotal,
      p.net,
    ]),
  };
  const summarySheet: Sheet = {
    name: labels.summary.slice(0, 28) || 'Jami',
    headers: [labels.summary, ''],
    rows: [
      [labels.period, `${data.from} — ${data.to}`],
      [labels.workdays, data.workdays],
      [labels.latePct, data.latePenaltyPct],
      [labels.employee, data.summary.headcount],
      [labels.monthly, data.summary.salaryFund],
      [labels.fines, data.summary.fineTotal],
      [labels.advances, data.summary.advancesTotal],
      [labels.bonus, data.summary.adjustmentsTotal],
      [labels.net, data.summary.netTotal],
    ],
  };
  downloadXlsx(`oylik-${data.month}.xlsx`, [peopleSheet, summarySheet]);
}

export async function exportMonthPdf(data: PayMonth, labels: PayLabels) {
  const doc = await makePdfDoc(true);
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(13);
  doc.text(`${labels.title} · ${data.month}`, 14, 14);
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(9);
  doc.text(
    `${labels.period}: ${data.from} — ${data.to}  ·  ${labels.workdays}: ${data.workdays}  ·  ${labels.latePct}: ${data.latePenaltyPct}%`,
    14,
    20,
  );
  doc.text(
    `${labels.monthly}: ${data.summary.salaryFund}  ·  ${labels.fines}: ${data.summary.fineTotal}  ·  ${labels.advances}: ${data.summary.advancesTotal}  ·  ${labels.bonus}: ${data.summary.adjustmentsTotal}  ·  ${labels.net}: ${data.summary.netTotal}`,
    14,
    25,
  );
  autoTable(doc, {
    startY: 30,
    head: [[
      labels.employee,
      labels.login,
      labels.monthly,
      labels.daily,
      labels.absent,
      labels.late,
      labels.fines,
      labels.advances,
      labels.bonus,
      labels.net,
    ]],
    body: data.people.map((p) => [
      p.name,
      p.login,
      p.monthly,
      p.daily,
      p.absentDays,
      p.lateDays,
      p.fineTotal,
      p.advancesTotal,
      p.adjustmentsTotal,
      p.net,
    ]),
    styles: { font: 'Roboto', fontSize: 7.5 },
    headStyles: { fillColor: [29, 78, 216], font: 'Roboto', fontStyle: 'bold' },
    columnStyles: {
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'right' },
      8: { halign: 'right' },
      9: { halign: 'right' },
    },
  });
  doc.save(`oylik-${data.month}.pdf`);
}

export function exportPersonExcel(person: PayPerson, month: string, labels: PayLabels) {
  const summary: Sheet = {
    name: labels.summary.slice(0, 28) || 'Jami',
    headers: [labels.summary, ''],
    rows: [
      [labels.employee, person.name],
      [labels.login, person.login],
      [labels.role, person.role],
      [labels.period, month],
      [labels.monthly, person.monthly],
      [labels.daily, person.daily],
      [labels.workdays, person.workdays],
      [labels.present, person.presentDays],
      [labels.absent, person.absentDays],
      [labels.late, person.lateDays],
      [labels.fines, person.fineTotal],
      [labels.advances, person.advancesTotal],
      [labels.bonus, person.adjustmentsTotal],
      [labels.net, person.net],
    ],
  };
  const fines: Sheet = {
    name: labels.fines.slice(0, 28) || 'Jarimalar',
    headers: [labels.date, labels.kind, labels.amount, labels.auto, labels.note],
    rows: person.fines.map((f) => [
      f.date,
      kindLabel(f.kind, labels) + (f.lateMin ? ` (${f.lateMin})` : ''),
      f.amount,
      f.autoAmount,
      f.note || (f.overridden ? 'edit' : ''),
    ]),
  };
  const advances: Sheet = {
    name: labels.advances.slice(0, 28) || 'Avanslar',
    headers: [labels.date, labels.amount, labels.note],
    rows: person.advances.map((a) => [a.date, a.amount, a.note || '']),
  };
  const bonus: Sheet = {
    name: labels.bonus.slice(0, 28) || 'Bonus',
    headers: [labels.kind, labels.amount, labels.note],
    rows: person.adjustments.map((a) => [a.kind, a.amount, a.note || '']),
  };
  downloadXlsx(`oylik-${month}-${safeName(person.name)}.xlsx`, [summary, fines, advances, bonus]);
}

export async function exportPersonPdf(person: PayPerson, month: string, labels: PayLabels) {
  const doc = await makePdfDoc(false);
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(14);
  doc.text(`${labels.title}`, 14, 16);
  doc.setFontSize(11);
  doc.text(`${person.name} · ${person.login}`, 14, 23);
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(9);
  doc.text(`${labels.period}: ${month}`, 14, 29);
  autoTable(doc, {
    startY: 34,
    theme: 'plain',
    body: [
      [labels.monthly, String(person.monthly), labels.daily, String(person.daily)],
      [labels.absent, String(person.absentDays), labels.late, String(person.lateDays)],
      [labels.fines, String(person.fineTotal), labels.advances, String(person.advancesTotal)],
      [labels.bonus, String(person.adjustmentsTotal), labels.net, String(person.net)],
    ],
    styles: { font: 'Roboto', fontSize: 9, cellPadding: 1.5 },
    columnStyles: {
      0: { fontStyle: 'bold', textColor: [100, 116, 139] },
      2: { fontStyle: 'bold', textColor: [100, 116, 139] },
    },
  });
  let y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || 55) + 6;

  const section = (title: string, head: string[], body: (string | number)[][]) => {
    if (!body.length) return;
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(10);
    doc.text(title, 14, y);
    autoTable(doc, {
      startY: y + 2,
      head: [head],
      body,
      styles: { font: 'Roboto', fontSize: 8 },
      headStyles: { fillColor: [29, 78, 216], font: 'Roboto', fontStyle: 'bold' },
    });
    y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || y) + 8;
  };

  section(
    labels.fines,
    [labels.date, labels.kind, labels.amount, labels.auto, labels.note],
    person.fines.map((f) => [
      f.date,
      kindLabel(f.kind, labels) + (f.lateMin ? ` (${f.lateMin})` : ''),
      f.amount,
      f.autoAmount,
      f.note || '',
    ]),
  );
  section(
    labels.advances,
    [labels.date, labels.amount, labels.note],
    person.advances.map((a) => [a.date, a.amount, a.note || '']),
  );
  section(
    labels.bonus,
    [labels.kind, labels.amount, labels.note],
    person.adjustments.map((a) => [a.kind, a.amount, a.note || '']),
  );

  doc.save(`oylik-${month}-${safeName(person.name)}.pdf`);
}
