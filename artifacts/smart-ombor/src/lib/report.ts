import { formatDate, formatDateTime, formatMoney, formatNumber, translate, type Lang, type TKey } from '@/i18n';
import type { Cell, Sheet } from '@/lib/xlsx';

export type ExportKind =
  | 'dashboard' | 'products' | 'stock' | 'warehouses' | 'receipts' | 'transfers'
  | 'inventory' | 'documents' | 'sales' | 'nonMoving' | 'factories' | 'branches' | 'recommendations'
  | 'audit' | 'tasks';

export type Period = 'today' | 'days7' | 'thisMonth' | 'all';
export type ExportFormat = 'xlsx' | 'pdf';

export const PERIOD_KINDS: ExportKind[] = ['dashboard', 'receipts', 'transfers', 'inventory', 'documents', 'sales', 'audit', 'tasks'];

type Product = {
  id: string; name: string; code: string | null; article: string | null; barcodes: string[];
  factory: string | null; category: string | null; unit: string | null; stock: number; available: number;
  cost: number | null; salePrice: number | null; lastSale: string | null; lastReceipt: string | null;
  sales7: number; sales30: number; daysCover: number | null; stockStatus: string; inTransit: number;
};
type Warehouse = { id: string; name: string; code: string | null; address: string | null };
type Document = {
  id: string; kind: string; number: string; date: string; status: string;
  sourceWarehouse: string | null; targetWarehouse: string | null; itemCount: number; total?: number | null;
};
type StockFlat = {
  productId: string; warehouseId: string; warehouseName: string; warehouseCode: string | null;
  quantity: number; inTransit: number; value: number | null;
};
type CatalogDump = {
  companyName: string | null; loadedAt: string; productCount: number;
  salesToday: number; incomingToday: number; pendingTransfers: number;
  products: Product[]; warehouses: Warehouse[]; documents: Document[]; stockRows: StockFlat[];
};
type WarehouseTotal = { id: string; name: string; units: number; products: number; inTransit: number; value: number };
type Dashboard = {
  productCount: number; stockUnits: number; stockValue: number; salesToday: number;
  lowStockCount: number; nonMovingCount: number; pendingTransfers: number; incomingToday: number; lastSync: string | null;
};
type Sales = { period: string; totalAmount: number; totalQuantity: number; averagePerDay: number; trend: { date: string; amount: number; quantity: number }[]; topProducts: Product[] };
type Reco = { product: Product; onHand: number; inTransit: number; dailyAverage: number; leadTimeDays: number; safetyStock: number; suggestedQuantity: number; reason: string };

export type BuiltReport = {
  title: string;
  periodLabel: string;
  generatedAt: string;
  source: string;
  sheets: Sheet[];
  rowCount: number;
};

const t = (lang: Lang, key: TKey, vars?: Record<string, string | number>) => translate(lang, key, vars);
const money = (lang: Lang, n: number | null | undefined) => formatMoney(lang, n);
const n = (v: number | null | undefined, d = 0) => formatNumber(v, d);
const pcs = (lang: Lang, unit?: string | null) => {
  if (!unit) return '';
  return /^(шт\.?|шт)$/i.test(unit.trim()) ? t(lang, 'common.pcs') : unit.trim();
};
const status = (lang: Lang, value: string) => {
  const key = (value === 'low' ? 'status.low' : `status.${value}`) as TKey;
  const label = t(lang, key);
  return label === key ? value : label;
};
const kindLabel = (lang: Lang, kind: string) => {
  const key = `doc.${kind}` as TKey;
  const label = t(lang, key);
  return label === key ? kind : label;
};

function dayStart(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function dayEnd(d: Date) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

export function periodRange(period: Period): { from: Date; to: Date } | null {
  const now = new Date();
  const to = dayEnd(now);
  if (period === 'all') return null;
  if (period === 'today') return { from: dayStart(now), to };
  if (period === 'days7') {
    const from = dayStart(now);
    from.setDate(from.getDate() - 6);
    return { from, to };
  }
  const from = dayStart(now);
  from.setDate(1);
  return { from, to };
}

export function inPeriod(iso: string | null | undefined, period: Period) {
  const range = periodRange(period);
  if (!range) return true;
  if (!iso) return false;
  const d = new Date(iso);
  return d >= range.from && d <= range.to;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json() as T;
  } catch {
    return null;
  }
}

