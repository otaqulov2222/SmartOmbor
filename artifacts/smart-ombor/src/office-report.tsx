import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Download, FileText, QrCode, RefreshCw, Search, X } from 'lucide-react';
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
/** 24 soat format: 8:00 / 08:00 / 18:00 */
function normalizeHm(raw: string) {
  const m = String(raw || '').trim().match(/^(\d{1,2})[:.,]?(\d{2})$/);
  if (!m) return '';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
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
  const roleLabel = (role: string) => {
    const key = `role.${role}` as TKey;
    const label = t(key);
    return label === key ? role : label;
  };
  const today = tashkentDay();
  const [mode, setMode] = useState<Mode>('day');
  const [day, setDay] = useState(today);
  const [from, setFrom] = useState(shift(today, -6));
  const [to, setTo] = useState(today);
  const [data, setData] = useState<Tabel | null>(null);
  const [qr, setQr] = useState('');
  const [officeGeo, setOfficeGeo] = useState('41.219353, 69.272828 · 100 m');
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
  const [inHm, setInHm] = useState('08:00');
  const [outHm, setOutHm] = useState('18:00');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [expandId, setExpandId] = useState('');
  const [monthKey, setMonthKey] = useState(today.slice(0, 7));
  const [monthRows, setMonthRows] = useState<TabelRow[]>([]);
  const [monthLoad, setMonthLoad] = useState(false);
  const [monthErr, setMonthErr] = useState('');
  const [monthTick, setMonthTick] = useState(0);
  const ranged = mode !== 'day';
  const span = spanOf(mode, day, from, to);
  const monthSpan = useMemo(() => {
    const start = `${monthKey}-01`;
    const last = lastOfMonth(start);
    return { from: start, to: last > today ? today : last };
  }, [monthKey, today]);

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
    const label = (value: string | null) => (
      value === 'qr' ? t('office.methodQr')
        : value === 'face' ? t('office.methodFace')
          : value === 'manual' ? t('office.methodManual')
            : ''
    );
    const inn = label(row.inMethod);
    const out = label(row.outMethod);
    if (inn && out && inn !== out) return `${inn} → ${out}`;
    return inn || out || '—';
  };
  const tabelUrl = mode === 'day' ? `/api/office/tabel?date=${day}` : `/api/office/tabel?from=${span.from}&to=${span.to}`;
  const hasDataRef = useRef(false);
  hasDataRef.current = data != null;

  useEffect(() => {
    let live = true;
    const quiet = hasDataRef.current;
    if (!quiet) {
      setLoad(true);
      setError('');
    }
    void fetch(tabelUrl, { headers: officeHeaders() }).then(async response => {
      if (!live) return;
      if (!response.ok) {
        if (!quiet) setError(t('common.loadFailed'));
        return;
      }
      setData(await response.json() as Tabel);
      setError('');
    }).catch(() => {
      if (live && !quiet) setError(t('common.serverLost'));
    }).finally(() => {
      if (live && !quiet) setLoad(false);
    });
    return () => { live = false; };
  }, [tabelUrl, reload, t]);
  useEffect(() => {
    void fetch('/api/office/qr', { headers: officeHeaders() }).then(async response => {
      if (response.ok) setQr((await response.json() as { token: string }).token);
    });
    void fetch('/api/office/me', { headers: officeHeaders() }).then(async response => {
      if (!response.ok) return;
      const body = await response.json() as { office?: { lat: number; lng: number; radiusM: number } };
      if (body.office) {
        setOfficeGeo(`${body.office.lat}, ${body.office.lng} · ${body.office.radiusM} m`);
      }
    }).catch(() => undefined);
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
    setInHm(open.inHm || data?.start || '08:00');
    setOutHm(open.outHm || data?.end || '18:00');
    setSaved('');
  }, [open, data?.start, data?.end]);

  useEffect(() => {
    if (!expandId) {
      setMonthRows([]);
      setMonthErr('');
      return;
    }
    let live = true;
    setMonthLoad(true);
    setMonthErr('');
    const url = `/api/office/tabel?from=${monthSpan.from}&to=${monthSpan.to}`;
    void fetch(url, { headers: officeHeaders() }).then(async response => {
      if (!live) return;
      if (!response.ok) { setMonthErr(t('common.loadFailed')); setMonthRows([]); return; }
      const body = await response.json() as Tabel;
      const mine = (body.items || [])
        .filter(row => row.accountId === expandId)
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
      setMonthRows(mine);
    }).catch(() => {
      if (live) { setMonthErr(t('common.serverLost')); setMonthRows([]); }
    }).finally(() => {
      if (live) setMonthLoad(false);
    });
    return () => { live = false; };
  }, [expandId, monthSpan.from, monthSpan.to, monthTick, t]);

  const toggleExpand = (accountId: string, anchorDay?: string) => {
    if (expandId === accountId) {
      setExpandId('');
      return;
    }
    const seed = (anchorDay || day || today).slice(0, 7);
    setMonthKey(seed);
    setExpandId(accountId);
  };

  const shiftMonthKey = (by: number) => {
    const [y, m] = monthKey.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
    const max = today.slice(0, 7);
    setMonthKey(next > max ? max : next);
  };

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
      geo: officeGeo,
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

  const restoreFocus = (accountId: string) => {
    const y = window.scrollY;
    window.requestAnimationFrame(() => {
      const node = document.querySelector(`[data-person="${accountId}"]`) as HTMLElement | null;
      if (node) node.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      else window.scrollTo({ top: y });
    });
  };

  const saveMark = async (opts?: { present?: boolean; clearPunch?: boolean }) => {
    if (!open) return;
    const accountId = open.accountId;
    const inn = normalizeHm(inHm);
    const out = normalizeHm(outHm);
    setSaving(true); setSaved('');
    const body: Record<string, unknown> = {
      accountId,
      date: open.date || data?.date || day,
      note,
    };
    if (opts?.clearPunch) {
      body.clearPunch = true;
      body.excuse = excuse;
    } else if (opts?.present) {
      if (!inn || !out) {
        setSaving(false);
        setSaved(t('office.timeRequired'));
        return;
      }
      body.present = true;
      body.inHm = inn;
      body.outHm = out;
    } else if (excuse) {
      // Dam/kasal/... — faqat sabab
      body.excuse = excuse;
    } else if (inn && out) {
      // Sababsiz + vaqt → kelgan (Saqlash ham ishlaydi)
      body.present = true;
      body.inHm = inn;
      body.outHm = out;
    } else {
      body.excuse = '';
    }
    const response = await fetch('/api/office/tabel', {
      method: 'PATCH', headers: officeHeaders(),
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!response.ok) { setSaved(t('common.actionFailed')); return; }
    setSaved(t('office.saved'));
    setOpen(null);
    setReload(value => value + 1);
    if (expandId) setMonthTick(value => value + 1);
    const focusId = expandId || accountId;
    window.setTimeout(() => restoreFocus(focusId), 100);
  };

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

  const monthCame = monthRows.filter(row => row.status === 'present' || row.status === 'late' || row.status === 'out_missing').length;
  const monthAbsent = monthRows.filter(row => row.status === 'absent').length;
  const monthLate = monthRows.filter(row => row.status === 'late').length;
  const monthOff = monthRows.filter(row => row.status === 'off' || row.status === 'sick' || row.status === 'vacation' || row.status === 'trip' || row.status === 'permit').length;

  const renderPersonMonth = (name: string) => (
    <div className="tabel-month" onClick={event => event.stopPropagation()}>
      <div className="tabel-month-head">
        <div>
          <b>{t('office.personMonth')}</b>
          <span className="muted"> · {name}</span>
        </div>
        <div className="tabel-month-nav">
          <button type="button" className="icon-btn" onClick={() => shiftMonthKey(-1)} aria-label={t('common.prevPage')}><ChevronLeft size={16}/></button>
          <b>{date(monthSpan.from)} – {date(monthSpan.to)}</b>
          <button type="button" className="icon-btn" disabled={monthKey >= today.slice(0, 7)} onClick={() => shiftMonthKey(1)} aria-label={t('common.nextPage')}><ChevronRight size={16}/></button>
        </div>
      </div>
      {!monthLoad && !monthErr && monthRows.length > 0 && <div className="tabel-month-stats">
        <span>{t('office.statCame')}: <b>{fmt(monthCame)}</b></span>
        <span>{t('office.statAbsent')}: <b>{fmt(monthAbsent)}</b></span>
        <span>{t('office.statLate')}: <b>{fmt(monthLate)}</b></span>
        <span>{t('office.statOff')}: <b>{fmt(monthOff)}</b></span>
      </div>}
      {monthLoad && <p className="muted tabel-state">{t('common.loading')}</p>}
      {monthErr && !monthLoad && <p className="tabel-month-err">{monthErr}</p>}
      {!monthLoad && !monthErr && !monthRows.length && <p className="muted tabel-state">{t('office.emptyBody')}</p>}
      {!monthLoad && !monthErr && monthRows.length > 0 && <div className="tabel-month-wrap">
        <table className="table tabel-month-table">
          <thead><tr>
            <th>{t('office.colDay')}</th>
            <th>{t('common.date')}</th>
            <th>{t('office.colStatus')}</th>
            <th>{t('office.colIn')}</th>
            <th>{t('office.colOut')}</th>
            <th>{t('office.colWork')}</th>
            <th>{t('office.colLate')}</th>
            <th>{t('office.colMethod')}</th>
            <th>{t('office.editDay')}</th>
          </tr></thead>
          <tbody>
            {monthRows.map((row, index) => (
              <tr key={row.date || index} className="is-clickable" onClick={() => setOpen(row)}>
                <td data-label={t('office.colDay')}>{index + 1}</td>
                <td data-label={t('common.date')}>{date(row.date || '')}</td>
                <td data-label={t('office.colStatus')}><span className={`tabel-pill is-${row.status}`}>{statusText(row.status)}</span></td>
                <td data-label={t('office.colIn')}>{row.inHm || '—'}</td>
                <td data-label={t('office.colOut')}>{row.outHm || '—'}</td>
                <td data-label={t('office.colWork')}>{hhmm(row.workedMs)}</td>
                <td data-label={t('office.colLate')}>{lateLabel(row.lateIn)}</td>
                <td data-label={t('office.colMethod')}>{methodText(row)}</td>
                <td data-label={t('office.editDay')}>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={event => { event.stopPropagation(); setOpen(row); }}>{t('office.editDay')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
      <p className="muted tabel-month-hint">{t('office.personMonthHint')}</p>
    </div>
  );

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
      <button type="button" className={filter === 'all' ? 'is-on' : ''} onClick={() => setFilter('all')}><span>{t('office.statTotal')}</span><b>{fmt(data.stats.total)}</b></button>
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
            <th className="tabel-expand-col" aria-hidden/>
            <th>{t('office.colName')}</th><th>{t('office.colRole')}</th><th>{t('office.colDays')}</th>
            <th>{t('office.statAbsent')}</th><th>{t('office.statLate')}</th><th>{t('office.colDaysOff')}</th>
            <th>{t('office.colWork')}</th><th>{t('office.colLate')}</th><th>{t('office.colEarlyOut')}</th><th>{t('office.colOver')}</th>
          </tr></thead>
          <tbody>
            {peopleRows.map(row => {
              const openMonth = expandId === row.accountId;
              return <Fragment key={row.accountId}>
                <tr className={`is-clickable ${openMonth ? 'is-expanded' : ''}`} data-person={row.accountId}>
                  <td className="tabel-expand-col" data-label="">
                    <button type="button" className={`tabel-arrow ${openMonth ? 'is-open' : ''}`} aria-label={t('office.personMonth')} aria-expanded={openMonth} onClick={event => { event.stopPropagation(); toggleExpand(row.accountId); }}>
                      {openMonth ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}
                    </button>
                  </td>
                  <td data-label="" onClick={() => toggleExpand(row.accountId)}><b>{row.name}</b></td>
                  <td data-label={t('office.colRole')}>{roleLabel(row.role)}</td>
                  <td data-label={t('office.colDays')}>{fmt(row.came)}</td>
                  <td data-label={t('office.statAbsent')}>{fmt(row.absent)}</td>
                  <td data-label={t('office.statLate')}>{fmt(row.late)}</td>
                  <td data-label={t('office.colDaysOff')}>{fmt(row.off)}</td>
                  <td data-label={t('office.colWork')}>{hhmm(row.workedMs)}</td>
                  <td data-label={t('office.colLate')}>{lateLabel(row.lateMin)}</td>
                  <td data-label={t('office.colEarlyOut')}>{lateLabel(row.earlyOut)}</td>
                  <td data-label={t('office.colOver')}>{lateLabel(row.overtime)}</td>
                </tr>
                {openMonth && <tr className="tabel-month-row"><td colSpan={11}>{renderPersonMonth(row.name)}</td></tr>}
              </Fragment>;
            })}
          </tbody>
        </table>
      </div>}
      {!load && !error && (view !== 'people' || !ranged) && rows.length > 0 && <div className="table-wrap">
        <table className="table">
          <thead><tr>
            <th className="tabel-expand-col" aria-hidden/>
            {ranged && <th>{t('common.date')}</th>}
            <th>{t('office.colName')}</th><th>{t('office.colN')}</th><th>{t('office.colRole')}</th><th>{t('office.colStatus')}</th>
            <th>{t('office.colIn')}</th><th>{t('office.colOut')}</th><th>{t('office.colWork')}</th>
            <th>{t('office.colLate')}</th><th>{t('office.colEarlyOut')}</th><th>{t('office.colOver')}</th><th>{t('office.colMethod')}</th>
          </tr></thead>
          <tbody>
            {rows.map((row, index) => {
              const openMonth = expandId === row.accountId;
              const showPanel = openMonth && rows.findIndex(item => item.accountId === row.accountId) === index;
              const colSpan = (ranged ? 13 : 12);
              return <Fragment key={`${row.date || day}-${row.accountId}`}>
                <tr className={`is-clickable ${openMonth ? 'is-expanded' : ''}`} data-person={row.accountId}>
                  <td className="tabel-expand-col" data-label="">
                    <button type="button" className={`tabel-arrow ${openMonth ? 'is-open' : ''}`} aria-label={t('office.personMonth')} aria-expanded={openMonth} onClick={event => { event.stopPropagation(); toggleExpand(row.accountId, row.date || day); }}>
                      {openMonth ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}
                    </button>
                  </td>
                  {ranged && <td data-label="" onClick={() => setOpen(row)}>{date(row.date || '')}</td>}
                  <td data-label={ranged ? t('office.colName') : ''} onClick={() => setOpen(row)}><b>{row.name}</b></td>
                  <td data-label={t('office.colN')} onClick={() => setOpen(row)}>{row.n}</td>
                  <td data-label={t('office.colRole')} onClick={() => setOpen(row)}>{roleLabel(row.role)}</td>
                  <td data-label={t('office.colStatus')} onClick={() => setOpen(row)}><span className={`tabel-pill is-${row.status}`}>{statusText(row.status)}</span></td>
                  <td data-label={t('office.colIn')} onClick={() => setOpen(row)}>{row.inHm || '—'}</td>
                  <td data-label={t('office.colOut')} onClick={() => setOpen(row)}>{row.outHm || '—'}</td>
                  <td data-label={t('office.colWork')} onClick={() => setOpen(row)}>{hhmm(row.workedMs)}</td>
                  <td data-label={t('office.colLate')} onClick={() => setOpen(row)}>{lateLabel(row.lateIn)}</td>
                  <td data-label={t('office.colEarlyOut')} onClick={() => setOpen(row)}>{lateLabel(row.earlyOut)}</td>
                  <td data-label={t('office.colOver')} onClick={() => setOpen(row)}>{lateLabel(row.overtime)}</td>
                  <td data-label={t('office.colMethod')} onClick={() => setOpen(row)}>{methodText(row)}</td>
                </tr>
                {showPanel && <tr className="tabel-month-row"><td colSpan={colSpan}>{renderPersonMonth(row.name)}</td></tr>}
              </Fragment>;
            })}
          </tbody>
        </table>
      </div>}
    </section>
    {open && createPortal(<div className="backdrop" onClick={() => setOpen(null)}>
      <div className="modal tabel-edit-modal" onClick={event => event.stopPropagation()} role="dialog" aria-labelledby="tabel-row-title">
        <div className="modal-top">
          <div>
            <p className="eyebrow">{date(open.date || data?.date || day)} · {statusText(open.status)}</p>
            <h2 id="tabel-row-title">{open.name}</h2>
            <p className="tabel-edit-meta">{open.login} · {roleLabel(open.role)}</p>
          </div>
          <button type="button" className="icon-btn" onClick={() => setOpen(null)} aria-label={t('common.close')}><X size={18}/></button>
        </div>
        <div className="tabel-manual">
          <p className="muted">{t('office.markPresentHint')}</p>
          <div className="tabel-manual-times">
            <label className="field">
              <span>{t('office.manualIn')} <small>24s</small></span>
              <input
                className="input"
                type="text"
                inputMode="numeric"
                placeholder="08:00"
                maxLength={5}
                value={inHm}
                onChange={event => setInHm(event.target.value)}
                onBlur={() => setInHm(value => normalizeHm(value) || value)}
              />
            </label>
            <label className="field">
              <span>{t('office.manualOut')} <small>24s</small></span>
              <input
                className="input"
                type="text"
                inputMode="numeric"
                placeholder="18:00"
                maxLength={5}
                value={outHm}
                onChange={event => setOutHm(event.target.value)}
                onBlur={() => setOutHm(value => normalizeHm(value) || value)}
              />
            </label>
          </div>
          {(open.inHm || open.outHm) && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={saving} onClick={() => void saveMark({ clearPunch: true })}>{t('office.clearPunch')}</button>
          )}
        </div>
        <div className="tabel-chips">
          {excuses.map(([id, label]) => (
            <button type="button" key={id || 'none'} className={excuse === id ? 'is-on' : ''} onClick={() => setExcuse(id)}>{label}</button>
          ))}
        </div>
        <label className="field"><span>{t('office.colNote')}</span><textarea className="input" value={note} onChange={event => setNote(event.target.value)} rows={2} maxLength={400}/></label>
        {saved && <p className="muted">{saved}</p>}
        <div className="form-actions tabel-edit-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setOpen(null)}>{t('common.close')}</button>
          <button type="button" className="btn btn-primary" disabled={saving || (!excuse && (!normalizeHm(inHm) || !normalizeHm(outHm)))} onClick={() => void saveMark(excuse ? undefined : { present: true })}>
            {saving ? t('common.saving') : (excuse ? t('office.save') : t('office.markPresent'))}
          </button>
        </div>
      </div>
    </div>, document.body)}
  </div>;
}
