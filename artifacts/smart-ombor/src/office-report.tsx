import { useEffect, useMemo, useState } from 'react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Download, FileText, QrCode, ChevronLeft, ChevronRight } from 'lucide-react';
import { Link } from 'wouter';
import { useI18n, type TKey } from '@/i18n';
import { officeHeaders } from '@/office';
import { officeQrCanvas, officeQrSvg } from '@/office-qr';
import './office-report.css';

type TabelRow = {
  n: number; accountId: string; name: string; login: string; role: string; status: string;
  inHm: string; outHm: string; workedMs: number; lateIn: number; earlyIn: number; earlyOut: number; lateOut: number; note: string;
};
type Tabel = {
  date: string; start: string; end: string;
  stats: { total: number; came: number; absent: number; late: number; off: number; waiting: number };
  items: TabelRow[];
};
type Person = { id: string; name: string; login: string; role: string };

function tashkentDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
}
function shift(day: string, by: number) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + by));
  return dt.toISOString().slice(0, 10);
}
function hhmm(ms: number) {
  const total = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
function mins(n: number, label: (n: number) => string) {
  return n > 0 ? label(n) : '—';
}

export function OfficeReportPage() {
  const { t, date, fmt } = useI18n();
  const roleLabel = (role: string) => t(`role.${role}` as TKey);
  const [day, setDay] = useState(tashkentDay());
  const [data, setData] = useState<Tabel | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [qr, setQr] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [dueDate, setDueDate] = useState(tashkentDay());
  const [dueTime, setDueTime] = useState('18:00');
  const [priority, setPriority] = useState('normal');
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (next = day) => {
    const response = await fetch(`/api/office/tabel?date=${next}`, { headers: officeHeaders() });
    if (response.ok) setData(await response.json());
  };
  useEffect(() => { void load(day); }, [day]);
  useEffect(() => {
    void fetch('/api/office/qr', { headers: officeHeaders() }).then(async response => {
      if (response.ok) setQr((await response.json() as { token: string }).token);
    });
    void fetch('/api/office/people', { headers: officeHeaders() }).then(async response => {
      if (response.ok) setPeople((await response.json() as { items: Person[] }).items);
    });
  }, []);

  const svg = useMemo(() => {
    if (!qr) return null;
    try { return officeQrSvg(qr); } catch { return null; }
  }, [qr]);

  const statusText = (status: string) => {
    if (status === 'absent') return t('office.stAbsent');
    if (status === 'out_missing') return t('office.stWait');
    return t('office.stOk');
  };

  const downloadQr = async (kind: 'pdf' | 'png') => {
    if (!qr) return;
    const canvas = officeQrCanvas(qr, 10);
    if (kind === 'png') {
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = 'bordo-ofis-davomat-qr.png';
      a.click();
      return;
    }
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    doc.setFontSize(18);
    doc.text('Bordo · Asosiy ofis', 105, 28, { align: 'center' });
    doc.setFontSize(12);
    doc.text(t('office.qrPaper'), 105, 38, { align: 'center' });
    doc.addImage(canvas.toDataURL('image/png'), 'PNG', 45, 50, 120, 120);
    doc.setFontSize(10);
    doc.text(t('office.qrPaperHint'), 105, 182, { align: 'center', maxWidth: 160 });
    doc.text('41.258556, 69.150964 · 100 m', 105, 196, { align: 'center' });
    doc.save('bordo-ofis-davomat-qr-A4.pdf');
  };

  const exportExcel = () => {
    if (!data) return;
    const head = [t('office.colN'), t('office.colName'), t('office.colRole'), t('office.colStatus'), t('office.colIn'), t('office.colOut'), t('office.colWork'), t('office.colLate'), t('office.colEarly'), t('common.comment')];
    const late = (n: number) => mins(n, value => t('office.minShort', { n: String(value) }));
    const rows = data.items.map(row => [row.n, row.name, roleLabel(row.role), statusText(row.status), row.inHm || '—', row.outHm || '—', hhmm(row.workedMs), late(row.lateIn), late(row.earlyIn), row.note]);
    const csv = [head, ...rows].map(line => line.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(';')).join('\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `davomat-${data.date}.csv`;
    a.click();
  };

  const exportPdf = () => {
    if (!data) return;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    doc.setFontSize(14);
    doc.text(`${t('nav.office')} · ${date(data.date)}`, 14, 14);
    autoTable(doc, {
      startY: 20,
      head: [[t('office.colN'), t('office.colName'), t('office.colRole'), t('office.colStatus'), t('office.colIn'), t('office.colOut'), t('office.colWork'), t('office.colLate')]],
      body: data.items.map(row => [row.n, row.name, roleLabel(row.role), statusText(row.status), row.inHm || '—', row.outHm || '—', hhmm(row.workedMs), mins(row.lateIn, value => t('office.minShort', { n: String(value) }))]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [47, 84, 235] },
    });
    doc.save(`davomat-${data.date}.pdf`);
  };

  const createTask = async () => {
    setBusy(true); setNote('');
    const response = await fetch('/api/office/tasks', {
      method: 'POST', headers: officeHeaders(),
      body: JSON.stringify({ title, description: body, assignedTo: picked, dueDate, dueTime, priority, remind: true }),
    });
    setBusy(false);
    if (!response.ok) { setNote(t('office.taskNeed')); return; }
    setTitle(''); setBody(''); setPicked([]);
    setOk(t('office.taskOk'));
  };

  const stats = data?.stats;
  const waitingNames = data?.items.filter(row => row.status === 'out_missing').map(row => row.name) ?? [];

  return <div className="tabel">
    {waitingNames.length > 0 && <div className="tabel-banner">{t('office.waitingBanner', { names: waitingNames.slice(0, 3).join(', ') })}</div>}
    <div className="page-head">
      <div>
        <h1>{t('nav.office')} · {t('office.officeName')}</h1>
        <p>{t('office.reportSub')}</p>
      </div>
      <div className="page-actions">
        <Link href="/office" className="btn btn-secondary">{t('office.openPunch')}</Link>
        <button type="button" className="btn btn-secondary" onClick={() => void downloadQr('pdf')}><QrCode size={16}/> {t('office.qrA4')}</button>
        <button type="button" className="btn btn-secondary" onClick={exportExcel}><Download size={16}/> {t('office.excel')}</button>
        <button type="button" className="btn btn-primary" onClick={exportPdf}><FileText size={16}/> {t('office.pdf')}</button>
      </div>
    </div>
    <div className="tabel-day">
      <button type="button" className="icon-btn" onClick={() => setDay(shift(day, -1))} aria-label={t('common.prevPage')}><ChevronLeft size={18}/></button>
      <b>{date(day)}</b>
      <button type="button" className="icon-btn" onClick={() => setDay(shift(day, 1))} aria-label={t('common.nextPage')}><ChevronRight size={18}/></button>
      <button type="button" className={`btn btn-sm ${day === tashkentDay() ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setDay(tashkentDay())}>{t('common.today')}</button>
    </div>
    {stats && <div className="tabel-stats">
      <article><span>{t('office.statTotal')}</span><b>{fmt(stats.total)}</b></article>
      <article className="is-ok"><span>{t('office.statCame')}</span><b>{fmt(stats.came)}</b></article>
      <article className="is-bad"><span>{t('office.statAbsent')}</span><b>{fmt(stats.absent)}</b></article>
      <article className="is-warn"><span>{t('office.statLate')}</span><b>{fmt(stats.late)}</b></article>
      <article><span>{t('office.statWait')}</span><b>{fmt(stats.waiting)}</b></article>
      <article><span>{t('office.statOff')}</span><b>{fmt(stats.off)}</b></article>
    </div>}
    <section className="card table-card">
      <div className="card-head"><h2>{t('office.tabelTitle')}</h2><span className="card-meta">{date(day)} · {data?.start}–{data?.end}</span></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr>
            <th>{t('office.colN')}</th><th>{t('office.colName')}</th><th>{t('office.colRole')}</th><th>{t('office.colStatus')}</th>
            <th>{t('office.colShift')}</th><th>{t('office.colIn')}</th><th>{t('office.colOut')}</th><th>{t('office.colWork')}</th>
            <th>{t('office.colLate')}</th><th>{t('office.colEarly')}</th>
          </tr></thead>
          <tbody>
            {(data?.items || []).map(row => <tr key={row.accountId}>
              <td>{row.n}</td>
              <td><b>{row.name}</b></td>
              <td>{roleLabel(row.role)}</td>
              <td><span className={`tabel-pill is-${row.status}`}>{statusText(row.status)}</span></td>
              <td>{data?.start}–{data?.end}</td>
              <td>{row.inHm || '—'}</td>
              <td>{row.outHm || '—'}</td>
              <td>{hhmm(row.workedMs)}</td>
              <td>{mins(row.lateIn, value => t('office.minShort', { n: String(value) }))}</td>
              <td>{mins(row.earlyIn, value => t('office.minShort', { n: String(value) }))}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </section>
    <section className="card tabel-qr">
      <div className="card-head"><h2>{t('office.qrTitle')}</h2></div>
      <p className="muted">{t('office.qrBody')}</p>
      {svg && <svg className="tabel-qr-mark" viewBox={`0 0 ${svg.n} ${svg.n}`} dangerouslySetInnerHTML={{ __html: svg.html }}/>}
      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={() => void downloadQr('pdf')}>{t('office.qrA4')}</button>
        <button type="button" className="btn btn-secondary" onClick={() => void downloadQr('png')}>{t('office.qrPng')}</button>
      </div>
    </section>
    <section className="card">
      <div className="card-head"><h2>{t('office.newTask')}</h2></div>
      <div className="form-grid">
        <label className="field"><span>{t('office.taskName')}</span><input className="input" value={title} onChange={e => setTitle(e.target.value)} maxLength={200}/></label>
        <label className="field"><span>{t('office.taskText')}</span><textarea className="input" value={body} onChange={e => setBody(e.target.value)} rows={3} maxLength={2000}/></label>
      </div>
      <div className="tabel-people">
        {people.filter(item => item.role === 'office' || item.role === 'worker' || item.role === 'accountant').map(item => (
          <button type="button" key={item.id} className={picked.includes(item.id) ? 'is-on' : ''} onClick={() => setPicked(list => list.includes(item.id) ? list.filter(id => id !== item.id) : [...list, item.id])}>{item.name}</button>
        ))}
      </div>
      <div className="form-grid">
        <label className="field"><span>{t('common.date')}</span><input className="input" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}/></label>
        <label className="field"><span>{t('office.dueTime')}</span><input className="input" type="time" value={dueTime} onChange={e => setDueTime(e.target.value)}/></label>
      </div>
      <div className="tabel-prio">
        {([['low', 'office.pLow'], ['normal', 'office.pMid'], ['high', 'office.pHigh'], ['urgent', 'office.pNow']] as const).map(([id, key]) => (
          <button type="button" key={id} className={priority === id ? 'is-on' : ''} onClick={() => setPriority(id)}>{t(key)}</button>
        ))}
      </div>
      {note && <p className="muted">{note}</p>}
      {ok && <p>{ok}</p>}
      <div className="form-actions"><button type="button" className="btn btn-primary" disabled={busy || !title.trim() || !picked.length} onClick={() => void createTask()}>{t('office.createTask')}</button></div>
    </section>
  </div>;
}
