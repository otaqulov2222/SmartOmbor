import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Banknote, Boxes, Check, ChevronDown, ChevronRight, ChevronUp, Copy, Download, Eye, EyeOff, Factory, FileSpreadsheet, FileText, KeyRound, Pencil, Plus, Search, Trash2, Truck, X } from 'lucide-react';
import { Link, useLocation, useSearch } from 'wouter';
import { listProducts, useListWarehouses } from '@workspace/api-client-react';
import { useI18n } from '@/i18n';
import { downloadXlsx, type Sheet } from '@/lib/xlsx';
import { BORDO_SIZES, bordoColorKey, isBordoSize, tashkentDay } from '@/bordo-sizes';

type Account = { id: string; name: string; code: string; catalogName: string; login: string; password?: string | null; active: boolean; createdAt: string; counterpartyId?: string | null; counterpartyName?: string | null };
type ColorLine = { name: string; quantity: number };
type Line = {
  id: string; factoryCode: string; sectionCode: string; productCode: string; model: string; size: string;
  pairs: number; boxes: number; pachka?: number; quantity: number; price: number; priceType?: string; markupPct?: number | null; markup?: Partial<SaleMarkup>; colors: ColorLine[]; note: string;
  productId?: string | null; productName?: string | null;
};
const PRICE_TYPES = ['Premium', 'Exclusive', 'Standard'] as const;
type SaleType = typeof PRICE_TYPES[number];
const DEFAULT_MARKUP = { Premium: 5, Exclusive: 10, Standard: 13 };
type SaleMarkup = typeof DEFAULT_MARKUP;
type PctMap = Record<SaleType, string>;
function pctDigits(value: string) {
  return value.replace(/[^\d]/g, '').slice(0, 2);
}
function parseLinePct(value: string) {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 99 ? Math.round(n) : null;
}
function defaultPctMap(markup: SaleMarkup): PctMap {
  return { Premium: String(markup.Premium), Exclusive: String(markup.Exclusive), Standard: String(markup.Standard) };
}
function pctMapOf(line: Pick<Line, 'markup' | 'priceType' | 'markupPct'>, markup: SaleMarkup): PctMap {
  const next = defaultPctMap(markup);
  for (const type of PRICE_TYPES) {
    if (line.markup?.[type] != null) next[type] = String(line.markup[type]);
    else if (line.priceType === type && line.markupPct != null) next[type] = String(line.markupPct);
  }
  return next;
}
function parsePctMap(map: PctMap): Partial<SaleMarkup> {
  return {
    Premium: parseLinePct(map.Premium) ?? undefined,
    Exclusive: parseLinePct(map.Exclusive) ?? undefined,
    Standard: parseLinePct(map.Standard) ?? undefined,
  };
}
function markupLabel(line: Line, markup: SaleMarkup) {
  const map = pctMapOf(line, markup);
  return `P ${map.Premium}% · E ${map.Exclusive}% · S ${map.Standard}%`;
}
function MarkupTriple({ values, locked, compact, onChange, onBlur }: {
  values: PctMap; locked?: Partial<Record<SaleType, boolean>>; compact?: boolean;
  onChange: (next: PctMap) => void; onBlur?: (next: PctMap) => void;
}) {
  const { t } = useI18n();
  return <div className={`sale-triple ${compact ? 'compact' : ''}`} role="group" aria-label={t('zavod.priceType')}>
    {PRICE_TYPES.map(type => <label className="sale-triple-row" key={type}>
      <b>{type}</b>
      <span className="pct-box">
        <input className={`input ${locked?.[type] ? 'input-locked' : ''}`} inputMode="numeric" disabled={Boolean(locked?.[type])} value={values[type]} onChange={event => onChange({ ...values, [type]: pctDigits(event.target.value) })} onFocus={event => event.target.select()} onBlur={event => onBlur?.({ ...values, [type]: pctDigits(event.target.value) })} aria-label={`${type} ${t('products.field.markup')}`}/>
        <span>%</span>
      </span>
    </label>)}
  </div>;
}
async function loadMarkup(): Promise<SaleMarkup> {
  const response = await fetch('/api/settings/markup');
  if (!response.ok) return DEFAULT_MARKUP;
  const data = await response.json() as Partial<SaleMarkup>;
  return {
    Premium: Number.isFinite(Number(data.Premium)) ? Number(data.Premium) : DEFAULT_MARKUP.Premium,
    Exclusive: Number.isFinite(Number(data.Exclusive)) ? Number(data.Exclusive) : DEFAULT_MARKUP.Exclusive,
    Standard: Number.isFinite(Number(data.Standard)) ? Number(data.Standard) : DEFAULT_MARKUP.Standard,
  };
}
function blankLine(factoryCode: string): Line {
  return {
    id: '', factoryCode, sectionCode: '', productCode: '', model: '', size: '',
    pairs: 0, boxes: 0, pachka: 0, quantity: 0, price: 0, priceType: '', colors: [], note: '',
    productId: null, productName: null,
  };
}
function todayKey() {
  return tashkentDay();
}

function matchPartnerRow(items: Row[], selected: string) {
  const needle = selected.trim().toLowerCase();
  if (!needle) return null;
  return items.find(row => row.name.toLowerCase() === needle)
    || items.find(row => (row.account?.name || '').toLowerCase() === needle)
    || items.find(row => (row.account?.catalogName || '').toLowerCase() === needle)
    || items.find(row => (row.account?.code || '').toLowerCase() === needle)
    || null;
}

type Shipment = {
  id: string; number: string; date: string; status: 'sent' | 'accepted' | 'declined'; note: string; createdAt: string;
  lines: Line[]; pairs: number; boxes: number; amount: number;
  moyskladId?: string | null; moyskladNumber?: string | null;
};
type Row = { name: string; productCount: number; stock: number; account: Account | null; shipmentCount: number; pendingCount?: number; lastShipment: string | null };

function portalUrl() {
  return `${window.location.origin}/zavod`;
}

type DraftLine = {
  key: string;
  factoryCode: string;
  sectionCode: string;
  productCode: string;
  model: string;
  size: string;
  pairs: string;
  pachka: string;
  boxes: string;
  quantity: string;
  price: string;
  markup: PctMap;
  colors: { name: string; quantity: string }[];
};

function draftFrom(line: Line, markup: SaleMarkup = DEFAULT_MARKUP): DraftLine {
  return {
    key: line.id,
    factoryCode: line.factoryCode,
    sectionCode: line.sectionCode,
    productCode: line.productCode,
    model: line.model,
    size: line.size,
    pairs: line.pairs ? String(line.pairs) : '',
    pachka: line.pachka && line.pachka > 1 ? String(line.pachka) : '',
    boxes: line.boxes ? String(line.boxes) : '',
    quantity: line.quantity ? String(line.quantity) : '',
    price: line.price ? String(line.price) : '',
    markup: pctMapOf(line, markup),
    colors: (line.colors ?? []).length ? (line.colors ?? []).map(color => ({ name: color.name, quantity: String(color.quantity) })) : [{ name: '', quantity: '' }],
  };
}

function blankDraft(markup: SaleMarkup = DEFAULT_MARKUP): DraftLine {
  return { key: Math.random().toString(36).slice(2), factoryCode: '', sectionCode: '', productCode: '', model: '', size: '', pairs: '', pachka: '', boxes: '', quantity: '', price: '', markup: defaultPctMap(markup), colors: [{ name: '', quantity: '' }] };
}

function asNumber(value: string) {
  return Math.max(0, Number(value.replace(',', '.')) || 0);
}

function codeInput(value: string) {
  return value.replace(/[^\S\n]+/g, ' ').replace(/^\s+/g, '').toLocaleUpperCase('ru-RU');
}
function codeValue(value: string) {
  return codeInput(value).trim();
}

type Passport = {
  found: boolean;
  productId?: string;
  name?: string;
  groupCode?: string;
  size?: string;
  packSize?: number | null;
  cost?: number | null;
  salePrice?: number | null;
  priceType?: string;
  markupPct?: number | null;
  markups?: Partial<SaleMarkup>;
};

async function loadPassport(input: { factory: string; code: string; size?: string; group?: string }): Promise<Passport | null> {
  if (!input.code.trim()) return null;
  const qs = new URLSearchParams({ code: input.code.trim(), factory: input.factory.trim() });
  if (input.size?.trim()) qs.set('size', input.size.trim());
  if (input.group?.trim()) qs.set('group', input.group.trim());
  const response = await fetch(`/api/products/passport?${qs}`);
  if (!response.ok) return null;
  return response.json() as Promise<Passport>;
}

function fromPassport(current: { group: string; size: string; pack: string; price: string; pachka?: string; markup?: PctMap }, data: Passport): Partial<Line> {
  const patch: Partial<Line> = {};
  if (data.found) {
    if (!current.group && data.groupCode) patch.sectionCode = data.groupCode;
    if (!current.size && data.size) patch.size = data.size;
    if (!(Number(current.pachka) > 1) && data.packSize && data.packSize > 1) patch.pachka = data.packSize;
    const amount = data.cost || data.salePrice || 0;
    if (!current.price && amount > 0) patch.price = amount;
    if (data.productId) {
      patch.productId = data.productId;
      patch.productName = data.name || null;
    }
  }
  const inherited: Partial<SaleMarkup> = { ...(data.markups ?? {}) };
  if (!PRICE_TYPES.some(type => inherited[type] != null) && data.priceType && data.priceType in DEFAULT_MARKUP && data.markupPct != null) {
    inherited[data.priceType as SaleType] = data.markupPct;
  }
  if (PRICE_TYPES.some(type => inherited[type] != null)) patch.markup = inherited;
  return patch;
}

function mergeColors(colors: ColorLine[]) {
  const merged = new Map<string, ColorLine>();
  for (const color of colors) {
    const name = bordoColorKey(color.name);
    const quantity = Math.max(0, Number(color.quantity) || 0);
    if (!name || quantity <= 0) continue;
    const prev = merged.get(name);
    if (prev) prev.quantity += quantity;
    else merged.set(name, { name, quantity });
  }
  return [...merged.values()];
}

function lineUnits(line: Line) {
  const pack = line.pairs > 0 ? line.pairs : 0;
  const colors = mergeColors(line.colors ?? []);
  if (pack > 0 && colors.length) return colors.reduce((sum, color) => sum + color.quantity * pack, 0);
  if (pack > 0 && line.boxes > 0) return pack * line.boxes;
  if (line.quantity > 0) return line.quantity;
  return pack;
}

