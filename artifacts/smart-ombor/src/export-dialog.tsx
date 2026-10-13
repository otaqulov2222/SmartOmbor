import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownLeft, ArrowLeftRight, BarChart3, Boxes, CalendarDays, ClipboardCheck, ClipboardList, Clock3, Download, Factory, FileSpreadsheet, FileText, LayoutDashboard, Package, Repeat, ShieldCheck, Sparkles, Warehouse, X } from 'lucide-react';
import { useI18n, type TKey } from '@/i18n';
import { downloadReportPdf } from '@/lib/pdf';
import { downloadXlsx } from '@/lib/xlsx';
import {
  KIND_META, buildReport, fileStamp, formatCell,
  type BuiltReport, type ExportFormat, type ExportKind, type Period,
} from '@/lib/report';

const PERIODS: Period[] = ['today', 'days7', 'thisMonth', 'all'];
const PERIOD_LABEL: Record<Period, TKey> = {
  today: 'period.daily',
  days7: 'period.weekly',
  thisMonth: 'period.monthly',
  all: 'period.all',
};

export function ExportDialog({ kind, defaultPeriod = 'all', onClose }: { kind: ExportKind; defaultPeriod?: Period; onClose: () => void }) {
  const { t, lang, fmt } = useI18n();
  const supportsPeriod = KIND_META[kind].period;
  const [period, setPeriod] = useState<Period>(supportsPeriod ? defaultPeriod : 'all');
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<BuiltReport | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    setBusy(true); setError(''); setPreview(null);
    buildReport(kind, period, lang).then(report => { if (live) setPreview(report); }).catch(() => { if (live) setError(t('export.failed')); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [kind, period, lang, t]);

  const run = () => {
    if (!preview) return;
    setError('');
    try {
      if (preview.rowCount === 0) { setError(t('export.noRows')); return; }
      if (format === 'xlsx') {
        downloadXlsx(`smart-ombor-${kind}-${fileStamp()}.xlsx`, preview.sheets);
        return;
      }
      setBusy(true);
      downloadReportPdf(`smart-ombor-${kind}-${fileStamp()}.pdf`, preview, lang).catch(() => setError(t('export.failed'))).finally(() => setBusy(false));
    } catch {
      setError(t('export.failed'));
    }
  };

  return createPortal(
    <div className="backdrop" onClick={onClose} data-testid="export-backdrop">
      <div className="modal export-modal" onClick={e => e.stopPropagation()} role="dialog" aria-labelledby="export-title">
        <div className="modal-top"><div><p className="eyebrow">{t('export.title')}</p><h2 id="export-title">{t(KIND_META[kind].title)}</h2></div><button className="icon-btn" onClick={onClose} aria-label={t('common.close')} data-testid="button-export-close"><X size={18}/></button></div>
        {supportsPeriod && <div className="export-block"><span className="export-label"><CalendarDays size={14}/>{t('export.period')}</span><div className="seg">{PERIODS.map(p => <button key={p} type="button" className={period === p ? 'is-active' : ''} onClick={() => setPeriod(p)} data-testid={`export-period-${p}`}>{t(PERIOD_LABEL[p])}</button>)}</div></div>}
        <div className="format-grid">
          <button type="button" className={`format-card ${format === 'xlsx' ? 'is-active' : ''}`} onClick={() => setFormat('xlsx')} data-testid="export-format-xlsx"><FileSpreadsheet size={22}/><span><b>{t('export.excel')}</b><small>{t('export.excel.note')}</small></span></button>
          <button type="button" className={`format-card ${format === 'pdf' ? 'is-active' : ''}`} onClick={() => setFormat('pdf')} data-testid="export-format-pdf"><FileText size={22}/><span><b>{t('export.pdf')}</b><small>{t('export.pdf.note')}</small></span></button>
        </div>
        <p className="export-count">{busy ? t('export.preparing') : preview ? t('export.rows', { count: fmt(preview.rowCount) }) : '—'}</p>
        {preview && preview.sheets[0] && preview.sheets[0].rows.length > 0 && <div className="export-preview"><div className="export-table-wrap"><table><thead><tr>{preview.sheets[0].headers.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{preview.sheets[0].rows.slice(0, 6).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{formatCell(lang, cell)}</td>)}</tr>)}</tbody></table></div></div>}
        {error && <p className="error-text">{error}</p>}
        <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button type="button" className="btn btn-primary" disabled={busy || !preview} onClick={run} data-testid="button-export-confirm"><Download size={16}/>{busy ? t('export.preparing') : format === 'xlsx' ? t('export.saveExcel') : t('export.printPdf')}</button></div>
      </div>
    </div>,
    document.body,
  );
}

