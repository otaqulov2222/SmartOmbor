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
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function colName(index: number) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export type Cell = string | number | null | undefined;
export type Sheet = { name: string; headers: string[]; rows: Cell[][] };

function colWidth(sheet: Sheet, index: number) {
  const header = sheet.headers[index] || '';
  let max = header.length;
  let numeric = true;
  const sample = Math.min(sheet.rows.length, 80);
  for (let row = 0; row < sample; row += 1) {
    const value = sheet.rows[row]?.[index];
    if (typeof value === 'number' && Number.isFinite(value)) {
      const formatted = Math.abs(value) >= 1000 ? value.toLocaleString('fr-FR').length : String(value).length;
      if (formatted > max) max = formatted;
    } else if (value != null && value !== '') {
      numeric = false;
      if (String(value).length > max) max = String(value).length;
    }
  }
  if (numeric) return Math.min(16, Math.max(11, max + 2));
  return Math.min(index === 0 ? 46 : 28, Math.max(14, max + 2));
}

function cellXml(ref: string, cell: Cell, style: number) {
  if (typeof cell === 'number' && Number.isFinite(cell)) return `<c r="${ref}" s="${style}"><v>${cell}</v></c>`;
  const text = cell == null || cell === '' ? '' : String(cell).slice(0, 32000);
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

function sheetXml(sheet: Sheet) {
  const columns = Math.max(sheet.headers.length, ...sheet.rows.map(row => row.length), 1);
  const lastCol = colName(columns - 1);
  const lastRow = sheet.rows.length + 1;
  const cols = Array.from({ length: columns }, (_, index) => `<col min="${index + 1}" max="${index + 1}" width="${colWidth(sheet, index)}" customWidth="1"/>`).join('');
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>',
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    `<sheetFormatPr defaultRowHeight="18"/><cols>${cols}</cols><sheetData>`,
  ];
  const writeRow = (r: number, cells: Cell[], styleFor: (index: number, cell: Cell) => number) => {
    let row = `<row r="${r}">`;
    for (let i = 0; i < columns; i += 1) row += cellXml(`${colName(i)}${r}`, cells[i], styleFor(i, cells[i]));
    lines.push(row + '</row>');
  };
  writeRow(1, sheet.headers, () => 1);
  sheet.rows.forEach((row, i) => writeRow(i + 2, row, (_index, cell) => {
    const number = typeof cell === 'number' && Number.isFinite(cell);
    if (i % 2 === 1) return number ? 4 : 2;
    return number ? 3 : 0;
  }));
  lines.push(`</sheetData><autoFilter ref="A1:${lastCol}${lastRow}"/>`);
  lines.push('<pageMargins left="0.4" right="0.4" top="0.45" bottom="0.45" header="0.2" footer="0.2"/>');
  lines.push('<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>');
  lines.push('</worksheet>');
  return lines.join('');
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/><color rgb="FF0F1B2D"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF2F54EB"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEEF2FF"/></patternFill></fill>
</fills>
<borders count="2">
<border><left style="thin"><color rgb="FFE4E8EE"/></left><right style="thin"><color rgb="FFE4E8EE"/></right><top style="thin"><color rgb="FFE4E8EE"/></top><bottom style="thin"><color rgb="FFE4E8EE"/></bottom></border>
<border><left style="thin"><color rgb="FF2F54EB"/></left><right style="thin"><color rgb="FF2F54EB"/></right><top style="thin"><color rgb="FF2F54EB"/></top><bottom style="thin"><color rgb="FF2F54EB"/></bottom></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="3" fontId="0" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
</cellXfs>
</styleSheet>`;

function sanitizeSheetName(name: string, used: Set<string>) {
  let base = name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet';
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
      name: '[Content_Types].xml',
      data: xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>`),
    },
    {
      name: '_rels/.rels',
      data: xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    },
    { name: 'xl/styles.xml', data: xml(STYLES_XML) },
    {
      name: 'xl/workbook.xml',
      data: xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${named.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}
</sheets>
</workbook>`),
    },
  ];
  named.forEach((sheet, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml(sheetXml(sheet)) });
  });
  return Buffer.from(zipStore(files));
}