let catalogCache: { at: number; data: CatalogDump } | null = null;

export async function loadCatalogDump(force = false): Promise<CatalogDump> {
  if (!force && catalogCache && Date.now() - catalogCache.at < 60_000) return catalogCache.data;
  const data = await getJson<CatalogDump>('/api/export/catalog');
  if (!data) throw new Error('catalog');
  catalogCache = { at: Date.now(), data };
  return data;
}

export function clearCatalogDump() { catalogCache = null; }

function sheet(name: string, headers: string[], rows: Cell[][]): Sheet {
  return { name, headers, rows };
}

export const KIND_META: Record<ExportKind, { title: TKey; detail: TKey; period: boolean }> = {
  dashboard: { title: 'report.daily', detail: 'reports.line.dashboard', period: true },
  products: { title: 'report.products', detail: 'reports.line.products', period: false },
  stock: { title: 'report.stock', detail: 'reports.line.stock', period: false },
  warehouses: { title: 'report.warehouses', detail: 'reports.line.warehouses', period: false },
  receipts: { title: 'report.receipts', detail: 'reports.line.receipts', period: true },
  transfers: { title: 'report.transfers', detail: 'reports.line.transfers', period: true },
  inventory: { title: 'report.inventory', detail: 'reports.line.inventory', period: true },
  documents: { title: 'report.documents', detail: 'reports.line.documents', period: true },
  sales: { title: 'report.sales', detail: 'reports.line.sales', period: true },
  nonMoving: { title: 'report.nonMoving', detail: 'reports.line.nonMoving', period: false },
  factories: { title: 'report.factories', detail: 'reports.line.factories', period: false },
  branches: { title: 'report.branches', detail: 'reports.line.branches', period: false },
  recommendations: { title: 'report.recommendations', detail: 'reports.line.recommendations', period: false },
  audit: { title: 'report.audit', detail: 'reports.line.audit', period: true },
  tasks: { title: 'report.tasks', detail: 'reports.line.tasks', period: true },
};

function productRow(lang: Lang, p: Product): Cell[] {
  return [
    p.name, p.code || '', p.article || '', p.factory || '', p.category || '', pcs(lang, p.unit),
    p.stock, p.available, p.inTransit, p.cost, p.salePrice, p.daysCover, p.sales30,
    status(lang, p.stockStatus), formatDate(p.lastSale), formatDate(p.lastReceipt), (p.barcodes || []).join(', '),
  ];
}
function productHeaders(lang: Lang) {
  return [
    t(lang, 'col.name'), t(lang, 'col.code'), t(lang, 'col.article'), t(lang, 'col.factory'), t(lang, 'col.category'), t(lang, 'col.unit'),
    t(lang, 'products.col.stock'), t(lang, 'products.col.available'), t(lang, 'stock.col.inTransit'), t(lang, 'col.cost'), t(lang, 'col.price'),
    t(lang, 'col.daysCover'), t(lang, 'col.sales30'), t(lang, 'common.status'), t(lang, 'col.lastSale'), t(lang, 'col.lastReceipt'), t(lang, 'col.barcodes'),
  ];
}
function docHeaders(lang: Lang, kind?: string) {
  const from = kind === 'receipt' ? 'docs.col.supplier' : 'docs.col.from';
  const to = kind === 'receipt' ? 'docs.col.warehouse' : 'docs.col.to';
  return [t(lang, 'common.number'), t(lang, 'col.kind'), t(lang, 'common.date'), t(lang, 'common.status'), t(lang, from), t(lang, to), t(lang, 'docs.col.items'), t(lang, 'docs.col.sum')];
}
function docRow(lang: Lang, d: Document): Cell[] {
  return [d.number, kindLabel(lang, d.kind), formatDate(d.date), status(lang, d.status), d.sourceWarehouse || '', d.targetWarehouse || '', d.itemCount, d.total ?? ''];
}