export function ExportButton({ kind, defaultPeriod, testId }: { kind: ExportKind; defaultPeriod?: Period; testId?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)} data-testid={testId || `button-export-${kind}`}><Download size={15}/>{t('common.export')}</button>
    {open && <ExportDialog kind={kind} defaultPeriod={defaultPeriod} onClose={() => setOpen(false)}/>}
  </>;
}

const REPORT_GROUPS: { label: TKey; ids: ExportKind[] }[] = [
  { label: 'reports.group.summary', ids: ['dashboard', 'sales'] },
  { label: 'reports.group.catalog', ids: ['products', 'stock', 'warehouses', 'factories'] },
  { label: 'reports.group.docs', ids: ['receipts', 'transfers', 'inventory', 'documents'] },
  { label: 'reports.group.analysis', ids: ['nonMoving', 'branches', 'recommendations'] },
  { label: 'reports.group.system', ids: ['audit', 'tasks'] },
];
const REPORT_ICON: Record<ExportKind, typeof FileText> = {
  dashboard: LayoutDashboard, products: Package, stock: Boxes, warehouses: Warehouse,
  receipts: ArrowDownLeft, transfers: ArrowLeftRight, inventory: ClipboardCheck, documents: FileText,
  sales: BarChart3, nonMoving: Clock3, factories: Factory, branches: Repeat,
  recommendations: Sparkles, audit: ShieldCheck, tasks: ClipboardList,
};
export function ReportsHub() {
  const { t } = useI18n();
  const [kind, setKind] = useState<ExportKind>('dashboard');
  const [open, setOpen] = useState(false);
  const Icon = REPORT_ICON[kind];
  return <>
    <div className="report-hub">
      <section className="card report-list"><h2>{t('reports.choose')}</h2><div className="report-options">{REPORT_GROUPS.map(group => <div className="report-group" key={group.label}><p>{t(group.label)}</p>{group.ids.map(id => { const ItemIcon = REPORT_ICON[id]; return <button key={id} type="button" className={`option ${kind === id ? 'is-active' : ''}`} onClick={() => setKind(id)} data-testid={`select-report-${id}`}><span className="option-icon"><ItemIcon size={18}/></span><span className="option-copy"><b>{t(KIND_META[id].title)}</b><small>{t(KIND_META[id].detail)}</small></span><span className="radio"/></button>; })}</div>)}</div></section>
      <aside className="card preview">
        <div className="report-side-head"><span className="option-icon"><Icon size={20}/></span><div><p className="eyebrow">{t('reports.preview')}</p><h2>{t(KIND_META[kind].title)}</h2></div></div>
        <p className="report-side-copy">{t(KIND_META[kind].detail)}</p>
        <div className="facts">
          <div><span>{t('export.format')}</span><b>Excel · PDF</b></div>
          <div><span>{t('export.period')}</span><b>{KIND_META[kind].period ? t('reports.periods') : t('export.snapshot')}</b></div>
        </div>
        <div className="form-actions"><button type="button" className="btn btn-primary" onClick={() => setOpen(true)} data-testid="button-export-report"><Download size={16}/>{t('common.export')}</button></div>
      </aside>
    </div>
    {open && <ExportDialog kind={kind} defaultPeriod={KIND_META[kind].period ? 'today' : 'all'} onClose={() => setOpen(false)}/>}
  </>;
}