function supplyError(body: { error?: string; detail?: string }, t: (key: 'partners.agentMissing' | 'partners.storeMissing' | 'partners.supplyFailed' | 'partners.supplyNameTaken') => string) {
  if (body.error === 'agent') return t('partners.agentMissing');
  if (body.error === 'store') return t('partners.storeMissing');
  if (body.error === 'posted' || body.detail === 'posted') return t('partners.supplyFailed');
  const raw = String(body.detail || '').trim();
  if (raw === 'posted') return t('partners.supplyFailed');
  if (/уникал|unique|already exists|уже существ|MoySkladda bor|карточка уже есть/i.test(raw)) return t('partners.supplyNameTaken');
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { errors?: Array<{ error?: string }> };
      const text = parsed.errors?.[0]?.error?.trim();
      if (text) return text;
    } catch {
      /* keep fallback */
    }
  }
  if (raw && raw !== 'rejected' && raw !== 'unlinked') return raw;
  return t('partners.supplyFailed');
}

function receiptParts(line: Line) {
  const pack = line.pairs > 0 ? line.pairs : 0;
  const colors = mergeColors(line.colors ?? []);
  if (pack > 0 && colors.length) return colors.map(color => ({ color: color.name, quantity: color.quantity * pack }));
  const total = lineUnits(line);
  if (total <= 0) return [];
  return [{ color: null as string | null, quantity: total }];
}

function WaybillCells({ line, locked, markup, onSave }: { line: Line; locked: boolean; markup: SaleMarkup; onSave: (patch: Partial<Line>) => Promise<boolean> }) {
  const { t, fmt, money } = useI18n();
  const colors = mergeColors(line.colors ?? []);
  const [factoryCode, setFactoryCode] = useState(line.factoryCode || '');
  const [sectionCode, setSectionCode] = useState(line.sectionCode || '');
  const [productCode, setProductCode] = useState(line.productCode || '');
  const [size, setSize] = useState(line.size || '');
  const [pairs, setPairs] = useState(line.pairs ? String(line.pairs) : '');
  const [pachka, setPachka] = useState(line.pachka && line.pachka > 1 ? String(line.pachka) : '');
  const [boxes, setBoxes] = useState(line.boxes ? String(line.boxes) : '');
  const [price, setPrice] = useState(line.price ? String(line.price) : '');
  const [pctMap, setPctMap] = useState<PctMap>(() => pctMapOf(line, markup));
  const [kept, setKept] = useState<Partial<Record<SaleType, boolean>>>({});
  const passportOnce = useRef(false);
  useEffect(() => {
    setFactoryCode(line.factoryCode || '');
    setSectionCode(line.sectionCode || '');
    setProductCode(line.productCode || '');
    setSize(line.size || '');
    setPairs(line.pairs ? String(line.pairs) : '');
    setPachka(current => (line.pachka && line.pachka > 1 ? String(line.pachka) : current));
    setBoxes(line.boxes ? String(line.boxes) : '');
    setPrice(line.price ? String(line.price) : '');
    setPctMap(pctMapOf(line, markup));
  }, [line, markup]);
  useEffect(() => {
    if (locked || passportOnce.current) return;
    if ((line.pachka && line.pachka > 1) || !line.productCode.trim()) return;
    passportOnce.current = true;
    void loadPassport({ factory: line.factoryCode, code: line.productCode, size: line.size, group: line.sectionCode }).then(data => {
      const pack = data?.packSize && data.packSize > 1 ? data.packSize : 0;
      if (!(pack > 1)) return;
      setPachka(String(pack));
      void onSave({ pachka: pack });
    }).catch(() => undefined);
  }, [locked, line.factoryCode, line.pachka, line.productCode, line.sectionCode, line.size, onSave]);
  const preview = lineUnits({ ...line, pairs: asNumber(pairs), boxes: asNumber(boxes), price: asNumber(price) });
  const commit = (next?: Partial<Line>) => {
    const markupValues = next?.markup ?? parsePctMap(pctMap);
    const typedPachka = asNumber(pachka);
    const patch: Partial<Line> = {
      size,
      pairs: asNumber(pairs),
      pachka: typedPachka > 1 ? typedPachka : (line.pachka && line.pachka > 1 ? line.pachka : typedPachka),
      boxes: asNumber(boxes),
      price: asNumber(price),
      markup: markupValues,
      ...next,
      factoryCode: codeValue(next?.factoryCode ?? factoryCode),
      sectionCode: codeValue(next?.sectionCode ?? sectionCode),
      productCode: codeValue(next?.productCode ?? productCode),
    };
    const sameMarkup = PRICE_TYPES.every(type => (patch.markup?.[type] ?? null) === (line.markup?.[type] ?? (line.priceType === type ? line.markupPct : null) ?? null));
    const unchanged = patch.factoryCode === (line.factoryCode || '') && patch.sectionCode === (line.sectionCode || '') && patch.productCode === (line.productCode || '') && patch.size === (line.size || '') && patch.pairs === line.pairs && (patch.pachka ?? 0) === (line.pachka ?? 0) && patch.boxes === line.boxes && patch.price === line.price && sameMarkup && (patch.productId ?? line.productId ?? null) === (line.productId ?? null);
    if (unchanged) return;
    void onSave(patch);
  };
  const applyPassport = (next?: Partial<Line>) => {
    const code = (next?.productCode ?? productCode).trim();
    const sizeVal = (next?.size ?? size).trim();
    const factory = (next?.factoryCode ?? factoryCode).trim();
    const group = (next?.sectionCode ?? sectionCode).trim();
    if (!code) { setKept({}); commit(next); return; }
    void loadPassport({ factory, code, size: sizeVal, group }).then(data => {
      const extra = data ? fromPassport({
        group,
        size: sizeVal,
        pack: next?.pairs != null ? String(next.pairs) : pairs,
        price: next?.price != null ? String(next.price) : price,
        pachka: next?.pachka != null ? String(next.pachka) : pachka,
        markup: pctMap,
      }, data) : {};
      if (extra.sectionCode) setSectionCode(codeInput(extra.sectionCode));
      if (extra.size) setSize(extra.size);
      if (extra.pairs) setPairs(String(extra.pairs));
      if (extra.pachka) setPachka(String(extra.pachka));
      if (extra.price) setPrice(String(extra.price));
      if (extra.markup) {
        setPctMap(current => {
          const nextMap = { ...current };
          for (const type of PRICE_TYPES) {
            if (extra.markup?.[type] != null) nextMap[type] = String(extra.markup[type]);
          }
          return nextMap;
        });
        setKept(Object.fromEntries(PRICE_TYPES.filter(type => extra.markup?.[type] != null).map(type => [type, true])));
      } else {
        setKept({});
      }
      commit({ ...next, ...extra, ...(extra.sectionCode ? { sectionCode: codeInput(extra.sectionCode) } : {}) });
    }).catch(() => commit(next));
  };
  if (locked) {
    return <>
      <td data-label={t('zavod.brand')}><b>Bordo</b></td>
      <td data-label={t('zavod.factoryCode')}>{line.factoryCode || '—'}</td>
      <td data-label={t('zavod.groupCode')}>{line.sectionCode || '—'}</td>
      <td data-label={t('zavod.product')}><b>{line.productCode || '—'}</b></td>
      <td data-label={t('zavod.size')}>{line.size || '—'}</td>
      <td className="num" data-label={t('zavod.pairs')}>{fmt(line.pairs)}</td>
      <td className="num waybill-pachka" data-label={t('zavod.pachka')}>{line.pachka && line.pachka > 1 ? fmt(line.pachka) : '—'}</td>
      <td className="num" data-label={t('zavod.boxes')}>{fmt(line.boxes)}</td>
      <td className="num" data-label={t('zavod.price')}>{line.price ? money(line.price) : '—'}</td>
      <td data-label={t('zavod.priceType')}>{markupLabel(line, markup)}</td>
      <td className="waybill-colors-cell" data-label={t('zavod.colors')}><ColorCount colors={colors} fmt={fmt}/></td>
      <td className="num" data-label={t('zavod.sum')}>{money(lineUnits(line) * line.price)}</td>
    </>;
  }
  return <>
    <td data-label={t('zavod.brand')}><b>Bordo</b></td>
    <td data-label={t('zavod.factoryCode')}><input className="input" aria-label={t('zavod.factoryCode')} autoCapitalize="characters" value={factoryCode} onChange={event => setFactoryCode(codeInput(event.target.value))} onBlur={() => applyPassport()}/></td>
    <td data-label={t('zavod.groupCode')}><input className="input" aria-label={t('zavod.groupCode')} autoCapitalize="characters" value={sectionCode} onChange={event => setSectionCode(codeInput(event.target.value))} onBlur={() => applyPassport()}/></td>
    <td data-label={t('zavod.product')}><input className="input" aria-label={t('zavod.product')} autoCapitalize="characters" value={productCode} onChange={event => setProductCode(codeInput(event.target.value))} onBlur={() => applyPassport()}/></td>
    <td className="waybill-size" data-label={t('zavod.size')}><select className="input" aria-label={t('zavod.size')} value={size} onChange={event => { setSize(event.target.value); applyPassport({ size: event.target.value }); }}><option value=""/>{!isBordoSize(size) && size && <option value={size}>{size}</option>}{BORDO_SIZES.map(item => <option key={item} value={item}>{item}</option>)}</select></td>
    <td data-label={t('zavod.pairs')}><input className="input" aria-label={t('zavod.pairs')} inputMode="decimal" value={pairs} onChange={event => setPairs(event.target.value)} onBlur={() => applyPassport()}/></td>
    <td className="waybill-pachka" data-label={t('zavod.pachka')}><input className="input" aria-label={t('zavod.pachka')} inputMode="numeric" value={pachka} onChange={event => setPachka(event.target.value.replace(/[^\d]/g, ''))} onBlur={() => commit()}/></td>
    <td data-label={t('zavod.boxes')}><input className="input" aria-label={t('zavod.boxes')} inputMode="decimal" value={boxes} onChange={event => setBoxes(event.target.value)} onBlur={() => commit()}/></td>
    <td data-label={t('zavod.price')}><input className="input" aria-label={t('zavod.price')} inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} onBlur={() => applyPassport()}/></td>
    <td className="waybill-type" data-label={t('zavod.priceType')}><MarkupTriple compact values={pctMap} locked={kept} onChange={setPctMap} onBlur={next => { setPctMap(next); commit({ markup: parsePctMap(next) }); }}/></td>
    <td className="waybill-colors-cell" data-label={t('zavod.colors')}><ColorCount colors={colors} fmt={fmt}/></td>
    <td className="num" data-label={t('zavod.sum')}>{money(preview * asNumber(price))}</td>
  </>;
}

