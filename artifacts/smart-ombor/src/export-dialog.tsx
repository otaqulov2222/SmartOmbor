import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, Download, FileSpreadsheet, FileText, X } from 'lucide-react';
import { useI18n, type TKey } from '@/i18n';
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

function escHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function openPdf(report: BuiltReport, lang: string, hint: string, footer: string) {
  const sheetsHtml = report.sheets.map(sheet => {
    const head = sheet.headers.map(h => `<th>${escHtml(h)}</th>`).join('');
    const body = sheet.rows.map(row => `<tr>${row.map(cell => `<td>${escHtml(formatCell(lang as 'uz' | 'ru', cell))}</td>`).join('')}</tr>`).join('');
    return `<section><h2>${escHtml(sheet.name)}</h2><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
  }).join('');
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"/><title>${escHtml(report.title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 12px/1.45 Inter, Segoe UI, sans-serif; color: #0f1b2d; background: #fff; }
  .page { max-width: 980px; margin: 0 auto; padding: 28px 32px 48px; }
  header { display: flex; justify-content: space-between; gap: 16px; border-bottom: 2px solid #2f54eb; padding-bottom: 16px; margin-bottom: 22px; }
  .brand { font-weight: 800; font-size: 18px; letter-spacing: -.02em; }
  .brand span { color: #2f54eb; }
  h1 { margin: 4px 0 0; font-size: 22px; }
  .meta { text-align: right; color: #64748b; font-size: 12px; }
  .meta b { color: #0f1b2d; font-weight: 600; }
  h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #2f54eb; margin: 22px 0 8px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th, td { border: 1px solid #e4e8ee; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f5f7fa; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: #64748b; }
  td { font-variant-numeric: tabular-nums; }
  tr:nth-child(even) td { background: #fafbfc; }
  footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #e4e8ee; color: #94a3b8; font-size: 11px; }
  .hint { position: sticky; top: 0; background: #0f172a; color: #fff; padding: 10px 16px; font-size: 13px; display: flex; justify-content: space-between; gap: 12px; }
  .hint button { background: #2f54eb; color: #fff; border: 0; border-radius: 8px; padding: 6px 12px; font-weight: 600; cursor: pointer; }
  @media print { .hint { display: none; } body { background: #fff; } .page { padding: 0; max-width: none; } }
</style></head><body>
<div class="hint"><span>${escHtml(hint)}</span><button onclick="window.print()">PDF</button></div>
<div class="page">
<header><div><div class="brand">Smart <span>Ombor</span></div><h1>${escHtml(report.title)}</h1></div>
<div class="meta"><div><b>${escHtml(report.periodLabel)}</b></div><div>${escHtml(report.generatedAt)}</div><div>${escHtml(report.source)}</div></div></header>
${sheetsHtml}
<footer>${escHtml(footer)}</footer>
</div>
<script>setTimeout(() => window.print(), 350);</script>
</body></html>`;
  const w = window.open('', '_blank', 'noopener,width=1100,height=800');
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  return true;
}

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
      if (format === 'xlsx') {
        if (preview.rowCount === 0) { setError(t('export.noRows')); return; }
        downloadXlsx(`smart-ombor-${kind}-${fileStamp()}.xlsx`, preview.sheets);
      } else {
        const ok = openPdf(preview, lang, t('export.pdfHint'), t('export.footer'));
        if (!ok) setError(t('export.failed'));
      }
    } catch {
      setError(t('export.failed'));
    }
  };

  return createPortal(
    <div className="backdrop" onClick={onClose} data-testid="export-backdrop">
      <div className="modal export-modal" onClick={e => e.stopPropagation()} role="dialog" aria-labelledby="export-title">
        <div className="modal-top"><div><p className="eyebrow">{t('export.title')}</p><h2 id="export-title">{t(KIND_META[kind].title)}</h2></div><button className="icon-btn" onClick={onClose} aria-label={t('common.close')} data-testid="button-export-close"><X size={18}/></button></div>
        <p className="muted export-lead">{t(KIND_META[kind].detail)}</p>
        {supportsPeriod ? <div className="export-block"><span className="export-label"><CalendarDays size={14}/>{t('export.period')}</span><div className="seg">{PERIODS.map(p => <button key={p} type="button" className={period === p ? 'is-active' : ''} onClick={() => setPeriod(p)} data-testid={`export-period-${p}`}>{t(PERIOD_LABEL[p])}</button>)}</div><small className="muted">{t('reports.period.hint')}</small></div>
          : <div className="export-note">{t('export.snapshot.note')}</div>}
        <div className="export-block"><span className="export-label">{t('export.format')}</span><div className="format-grid">
          <button type="button" className={`format-card ${format === 'xlsx' ? 'is-active' : ''}`} onClick={() => setFormat('xlsx')} data-testid="export-format-xlsx"><FileSpreadsheet size={20}/><b>{t('export.excel')}</b><small>{t('export.excel.note')}</small></button>
          <button type="button" className={`format-card ${format === 'pdf' ? 'is-active' : ''}`} onClick={() => setFormat('pdf')} data-testid="export-format-pdf"><FileText size={20}/><b>{t('export.pdf')}</b><small>{t('export.pdf.note')}</small></button>
        </div></div>
        <div className="export-facts">
          <div><span>{t('export.rowsLabel')}</span><b>{busy ? '…' : preview ? fmt(preview.rowCount) : '—'}</b></div>
          <div><span>{t('export.period')}</span><b>{supportsPeriod ? t(PERIOD_LABEL[period]) : t('export.snapshot')}</b></div>
          <div><span>{t('export.source')}</span><b>{preview?.source || 'MoySklad'}</b></div>
        </div>
        {preview && preview.sheets[0] && preview.sheets[0].rows.length > 0 && <div className="export-preview"><p className="eyebrow">{t('reports.preview.table', { count: Math.min(6, preview.sheets[0].rows.length) })}</p><div className="export-table-wrap"><table><thead><tr>{preview.sheets[0].headers.slice(0, 6).map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{preview.sheets[0].rows.slice(0, 6).map((row, i) => <tr key={i}>{row.slice(0, 6).map((cell, j) => <td key={j}>{formatCell(lang, cell)}</td>)}</tr>)}</tbody></table></div></div>}
        {error && <p className="error-text">{error}</p>}
        <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button type="button" className="btn btn-primary" disabled={busy || !preview} onClick={run} data-testid="button-export-confirm"><Download size={16}/>{busy ? t('export.preparing') : format === 'xlsx' ? t('export.excel') : t('export.printPdf')}</button></div>
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

export function ReportsHub() {
  const { t } = useI18n();
  const kinds = useMemo(() => Object.keys(KIND_META) as ExportKind[], []);
  const [kind, setKind] = useState<ExportKind>('dashboard');
  const [open, setOpen] = useState(false);
  return <>
    <div className="report-hub">
      <section className="card"><h2>{t('reports.choose')}</h2><div className="options report-options">{kinds.map(id => <button key={id} type="button" className={`option ${kind === id ? 'is-active' : ''}`} onClick={() => setKind(id)} data-testid={`select-report-${id}`}><span className="option-icon"><FileText size={18}/></span><span className="option-copy"><b>{t(KIND_META[id].title)}</b><small>{t(KIND_META[id].detail)}</small></span><span className="radio"/></button>)}</div></section>
      <aside className="card preview">
        <p className="eyebrow">{t('reports.preview')}</p>
        <h2>{t(KIND_META[kind].title)}</h2>
        <p className="muted">{t(KIND_META[kind].detail)}</p>
        <div className="facts">
          <div><span>{t('export.format')}</span><b>Excel · PDF</b></div>
          <div><span>{t('export.period')}</span><b>{KIND_META[kind].period ? `${t('period.daily')} / ${t('period.weekly')} / ${t('period.monthly')}` : t('export.snapshot')}</b></div>
          <div><span>{t('export.source')}</span><b>MoySklad</b></div>
        </div>
        <div className="form-actions"><button type="button" className="btn btn-primary" onClick={() => setOpen(true)} data-testid="button-export-report"><Download size={16}/>{t('common.export')}</button></div>
      </aside>
    </div>
    {open && <ExportDialog kind={kind} defaultPeriod={KIND_META[kind].period ? 'today' : 'all'} onClose={() => setOpen(false)}/>}
  </>;
}
