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
  for (const p of parts) { out.set(p, o); o += p.length; }
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
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(file.data.length), u32(file.data.length), u16(name.length), u16(0),
      name, file.data,
    ]);
    const central = concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(file.data.length), u32(file.data.length), u16(name.length), u16(0),
      u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = concat(centrals);
  const end = concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralDir.length), u32(offset), u16(0),
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

/** Style ids in STYLES_XML cellXfs */
const STYLE = {
  text: 0,
  header: 1,
  zebraText: 2,
  money: 3,
  zebraMoney: 4,
  pct: 5,
  zebraPct: 6,
  ok: 7,
  warn: 8,
  bad: 9,
  int: 10,
  zebraInt: 11,
  info: 12,
  orderId: 13,
  zebraOrderId: 14,
} as const;

/** Soft status tones — only for Holat. confirmed=blue, paid=green. */
function statusStyle(value: unknown): number | null {
  const s = String(value ?? "").toLowerCase().trim();
  if (!s || s === "—") return null;
  if (s.includes("pending") || s.includes("partial") || s.includes("kutil") || s.includes("qisman") || s === "agent") {
    return STYLE.warn;
  }
  if (
    s.includes("expir") ||
    s.includes("cancel") ||
    s.includes("overdue") ||
    s.includes("muddati") ||
    s.includes("bekor") ||
    s === "taxminiy"
  ) {
    return STYLE.bad;
  }
  if (s.includes("confirm") || s.includes("tasdiq")) return STYLE.info;
  if (
    s === "paid" ||
    s.includes("to‘lang") ||
    s.includes("to'lang") ||
    s.includes("tolang") ||
    s === "ok" ||
    s === "aniq" ||
    s === "active" ||
    s === "faol"
  ) {
    return STYLE.ok;
  }
  return null;
}

function isMoneyHeader(header: string) {
  return /jami|to‘lang|tolang|baza|savdo|^kpi$|kpi summa|reja|qarz|amount|total|paid|sales|so'm|som/i.test(header);
}
function isPctHeader(header: string) {
  return /foiz|%|percent/i.test(header);
}
function isIntHeader(header: string) {
  return /^kun$|qolgan kun|days/i.test(header);
}
function isCoordHeader(header: string) {
  return /^(lat|lng)$/i.test(header.trim());
}
function isStatusHeader(header: string) {
  return /^holat$|status|gps|to'lov holati|tolov holati/i.test(header);
}
function isBosqichHeader(header: string) {
  return /bosqich|stage/i.test(header);
}
function isOrderHeader(header: string) {
  return /buyurtma|raqam|^№/i.test(header);
}

/** Dense widths — table looks solid, not full of empty gaps */
function colWidth(sheet: Sheet, index: number) {
  const header = sheet.headers[index] || "";
  let max = header.length;
  const sample = Math.min(sheet.rows.length, 250);
  for (let row = 0; row < sample; row += 1) {
    const value = sheet.rows[row]?.[index];
    if (typeof value === "number" && Number.isFinite(value)) {
      const formatted =
        Math.abs(value) >= 1000 ? value.toLocaleString("fr-FR").length + 1 : String(value).length + 1;
      if (formatted > max) max = formatted;
    } else if (value != null && value !== "") {
      if (String(value).length > max) max = String(value).length;
    }
  }
  if (isStatusHeader(header)) return Math.min(18, Math.max(14, max + 1));
  if (isBosqichHeader(header)) return Math.min(12, Math.max(10, max + 1));
  if (isIntHeader(header)) return Math.min(8, Math.max(7, max + 1));
  if (isPctHeader(header)) return Math.min(9, Math.max(8, max + 1));
  if (isCoordHeader(header)) return Math.min(11, Math.max(9, max + 1));
  if (isMoneyHeader(header)) return Math.min(14, Math.max(11, max + 1));
  if (isOrderHeader(header)) return Math.min(12, Math.max(10, max + 1));
  if (/agent|login|telefon|f\.i\.sh/i.test(header)) return Math.min(14, Math.max(10, max + 1));
  if (/manzil|mijoz|reference/i.test(header)) return Math.min(28, Math.max(14, max + 1));
  return Math.min(16, Math.max(10, max + 1));
}