function ColorCount({ colors, fmt }: { colors: ColorLine[]; fmt: (value: number) => string }) {
  if (!colors.length) return <span className="color-empty">—</span>;
  return <span className="color-count">{fmt(colors.length)}</span>;
}

function ColorMarks({ colors, fmt }: { colors: ColorLine[]; fmt: (value: number) => string }) {
  if (!colors.length) return <span className="color-empty">—</span>;
  return <span className="color-chips">{colors.map(color => <span className="color-chip" key={`${color.name}-${color.quantity}`}><b>{color.name.toLocaleUpperCase('ru-RU')}</b><i>{fmt(color.quantity)}</i></span>)}</span>;
}

function colorText(line: Line, fmt: (value: number) => string) {
  const colors = mergeColors(line.colors ?? []);
  return colors.length ? colors.map(color => `${color.name} · ${fmt(color.quantity)}`).join(', ') : '';
}

function statusLabel(status: Shipment['status'], t: (key: 'partners.accepted' | 'partners.declined' | 'partners.sent') => string) {
  if (status === 'accepted') return t('partners.accepted');
  if (status === 'declined') return t('partners.declined');
  return t('partners.sent');
}

function htmlEscape(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function WaybillExport({ shipments, filename, title, factory, code }: { shipments: Shipment[]; filename: string; title: string; factory: string; code: string }) {
  const { t, lang, fmt, money, date } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const headers = [t('common.number'), t('common.date'), t('common.status'), t('zavod.brand'), t('zavod.factoryCode'), t('zavod.groupCode'), t('zavod.product'), t('zavod.size'), t('zavod.pairs'), t('zavod.pachka'), t('zavod.boxes'), t('zavod.price'), t('zavod.priceType'), t('zavod.colors'), t('zavod.sum')];
  const excel = () => {
    const rows = shipments.flatMap(shipment => shipment.lines.map(line => [
      shipment.number,
      date(shipment.date),
      statusLabel(shipment.status, t),
      'Bordo',
      line.factoryCode,
      line.sectionCode,
      line.productCode,
      line.size,
      line.pairs,
      line.pachka && line.pachka > 1 ? line.pachka : '',
      line.boxes,
      line.price,
      markupLabel(line, DEFAULT_MARKUP),
      colorText(line, fmt),
      lineUnits(line) * line.price,
    ]));
    const sheet: Sheet = { name: title, headers, rows };
    downloadXlsx(`${filename}.xlsx`, [sheet]);
    setOpen(false);
  };
  const pdf = () => {
    const blocks = shipments.map(shipment => {
      const body = shipment.lines.map(line => `<tr><td>Bordo</td><td>${htmlEscape(line.factoryCode || '—')}</td><td>${htmlEscape(line.sectionCode || '—')}</td><td><b>${htmlEscape(line.productCode || '—')}</b></td><td>${htmlEscape(line.size || '—')}</td><td class="num">${fmt(line.pairs)}</td><td class="num">${line.pachka && line.pachka > 1 ? fmt(line.pachka) : '—'}</td><td class="num">${fmt(line.boxes)}</td><td class="num">${line.price ? htmlEscape(money(line.price)) : '—'}</td><td>${htmlEscape(markupLabel(line, DEFAULT_MARKUP))}</td><td>${htmlEscape(colorText(line, fmt) || '—')}</td><td class="num">${htmlEscape(money(lineUnits(line) * line.price))}</td></tr>`).join('');
      return `<article><header><div><p>${htmlEscape(code || factory)}</p><h2>${htmlEscape(shipment.number)}</h2></div><div class="meta"><div>${htmlEscape(date(shipment.date))}</div><div>${htmlEscape(statusLabel(shipment.status, t))}</div><b>${htmlEscape(money(shipment.amount))}</b></div></header><table><thead><tr><th>${htmlEscape(t('zavod.brand'))}</th><th>${htmlEscape(t('zavod.factoryCode'))}</th><th>${htmlEscape(t('zavod.groupCode'))}</th><th>${htmlEscape(t('zavod.product'))}</th><th>${htmlEscape(t('zavod.size'))}</th><th>${htmlEscape(t('zavod.pairs'))}</th><th>${htmlEscape(t('zavod.pachka'))}</th><th>${htmlEscape(t('zavod.boxes'))}</th><th>${htmlEscape(t('zavod.price'))}</th><th>${htmlEscape(t('zavod.priceType'))}</th><th>${htmlEscape(t('zavod.colors'))}</th><th>${htmlEscape(t('zavod.sum'))}</th></tr></thead><tbody>${body}</tbody></table>${shipment.note ? `<p class="note">${htmlEscape(shipment.note)}</p>` : ''}</article>`;
    }).join('');
    const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"/><title>${htmlEscape(title)}</title><style>
      *{box-sizing:border-box} body{margin:0;font:12px/1.45 Inter,Segoe UI,sans-serif;color:#0f1b2d}
      .hint{position:sticky;top:0;background:#0f172a;color:#fff;padding:10px 16px;display:flex;justify-content:space-between;gap:12px}
      .hint button{background:#2f54eb;color:#fff;border:0;border-radius:8px;padding:6px 12px;font-weight:600;cursor:pointer}
      .page{max-width:1040px;margin:0 auto;padding:28px 32px 48px}
      .brand{font-weight:800;font-size:16px} .brand span{color:#2f54eb}
      article{margin-top:22px;break-inside:avoid}
      article header{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #2f54eb;padding-bottom:10px;margin-bottom:12px}
      article h2{margin:2px 0 0;font-size:20px} article p{margin:0;color:#64748b;font-size:12px}
      .meta{text-align:right} .meta b{display:block;margin-top:4px;font-size:16px}
      table{width:100%;border-collapse:collapse} th,td{border:1px solid #e4e8ee;padding:6px 8px;text-align:left}
      th{background:#2f54eb;color:#fff;font-size:10px;letter-spacing:.04em;text-transform:uppercase}
      td.num{text-align:right;font-variant-numeric:tabular-nums} .note{color:#64748b;margin-top:8px}
      @media print{.hint{display:none} .page{padding:0;max-width:none} article{break-after:page}}
    </style></head><body><div class="hint"><span>${htmlEscape(t('export.pdfHint'))}</span><button onclick="window.print()">PDF</button></div><div class="page"><div class="brand">Smart <span>Ombor</span> · ${htmlEscape(factory)}</div>${blocks}</div><script>setTimeout(()=>window.print(),350)</script></body></html>`;
    const view = window.open('', '_blank', 'noopener,width=1100,height=800');
    if (!view) return;
    view.document.write(html);
    view.document.close();
    setOpen(false);
  };
  return <div className="waybill-export" ref={box}><button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(value => !value)} data-testid={`button-export-${filename}`}><Download size={14}/>{t('common.export')}</button>{open && <div className="waybill-export-menu"><button type="button" onClick={excel}><FileSpreadsheet size={15}/>{t('export.excel')}</button><button type="button" onClick={pdf}><FileText size={15}/>{t('export.pdf')}</button></div>}</div>;
}

export function PartnersPage() {
  const { t, fmt, date } = useI18n();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const selected = new URLSearchParams(search).get('factory') || '';
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const cache = useQueryClient();
  const held = useRef<Row | null>(null);
  const list = useQuery<{ items: Row[] }>({
    queryKey: ['partner-factories'],
    staleTime: 4_000,
    refetchInterval: 8_000,
    placeholderData: previous => previous,
    queryFn: async () => {
      const response = await fetch('/api/partner-factories');
      if (!response.ok) throw new Error('load');
      return response.json();
    },
  });
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data?.items ?? []).filter(row => !needle || row.name.toLowerCase().includes(needle) || (row.account?.code || '').toLowerCase().includes(needle) || (row.account?.login || '').includes(needle));
  }, [list.data, q]);
  const current = matchPartnerRow(list.data?.items ?? [], selected);
  if (current) held.current = current;
  const row = current ?? (held.current && matchPartnerRow([held.current], selected) ? held.current : null);

  if (selected && row) {
    return <PartnerDetail row={row} onBack={() => setLocation('/partners')} />;
  }
  if (selected && list.isFetching) {
    return <div className="loading-rows"><i className="skeleton-line"/><i className="skeleton-line"/></div>;
  }

  return <>
    <div className="page-head partner-head"><div><h1>{t('partners.title')}</h1><p>{t('partners.sub')}</p></div><div className="partner-bar"><label className="partner-search"><Search size={16}/><input value={q} onChange={e => setQ(e.target.value)} placeholder={t('partners.search')} data-testid="input-partners-search"/>{q && <button type="button" className="partner-search-clear" onClick={() => setQ('')} aria-label={t('common.close')}><X size={14}/></button>}</label><button type="button" className="btn btn-primary" onClick={() => setCreating(true)} data-testid="button-add-partner"><Plus size={16}/>{t('partners.add')}</button></div></div>
    {list.isLoading ? <div className="loading-rows"><i className="skeleton-line"/><i className="skeleton-line"/></div> : items.length ? <div className="partner-grid">{items.map(row => <button key={row.name} type="button" className="partner-card" onClick={() => setLocation(`/partners?factory=${encodeURIComponent(row.name)}`)} data-testid={`partner-${row.name}`}>
      <span className="partner-mark"><Factory size={18}/></span>
      <span className="partner-copy"><b>{row.name}</b><small>{row.account?.code || t('partners.noAccount')}</small></span>
      <ChevronRight size={18} className="partner-go"/>
      {(row.pendingCount ?? 0) > 0 && <span className="partner-alert" title={t('partners.pending', { count: row.pendingCount ?? 0 })}>{fmt(row.pendingCount ?? 0)}</span>}
      <span className="partner-meta">{t('partners.shipments', { count: fmt(row.shipmentCount) })}{row.lastShipment ? ` · ${date(row.lastShipment)}` : ''}</span>
    </button>)}</div> : <div className="state state-empty"><b>{t('partners.empty')}</b></div>}
    {creating && <CreatePartner onClose={() => setCreating(false)} onCreated={async () => { setCreating(false); await cache.invalidateQueries({ queryKey: ['partner-factories'] }); }}/>}
  </>;
}

function CreatePartner({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/partner-factories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, code, login, password: password || undefined, catalogName: name }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error === 'login_taken' ? t('partners.loginTaken') : body.error === 'code_taken' ? t('partners.codeTaken') : body.error === 'password_short' ? t('partners.passwordShort') : t('partners.required'));
        return;
      }
      await onCreated();
    } finally {
      setBusy(false);
    }
  };
  return createPortal(<div className="backdrop" onClick={onClose}><div className="modal" onClick={event => event.stopPropagation()} role="dialog" aria-labelledby="partner-create-title">
    <div className="modal-top"><div><p className="eyebrow">{t('partners.title')}</p><h2 id="partner-create-title">{t('partners.add')}</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label={t('common.close')}><X size={18}/></button></div>
    <p className="muted">{t('partners.accessHint')}</p>
    <div className="form-grid">
      <label className="field"><span>{t('partners.name')}</span><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Sando" data-testid="input-new-factory-name"/></label>
      <label className="field"><span>{t('partners.code')}</span><input className="input" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="BOP80" data-testid="input-new-factory-code"/></label>
      <label className="field"><span>{t('partners.login')}</span><input className="input" value={login} onChange={e => setLogin(e.target.value.toLowerCase())} placeholder="sando" data-testid="input-new-factory-login"/></label>
      <label className="field"><span>{t('partners.password')}</span><input className="input" value={password} onChange={e => setPassword(e.target.value)} placeholder={t('partners.generate')} data-testid="input-new-factory-password"/></label>
    </div>
    {error && <p className="error-text">{error}</p>}
    <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button type="button" className="btn btn-primary" disabled={busy || !name.trim() || !code.trim() || !login.trim()} onClick={() => void save()} data-testid="button-create-factory"><KeyRound size={15}/>{busy ? t('common.saving') : t('partners.saveAccess')}</button></div>
  </div></div>, document.body);
}

function LineColors({ line, onSave }: { line: Line; onSave: (colors: ColorLine[]) => Promise<boolean> }) {
  const { t, fmt } = useI18n();
  const [rows, setRows] = useState(() => {
    const saved = mergeColors(line.colors ?? []).map(color => ({ name: color.name, quantity: String(color.quantity) }));
    return [...saved, { name: '', quantity: '' }];
  });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [checked, setChecked] = useState(false);
  const nameRefs = useRef<Array<HTMLInputElement | null>>([]);
  const focusAt = useRef(rows.length - 1);
  useEffect(() => {
    const index = focusAt.current;
    if (index < 0) return;
    focusAt.current = -1;
    nameRefs.current[index]?.focus();
  });
  const edit = (index: number, field: 'name' | 'quantity', value: string) => {
    setChecked(false);
    setFailed(false);
    setRows(list => {
      const next = list.map((item, i) => i === index ? { ...item, [field]: field === 'name' ? value.toLocaleUpperCase('ru-RU') : value } : item);
      if (field !== 'quantity' || !next[index]?.name.trim() || !(Number(value.replace(',', '.')) > 0)) return next;
      if (next.some((item, i) => i > index && !item.name.trim() && !item.quantity.trim())) return next;
      return [...next, { name: '', quantity: '' }];
    });
  };
  const filled = mergeColors(rows
    .map(row => ({ name: row.name.trim(), quantity: Math.max(0, Number(row.quantity.replace(',', '.')) || 0) }))
    .filter(row => row.name && row.quantity > 0));
  const sum = filled.reduce((total, row) => total + row.quantity, 0);
  const boxes = line.boxes;
  const diff = Math.abs(sum - boxes);
  const ready = filled.length > 0 && sum === boxes;
  const message = !filled.length
    ? t('partners.colorUnder', { sum: fmt(0), boxes: fmt(boxes), diff: fmt(boxes) })
    : sum > boxes
      ? t('partners.colorOver', { sum: fmt(sum), boxes: fmt(boxes), diff: fmt(diff) })
      : sum < boxes
        ? t('partners.colorUnder', { sum: fmt(sum), boxes: fmt(boxes), diff: fmt(diff) })
        : t('partners.colorMatch');
  const save = async () => {
    setChecked(true);
    if (!ready) return;
    setBusy(true);
    setFailed(false);
    const ok = await onSave(filled);
    setBusy(false);
    if (!ok) setFailed(true);
  };
  return <div className="color-edit" onMouseDown={event => event.stopPropagation()}>
    {rows.map((row, index) => <div key={index} className="color-pair">
      <input className="input" ref={node => { nameRefs.current[index] = node; }} value={row.name} aria-label={t('zavod.colorName')} placeholder={t('zavod.colorName')} autoCapitalize="characters" onChange={event => edit(index, 'name', event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.parentElement?.querySelector<HTMLInputElement>('.color-qty')?.focus(); } }}/>
      <span>/</span>
      <input className="input color-qty" inputMode="numeric" value={row.quantity} aria-label={t('zavod.boxes')} placeholder={t('zavod.boxes')} onChange={event => edit(index, 'quantity', event.target.value)} onKeyDown={event => { if (event.key !== 'Enter') return; event.preventDefault(); const next = event.currentTarget.parentElement?.nextElementSibling?.querySelector('input'); if (next instanceof HTMLInputElement) next.focus(); }}/>
    </div>)}
    <button type="button" className="icon-btn" aria-label={t('partners.colorAdd')} onClick={() => { setChecked(false); focusAt.current = rows.length; setRows(list => [...list, { name: '', quantity: '' }]); }}><Plus size={14}/></button>
    {checked && <p className={ready ? 'color-ok' : 'color-warn'}>{message}</p>}
    {failed && <p className="color-warn">{t('partners.shipmentInvalid')}</p>}
    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>{busy ? t('common.saving') : t('partners.colorSave')}</button>
  </div>;
}

function PartnerDetail({ row, onBack }: { row: Row; onBack: () => void }) {
  const { t, fmt, money, date } = useI18n();
  const cache = useQueryClient();
  const [, setLocation] = useLocation();
  const [name, setName] = useState(row.name);
  const [code, setCode] = useState(row.account?.code || '');
  const [login, setLogin] = useState(row.account?.login || row.name.toLowerCase().replace(/[^a-z0-9]+/gi, '').slice(0, 16));
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const supplyBusy = useRef(false);
  const saveQueue = useRef(Promise.resolve(true));
  const [settings, setSettings] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [day, setDay] = useState(todayKey);
  const [openShipment, setOpenShipment] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [colorFor, setColorFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<Shipment | null>(null);
  const [removing, setRemoving] = useState<Shipment | null>(null);
  const [removingLine, setRemovingLine] = useState<{ shipment: Shipment; line: Line } | null>(null);
  const [lineEdit, setLineEdit] = useState<{ shipment: Shipment; line: Line } | null>(null);
  const [posting, setPosting] = useState<Shipment | null>(null);
  const [supplyingId, setSupplyingId] = useState<string | null>(null);
  const [storeId, setStoreId] = useState('');
  const [postError, setPostError] = useState('');
  const [agentQuery, setAgentQuery] = useState('');
  const [agentHits, setAgentHits] = useState<Array<{ id: string; name: string }>>([]);
  const [agent, setAgent] = useState<{ id: string; name: string } | null>(null);
  const [markup, setMarkup] = useState<SaleMarkup>(DEFAULT_MARKUP);
  useEffect(() => { void loadMarkup().then(setMarkup); }, []);
  useEffect(() => {
    if (!posting) return;
    const saved = row.account?.counterpartyId && row.account.counterpartyName ? { id: row.account.counterpartyId, name: row.account.counterpartyName } : null;
    setAgent(saved);
    setAgentQuery('');
    setAgentHits([]);
    if (saved) return;
    const seed = (row.account?.catalogName || row.account?.name || row.name || '').trim();
    if (seed.length < 2) return;
    void fetch(`/api/counterparties?search=${encodeURIComponent(seed)}`).then(response => response.json()).then(data => {
      const items = Array.isArray(data.items) ? data.items as Array<{ id: string; name: string }> : [];
      const exact = items.filter(item => item.name.trim().toLowerCase() === seed.toLowerCase());
      const pick = exact.length === 1 ? exact[0] : items.length === 1 ? items[0] : null;
      if (pick) setAgent(pick);
      else setAgentHits(items.slice(0, 8));
    }).catch(() => undefined);
  }, [posting, row.account?.counterpartyId, row.account?.counterpartyName, row.account?.catalogName, row.account?.name, row.name]);
  useEffect(() => {
    const text = agentQuery.trim();
    if (text.length < 2) { setAgentHits([]); return; }
    const timer = window.setTimeout(() => {
      void fetch(`/api/counterparties?search=${encodeURIComponent(text)}`).then(response => response.json()).then(data => {
        setAgentHits(Array.isArray(data.items) ? data.items : []);
      }).catch(() => setAgentHits([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [agentQuery]);
  useEffect(() => { setCatalogOpen(false); }, [row.name]);
  useEffect(() => {
    setName(row.name);
    setCode(row.account?.code || '');
    setLogin(row.account?.login || row.name.toLowerCase().replace(/[^a-z0-9]+/gi, '').slice(0, 16));
  }, [row.name, row.account?.code, row.account?.login]);
  const detail = useQuery<{ account: Account; shipments: Shipment[] }>({
    queryKey: ['partner-detail', row.account?.id],
    enabled: !!row.account,
    staleTime: 2_000,
    refetchInterval: 4_000,
    placeholderData: previous => previous,
    queryFn: async () => {
      const response = await fetch(`/api/partner-factories/${row.account!.id}`);
      if (!response.ok) throw new Error('load');
      return response.json();
    },
  });
  const products = useQuery({
    queryKey: ['partner-catalog', row.account?.catalogName || row.name],
    enabled: catalogOpen,
    staleTime: 60_000,
    queryFn: async () => {
      const pageSize = 100;
      const first = await listProducts({ factory: row.name, page: 1, pageSize });
      if (first.total <= first.items.length) return first;
      const pages = Math.ceil(first.total / pageSize);
      const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, index) => listProducts({ factory: row.name, page: index + 2, pageSize })));
      return { ...first, items: [first.items, ...rest.map((page) => page.items)].flat() };
    },
  });
  const warehouses = useListWarehouses();
  useEffect(() => {
    const firstStore = warehouses.data?.[0]?.id;
    if (posting && firstStore) setStoreId(current => current || firstStore);
  }, [posting, warehouses.data]);
  const shipments = detail.data?.shipments ?? [];

  const saveAccess = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch(row.account ? `/api/partner-factories/${row.account.id}` : '/api/partner-factories', {
        method: row.account ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, catalogName: name, code, login, password: password || undefined }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error === 'login_taken' ? t('partners.loginTaken') : body.error === 'code_taken' ? t('partners.codeTaken') : body.error === 'password_short' ? t('partners.passwordShort') : t('partners.required'));
        return;
      }
      setPassword(body.password || password);
      setShowPassword(false);
      await cache.invalidateQueries({ queryKey: ['partner-factories'] });
      if (body.account?.id) await cache.invalidateQueries({ queryKey: ['partner-detail', body.account.id] });
      if (row.account && name.trim() !== row.name) setLocation(`/partners?factory=${encodeURIComponent(name.trim())}`);
      else setSettings(false);
    } finally {
      setBusy(false);
    }
  };

  const removeFactory = async () => {
    if (!row.account) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/partner-factories/${row.account.id}`, { method: 'DELETE' });
      if (!response.ok) { setError(t('partners.required')); return; }
      await cache.invalidateQueries({ queryKey: ['partner-factories'] });
      await cache.invalidateQueries({ queryKey: ['partner-alerts'] });
      onBack();
    } finally {
      setBusy(false);
    }
  };

  const refreshShipments = async () => {
    await cache.invalidateQueries({ queryKey: ['partner-detail', row.account?.id] });
    await cache.invalidateQueries({ queryKey: ['partner-factories'] });
    await cache.invalidateQueries({ queryKey: ['partner-alerts'] });
  };

  const postSupply = async () => {
    if (supplyBusy.current || !posting || posting.moyskladId || posting.status === 'declined') return;
    const chosen = storeId || (warehouses.data?.length === 1 ? warehouses.data[0].id : '');
    if (!chosen) { setPostError(t('partners.storeMissing')); return; }
    if (!agent && !row.account?.counterpartyId) { setPostError(t('partners.agentMissing')); return; }
    const mismatch = posting.lines.find(line => {
      const colors = mergeColors(line.colors ?? []);
      if (!colors.length || !(line.boxes > 0)) return false;
      return colors.reduce((sum, color) => sum + color.quantity, 0) !== line.boxes;
    });
    if (mismatch) {
      const colors = mergeColors(mismatch.colors ?? []);
      const sum = colors.reduce((total, color) => total + color.quantity, 0);
      const diff = Math.abs(sum - mismatch.boxes);
      setPostError(sum > mismatch.boxes
        ? t('partners.colorOver', { sum: fmt(sum), boxes: fmt(mismatch.boxes), diff: fmt(diff) })
        : t('partners.colorUnder', { sum: fmt(sum), boxes: fmt(mismatch.boxes), diff: fmt(diff) }));
      return;
    }
    supplyBusy.current = true;
    setBusy(true); setPostError('');
    const shipmentId = posting.id;
    const postedNow = async () => {
      await refreshShipments();
      const latest = cache.getQueryData<{ account: Account; shipments: Shipment[] }>(['partner-detail', row.account?.id]);
      return latest?.shipments.find(item => item.id === shipmentId && item.moyskladId) ?? null;
    };
    const waitPosted = async (tries: number) => {
      for (let i = 0; i < tries; i += 1) {
        const hit = await postedNow();
        if (hit) return hit;
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
      return postedNow();
    };
    try {
      if (row.account && (agent ? agent.id !== row.account.counterpartyId : Boolean(row.account.counterpartyId))) {
        const saved = await fetch(`/api/partner-factories/${row.account.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: row.account.name, code: row.account.code, login: row.account.login, password: '', counterpartyId: agent?.id ?? '', counterpartyName: agent?.name ?? '' }),
        });
        if (!saved.ok) { setPostError(t('partners.agentMissing')); return; }
      }
      const started = await fetch(`/api/partner-factories/shipments/${shipmentId}/supply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storeId: chosen }) });
      const startedBody = await started.json().catch(() => ({})) as { pending?: boolean; error?: string; detail?: string; id?: string; already?: boolean };
      if (started.ok && !startedBody.pending && (startedBody.id || startedBody.already)) {
        setPosting(null);
        setSupplyingId(null);
        await refreshShipments();
        return;
      }
      if (!started.ok && started.status !== 202) {
        if (await postedNow()) {
          setPosting(null);
          setSupplyingId(null);
          return;
        }
        setPostError(supplyError(startedBody, t));
        return;
      }
      setSupplyingId(shipmentId);
      setPosting(null);
      setBusy(false);
      for (let i = 0; i < 120; i += 1) {
        const hit = await postedNow();
        if (hit) {
          setSupplyingId(null);
          return;
        }
        const status = await fetch(`/api/partner-factories/shipments/${shipmentId}/supply`);
        const body = await status.json().catch(() => ({})) as { pending?: boolean; error?: string; detail?: string; id?: string; already?: boolean };
        if (body.pending || status.status === 202 || status.status === 404) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        if ((status.ok || body.already) && (body.id || body.already)) {
          setSupplyingId(null);
          await refreshShipments();
          return;
        }
        setSupplyingId(null);
        setPostError(supplyError(body, t));
        setPosting(posting);
        return;
      }
      const hit = await waitPosted(8);
      if (hit) {
        setSupplyingId(null);
        return;
      }
      setSupplyingId(null);
      setPostError(t('partners.supplyFailed'));
      setPosting(posting);
    } catch {
      const hit = await postedNow();
      if (hit) {
        setPosting(null);
        setSupplyingId(null);
      } else {
        setSupplyingId(null);
        setPostError(t('partners.supplyFailed'));
      }
    } finally {
      supplyBusy.current = false;
      setBusy(false);
    }
  };

  const lineBody = (line: Line, patch?: Partial<Line>) => {
    const touchesIdentity = patch != null && (patch.productCode !== undefined || patch.size !== undefined || patch.sectionCode !== undefined || patch.factoryCode !== undefined);
    const linked = patch?.productId !== undefined ? patch.productId : (touchesIdentity ? null : line.productId);
    return {
      id: line.id,
      factoryCode: patch?.factoryCode ?? line.factoryCode,
      sectionCode: patch?.sectionCode ?? line.sectionCode,
      productCode: patch?.productCode ?? line.productCode,
      model: line.model,
      size: patch?.size ?? line.size,
      pairs: patch?.pairs ?? line.pairs,
      boxes: patch?.boxes ?? line.boxes,
      pachka: patch?.pachka ?? line.pachka ?? 0,
      quantity: line.quantity,
      price: patch?.price ?? line.price,
      priceType: patch?.priceType ?? line.priceType ?? '',
      markupPct: patch?.markupPct !== undefined ? patch.markupPct : (line.markupPct ?? null),
      markup: patch?.markup ?? line.markup ?? {},
      colors: patch?.colors ?? line.colors,
      productId: linked ?? null,
      productName: patch?.productName !== undefined ? patch.productName : (linked ? line.productName : null),
    };
  };

  const saveLine = async (shipment: Shipment, line: Line, patch: Partial<Line>) => {
    const run = async () => {
      const latest = cache.getQueryData<{ account: Account; shipments: Shipment[] }>(['partner-detail', row.account?.id])?.shipments.find(item => item.id === shipment.id) ?? shipment;
      const source = latest.lines.find(item => item.id === line.id) ?? line;
      const next = lineBody(source, patch);
      const lines = source.id
        ? latest.lines.map(item => item.id === source.id ? next : lineBody(item))
        : [...latest.lines.map(item => lineBody(item)), next];
      const response = await fetch(`/api/partner-factories/shipments/${shipment.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: latest.date,
          note: latest.note,
          lines,
        }),
      });
      if (!response.ok) return false;
      const saved = await response.json() as Shipment;
      cache.setQueryData<{ account: Account; shipments: Shipment[] }>(['partner-detail', row.account?.id], (prev) => {
        if (!prev) return prev;
        return { ...prev, shipments: prev.shipments.map(item => item.id === saved.id ? saved : item) };
      });
      return true;
    };
    const queued = saveQueue.current.then(run, run);
    saveQueue.current = queued.then(() => true, () => true);
    return queued;
  };

  const removeLine = async (shipment: Shipment, line: Line) => {
    const rest = shipment.lines.filter(item => item.id !== line.id);
    const response = rest.length
      ? await fetch(`/api/partner-factories/shipments/${shipment.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: shipment.date, note: shipment.note, lines: rest.map(item => lineBody(item)) }),
      })
      : await fetch(`/api/partner-factories/shipments/${shipment.id}`, { method: 'DELETE' });
    if (!response.ok) return;
    await refreshShipments();
  };

  const setStatus = async (id: string, status: 'accepted' | 'declined' | 'sent') => {
    const path = status === 'accepted' ? 'accept' : status === 'declined' ? 'decline' : 'reopen';
    await fetch(`/api/partner-factories/shipments/${id}/${path}`, { method: 'POST' });
    await refreshShipments();
  };

  const removeShipment = async () => {
    if (!removing) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/partner-factories/shipments/${removing.id}`, { method: 'DELETE' });
      if (!response.ok) { setError(t('partners.shipmentInvalid')); return; }
      setRemoving(null);
      await refreshShipments();
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(portalUrl());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const visible = useMemo(() => shipments.filter(shipment => !day || tashkentDay(shipment.date) === day), [shipments, day]);
  const pairs = visible.reduce((sum, shipment) => sum + shipment.pairs, 0);
  const amount = visible.reduce((sum, shipment) => sum + shipment.amount, 0);
  const passwordShown = detail.data?.account.password || row.account?.password || '';
  const passwordReady = useRef(false);
  useEffect(() => {
    if (!settings) { passwordReady.current = false; return; }
    if (passwordReady.current || !passwordShown) return;
    setPassword(passwordShown);
    setShowPassword(false);
    passwordReady.current = true;
  }, [settings, passwordShown]);

  return <div className="partner-detail">
    <button type="button" className="partner-back" onClick={onBack}><ArrowLeft size={16}/>{t('partners.back')}</button>
    <header className="factory-hero">
      <span className="factory-mark"><Factory size={22}/></span>
      <div className="factory-id">
        <span className="factory-code">{row.account?.code || t('partners.noAccount')}</span>
        <h1>{row.name}</h1>
        {(row.productCount > 0 || row.stock > 0) && <p>{t('partners.products', { count: fmt(row.productCount) })} · {t('partners.stock', { count: fmt(row.stock) })}</p>}
      </div>
      <div className="factory-actions">
        <button type="button" className="btn btn-secondary" onClick={() => setSettings(true)} data-testid="button-edit-partner"><Pencil size={16}/>{t('partners.edit')}</button>
        {row.account && <button type="button" className="btn btn-ghost factory-delete" onClick={() => setConfirmDelete(true)} data-testid="button-delete-partner"><Trash2 size={16}/>{t('partners.delete')}</button>}
      </div>
    </header>
    <div className="partner-kpis">
      <div><span className="kpi-icon"><Truck size={18}/></span><div><span>{t('partners.incoming')}</span><b>{fmt(visible.length)}</b></div></div>
      <div><span className="kpi-icon"><Boxes size={18}/></span><div><span>{t('zavod.totalPairs')}</span><b>{fmt(pairs)}</b></div></div>
      <div><span className="kpi-icon"><Banknote size={18}/></span><div><span>{t('zavod.sum')}</span><b>{money(amount)}</b></div></div>
    </div>
    <section className="card factory-sheet">
      <div className="card-head"><h2>{t('partners.incoming')}</h2><div className="waybill-head-tools"><label className="waybill-filter"><span>{t('common.date')}</span><input className="input" type="date" value={day} onChange={e => setDay(e.target.value)} data-testid="input-shipment-date"/></label>{visible.length > 0 && <WaybillExport shipments={visible} filename={`${row.account?.code || row.name}-${day || 'all'}`} title={t('partners.incoming')} factory={row.name} code={row.account?.code || ''}/>}</div></div>
      {detail.isLoading && !shipments.length ? (
        <div className="loading-rows"><i className="skeleton-line"/><i className="skeleton-line"/></div>
      ) : visible.length ? (
        <div className="shipment-list">{visible.map(shipment => (
          <article key={shipment.id} className="waybill" data-testid={`shipment-${shipment.id}`}>
            <header>
              <button type="button" className="waybill-open" onClick={() => setOpenShipment(openShipment === shipment.id ? null : shipment.id)}>
                <span className="waybill-mark"><Truck size={16}/></span>
                <div><b>{shipment.number}</b><small>{date(shipment.date)} · {t('docs.items', { count: fmt((shipment.lines ?? []).length) })}</small></div>
                <span className={`badge ${shipment.status === 'accepted' ? 'badge-healthy' : shipment.status === 'declined' ? 'badge-rejected' : 'badge-in-transit'}`}>{shipment.status === 'accepted' ? t('partners.accepted') : shipment.status === 'declined' ? t('partners.declined') : t('partners.sent')}</span>
                <strong className="waybill-sum">{money(shipment.amount)}</strong>
              </button>
            </header>
            {openShipment === shipment.id && (
              <div className="waybill-scroll"><table className="waybill-table">
                <thead><tr><th>{t('zavod.brand')}</th><th>{t('zavod.factoryCode')}</th><th>{t('zavod.groupCode')}</th><th>{t('zavod.product')}</th><th>{t('zavod.size')}</th><th className="num">{t('zavod.pairs')}</th><th className="num">{t('zavod.pachka')}</th><th className="num">{t('zavod.boxes')}</th><th className="num">{t('zavod.price')}</th><th>{t('zavod.priceType')}</th><th className="waybill-colors-cell">{t('zavod.colors')}</th><th className="num">{t('zavod.sum')}</th><th/></tr></thead>
                <tbody>{(shipment.lines ?? []).map(line => {
                  const colors = mergeColors(line.colors ?? []);
                  const colored = colors.length > 0;
                  return <Fragment key={line.id}>
                    <tr className={colored ? 'has-colors' : undefined}>
                      <WaybillCells line={line} locked={Boolean(shipment.moyskladId)} markup={markup} onSave={patch => saveLine(shipment, line, patch)}/>
                      <td className="waybill-line-tools" data-label="">{!shipment.moyskladId && <><button type="button" className="icon-btn" aria-label={t('partners.edit')} onClick={() => setLineEdit({ shipment, line })}><Pencil size={14}/></button><button type="button" className="icon-btn" aria-label={t('partners.colorAdd')} onClick={() => setColorFor(colorFor === line.id ? null : line.id)}><Plus size={14}/></button><button type="button" className="icon-btn" aria-label={t('partners.delete')} onClick={() => setRemovingLine({ shipment, line })}><Trash2 size={14}/></button></>}</td>
                    </tr>
                    {colored && colorFor !== line.id && <tr className="waybill-color-strip"><td colSpan={13}><div className="color-strip"><em>{t('zavod.colors')}</em><ColorMarks colors={colors} fmt={fmt}/></div></td></tr>}
                    {colorFor === line.id && <tr><td className="waybill-colors" colSpan={13}><LineColors line={line} onSave={async colors => { const ok = await saveLine(shipment, line, { colors }); if (ok) setColorFor(null); return ok; }}/></td></tr>}
                  </Fragment>;
                })}</tbody>
              </table></div>
            )}
            {openShipment === shipment.id && shipment.note && <p className="waybill-note">{shipment.note}</p>}
            {openShipment === shipment.id && shipment.moyskladNumber && <p className="waybill-note">{t('partners.posted', { number: shipment.moyskladNumber })}</p>}
            {openShipment === shipment.id && supplyingId === shipment.id && !shipment.moyskladNumber && <p className="waybill-note">{t('partners.supplyPending')}</p>}
            {openShipment === shipment.id && (
              <div className="waybill-actions">
                <div className="waybill-tools">
                  <WaybillExport shipments={[shipment]} filename={`${row.account?.code || row.name}-${shipment.number}`} title={`${t('zavod.title')} ${shipment.number}`} factory={row.name} code={row.account?.code || ''}/>
                  {!shipment.moyskladId && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(shipment)}><Pencil size={14}/>{t('partners.edit')}</button>}
                  {!shipment.moyskladId && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLineEdit({ shipment, line: blankLine(row.account?.code || shipment.lines[0]?.factoryCode || '') })} data-testid="button-add-waybill-line"><Plus size={14}/>{t('zavod.addRow')}</button>}
                  {!shipment.moyskladId && <button type="button" className="btn btn-ghost btn-sm factory-delete" onClick={() => setRemoving(shipment)}><Trash2 size={14}/>{t('partners.delete')}</button>}
                </div>
                <div className="waybill-decide">
                  {!shipment.moyskladId && shipment.status !== 'declined' && <button type="button" className="btn btn-sm waybill-decline" onClick={() => void setStatus(shipment.id, 'declined')}><X size={15}/>{t('partners.unaccept')}</button>}
                  {!shipment.moyskladId && shipment.status === 'sent' && <button type="button" className="btn btn-primary btn-sm" onClick={() => void setStatus(shipment.id, 'accepted')}><Check size={15}/>{t('partners.accept')}</button>}
                  {!shipment.moyskladId && shipment.status === 'declined' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void setStatus(shipment.id, 'sent')} data-testid="button-reopen-shipment"><Check size={15}/>{t('partners.reopen')}</button>}
                  {!shipment.moyskladId && shipment.status !== 'declined' && <button type="button" className="btn btn-primary btn-sm" disabled={supplyingId === shipment.id} onClick={() => { setPostError(''); setPosting(shipment); }}>{supplyingId === shipment.id ? t('partners.supplyPending') : t('partners.supply')}</button>}
                </div>
              </div>
            )}
          </article>
        ))}</div>
      ) : <p className="muted">{day ? t('partners.noOnDate') : t('partners.noShipments')}</p>}
    </section>
    {(row.productCount > 0 || (products.data?.total ?? products.data?.items?.length ?? 0) > 0) && <section className={`card partner-catalog ${catalogOpen ? 'is-open' : ''}`}>
      <button type="button" className="partner-catalog-toggle" aria-expanded={catalogOpen} onClick={() => setCatalogOpen(open => !open)}>
        <h2>{t('partners.catalog')}</h2>
        <span className="card-meta">{fmt(products.data?.total ?? products.data?.items?.length ?? row.productCount)}</span>
        {catalogOpen ? <ChevronDown size={18}/> : <ChevronUp size={18}/>}
      </button>
      {catalogOpen && <>
        <ul className="partner-products">{(products.data?.items ?? []).map(product => <li key={product.id}><b>{product.name}</b><small>{product.code || product.article || '—'}</small><span>{fmt(product.stock)}</span></li>)}</ul>
        <Link href="/factories" className="link">{t('nav.factories')}</Link>
      </>}
    </section>}
    {posting && createPortal(<div className="backdrop" onClick={() => { if (!busy) setPosting(null); }}><div className="modal" onClick={event => event.stopPropagation()} role="dialog" aria-labelledby="supply-title"><div className="modal-top"><div><p className="eyebrow">{posting.number}</p><h2 id="supply-title">{t('partners.supplyTitle')}</h2></div><button type="button" className="icon-btn" onClick={() => { if (!busy) setPosting(null); }} aria-label={t('common.close')}><X size={18}/></button></div><p>{t('partners.supplyBody', { count: fmt(posting.lines.reduce((sum, line) => sum + receiptParts(line).length, 0)), units: fmt(posting.lines.reduce((sum, line) => sum + receiptParts(line).reduce((inner, part) => inner + part.quantity, 0), 0)) })}</p><ul className="partner-products">{posting.lines.filter(line => lineUnits(line) > 0).flatMap(line => receiptParts(line).map(part => { const mixed = [line.pairs, line.boxes, line.quantity].filter(value => value > 0); const warn = false; return <li key={`${line.id}-${part.color || 'all'}`}><b>{part.color ? `${line.productCode || line.productName || '—'} · ${part.color}` : (line.productName || line.productCode || '—')}</b><small>{t('partners.supplyUnits', { units: fmt(part.quantity) })}{warn ? ` · ${t('partners.supplyMix', { pairs: fmt(line.pairs), boxes: fmt(line.boxes), quantity: fmt(line.quantity) })}` : ''}</small><span>{money(part.quantity * line.price)}</span></li>; }))}</ul>{(warehouses.data?.length ?? 0) > 1 && <label className="field">{t('common.warehouse')}<select className="input" value={storeId} onChange={event => setStoreId(event.target.value)}><option value=""/>{warehouses.data?.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>}<label className="field"><span>{t('partners.counterparty')}</span><input className="input" value={agent ? agent.name : agentQuery} placeholder={t('partners.counterpartySearch')} onChange={event => { setAgent(null); setAgentQuery(event.target.value); }}/>{!agent && agentHits.map(item => <button type="button" key={item.id} className="btn btn-secondary btn-sm" onClick={() => { setAgent(item); setAgentHits([]); }}>{item.name}</button>)}{agent && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAgent(null)}>{t('partners.counterpartyClear')}</button>}</label>{postError && <p className="error-text">{postError}</p>}<div className="form-actions"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void postSupply()}>{busy ? t('partners.supplyPending') : t('partners.supply')}</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setPosting(null)}>{t('common.cancel')}</button></div></div></div>, document.body)}
    {settings && createPortal(<div className="backdrop" onClick={() => setSettings(false)}><div className="modal" onClick={event => event.stopPropagation()} role="dialog" aria-labelledby="partner-settings-title">
      <div className="modal-top"><div><p className="eyebrow">{row.name}</p><h2 id="partner-settings-title">{t('partners.edit')}</h2></div><button type="button" className="icon-btn" onClick={() => setSettings(false)} aria-label={t('common.close')}><X size={18}/></button></div>
      <div className="form-grid">
        <label className="field"><span>{t('partners.name')}</span><input className="input" value={name} onChange={e => setName(e.target.value)} data-testid="input-partner-name"/></label>
        <label className="field"><span>{t('partners.code')}</span><input className="input" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="BOP80" data-testid="input-partner-code"/></label>
        <label className="field"><span>{t('partners.login')}</span><input className="input" value={login} onChange={e => setLogin(e.target.value.toLowerCase())} data-testid="input-partner-login"/></label>
        <label className="field"><span>{t('partners.password')}</span><span className="secret"><input className="input" type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" data-testid="input-partner-password"/><button type="button" className="secret-eye" aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')} onClick={() => setShowPassword(open => !open)}>{showPassword ? <EyeOff size={18}/> : <Eye size={18}/>}</button></span></label>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="portal-link"><span>{t('partners.portal')}</span><code>{portalUrl()}</code><button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy()}><Copy size={14}/>{copied ? t('partners.copied') : t('partners.copy')}</button></div>
      <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={() => setSettings(false)}>{t('common.cancel')}</button><button type="button" className="btn btn-primary" disabled={busy || !name.trim() || !code.trim() || !login.trim()} onClick={() => void saveAccess()} data-testid="button-partner-access"><Pencil size={15}/>{busy ? t('common.saving') : t('partners.edit')}</button></div>
    </div></div>, document.body)}
    {confirmDelete && createPortal(<div className="backdrop" onClick={() => setConfirmDelete(false)}><div className="modal" onClick={event => event.stopPropagation()} role="dialog" aria-labelledby="partner-delete-title">
      <div className="modal-top"><div><p className="eyebrow">{row.name}</p><h2 id="partner-delete-title">{t('partners.deleteTitle')}</h2></div><button type="button" className="icon-btn" onClick={() => setConfirmDelete(false)} aria-label={t('common.close')}><X size={18}/></button></div>
      <p>{t('partners.deleteBody', { name: row.name })}</p>
      {error && <p className="error-text">{error}</p>}
      <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</button><button type="button" className="btn btn-danger" disabled={busy} onClick={() => void removeFactory()} data-testid="button-confirm-delete-partner"><Trash2 size={15}/>{busy ? t('common.saving') : t('partners.delete')}</button></div>
    </div></div>, document.body)}
    {editing && <WaybillEditor shipment={editing} markup={markup} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refreshShipments(); }}/>}
    {lineEdit && <LineEditor shipment={lineEdit.shipment} line={lineEdit.line} creating={!lineEdit.line.id} markup={markup} onClose={() => setLineEdit(null)} onSave={async patch => { const ok = await saveLine(lineEdit.shipment, lineEdit.line, patch); if (ok) setLineEdit(null); return ok; }}/>}
    {removing && createPortal(<div className="backdrop" onClick={() => setRemoving(null)}><div className="modal" onClick={event => event.stopPropagation()} role="dialog" aria-labelledby="shipment-delete-title">
      <div className="modal-top"><div><p className="eyebrow">{removing.number}</p><h2 id="shipment-delete-title">{t('partners.deleteShipment')}</h2></div><button type="button" className="icon-btn" onClick={() => setRemoving(null)} aria-label={t('common.close')}><X size={18}/></button></div>
      <p>{t('partners.deleteShipmentBody', { number: removing.number })}</p>
      {error && <p className="error-text">{error}</p>}
      <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={() => setRemoving(null)}>{t('common.cancel')}</button><button type="button" className="btn btn-danger" disabled={busy} onClick={() => void removeShipment()} data-testid="button-confirm-delete-shipment"><Trash2 size={15}/>{busy ? t('common.saving') : t('partners.delete')}</button></div>
    </div></div>, document.body)}
    {removingLine && createPortal(<div className="backdrop" onClick={() => setRemovingLine(null)}><div className="modal" onClick={event => event.stopPropagation()} role="dialog" aria-labelledby="line-delete-title">
      <div className="modal-top"><div><p className="eyebrow">{removingLine.shipment.number}</p><h2 id="line-delete-title">{t('partners.deleteLine')}</h2></div><button type="button" className="icon-btn" onClick={() => setRemovingLine(null)} aria-label={t('common.close')}><X size={18}/></button></div>
      <p>{t('partners.deleteLineBody', { product: removingLine.line.productCode || removingLine.line.size || removingLine.shipment.number })}</p>
      {error && <p className="error-text">{error}</p>}
      <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={() => setRemovingLine(null)}>{t('common.cancel')}</button><button type="button" className="btn btn-danger" disabled={busy} onClick={() => { const target = removingLine; setRemovingLine(null); void removeLine(target.shipment, target.line); }} data-testid="button-confirm-delete-line"><Trash2 size={15}/>{t('partners.delete')}</button></div>
    </div></div>, document.body)}
  </div>;
}

function LineEditor({ line, creating, markup, onClose, onSave }: { shipment: Shipment; line: Line; creating?: boolean; markup: SaleMarkup; onClose: () => void; onSave: (patch: Partial<Line>) => Promise<boolean> }) {
  const { t, money } = useI18n();
  const [factoryCode, setFactoryCode] = useState(line.factoryCode);
  const [sectionCode, setSectionCode] = useState(line.sectionCode);
  const [productCode, setProductCode] = useState(line.productCode);
  const [size, setSize] = useState(line.size);
  const [pairs, setPairs] = useState(line.pairs ? String(line.pairs) : '');
  const [boxes, setBoxes] = useState(line.boxes ? String(line.boxes) : '');
  const [pachka, setPachka] = useState(line.pachka && line.pachka > 1 ? String(line.pachka) : '');
  const [price, setPrice] = useState(line.price ? String(line.price) : '');
  const [pctMap, setPctMap] = useState<PctMap>(() => pctMapOf(line, markup));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pack = asNumber(pairs);
  const colorBoxes = mergeColors(line.colors ?? []);
  const pieces = pack > 0 && colorBoxes.length ? colorBoxes.reduce((sum, color) => sum + color.quantity * pack, 0) : pack > 0 && asNumber(boxes) > 0 ? pack * asNumber(boxes) : pack;
  const sum = pieces * asNumber(price);
  const fill = async () => {
    const data = await loadPassport({ factory: factoryCode.trim(), code: productCode.trim(), size, group: sectionCode.trim() });
    if (!data) return;
    const extra = fromPassport({ group: sectionCode, size, pack: pairs, price, pachka, markup: pctMap }, data);
    if (extra.sectionCode) setSectionCode(extra.sectionCode);
    if (extra.size) setSize(extra.size);
    if (extra.pairs) setPairs(String(extra.pairs));
    if (extra.pachka) setPachka(String(extra.pachka));
    if (extra.price) setPrice(String(extra.price));
    if (extra.markup) {
      setPctMap(current => {
        const nextMap = { ...current };
        for (const type of PRICE_TYPES) {
          if (extra.markup?.[type] != null) nextMap[type] = String(extra.markup[type]);
        }
        return nextMap;
      });
    }
  };
  const save = async () => {
    if (!productCode.trim() || !sectionCode.trim() || !size.trim()) { setError(t('zavod.needProduct')); return; }
    setBusy(true);
    const typedPachka = asNumber(pachka);
    const ok = await onSave({ factoryCode: codeValue(factoryCode), sectionCode: codeValue(sectionCode), productCode: codeValue(productCode), size: size.trim(), pairs: asNumber(pairs), boxes: asNumber(boxes), pachka: typedPachka > 1 ? typedPachka : (line.pachka && line.pachka > 1 ? line.pachka : typedPachka), price: asNumber(price), markup: parsePctMap(pctMap) });
    setBusy(false);
    if (!ok) setError(t('partners.shipmentInvalid'));
  };
  return createPortal(<div className="backdrop" onClick={onClose}><div className="modal" onClick={event => event.stopPropagation()} role="dialog" aria-labelledby="line-edit-title">
    <div className="modal-top"><div><p className="eyebrow">Bordo</p><h2 id="line-edit-title">{creating ? t('zavod.addRow') : t('partners.edit')}</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label={t('common.close')}><X size={18}/></button></div>
    <div className="form-grid">
      <label className="field"><span>{t('zavod.factoryCode')}</span><input className="input" autoCapitalize="characters" value={factoryCode} onChange={event => setFactoryCode(codeInput(event.target.value))} onBlur={() => void fill()}/></label>
      <label className="field"><span>{t('zavod.groupCode')}</span><input className="input" autoCapitalize="characters" value={sectionCode} onChange={event => setSectionCode(codeInput(event.target.value))} onBlur={() => void fill()}/></label>
      <label className="field"><span>{t('zavod.product')}</span><input className="input" autoCapitalize="characters" value={productCode} onChange={event => setProductCode(codeInput(event.target.value))} onBlur={() => void fill()}/></label>
      <label className="field"><span>{t('zavod.size')}</span><select className="input" value={size} onChange={event => { setSize(event.target.value); void loadPassport({ factory: factoryCode.trim(), code: productCode.trim(), size: event.target.value, group: sectionCode.trim() }).then(data => { if (!data) return; const extra = fromPassport({ group: sectionCode, size: event.target.value, pack: pairs, price, pachka, markup: pctMap }, data); if (extra.sectionCode) setSectionCode(extra.sectionCode); if (extra.pairs) setPairs(String(extra.pairs)); if (extra.pachka) setPachka(String(extra.pachka)); if (extra.price) setPrice(String(extra.price)); if (extra.markup) setPctMap(current => { const nextMap = { ...current }; for (const type of PRICE_TYPES) { if (extra.markup?.[type] != null) nextMap[type] = String(extra.markup[type]); } return nextMap; }); }); }}><option value=""/>{!isBordoSize(size) && size && <option value={size}>{size}</option>}{BORDO_SIZES.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
      <label className="field"><span>{t('zavod.pairs')}</span><input className="input" inputMode="decimal" value={pairs} onChange={event => setPairs(event.target.value)} onBlur={() => void fill()}/></label>
      <label className="field"><span>{t('zavod.pachka')}</span><input className="input" inputMode="numeric" value={pachka} onChange={event => setPachka(event.target.value.replace(/[^\d]/g, ''))}/></label>
      <label className="field"><span>{t('zavod.boxes')}</span><input className="input" inputMode="decimal" value={boxes} onChange={event => setBoxes(event.target.value)}/></label>
      <label className="field"><span>{t('zavod.price')}</span><input className="input" inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} onBlur={() => void fill()}/></label>
      <label className="field span-2"><span>{t('zavod.priceType')}</span><MarkupTriple values={pctMap} onChange={setPctMap}/></label>
      <label className="field"><span>{t('zavod.sum')}</span><input className="input" value={sum ? money(sum) : ''} readOnly/></label>
    </div>
    {error && <p className="error-text">{error}</p>}
    <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? t('common.saving') : creating ? t('zavod.addRow') : t('partners.edit')}</button></div>
  </div></div>, document.body);
}

function WaybillEditor({ shipment, markup, onClose, onSaved }: { shipment: Shipment; markup: SaleMarkup; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useI18n();
  const [date, setDate] = useState(String(shipment.date ?? '').slice(0, 10));
  const [note, setNote] = useState(shipment.note);
  const [lines, setLines] = useState<DraftLine[]>(() => shipment.lines.map(line => draftFrom(line, markup)));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const patch = (key: string, next: Partial<DraftLine>) => setLines(rows => rows.map(row => row.key === key ? { ...row, ...next } : row));
  const fillLine = (line: DraftLine, next?: Partial<DraftLine>) => {
    const merged = { ...line, ...next };
    if (!merged.productCode.trim()) { if (next) patch(line.key, next); return; }
    void loadPassport({ factory: merged.factoryCode.trim(), code: merged.productCode.trim(), size: merged.size, group: merged.sectionCode.trim() }).then(data => {
      if (!data) { if (next) patch(line.key, next); return; }
      const extra = fromPassport({ group: merged.sectionCode, size: merged.size, pack: merged.pairs, price: merged.price, pachka: merged.pachka, markup: merged.markup }, data);
      const nextMarkup = extra.markup ? { ...merged.markup } : null;
      if (nextMarkup && extra.markup) {
        for (const type of PRICE_TYPES) {
          if (extra.markup[type] != null) nextMarkup[type] = String(extra.markup[type]);
        }
      }
      patch(line.key, {
        ...next,
        ...(extra.sectionCode ? { sectionCode: extra.sectionCode } : {}),
        ...(extra.size ? { size: extra.size } : {}),
        ...(extra.pairs ? { pairs: String(extra.pairs) } : {}),
        ...(extra.pachka ? { pachka: String(extra.pachka) } : {}),
        ...(extra.price ? { price: String(extra.price) } : {}),
        ...(nextMarkup ? { markup: nextMarkup } : {}),
      });
    }).catch(() => { if (next) patch(line.key, next); });
  };
  const save = async () => {
    const filled = lines.filter(line => line.productCode.trim() || line.sectionCode || line.model || line.size || line.pairs || line.boxes || line.quantity || line.price);
    if (!filled.length || filled.some(line => asNumber(line.pairs) <= 0 && asNumber(line.boxes) <= 0 && asNumber(line.quantity) <= 0)) {
      setError(t('partners.shipmentInvalid'));
      return;
    }
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/partner-factories/shipments/${shipment.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          note,
          lines: filled.map(line => ({
            factoryCode: codeValue(line.factoryCode),
            sectionCode: codeValue(line.sectionCode),
            id: line.key,
            productCode: codeValue(line.productCode),
            model: line.model,
            size: line.size,
            pairs: asNumber(line.pairs),
            pachka: asNumber(line.pachka),
            boxes: asNumber(line.boxes),
            quantity: asNumber(line.quantity),
            price: asNumber(line.price),
            markup: parsePctMap(line.markup),
            colors: line.colors.filter(color => color.name.trim() && asNumber(color.quantity) > 0).map(color => ({ name: color.name.trim(), quantity: asNumber(color.quantity) })),
          })),
        }),
      });
      if (!response.ok) { setError(t('partners.shipmentInvalid')); return; }
      await onSaved();
    } finally {
      setBusy(false);
    }
  };
  return createPortal(<div className="backdrop" onClick={onClose}><div className="modal waybill-editor" onClick={event => event.stopPropagation()} role="dialog" aria-labelledby="waybill-edit-title">
    <div className="modal-top"><div><p className="eyebrow">{shipment.number}</p><h2 id="waybill-edit-title">{t('partners.editShipment')}</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label={t('common.close')}><X size={18}/></button></div>
    <div className="form-grid">
      <label className="field"><span>{t('common.date')}</span><input className="input" type="date" value={date} onChange={e => setDate(e.target.value)}/></label>
      <label className="field"><span>{t('zavod.note')}</span><input className="input" value={note} onChange={e => setNote(e.target.value)}/></label>
    </div>
    {lines.map((line, index) => <article className="waybill-line" key={line.key}>
      <header><b>{String(index + 1).padStart(2, '0')}</b>{lines.length > 1 && <button type="button" className="icon-btn" onClick={() => setLines(rows => rows.filter(row => row.key !== line.key))} aria-label={t('zavod.remove')}><Trash2 size={15}/></button>}</header>
      <div className="form-grid">
        <label className="field"><span>{t('zavod.factoryCode')}</span><input className="input" autoCapitalize="characters" value={line.factoryCode} onChange={e => patch(line.key, { factoryCode: codeInput(e.target.value) })} onBlur={e => fillLine(line, { factoryCode: codeValue(e.target.value) })}/></label>
        <label className="field"><span>{t('zavod.groupCode')}</span><input className="input" autoCapitalize="characters" value={line.sectionCode} onChange={e => patch(line.key, { sectionCode: codeInput(e.target.value) })} onBlur={e => fillLine(line, { sectionCode: codeValue(e.target.value) })}/></label>
        <label className="field"><span>{t('zavod.product')}</span><input className="input" autoCapitalize="characters" value={line.productCode} onChange={e => patch(line.key, { productCode: codeInput(e.target.value) })} onBlur={e => fillLine(line, { productCode: codeValue(e.target.value) })}/></label>
        <label className="field"><span>{t('zavod.size')}</span><select className="input" value={line.size} onChange={e => fillLine(line, { size: e.target.value })}><option value=""/>{!isBordoSize(line.size) && line.size && <option value={line.size}>{line.size}</option>}{BORDO_SIZES.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
        <label className="field"><span>{t('zavod.pairs')}</span><input className="input" inputMode="decimal" value={line.pairs} onChange={e => patch(line.key, { pairs: e.target.value })} onBlur={e => fillLine(line, { pairs: e.target.value })}/></label>
        <label className="field"><span>{t('zavod.pachka')}</span><input className="input" inputMode="numeric" value={line.pachka} onChange={e => patch(line.key, { pachka: e.target.value.replace(/[^\d]/g, '') })}/></label>
        <label className="field"><span>{t('zavod.boxes')}</span><input className="input" inputMode="decimal" value={line.boxes} onChange={e => patch(line.key, { boxes: e.target.value })}/></label>
        <label className="field"><span>{t('zavod.price')}</span><input className="input" inputMode="decimal" value={line.price} onChange={e => patch(line.key, { price: e.target.value })} onBlur={e => fillLine(line, { price: e.target.value })}/></label>
        <label className="field span-2"><span>{t('zavod.priceType')}</span><MarkupTriple values={line.markup} onChange={next => patch(line.key, { markup: next })}/></label>
      </div>
      <div className="yx-colors">
        <span>{t('zavod.colors')}</span>
        {line.colors.map((color, colorIndex) => <div className="yx-color" key={colorIndex}>
          <input className="input" value={color.name} placeholder={t('zavod.colorName')} autoCapitalize="characters" onChange={e => patch(line.key, { colors: line.colors.map((item, i) => i === colorIndex ? { ...item, name: e.target.value.toLocaleUpperCase('ru-RU') } : item) })}/>
          <input className="input" inputMode="decimal" value={color.quantity} placeholder={t('zavod.colorQty')} onChange={e => patch(line.key, { colors: line.colors.map((item, i) => i === colorIndex ? { ...item, quantity: e.target.value } : item) })}/>
          {line.colors.length > 1 && <button type="button" className="icon-btn" aria-label={t('zavod.remove')} onClick={() => patch(line.key, { colors: line.colors.filter((_, i) => i !== colorIndex) })}><X size={14}/></button>}
        </div>)}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => patch(line.key, { colors: [...line.colors, { name: '', quantity: '' }] })}><Plus size={14}/>{t('zavod.addColor')}</button>
      </div>
    </article>)}
    <button type="button" className="btn btn-secondary" onClick={() => setLines(rows => [...rows, blankDraft(markup)])}><Plus size={15}/>{t('zavod.addRow')}</button>
    {error && <p className="error-text">{error}</p>}
    <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()} data-testid="button-save-shipment"><Pencil size={15}/>{busy ? t('common.saving') : t('partners.edit')}</button></div>
  </div></div>, document.body);
}