export async function buildReport(kind: ExportKind, period: Period, lang: Lang): Promise<BuiltReport> {
  const catalog = await loadCatalogDump();
  const productMap = new Map(catalog.products.map(p => [p.id, p]));
  const periodLabel = KIND_META[kind].period ? t(lang, `period.${period}` as TKey) : t(lang, 'export.snapshot');
  const title = t(lang, KIND_META[kind].title);
  const sheets: Sheet[] = [];

  const docsOf = (k?: string) => catalog.documents.filter(d => (!k || d.kind === k) && inPeriod(d.date, period));

  if (kind === 'dashboard') {
    const dash = await getJson<Dashboard>('/api/dashboard');
    const warehouses = await getJson<WarehouseTotal[]>('/api/dashboard/warehouses') || [];
    const sales = await getJson<Sales>('/api/analytics/sales?period=7d');
    const kpiRows: Cell[][] = dash ? [
      [t(lang, 'dash.kpi.products'), dash.productCount, t(lang, 'dash.kpi.products.note')],
      [t(lang, 'dash.kpi.units'), dash.stockUnits, t(lang, 'dash.kpi.units.note', { count: warehouses.length })],
      [t(lang, 'dash.kpi.value'), dash.stockValue, t(lang, 'dash.kpi.value.note')],
      [t(lang, 'dash.kpi.sales'), dash.salesToday, t(lang, 'dash.kpi.sales.note')],
      [t(lang, 'dash.attention.low'), dash.lowStockCount, t(lang, 'dash.attention.low.note')],
      [t(lang, 'dash.attention.idle'), dash.nonMovingCount, t(lang, 'dash.attention.idle.note')],
      [t(lang, 'dash.attention.transfers'), dash.pendingTransfers, t(lang, 'dash.attention.transfers.note')],
      [t(lang, 'dash.attention.incoming'), dash.incomingToday, t(lang, 'dash.attention.incoming.note')],
    ] : [];
    sheets.push(sheet(t(lang, 'report.kpi'), [t(lang, 'col.indicator'), t(lang, 'col.result'), t(lang, 'col.description')], kpiRows));
    sheets.push(sheet(t(lang, 'report.warehouses'), [t(lang, 'common.warehouse'), t(lang, 'col.units'), t(lang, 'col.productsCount'), t(lang, 'stock.col.inTransit'), t(lang, 'col.value')],
      warehouses.map(w => [w.name, w.units, w.products, w.inTransit, w.value])));
    const todayDocs = catalog.documents.filter(d => inPeriod(d.date, period === 'all' ? 'today' : period));
    sheets.push(sheet(t(lang, 'dash.docs'), docHeaders(lang), todayDocs.map(d => docRow(lang, d))));
    if (sales) {
      sheets.push(sheet(t(lang, 'report.trend'), [t(lang, 'common.date'), t(lang, 'col.amount'), t(lang, 'common.quantity')], sales.trend.map(x => [formatDate(x.date), x.amount, x.quantity])));
    }
  } else if (kind === 'products') {
    sheets.push(sheet(t(lang, 'report.products'), productHeaders(lang), catalog.products.map(p => productRow(lang, p))));
  } else if (kind === 'stock') {
    sheets.push(sheet(t(lang, 'report.stock'), [
      t(lang, 'col.name'), t(lang, 'col.code'), t(lang, 'common.warehouse'), t(lang, 'col.warehouseCode'),
      t(lang, 'stock.col.quantity'), t(lang, 'stock.col.inTransit'), t(lang, 'col.value'), t(lang, 'common.status'),
    ], catalog.stockRows.map(row => {
      const p = productMap.get(row.productId);
      return [p?.name || row.productId, p?.code || p?.article || '', row.warehouseName, row.warehouseCode || '', row.quantity, row.inTransit, row.value, p ? status(lang, p.stockStatus) : ''];
    })));
  } else if (kind === 'warehouses') {
    const warehouses = await getJson<WarehouseTotal[]>('/api/dashboard/warehouses') || [];
    sheets.push(sheet(t(lang, 'report.warehouses'), [t(lang, 'common.warehouse'), t(lang, 'col.units'), t(lang, 'col.productsCount'), t(lang, 'stock.col.inTransit'), t(lang, 'col.value')],
      warehouses.map(w => [w.name, w.units, w.products, w.inTransit, w.value])));
  } else if (kind === 'receipts' || kind === 'transfers' || kind === 'inventory' || kind === 'documents') {
    const map = { receipts: 'receipt', transfers: 'transfer', inventory: 'inventory', documents: undefined } as const;
    const rows = docsOf(map[kind]);
    sheets.push(sheet(title, docHeaders(lang, map[kind]), rows.map(d => docRow(lang, d))));
  } else if (kind === 'sales') {
    const apiPeriod = period === 'today' || period === 'days7' ? '7d' : period === 'thisMonth' ? '30d' : '90d';
    const sales = await getJson<Sales>(`/api/analytics/sales?period=${apiPeriod}`);
    if (sales) {
      sheets.push(sheet(t(lang, 'export.summary'), [t(lang, 'col.indicator'), t(lang, 'col.result')], [
        [t(lang, 'analytics.total'), sales.totalAmount],
        [t(lang, 'analytics.qty'), sales.totalQuantity],
        [t(lang, 'analytics.avg'), sales.averagePerDay],
      ]));
      sheets.push(sheet(t(lang, 'report.trend'), [t(lang, 'common.date'), t(lang, 'col.amount'), t(lang, 'common.quantity')], sales.trend.map(x => [formatDate(x.date), x.amount, x.quantity])));
      sheets.push(sheet(t(lang, 'report.topProducts'), [t(lang, 'col.name'), t(lang, 'col.code'), t(lang, 'col.sales30'), t(lang, 'col.price')],
        sales.topProducts.map(p => [p.name, p.code || p.article || '', p.sales30, p.salePrice])));
    }
  } else if (kind === 'nonMoving') {
    type Idle = Product & { sales7?: number; sales90?: number };
    const loaded = await getJson<Idle[]>('/api/analytics/non-moving?days=30');
    const items = loaded ?? catalog.products.filter(product => product.stock > 0 && (product.daysCover ?? 0) >= 30);
    const sorted = items.slice().sort((a, b) => (b.stock * (b.salePrice ?? 0)) - (a.stock * (a.salePrice ?? 0)) || b.stock - a.stock);
    const windowDays = (product: Idle) => product.sales30 > 0 ? 7 : (product.sales90 ?? 0) > 0 ? 30 : 90;
    sheets.push(sheet(t(lang, 'report.nonMoving'), [
      t(lang, 'common.product'), t(lang, 'col.code'), t(lang, 'idle.col.stock'), t(lang, 'idle.col.value'),
      t(lang, 'idle.col.d7'), t(lang, 'idle.col.d30'), t(lang, 'idle.col.d90'), t(lang, 'idle.col.window'),
    ], sorted.map(product => [
      product.name, product.code || product.article || '', product.stock, Math.round(product.stock * (product.salePrice ?? 0)),
      product.sales7 ?? 0, product.sales30, product.sales90 ?? 0, t(lang, 'idle.window', { days: windowDays(product) }),
    ])));
  } else if (kind === 'factories') {
    const grouped = new Map<string, { count: number; stock: number }>();
    for (const p of catalog.products) {
      const name = p.factory || t(lang, 'factories.unknown');
      const cur = grouped.get(name) || { count: 0, stock: 0 };
      cur.count++; cur.stock += p.stock; grouped.set(name, cur);
    }
    sheets.push(sheet(t(lang, 'report.factories'), [t(lang, 'col.factory'), t(lang, 'col.productsCount'), t(lang, 'col.units')],
      [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, d]) => [name, d.count, d.stock])));
  } else if (kind === 'branches') {
    type Move = { name: string; code: string | null; fromWarehouse: string; toWarehouse: string; fromQuantity: number; toQuantity: number; suggestedQuantity: number; dailyAverage: number };
    const body = await getJson<{ items: Move[] }>('/api/analytics/rebalance');
    const items = body?.items ?? [];
    sheets.push(sheet(t(lang, 'report.branches'), [
      t(lang, 'common.product'), t(lang, 'col.code'), t(lang, 'branch.col.from'), t(lang, 'branch.col.to'),
      t(lang, 'branch.col.fromQty'), t(lang, 'branch.col.toQty'), t(lang, 'branch.col.move'), t(lang, 'reco.col.perDay'),
    ], items.map(row => [row.name, row.code || '', row.fromWarehouse, row.toWarehouse, row.fromQuantity, row.toQuantity, row.suggestedQuantity, row.dailyAverage])));
  } else if (kind === 'recommendations') {
    const items = await getJson<Reco[]>('/api/analytics/recommendations') || [];
    sheets.push(sheet(t(lang, 'report.recommendations'), [
      t(lang, 'col.name'), t(lang, 'col.code'), t(lang, 'col.onHand'), t(lang, 'stock.col.inTransit'), t(lang, 'col.perDay'), t(lang, 'col.leadTime'), t(lang, 'col.suggested'), t(lang, 'col.reason'),
    ], items.map(r => {
      const windowDays = r.product.sales30 > 0 ? 30 : 7;
      const sold = windowDays === 30 ? r.product.sales30 : r.product.sales7;
      const daily = sold / windowDays;
      const cover = daily > 0 ? Math.round((r.onHand / daily) * 10) / 10 : 0;
      const reason = `${t(lang, 'reco.fact.sold', { days: windowDays, sold })}. ${t(lang, 'reco.fact.need', { stock: r.onHand, transit: r.inTransit, cover, days: r.leadTimeDays, need: r.safetyStock, order: r.suggestedQuantity })}`;
      return [r.product.name, r.product.code || r.product.article || '', r.onHand, r.inTransit, r.dailyAverage, r.leadTimeDays, r.suggestedQuantity, reason];
    })));
  } else if (kind === 'audit') {
    const items = await getJson<Array<{ id: string; createdAt: string; action: string; entityType: string; entityId: string | null; actor: string; details: string | null }>>('/api/audit') || [];
    const rows = items.filter(e => inPeriod(e.createdAt, period));
    sheets.push(sheet(t(lang, 'report.audit'), [t(lang, 'audit.col.time'), t(lang, 'common.action'), t(lang, 'audit.col.object'), t(lang, 'audit.col.actor'), t(lang, 'audit.col.details')],
      rows.map(e => [formatDateTime(e.createdAt), e.action, `${e.entityType} ${e.entityId || ''}`.trim(), e.actor, e.details || ''])));
  } else if (kind === 'tasks') {
    const items = await getJson<Array<{ id: string; title: string; description: string | null; status: string; priority: string; assignedTo: string | null; dueDate: string | null }>>('/api/tasks') || [];
    sheets.push(sheet(t(lang, 'report.tasks'), [t(lang, 'tasks.name'), t(lang, 'common.status'), t(lang, 'col.priority'), t(lang, 'col.assignee'), t(lang, 'col.dueDate'), t(lang, 'col.description')],
      items.map(x => [x.title, status(lang, x.status), status(lang, x.priority), x.assignedTo || '', formatDate(x.dueDate), x.description || ''])));
  }

  const rowCount = sheets.reduce((sum, s) => sum + s.rows.length, 0);
  return {
    title,
    periodLabel,
    generatedAt: formatDateTime(new Date()),
    source: catalog.companyName || 'MoySklad',
    sheets,
    rowCount,
  };
}

export function fileStamp() {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatCell(lang: Lang, value: Cell) {
  if (value == null || value === '') return '—';
  if (typeof value === 'number') {
    if (Math.abs(value) >= 1000 && Number.isInteger(value)) return n(value);
    if (!Number.isInteger(value)) return n(value, 2);
    return n(value);
  }
  return String(value);
}

export { money, n };
