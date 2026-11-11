const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n: number) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}
function u32(n: number) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function zipStore(files: { name: string; data: Uint8Array }[]) {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const nameEnc = new TextEncoder();
  for (const file of files) {
    const name = nameEnc.encode(file.name);
    const crc = crc32(file.data);
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(file.data.length),
      u32(file.data.length),
      u16(name.length),
      u16(0),
      name,
      file.data,
    ]);
    const central = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(file.data.length),
      u32(file.data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = concat(centrals);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return concat([...locals, centralDir, end]);
}

function xml(s: string) {
  return new TextEncoder().encode(s);
}
function esc(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function colName(index: number) {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export type Cell = string | number | null | undefined;
export type Sheet = { name: string; headers: string[]; rows: Cell[][] };

/** Style ids in STYLES_XML cellXfs — keep in sync with STYLES_XML order */
const STYLE = {
  text: 0,
  title: 1,
  meta: 2,
  header: 3,
  zebraText: 4,
  money: 5,
  zebraMoney: 6,
  pct: 7,
  zebraPct: 8,
  int: 9,
  zebraInt: 10,
  ok: 11,
  warn: 12,
  bad: 13,
  stage1: 14,
  stage2: 15,
  stage3: 16,
  daysBad: 17,
  daysWarn: 18,
  orderId: 19,
  zebraOrderId: 20,
} as const;

function badgeStyle(value: unknown): number | null {
  const s = String(value ?? "")
    .toLowerCase()
    .trim();
  if (!s) return null;
  if (s.includes("1-bosqich") || s === "1") return STYLE.stage1;
  if (s.includes("2-bosqich") || s === "2") return STYLE.stage2;
  if (s.includes("3-bosqich") || s === "3") return STYLE.stage3;
  if (
    s.includes("confirm") ||
    s.includes("tasdiq") ||
    s.includes("to‘lang") ||
    s.includes("tolang") ||
    s === "paid" ||
    s === "ok" ||
    s === "aniq" ||
    s === "active" ||
    s === "faol"
  ) {
    return STYLE.ok;
  }
  if (
    s.includes("pending") ||
    s.includes("partial") ||
    s.includes("kutil") ||
    s.includes("qisman") ||
    s === "agent"
  ) {
    return STYLE.warn;
  }
  if (
    s.includes("expir") ||
    s.includes("cancel") ||
    s.includes("overdue") ||
    s.includes("muddati") ||
    s.includes("bekor") ||
    s === "taxminiy" ||
    s === "0%"
  ) {
    return STYLE.bad;
  }
  return null;
}

function isMoneyHeader(header: string) {
  return /jami|to‘lang|tolang|baza|kpi|summa|reja|qarz|amount|total|paid|sales/i.test(header);
}
function isPctHeader(header: string) {
  return /foiz|%|percent/i.test(header);
}
function isIntHeader(header: string) {
  return /qolgan kun|days|kun\b/i.test(header);
}
function isCoordHeader(header: string) {
  return /^(lat|lng)$/i.test(header.trim());
}
function isStatusHeader(header: string) {
  return /holat|status|gps|bosqich/i.test(header);
}
function isOrderHeader(header: string) {
  return /buyurtma|raqam|order/i.test(header);
}

function colWidth(sheet: Sheet, index: number) {
  const header = sheet.headers[index] || "";
  let max = header.length;
  let numeric = true;
  const sample = Math.min(sheet.rows.length, 250);
  for (let row = 0; row < sample; row += 1) {
    const value = sheet.rows[row]?.[index];
    if (typeof value === "number" && Number.isFinite(value)) {
      const formatted =
        Math.abs(value) >= 1000 ? value.toLocaleString("fr-FR").length + 3 : String(value).length + 2;
      if (formatted > max) max = formatted;
    } else if (value != null && value !== "") {
      numeric = false;
      if (String(value).length > max) max = String(value).length;
    }
  }
  if (isStatusHeader(header)) return Math.min(28, Math.max(20, max + 6));
  if (isIntHeader(header)) return Math.min(16, Math.max(13, max + 4));
  if (isCoordHeader(header)) return Math.min(14, Math.max(12, max + 2));
  if (isOrderHeader(header)) return Math.min(18, Math.max(14, max + 3));
  if (numeric || isMoneyHeader(header) || isPctHeader(header)) {
    return Math.min(22, Math.max(15, max + 5));
  }
  if (/manzil|mijoz|agent|nom|f\.i\.sh|login|reference/i.test(header)) {
    return Math.min(46, Math.max(18, max + 6));
  }
  return Math.min(40, Math.max(16, max + 5));
}

function cellXml(ref: string, cell: Cell, style: number) {
  if (typeof cell === "number" && Number.isFinite(cell)) return `<c r="${ref}" s="${style}"><v>${cell}</v></c>`;
  const text = cell == null || cell === "" ? "" : String(cell).slice(0, 32000);
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

function styleForCell(header: string, cell: Cell, zebra: boolean): number {
  const number = typeof cell === "number" && Number.isFinite(cell);
  if (!number) {
    const badge = badgeStyle(cell);
    if (badge != null) return badge;
    if (isOrderHeader(header)) return zebra ? STYLE.zebraOrderId : STYLE.orderId;
    return zebra ? STYLE.zebraText : STYLE.text;
  }
  if (isIntHeader(header)) {
    if (cell < 0) return STYLE.daysBad;
    if (cell <= 3) return STYLE.daysWarn;
    return zebra ? STYLE.zebraInt : STYLE.int;
  }
  if (isPctHeader(header) || isCoordHeader(header)) return zebra ? STYLE.zebraPct : STYLE.pct;
  if (isMoneyHeader(header) || Math.abs(cell) >= 1000) return zebra ? STYLE.zebraMoney : STYLE.money;
  return zebra ? STYLE.zebraPct : STYLE.pct;
}

function tashkentStamp() {
  try {
    return new Intl.DateTimeFormat("uz-UZ", {
      timeZone: "Asia/Tashkent",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 16).replace("T", " ");
  }
}

function sheetXml(sheet: Sheet) {
  const columns = Math.max(sheet.headers.length, ...sheet.rows.map((row) => row.length), 1);
  const lastCol = colName(columns - 1);
  const headerRow = 3;
  const lastDataRow = Math.max(headerRow, headerRow + sheet.rows.length);
  const cols = Array.from(
    { length: columns },
    (_, index) => `<col min="${index + 1}" max="${index + 1}" width="${colWidth(sheet, index)}" customWidth="1"/>`,
  ).join("");

  // Avoid fancy unicode (middle-dot) — some Excel locales choke on repair paths
  const title = `SmartOmbor - ${sheet.name}`;
  const meta = `${sheet.rows.length} qator | ${tashkentStamp()} (Toshkent)`;

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>',
    `<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${headerRow + 1}" sqref="A${headerRow + 1}"/></sheetView></sheetViews>`,
    `<sheetFormatPr defaultRowHeight="26"/><cols>${cols}</cols><sheetData>`,
  ];

  const writeRow = (
    r: number,
    cells: Cell[],
    height: number,
    styleFor: (index: number, cell: Cell) => number,
  ) => {
    let row = `<row r="${r}" ht="${height}" customHeight="1">`;
    for (let i = 0; i < columns; i += 1) {
      row += cellXml(`${colName(i)}${r}`, cells[i], styleFor(i, cells[i]));
    }
    lines.push(row + "</row>");
  };

  // Merged title/meta: ONLY top-left cell may exist (Excel repair otherwise)
  lines.push(
    `<row r="1" ht="38" customHeight="1">${cellXml("A1", title, STYLE.title)}</row>`,
  );
  lines.push(
    `<row r="2" ht="22" customHeight="1">${cellXml("A2", meta, STYLE.meta)}</row>`,
  );
  writeRow(headerRow, sheet.headers, 32, () => STYLE.header);
  sheet.rows.forEach((row, i) => {
    const zebra = i % 2 === 1;
    writeRow(headerRow + 1 + i, row, 26, (index, cell) =>
      styleForCell(sheet.headers[index] || "", cell, zebra),
    );
  });

  lines.push("</sheetData>");
  if (columns > 1) {
    lines.push(
      `<mergeCells count="2"><mergeCell ref="A1:${lastCol}1"/><mergeCell ref="A2:${lastCol}2"/></mergeCells>`,
    );
  }
  lines.push(`<autoFilter ref="A${headerRow}:${lastCol}${lastDataRow}"/>`);
  lines.push('<pageMargins left="0.35" right="0.35" top="0.4" bottom="0.4" header="0.2" footer="0.2"/>');
  lines.push('<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="1"/>');
  lines.push("</worksheet>");
  return lines.join("");
}

/**
 * BordoUz report theme:
 * deep wine banner, charcoal header, solid status badges, soft rose zebra, no gridlines.
 */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
<numFmt numFmtId="164" formatCode="#,##0.00"/>
<numFmt numFmtId="165" formatCode="0.00"/>
<numFmt numFmtId="166" formatCode="0"/>
</numFmts>
<fonts count="10">
<font><sz val="11"/><name val="Calibri"/><color rgb="FF1C1917"/></font>
<font><b/><sz val="18"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
<font><sz val="10"/><name val="Calibri"/><color rgb="FFFECACA"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FF9F1239"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FF9F1239"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFB45309"/></font>
</fonts>
<fills count="14">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF7F1D1D"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF9F1239"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1C1917"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF1F2"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF059669"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD97706"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDC2626"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1D4ED8"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF7C3AED"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/></patternFill></fill>
</fills>
<borders count="3">
<border>
  <left style="thin"><color rgb="FFF1E7E9"/></left>
  <right style="thin"><color rgb="FFF1E7E9"/></right>
  <top style="thin"><color rgb="FFF1E7E9"/></top>
  <bottom style="thin"><color rgb="FFF1E7E9"/></bottom>
</border>
<border>
  <left style="thin"><color rgb="FF7F1D1D"/></left>
  <right style="thin"><color rgb="FF7F1D1D"/></right>
  <top style="thin"><color rgb="FF7F1D1D"/></top>
  <bottom style="medium"><color rgb="FFE11D48"/></bottom>
</border>
<border>
  <left style="thin"><color rgb="FF1C1917"/></left>
  <right style="thin"><color rgb="FF1C1917"/></right>
  <top style="thin"><color rgb="FF1C1917"/></top>
  <bottom style="medium"><color rgb="FFE11D48"/></bottom>
</border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="21">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" indent="1" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" indent="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" indent="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" indent="1" wrapText="1"/></xf>
<xf numFmtId="164" fontId="8" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" indent="1"/></xf>
<xf numFmtId="164" fontId="8" fillId="5" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" indent="1"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="165" fontId="0" fillId="5" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="166" fontId="0" fillId="5" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="5" fillId="6" borderId="0" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="6" fillId="7" borderId="0" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="7" fillId="8" borderId="0" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="5" fillId="9" borderId="0" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="5" fillId="10" borderId="0" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="5" fillId="11" borderId="0" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="166" fontId="8" fillId="12" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="166" fontId="9" fillId="13" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" indent="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" indent="1"/></xf>
</cellXfs>
</styleSheet>`;

function sanitizeSheetName(name: string, used: Set<string>) {
  let base = name.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31) || "Sheet";
  let next = base;
  let n = 2;
  while (used.has(next)) {
    const suffix = ` ${n++}`;
    next = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(next);
  return next;
}

export function buildXlsx(sheets: Sheet[]): Buffer {
  const used = new Set<string>();
  const named = sheets.map((s, i) => ({ ...s, name: sanitizeSheetName(s.name || `Sheet${i + 1}`, used) }));
  const files: { name: string; data: Uint8Array }[] = [
    {
      name: "[Content_Types].xml",
      data: xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
</Types>`),
    },
    {
      name: "_rels/.rels",
      data: xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}
<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    },
    { name: "xl/styles.xml", data: xml(STYLES_XML) },
    {
      name: "xl/workbook.xml",
      data: xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${named.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}
</sheets>
</workbook>`),
    },
  ];
  named.forEach((sheet, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml(sheetXml(sheet)) });
  });
  return Buffer.from(zipStore(files));
}
