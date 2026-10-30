import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { ChevronLeft, ChevronRight, CircleAlert, Download, FileText, QrCode, RefreshCw, Search, X } from 'lucide-react';
import { useI18n, type TKey } from '@/i18n';
import { officeHeaders } from '@/office';
import { downloadOfficeQrA4 } from '@/office-qr';
import robotoRegular from '@/assets/fonts/Roboto-Regular.ttf';
import robotoBold from '@/assets/fonts/Roboto-Bold.ttf';
import './office-report.css';

type TabelRow = {
  n: number; accountId: string; name: string; login: string; role: string; status: string; date?: string;
  weekend?: boolean; excuse?: string;
  inHm: string; outHm: string; workedMs: number; lateIn: number; earlyOut: number; overtime: number; note: string;
  inMethod: string | null; outMethod: string | null;
  inLat: number | null; inLng: number | null; outLat: number | null; outLng: number | null;
};
type PersonSum = {
  accountId: string; name: string; login: string; role: string; days: number;
  came: number; absent: number; late: number; off: number; waiting: number;
  workedMs: number; lateMin: number; earlyOut: number; overtime: number;
};
type Tabel = {
  date?: string; from?: string; to?: string; start: string; end: string; weekend?: boolean;
  stats: { total: number; came: number; absent: number; late: number; off: number; waiting: number };
  items: TabelRow[];
  people?: PersonSum[];
};
type Mode = 'day' | 'week' | 'month' | 'range';
type Filter = 'all' | 'came' | 'absent' | 'late' | 'wait' | 'off' | 'early';

function tashkentDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
}
function shift(day: string, by: number) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + by));
  return dt.toISOString().slice(0, 10);
}
function lastOfMonth(day: string) {
  const [y, m] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function shiftMonth(day: string, by: number) {
  const [y, m] = day.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 10);
  const last = lastOfMonth(first);
  const today = tashkentDay();
  return last > today && first.slice(0, 7) === today.slice(0, 7) ? today : last;
}
function clampDay(value: string) {
  const today = tashkentDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return today;
  return value > today ? today : value;
}
function spanOf(mode: Mode, day: string, from: string, to: string) {
  const today = tashkentDay();
  if (mode === 'day') return { from: day, to: day };
  if (mode === 'week') return { from: shift(day, -6), to: day };
  if (mode === 'month') {
    const start = `${day.slice(0, 8)}01`;
    const last = lastOfMonth(day);
    return { from: start, to: last > today ? today : last };
  }
  const begin = clampDay(from);
  const end = clampDay(to);
  const first = begin <= end ? begin : end;
  const last = begin <= end ? end : begin;
  const cap = shift(first, 61);
  return { from: first, to: last > cap ? cap : last };
}
function hhmm(ms: number) {
  const total = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
function mins(n: number, label: (n: number) => string) {
  return n > 0 ? label(n) : '—';
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
    fetch(robotoRegular).then(response => response.arrayBuffer()),
    fetch(robotoBold).then(response => response.arrayBuffer()),
  ]);
  pdfFonts = { regular: bufToB64(regular), bold: bufToB64(bold) };
  return pdfFonts;
}