function cellXml(ref: string, cell: Cell, style: number) {
  if (typeof cell === "number" && Number.isFinite(cell)) return `<c r="${ref}" s="${style}"><v>${cell}</v></c>`;
  const text = cell == null || cell === "" ? "" : String(cell).slice(0, 32000);
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

function styleForCell(header: string, cell: Cell, _zebra: boolean): number {
  // No zebra fills — white rows only; Holat keeps soft status colors.
  const number = typeof cell === "number" && Number.isFinite(cell);
  if (!number) {
    if (isStatusHeader(header)) {
      const status = statusStyle(cell);
      if (status != null) return status;
    }
    if (isOrderHeader(header)) return STYLE.orderId;
    return STYLE.text;
  }
  if (isIntHeader(header)) return STYLE.int;
  if (isPctHeader(header) || isCoordHeader(header)) return STYLE.pct;
  if (isMoneyHeader(header) || Math.abs(cell) >= 1000) return STYLE.money;
  return STYLE.pct;
}

function sheetXml(sheet: Sheet) {
  const columns = Math.max(sheet.headers.length, ...sheet.rows.map((row) => row.length), 1);
  const lastCol = colName(columns - 1);
  const lastRow = sheet.rows.length + 1;
  const cols = Array.from(
    { length: columns },
    (_, index) => `<col min="${index + 1}" max="${index + 1}" width="${colWidth(sheet, index)}" customWidth="1"/>`,
  ).join("");
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetPr><tabColor rgb="FF9F1239"/><pageSetUpPr fitToPage="1"/></sheetPr>',
    `<dimension ref="A1:${lastCol}${lastRow}"/>`,
    '<sheetViews><sheetView workbookViewId="0" showGridLines="1" zoomScale="120"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>',
    `<sheetFormatPr defaultRowHeight="22"/><cols>${cols}</cols><sheetData>`,
  ];
  const writeRow = (r: number, cells: Cell[], height: number, styleFor: (index: number, cell: Cell) => number) => {
    let row = `<row r="${r}" ht="${height}" customHeight="1">`;
    for (let i = 0; i < columns; i += 1) row += cellXml(`${colName(i)}${r}`, cells[i], styleFor(i, cells[i]));
    lines.push(row + "</row>");
  };
  writeRow(1, sheet.headers, 26, () => STYLE.header);
  sheet.rows.forEach((row, i) => {
    const zebra = i % 2 === 1;
    writeRow(i + 2, row, 22, (index, cell) => styleForCell(sheet.headers[index] || "", cell, zebra));
  });
  lines.push(`</sheetData><autoFilter ref="A1:${lastCol}${lastRow}"/>`);
  lines.push('<pageMargins left="0.35" right="0.35" top="0.4" bottom="0.4" header="0.2" footer="0.2"/>');
  lines.push('<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="1"/>');
  lines.push("</worksheet>");
  return lines.join("");
}

/**
 * Dense table with REAL visible grid:
 * border index 0 = empty (Excel default), 1 = data grid, 2 = header.
 */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
<numFmt numFmtId="164" formatCode="#,##0"/>
<numFmt numFmtId="165" formatCode="0"/>
<numFmt numFmtId="166" formatCode="0"/>
</numFmts>
<fonts count="7">
<font><sz val="11"/><name val="Calibri"/><color rgb="FF0F172A"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FF047857"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFB45309"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFB91C1C"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FF1D4ED8"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FF9F1239"/></font>
</fonts>
<fills count="9">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF0F172A"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFECACA"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDBEAFE"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/></patternFill></fill>
</fills>
<borders count="3">
<border>
  <left/><right/><top/><bottom/>
</border>
<border>
  <left style="thin"><color rgb="FF64748B"/></left>
  <right style="thin"><color rgb="FF64748B"/></right>
  <top style="thin"><color rgb="FF64748B"/></top>
  <bottom style="thin"><color rgb="FF64748B"/></bottom>
</border>
<border>
  <left style="thin"><color rgb="FF0F172A"/></left>
  <right style="thin"><color rgb="FF0F172A"/></right>
  <top style="thin"><color rgb="FF0F172A"/></top>
  <bottom style="thin"><color rgb="FFE11D48"/></bottom>
</border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="15">
<xf numFmtId="0" fontId="0" fillId="8" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="8" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="165" fontId="0" fillId="8" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="165" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="166" fontId="0" fillId="8" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="166" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="5" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="6" fillId="8" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="6" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
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
