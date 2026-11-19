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
  siteOffDays?: number[];
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

const BLUE: [number, number, number] = [29, 78, 216];
const INK: [number, number, number] = [15, 27, 45];
const MUTED: [number, number, number] = [100, 116, 139];
const SOFT: [number, number, number] = [239, 246, 255];
const LINE: [number, number, number] = [226, 232, 240];
const GREEN: [number, number, number] = [22, 101, 52];

const UZ_MONTHS = [
  'yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun',
  'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr',
];

function money(n: number) {
  return new Intl.NumberFormat('en-US').format(Math.round(n || 0));
}
function moneySom(n: number) {
  return `${money(n)} so‘m`;
}
function signedMoney(n: number) {
  const abs = money(Math.abs(n || 0));
  if ((n || 0) > 0) return `+${abs}`;
  if ((n || 0) < 0) return `-${abs}`;
  return abs;
}

const DAY_SHORT = ['Ya', 'Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh'] as const;
function workdaysNote(offDays: number[] = [1]) {
  const off = new Set(offDays);
  const order = [1, 2, 3, 4, 5, 6, 0];
  const work = order.filter((d) => !off.has(d)).map((d) => DAY_SHORT[d]);
  const rest = order.filter((d) => off.has(d)).map((d) => DAY_SHORT[d]);
  if (!work.length) return 'Ish kunlari sozlanmagan';
  const workLabel = work.length > 1 ? `${work[0]}–${work[work.length - 1]}` : work[0];
  return rest.length ? `${workLabel} ish (${rest.join(', ')} dam)` : `${workLabel} (dam yo‘q)`;
}
/** 2026-11-04 → 04.11.2026 */
function fmtDate(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}
/** 2026-11 → 2026-yil noyabr */
function fmtMonthTitle(month: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(month.trim());
  if (!m) return month;
  const year = m[1];
  const idx = Number(m[2]) - 1;
  const name = UZ_MONTHS[idx] || m[2];
  return `${year}-yil ${name}`;
}
function fmtPeriod(month: string, from?: string, to?: string) {
  const title = fmtMonthTitle(month);
  if (from && to) return `${title} (${fmtDate(from)} — ${fmtDate(to)})`;
  return title;
}

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

function paintBrand(doc: jsPDF, title: string, subtitle: string, meta: string) {
  const w = doc.internal.pageSize.getWidth();
  doc.setFillColor(...BLUE);
  doc.rect(0, 0, w, 28, 'F');
  doc.setFillColor(37, 99, 235);
  doc.rect(0, 28, w, 1.2, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(11);
  doc.text('Smart Ombor', 14, 10);
  doc.setFontSize(16);
  doc.text(title, 14, 18);
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(9);
  doc.text(subtitle, 14, 24);
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(8.5);
  doc.text(meta, w - 14, 18, { align: 'right' });
}

function finalY(doc: jsPDF, fallback: number) {
  return ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || fallback);
}