export function OfficeReportPage() {
  const { t, date, fmt } = useI18n();
  const roleLabel = (role: string) => t(`role.${role}` as TKey);
  const today = tashkentDay();
  const [mode, setMode] = useState<Mode>('day');
  const [day, setDay] = useState(today);
  const [from, setFrom] = useState(shift(today, -6));
  const [to, setTo] = useState(today);
  const [data, setData] = useState<Tabel | null>(null);
  const [qr, setQr] = useState('');
  const [load, setLoad] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [person, setPerson] = useState('');
  const [view, setView] = useState<'days' | 'people'>('days');
  const [open, setOpen] = useState<TabelRow | null>(null);
  const [excuse, setExcuse] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const ranged = mode !== 'day';
  const span = spanOf(mode, day, from, to);

  const statusText = (status: string) => {
    if (status === 'absent') return t('office.stAbsent');
    if (status === 'out_missing') return t('office.stWait');
    if (status === 'late') return t('office.stLate');
    if (status === 'off') return t('office.stOff');
    if (status === 'sick') return t('office.stSick');
    if (status === 'vacation') return t('office.stVacation');
    if (status === 'trip') return t('office.stTrip');
    if (status === 'permit') return t('office.stPermit');
    return t('office.stOk');
  };
  const lateLabel = (n: number) => mins(n, value => t('office.minShort', { n: String(value) }));
  const methodText = (row: TabelRow) => {
    const label = (value: string | null) => value === 'qr' ? t('office.methodQr') : value === 'face' ? t('office.methodFace') : '';
    const inn = label(row.inMethod);
    const out = label(row.outMethod);
    if (inn && out && inn !== out) return `${inn} → ${out}`;
    return inn || out || '—';
  };
  const point = (lat: number | null, lng: number | null) => {
    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return '—';
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  };

  const tabelUrl = mode === 'day' ? `/api/office/tabel?date=${day}` : `/api/office/tabel?from=${span.from}&to=${span.to}`;

  useEffect(() => {
    let live = true;
    setLoad(true);
    setError('');
    void fetch(tabelUrl, { headers: officeHeaders() }).then(async response => {
      if (!live) return;
      if (!response.ok) { setError(t('common.loadFailed')); return; }
      setData(await response.json() as Tabel);
      setError('');
    }).catch(() => {
      if (live) setError(t('common.serverLost'));
    }).finally(() => {
      if (live) setLoad(false);
    });
    return () => { live = false; };
  }, [tabelUrl, reload, t]);
  useEffect(() => {
    void fetch('/api/office/qr', { headers: officeHeaders() }).then(async response => {
      if (response.ok) setQr((await response.json() as { token: string }).token);
    });
  }, []);
  useEffect(() => {
    if (mode !== 'day' || day !== today) return;
    const timer = window.setInterval(() => {
      void fetch(tabelUrl, { headers: officeHeaders() }).then(async response => {
        if (response.ok) setData(await response.json() as Tabel);
      }).catch(() => undefined);
    }, 30000);
    return () => window.clearInterval(timer);
  }, [mode, day, today, tabelUrl]);
  useEffect(() => {
    if (!open) return;
    setExcuse(open.excuse || '');
    setNote(open.note || '');
    setSaved('');
  }, [open]);

  const goDay = (value: string) => setDay(clampDay(value));
  const step = (by: number) => {
    if (mode === 'month') goDay(shiftMonth(day, by));
    else if (mode === 'week') goDay(shift(day, by * 7));
    else goDay(shift(day, by));
  };

  const people = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of data?.items || []) map.set(row.accountId, row.name);
    return [...map].map(([id, name]) => ({ id, name }));
  }, [data]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.items || []).filter(row => {
      if (person && row.accountId !== person) return false;
      if (q && !`${row.name} ${row.login} ${row.role}`.toLowerCase().includes(q)) return false;
      if (filter === 'came') return row.status === 'present' || row.status === 'late' || row.status === 'out_missing';
      if (filter === 'absent') return row.status === 'absent';
      if (filter === 'late') return row.lateIn > 0;
      if (filter === 'wait') return row.status === 'out_missing';
      if (filter === 'off') return ['off', 'sick', 'vacation', 'trip', 'permit'].includes(row.status);
      if (filter === 'early') return row.earlyOut > 0;
      return true;
    });
  }, [data, search, filter, person]);

  const peopleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.people || []).filter(row => {
      if (person && row.accountId !== person) return false;
      if (q && !`${row.name} ${row.login}`.toLowerCase().includes(q)) return false;
      if (filter === 'came') return row.came > 0;
      if (filter === 'absent') return row.absent > 0;
      if (filter === 'late') return row.late > 0;
      if (filter === 'wait') return row.waiting > 0;
      if (filter === 'off') return row.off > 0;
      if (filter === 'early') return row.earlyOut > 0;
      return true;
    });
  }, [data, search, filter, person]);

  const downloadQr = async () => {
    if (!qr) return;
    await downloadOfficeQrA4(qr, {
      brand: 'BORDO',
      office: t('office.officeName'),
      title: t('office.qrPaper'),
      hint: t('office.qrPaperHint'),
      geo: '41.258556, 69.150964 · 100 m',
    });
  };

  const exportRows = (data?.items || []).map(row => [
    date(row.date || data?.date || ''),
    row.n,
    row.name,
    row.login,
    roleLabel(row.role),
    statusText(row.status),
    row.inHm || '—',
    row.outHm || '—',
    hhmm(row.workedMs),
    lateLabel(row.lateIn),
    lateLabel(row.earlyOut),
    lateLabel(row.overtime),
    methodText(row),
    row.note || '—',
  ]);
  const exportHead = [
    t('common.date'), t('office.colN'), t('office.colName'), t('office.colLogin'), t('office.colRole'),
    t('office.colStatus'), t('office.colIn'), t('office.colOut'), t('office.colWork'), t('office.colLate'),
    t('office.colEarlyOut'), t('office.colOver'), t('office.colMethod'), t('office.colNote'),
  ];

  const exportSheet = async (kind: 'excel' | 'pdf') => {
    if (!data || !data.items.length) return;
    const stamp = data.date || `${data.from}_${data.to}`;
    if (kind === 'excel') {
      const csv = [exportHead, ...exportRows].map(line => line.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(';')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
      a.download = `davomat-${stamp}.csv`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    const fonts = await loadPdfFonts();
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    doc.addFileToVFS('Roboto-Regular.ttf', fonts.regular);
    doc.addFileToVFS('Roboto-Bold.ttf', fonts.bold);
    doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
    doc.addFont('Roboto-Bold.ttf', 'Roboto', 'bold');
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(13);
    doc.text(`${t('nav.officeReport')} · ${stamp}`, 14, 14);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9);
    doc.text(`${t('office.statTotal')}: ${fmt(data.stats.total)}  ·  ${t('office.statCame')}: ${fmt(data.stats.came)}  ·  ${t('office.statAbsent')}: ${fmt(data.stats.absent)}  ·  ${t('office.statLate')}: ${fmt(data.stats.late)}`, 14, 20);
    autoTable(doc, {
      startY: 24,
      head: [exportHead],
      body: exportRows,
      styles: { font: 'Roboto', fontSize: 7 },
      headStyles: { fillColor: [47, 84, 235], font: 'Roboto', fontStyle: 'bold' },
    });
    doc.save(`davomat-${stamp}.pdf`);
  };

  const saveMark = async () => {
    if (!open) return;
    setSaving(true); setSaved('');
    const response = await fetch('/api/office/tabel', {
      method: 'PATCH', headers: officeHeaders(),
      body: JSON.stringify({ accountId: open.accountId, date: open.date || data?.date || day, excuse, note }),
    });
    setSaving(false);
    if (!response.ok) { setSaved(t('common.actionFailed')); return; }
    setSaved(t('office.saved'));
    setOpen(null);
    setReload(value => value + 1);
  };

  const waitingNames = !ranged ? data?.items.filter(row => row.status === 'out_missing').map(row => row.name) ?? [] : [];
  const filters: Array<[Filter, string]> = [
    ['all', t('common.all')],
    ['came', t('office.statCame')],
    ['absent', t('office.statAbsent')],
    ['late', t('office.statLate')],
    ['wait', t('office.statWait')],
    ['off', t('office.statOff')],
    ['early', t('office.filterEarly')],
  ];
  const excuses: Array<[string, string]> = [
    ['', t('office.excuseNone')],
    ['off', t('office.stOff')],
    ['sick', t('office.stSick')],
    ['vacation', t('office.stVacation')],
    ['trip', t('office.stTrip')],
    ['permit', t('office.stPermit')],
  ];
  const meta = ranged
    ? `${date(data?.from || span.from)} – ${date(data?.to || span.to)}`
    : `${date(day)}${data?.start ? ` · ${data.start}–${data.end}` : ''}`;

  return <div className="tabel">
    <div className="page-head">
      <div>
        <h1>{t('nav.officeReport')}</h1>
        <p>{t('office.reportSub')}</p>
      </div>
      <div className="page-actions">
        <button type="button" className="btn btn-secondary" onClick={() => setReload(value => value + 1)}><RefreshCw size={16}/> {t('common.refresh')}</button>
        <button type="button" className="btn btn-secondary" disabled={!qr} onClick={() => void downloadQr()}><QrCode size={16}/> {t('office.qrDownload')}</button>
        <button type="button" className="btn btn-secondary" disabled={!data?.items.length} onClick={() => void exportSheet('excel')}><Download size={16}/> {t('office.excel')}</button>
        <button type="button" className="btn btn-primary" disabled={!data?.items.length} onClick={() => void exportSheet('pdf')}><FileText size={16}/> {t('office.pdf')}</button>
      </div>
    </div>
    {waitingNames.length > 0 && <div className="tabel-banner">{t('office.waitingBanner', { names: waitingNames.slice(0, 3).join(', ') })}</div>}
    <div className="tabel-day">
      {mode !== 'range' && <div className="tabel-day-nav">
        <button type="button" className="icon-btn" onClick={() => step(-1)} aria-label={t('common.prevPage')}><ChevronLeft size={18}/></button>
        <b>{ranged && data?.from && data?.to ? `${date(data.from)} – ${date(data.to)}` : date(day)}</b>
        <button type="button" className="icon-btn" disabled={clampDay(mode === 'month' ? shiftMonth(day, 1) : shift(day, mode === 'week' ? 7 : 1)) === day} onClick={() => step(1)} aria-label={t('common.nextPage')}><ChevronRight size={18}/></button>
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setDay(today); setTo(today); }}>{t('common.today')}</button>
      </div>}
      {mode === 'range' && <div className="tabel-range">
        <label className="field"><span>{t('office.from')}</span><input className="input" type="date" max={today} value={from} onChange={event => setFrom(clampDay(event.target.value))}/></label>
        <label className="field"><span>{t('office.to')}</span><input className="input" type="date" max={today} value={to} onChange={event => setTo(clampDay(event.target.value))}/></label>
      </div>}
      <div className="tabel-day-modes">
        {(['day', 'week', 'month', 'range'] as const).map(id => (
          <button type="button" key={id} className={`btn btn-sm ${mode === id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setMode(id); if (id === 'day') setView('days'); }}>{id === 'range' ? t('office.range') : t(`office.${id}` as TKey)}</button>
        ))}
      </div>
    </div>
    {data?.stats && <div className="tabel-stats">
      <article><span>{t('office.statTotal')}</span><b>{fmt(data.stats.total)}</b></article>
      <button type="button" className={`is-ok ${filter === 'came' ? 'is-on' : ''}`} onClick={() => setFilter(filter === 'came' ? 'all' : 'came')}><span>{t('office.statCame')}</span><b>{fmt(data.stats.came)}</b></button>
      <button type="button" className={`is-bad ${filter === 'absent' ? 'is-on' : ''}`} onClick={() => setFilter(filter === 'absent' ? 'all' : 'absent')}><span>{t('office.statAbsent')}</span><b>{fmt(data.stats.absent)}</b></button>
      <button type="button" className={`is-warn ${filter === 'late' ? 'is-on' : ''}`} onClick={() => setFilter(filter === 'late' ? 'all' : 'late')}><span>{t('office.statLate')}</span><b>{fmt(data.stats.late)}</b></button>
      <button type="button" className={filter === 'wait' ? 'is-on' : ''} onClick={() => setFilter(filter === 'wait' ? 'all' : 'wait')}><span>{t('office.statWait')}</span><b>{fmt(data.stats.waiting)}</b></button>
      <button type="button" className={filter === 'off' ? 'is-on' : ''} onClick={() => setFilter(filter === 'off' ? 'all' : 'off')}><span>{t('office.statOff')}</span><b>{fmt(data.stats.off)}</b></button>
    </div>}
    <div className="tabel-tools">
      <label className="search"><Search size={16}/><input className="input" value={search} onChange={event => setSearch(event.target.value)} placeholder={t('common.search')} aria-label={t('common.search')}/></label>
      <select className="input" value={person} onChange={event => setPerson(event.target.value)} aria-label={t('office.pickPerson')}>
        <option value="">{t('office.allPeople')}</option>
        {people.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <div className="tabel-chips">
        {filters.map(([id, label]) => (
          <button type="button" key={id} className={filter === id ? 'is-on' : ''} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>
      {ranged && <div className="tabel-day-modes">
        <button type="button" className={`btn btn-sm ${view === 'days' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('days')}>{t('office.viewDays')}</button>
        <button type="button" className={`btn btn-sm ${view === 'people' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('people')}>{t('office.viewPeople')}</button>
      </div>}
    </div>
    <section className="card table-card">
      <div className="card-head">
        <h2>{view === 'people' && ranged ? t('office.tabelPeople') : ranged ? t('office.tabelTitleRange') : t('office.tabelTitle')}</h2>
        <span className="card-meta">{meta}{!load && ` · ${view === 'people' ? peopleRows.length : rows.length}`}</span>
      </div>
      {load && <p className="muted tabel-state">{t('common.loading')}</p>}
      {error && !load && <div className="state state-error"><CircleAlert size={20}/><div><b>{t('common.loadFailed')}</b><p>{error}</p></div><button type="button" className="btn btn-secondary btn-sm" onClick={() => setReload(value => value + 1)}><RefreshCw size={14}/> {t('common.retry')}</button></div>}
      {!load && !error && !data?.items.length && <div className="state state-empty"><b>{t('office.noPeople')}</b><p>{t('office.noPeopleBody')}</p></div>}
      {!load && !error && data && data.items.length > 0 && view === 'people' && ranged && !peopleRows.length && <div className="state state-empty"><b>{t('office.empty')}</b><p>{t('office.emptyBody')}</p></div>}
      {!load && !error && data && data.items.length > 0 && (view !== 'people' || !ranged) && !rows.length && <div className="state state-empty"><b>{t('office.empty')}</b><p>{t('office.emptyBody')}</p></div>}
      {!load && !error && view === 'people' && ranged && peopleRows.length > 0 && <div className="table-wrap">
        <table className="table">
          <thead><tr>
            <th>{t('office.colName')}</th><th>{t('office.colRole')}</th><th>{t('office.colDays')}</th>
            <th>{t('office.statAbsent')}</th><th>{t('office.statLate')}</th><th>{t('office.colDaysOff')}</th>
            <th>{t('office.colWork')}</th><th>{t('office.colLate')}</th>
          </tr></thead>
          <tbody>
            {peopleRows.map(row => <tr key={row.accountId} className="is-clickable" onClick={() => { setPerson(row.accountId); setView('days'); }}>
              <td data-label=""><b>{row.name}</b></td>
              <td data-label={t('office.colRole')}>{roleLabel(row.role)}</td>
              <td data-label={t('office.colDays')}>{fmt(row.came)}</td>
              <td data-label={t('office.statAbsent')}>{fmt(row.absent)}</td>
              <td data-label={t('office.statLate')}>{fmt(row.late)}</td>
              <td data-label={t('office.colDaysOff')}>{fmt(row.off)}</td>
              <td data-label={t('office.colWork')}>{hhmm(row.workedMs)}</td>
              <td data-label={t('office.colLate')}>{lateLabel(row.lateMin)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>}
      {!load && !error && (view !== 'people' || !ranged) && rows.length > 0 && <div className="table-wrap">
        <table className="table">
          <thead><tr>
            {ranged && <th>{t('common.date')}</th>}
            <th>{t('office.colName')}</th><th>{t('office.colN')}</th><th>{t('office.colRole')}</th><th>{t('office.colStatus')}</th>
            <th>{t('office.colIn')}</th><th>{t('office.colOut')}</th><th>{t('office.colWork')}</th>
            <th>{t('office.colLate')}</th><th>{t('office.colEarlyOut')}</th><th>{t('office.colMethod')}</th>
          </tr></thead>
          <tbody>
            {rows.map(row => <tr key={`${row.date || day}-${row.accountId}`} className="is-clickable" onClick={() => setOpen(row)}>
              {ranged && <td data-label="">{date(row.date || '')}</td>}
              <td data-label={ranged ? t('office.colName') : ''}><b>{row.name}</b></td>
              <td data-label={t('office.colN')}>{row.n}</td>
              <td data-label={t('office.colRole')}>{roleLabel(row.role)}</td>
              <td data-label={t('office.colStatus')}><span className={`tabel-pill is-${row.status}`}>{statusText(row.status)}</span></td>
              <td data-label={t('office.colIn')}>{row.inHm || '—'}</td>
              <td data-label={t('office.colOut')}>{row.outHm || '—'}</td>
              <td data-label={t('office.colWork')}>{hhmm(row.workedMs)}</td>
              <td data-label={t('office.colLate')}>{lateLabel(row.lateIn)}</td>
              <td data-label={t('office.colEarlyOut')}>{lateLabel(row.earlyOut)}</td>
              <td data-label={t('office.colMethod')}>{methodText(row)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>}
    </section>
    {open && createPortal(<div className="backdrop" onClick={() => setOpen(null)}>
      <div className="modal" onClick={event => event.stopPropagation()} role="dialog" aria-labelledby="tabel-row-title">
        <div className="modal-top">
          <div>
            <p className="eyebrow">{date(open.date || data?.date || day)} · {statusText(open.status)}</p>
            <h2 id="tabel-row-title">{open.name}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={() => setOpen(null)} aria-label={t('common.close')}><X size={18}/></button>
        </div>
        <div className="tabel-facts">
          <div><span>{t('office.colLogin')}</span><b>{open.login}</b></div>
          <div><span>{t('office.colRole')}</span><b>{roleLabel(open.role)}</b></div>
          <div><span>{t('office.colIn')}</span><b>{open.inHm || '—'}</b></div>
          <div><span>{t('office.colOut')}</span><b>{open.outHm || '—'}</b></div>
          <div><span>{t('office.colWork')}</span><b>{hhmm(open.workedMs)}</b></div>
          <div><span>{t('office.colLate')}</span><b>{lateLabel(open.lateIn)}</b></div>
          <div><span>{t('office.colEarlyOut')}</span><b>{lateLabel(open.earlyOut)}</b></div>
          <div><span>{t('office.colOver')}</span><b>{lateLabel(open.overtime)}</b></div>
          <div><span>{t('office.colMethod')}</span><b>{methodText(open)}</b></div>
          <div><span>{t('office.gpsIn')}</span><b>{point(open.inLat, open.inLng)}</b></div>
          <div><span>{t('office.gpsOut')}</span><b>{point(open.outLat, open.outLng)}</b></div>
        </div>
        <p className="muted">{t('office.markHint')}</p>
        <div className="tabel-chips">
          {excuses.map(([id, label]) => (
            <button type="button" key={id || 'none'} className={excuse === id ? 'is-on' : ''} onClick={() => setExcuse(id)}>{label}</button>
          ))}
        </div>
        <label className="field"><span>{t('office.colNote')}</span><textarea className="input" value={note} onChange={event => setNote(event.target.value)} rows={3} maxLength={400}/></label>
        {saved && <p className="muted">{saved}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setOpen(null)}>{t('common.close')}</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void saveMark()}>{saving ? t('common.saving') : t('office.save')}</button>
        </div>
      </div>
    </div>, document.body)}
  </div>;
}