function safeName(value: string) {
  return value.replace(/[^\w\-а-яА-ЯёЁўқғҳʼ' ]+/gi, '').trim().replace(/\s+/g, '-') || 'oylik';
}

function kindLabel(kind: string, labels: PayLabels) {
  if (kind === 'absent') return labels.absent;
  if (kind === 'late') return labels.late;
  if (kind === 'bonus') return labels.bonus;
  if (kind === 'deduct') return 'Ushlanma';
  return kind;
}

function tableBase() {
  return {
    theme: 'grid' as const,
    styles: {
      font: 'Roboto',
      fontSize: 8.5,
      textColor: INK,
      lineColor: LINE,
      lineWidth: 0.15,
      cellPadding: { top: 2.2, right: 2.2, bottom: 2.2, left: 2.2 },
      valign: 'middle' as const,
    },
    headStyles: {
      fillColor: BLUE,
      textColor: [255, 255, 255] as [number, number, number],
      font: 'Roboto',
      fontStyle: 'bold' as const,
      fontSize: 8,
    },
    alternateRowStyles: { fillColor: [248, 250, 252] as [number, number, number] },
    margin: { left: 14, right: 14 },
  };
}

export function exportMonthExcel(data: PayMonth, labels: PayLabels) {
  const peopleSheet: Sheet = {
    name: labels.title.slice(0, 28) || 'Oylik',
    headers: [
      '№',
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
    rows: data.people.map((p, i) => [
      i + 1,
      p.name,
      p.login,
      p.role,
      money(p.monthly),
      money(p.daily),
      p.absentDays,
      p.lateDays,
      money(p.fineTotal),
      money(p.advancesTotal),
      signedMoney(p.adjustmentsTotal),
      money(p.net),
    ]),
  };
  const summarySheet: Sheet = {
    name: labels.summary.slice(0, 28) || 'Jami',
    headers: ["Ko‘rsatkich", 'Qiymat', 'Izoh'],
    rows: [
      ['Hujjat', 'Smart Ombor · Oylik hisobot', ''],
      ['Hisobot oyi', fmtMonthTitle(data.month), 'Oy nomi'],
      ['Sana oralig‘i', `${fmtDate(data.from)} — ${fmtDate(data.to)}`, 'Hisoblangan kunlar'],
      [labels.workdays, `${data.workdays} kun`, workdaysNote(data.siteOffDays)],
      [labels.latePct, `${data.latePenaltyPct}%`, 'Kechikish jarimasi (kunlikdan)'],
      ['Xodimlar soni', data.summary.headcount, ''],
      [labels.monthly, moneySom(data.summary.salaryFund), 'Barcha oyliklar jami'],
      [labels.fines, moneySom(data.summary.fineTotal), 'Jarimalar jami'],
      [labels.advances, moneySom(data.summary.advancesTotal), 'Avanslar jami'],
      [labels.bonus, moneySom(data.summary.adjustmentsTotal), 'Bonus / tuzatish jami'],
      [labels.net, moneySom(data.summary.netTotal), 'Yakuniy to‘lov jami'],
    ],
  };
  downloadXlsx(`oylik-${data.month}.xlsx`, [summarySheet, peopleSheet]);
}

export async function exportMonthPdf(data: PayMonth, labels: PayLabels) {
  const doc = await makePdfDoc(true);
  paintBrand(
    doc,
    labels.title,
    fmtPeriod(data.month, data.from, data.to),
    `${labels.workdays}: ${data.workdays}  ·  ${labels.latePct}: ${data.latePenaltyPct}%`,
  );

  autoTable(doc, {
    ...tableBase(),
    startY: 34,
    theme: 'plain',
    body: [[
      `${labels.monthly}\n${moneySom(data.summary.salaryFund)}`,
      `${labels.fines}\n${moneySom(data.summary.fineTotal)}`,
      `${labels.advances}\n${moneySom(data.summary.advancesTotal)}`,
      `${labels.bonus}\n${moneySom(data.summary.adjustmentsTotal)}`,
      `${labels.net}\n${moneySom(data.summary.netTotal)}`,
    ]],
    styles: {
      ...tableBase().styles,
      fontSize: 9,
      fillColor: SOFT,
      minCellHeight: 14,
      halign: 'center',
      lineWidth: 0,
    },
    didParseCell: (hook) => {
      if (hook.section !== 'body') return;
      const text = String(hook.cell.raw || '');
      if (text.includes('\n')) {
        hook.cell.text = text.split('\n');
      }
    },
  });

  autoTable(doc, {
    ...tableBase(),
    startY: finalY(doc, 50) + 4,
    head: [[
      '№',
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
    body: data.people.map((p, i) => [
      i + 1,
      p.name,
      p.login,
      money(p.monthly),
      money(p.daily),
      p.absentDays,
      p.lateDays,
      money(p.fineTotal),
      money(p.advancesTotal),
      signedMoney(p.adjustmentsTotal),
      money(p.net),
    ]),
    styles: { ...tableBase().styles, fontSize: 7.5 },
    columnStyles: {
      0: { halign: 'center', cellWidth: 8 },
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'center' },
      6: { halign: 'center' },
      7: { halign: 'right' },
      8: { halign: 'right' },
      9: { halign: 'right' },
      10: { halign: 'right', fontStyle: 'bold', textColor: GREEN },
    },
  });
  doc.save(`oylik-${data.month}.pdf`);
}

export function exportPersonExcel(
  person: PayPerson,
  month: string,
  labels: PayLabels,
  range?: { from: string; to: string },
) {
  const from = range?.from || `${month}-01`;
  const to = range?.to || from;
  const summary: Sheet = {
    name: labels.summary.slice(0, 28) || 'Jami',
    headers: ["Ko‘rsatkich", 'Qiymat', 'Izoh'],
    rows: [
      ['Hujjat', 'Smart Ombor · Xodim oylik hisoboti', ''],
      [labels.employee, person.name, ''],
      [labels.login, person.login, ''],
      [labels.role, person.role || '—', ''],
      ['Hisobot oyi', fmtMonthTitle(month), 'Masalan: 2026-yil noyabr'],
      ['Sana oralig‘i', `${fmtDate(from)} — ${fmtDate(to)}`, 'Hisoblangan kunlar'],
      [labels.monthly, moneySom(person.monthly), 'Asosiy oylik'],
      [labels.daily, moneySom(person.daily), 'Kunlik = oylik ÷ ish kunlari'],
      [labels.workdays, `${person.workdays} kun`, 'Oy bo‘yicha ish kunlari'],
      [labels.present, `${person.presentDays} kun`, 'Davomatda belgilangan'],
      [labels.absent, `${person.absentDays} kun`, 'Kelmagan ish kunlari'],
      [labels.late, `${person.lateDays} kun`, 'Kechikkan kunlar'],
      [labels.fines, moneySom(person.fineTotal), 'Jarimalar jami'],
      [labels.advances, moneySom(person.advancesTotal), 'Avanslar jami'],
      [labels.bonus, moneySom(person.adjustmentsTotal), 'Bonus / taqdirlash'],
      [labels.net, moneySom(person.net), 'Yakuniy to‘lov = oylik − jarima − avans + bonus'],
    ],
  };
  const fines: Sheet = {
    name: labels.fines.slice(0, 28) || 'Jarimalar',
    headers: ['№', labels.date, labels.kind, labels.amount, labels.auto, labels.note],
    rows: person.fines.length
      ? person.fines.map((f, i) => [
          i + 1,
          fmtDate(f.date),
          kindLabel(f.kind, labels) + (f.lateMin ? ` (${f.lateMin} daq)` : ''),
          moneySom(f.amount),
          moneySom(f.autoAmount),
          f.note || (f.overridden ? 'tahrirlangan' : '—'),
        ])
      : [['—', '—', '—', '—', '—', 'Bu oyda jarima yo‘q']],
  };
  const advances: Sheet = {
    name: labels.advances.slice(0, 28) || 'Avanslar',
    headers: ['№', labels.date, labels.amount, labels.note],
    rows: person.advances.length
      ? person.advances.map((a, i) => [i + 1, fmtDate(a.date), moneySom(a.amount), a.note || '—'])
      : [['—', '—', '—', 'Bu oyda avans yo‘q']],
  };
  const bonus: Sheet = {
    name: labels.bonus.slice(0, 28) || 'Bonus',
    headers: ['№', labels.kind, labels.amount, labels.note],
    rows: person.adjustments.length
      ? person.adjustments.map((a, i) => [
          i + 1,
          a.kind === 'bonus' ? 'Bonus / taqdirlash' : a.kind === 'deduct' ? 'Ushlanma' : a.kind,
          moneySom(a.amount),
          a.note || '—',
        ])
      : [['—', '—', '—', 'Bu oyda bonus yo‘q']],
  };
  downloadXlsx(`oylik-${month}-${safeName(person.name)}.xlsx`, [summary, fines, advances, bonus]);
}

export async function exportPersonPdf(
  person: PayPerson,
  month: string,
  labels: PayLabels,
  range?: { from: string; to: string },
) {
  const doc = await makePdfDoc(false);
  paintBrand(
    doc,
    labels.title,
    `${person.name}  ·  ${person.login}`,
    fmtPeriod(month, range?.from, range?.to),
  );

  autoTable(doc, {
    ...tableBase(),
    startY: 34,
    head: [[labels.summary, '']],
    body: [
      ['Hisobot oyi', fmtMonthTitle(month)],
      ['Sana oralig‘i', range?.from && range?.to ? `${fmtDate(range.from)} — ${fmtDate(range.to)}` : '—'],
      [labels.role, person.role || '—'],
      [labels.monthly, moneySom(person.monthly)],
      [labels.daily, moneySom(person.daily)],
      [labels.workdays, `${person.workdays} kun`],
      [labels.present, `${person.presentDays} kun`],
      [labels.absent, `${person.absentDays} kun`],
      [labels.late, `${person.lateDays} kun`],
      [labels.fines, moneySom(person.fineTotal)],
      [labels.advances, moneySom(person.advancesTotal)],
      [labels.bonus, `${signedMoney(person.adjustmentsTotal)} so‘m`],
      [labels.net, moneySom(person.net)],
    ],
    columnStyles: {
      0: { cellWidth: 55, textColor: MUTED, fontStyle: 'bold' },
      1: { halign: 'right', fontStyle: 'bold' },
    },
    didParseCell: (hook) => {
      if (hook.section !== 'body') return;
      if (hook.row.index === 12 && hook.column.index === 1) {
        hook.cell.styles.textColor = GREEN;
        hook.cell.styles.fontSize = 10;
        hook.cell.styles.fillColor = [240, 253, 244];
      }
    },
  });

  let y = finalY(doc, 90) + 8;

  const section = (title: string, head: string[], body: string[][], moneyCols: number[] = []) => {
    if (!body.length) return;
    doc.setFillColor(...SOFT);
    doc.roundedRect(14, y - 4.5, doc.internal.pageSize.getWidth() - 28, 7, 1.5, 1.5, 'F');
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...BLUE);
    doc.text(title, 16, y);
    y += 4;
    autoTable(doc, {
      ...tableBase(),
      startY: y,
      head: [head],
      body,
      columnStyles: Object.fromEntries(moneyCols.map((c) => [c, { halign: 'right' as const }])),
    });
    y = finalY(doc, y) + 8;
  };

  section(
    labels.fines,
    [labels.date, labels.kind, labels.amount, labels.auto, labels.note],
    person.fines.map((f) => [
      fmtDate(f.date),
      kindLabel(f.kind, labels) + (f.lateMin ? ` (${f.lateMin} daq)` : ''),
      money(f.amount),
      money(f.autoAmount),
      f.note || '—',
    ]),
    [2, 3],
  );
  section(
    labels.advances,
    [labels.date, labels.amount, labels.note],
    person.advances.map((a) => [fmtDate(a.date), money(a.amount), a.note || '—']),
    [1],
  );
  section(
    labels.bonus,
    [labels.kind, labels.amount, labels.note],
    person.adjustments.map((a) => [
      a.kind === 'bonus' ? 'Bonus / taqdirlash' : a.kind === 'deduct' ? 'Ushlanma' : a.kind,
      money(a.amount),
      a.note || '—',
    ]),
    [1],
  );

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...MUTED);
  doc.text('Smart Ombor · Oylik hisobot', 14, pageH - 8);
  doc.text(moneySom(person.net), pageW - 14, pageH - 8, { align: 'right' });

  doc.save(`oylik-${month}-${safeName(person.name)}.pdf`);
}
