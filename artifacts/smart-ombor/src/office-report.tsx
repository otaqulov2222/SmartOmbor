import { useEffect, useState } from 'react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { ChevronLeft, ChevronRight, Download, FileText, QrCode } from 'lucide-react';
import { useI18n, type TKey } from '@/i18n';
import { officeHeaders } from '@/office';
import { downloadOfficeQrA4 } from '@/office-qr';
import './office-report.css';

type TabelRow = {
  n: number; accountId: string; name: string; login: string; role: string; status: string; date?: string;
  inHm: string; outHm: string; workedMs: number; lateIn: number; note: string;
};
type Tabel = {
  date?: string; from?: string; to?: string; start: string; end: string;
  stats: { total: number; came: number; absent: number; late: number; off: number; waiting: number };
  items: TabelRow[];
};
type Person = { id: string; name: string; login: string; role: string };
type Task = {
  id: string; title: string; description: string; dueDate: string; dueTime: string; priority: string;
  status: 'assigned' | 'accepted' | 'done'; assignees: Array<{ id: string; name: string }>; late?: boolean;
};

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
  const [mode, setMode] = useState<'day' | 'week' | 'month'>('day');
  const [day, setDay] = useState(tashkentDay());
  const [data, setData] = useState<Tabel | null>(null);
  const [qr, setQr] = useState('');

  useEffect(() => {
    const url = mode === 'day' ? `/api/office/tabel?date=${day}` : `/api/office/tabel?range=${mode}`;
    void fetch(url, { headers: officeHeaders() }).then(async response => {
      if (response.ok) setData(await response.json());
    });
  }, [mode, day]);
  useEffect(() => {
    void fetch('/api/office/qr', { headers: officeHeaders() }).then(async response => {
      if (response.ok) setQr((await response.json() as { token: string }).token);
    });
  }, []);

  const statusText = (status: string) => {
    if (status === 'absent') return t('office.stAbsent');
    if (status === 'out_missing') return t('office.stWait');
    return t('office.stOk');
  };
  const lateLabel = (n: number) => mins(n, value => t('office.minShort', { n: String(value) }));
  const ranged = mode !== 'day';

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

  const exportSheet = (kind: 'excel' | 'pdf') => {
    if (!data) return;
    const stamp = data.date || `${data.from}_${data.to}`;
    const head = [t('common.date'), t('office.colN'), t('office.colName'), t('office.colRole'), t('office.colStatus'), t('office.colIn'), t('office.colOut'), t('office.colWork'), t('office.colLate')];
    const rows = data.items.map(row => [date(row.date || data.date || ''), row.n, row.name, roleLabel(row.role), statusText(row.status), row.inHm || '—', row.outHm || '—', hhmm(row.workedMs), lateLabel(row.lateIn)]);
    if (kind === 'excel') {
      const csv = [head, ...rows].map(line => line.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(';')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
      a.download = `davomat-${stamp}.csv`;
      a.click();
      return;
    }
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    doc.setFontSize(14);
    doc.text(`${t('nav.officeReport')} · ${stamp}`, 14, 14);
    autoTable(doc, { startY: 20, head: [head], body: rows, styles: { fontSize: 8 }, headStyles: { fillColor: [47, 84, 235] } });
    doc.save(`davomat-${stamp}.pdf`);
  };

  const waitingNames = !ranged ? data?.items.filter(row => row.status === 'out_missing').map(row => row.name) ?? [] : [];
  const rows = ranged ? (data?.items || []).filter(row => row.status !== 'absent' || row.inHm) : (data?.items || []);

  return <div className="tabel">
    <div className="page-head">
      <div>
        <h1>{t('nav.officeReport')}</h1>
        <p>{t('office.reportSub')}</p>
      </div>
      <div className="page-actions">
        <button type="button" className="btn btn-secondary" onClick={() => void downloadQr()}><QrCode size={16}/> {t('office.qrDownload')}</button>
        <button type="button" className="btn btn-secondary" onClick={() => exportSheet('excel')}><Download size={16}/> {t('office.excel')}</button>
        <button type="button" className="btn btn-primary" onClick={() => exportSheet('pdf')}><FileText size={16}/> {t('office.pdf')}</button>
      </div>
    </div>
    {waitingNames.length > 0 && <div className="tabel-banner">{t('office.waitingBanner', { names: waitingNames.slice(0, 3).join(', ') })}</div>}
    <div className="tabel-day">
      {mode === 'day' && <>
        <button type="button" className="icon-btn" onClick={() => setDay(shift(day, -1))} aria-label={t('common.prevPage')}><ChevronLeft size={18}/></button>
        <b>{date(day)}</b>
        <button type="button" className="icon-btn" onClick={() => setDay(shift(day, 1))} aria-label={t('common.nextPage')}><ChevronRight size={18}/></button>
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setDay(tashkentDay())}>{t('common.today')}</button>
      </>}
      <button type="button" className={`btn btn-sm ${mode === 'day' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('day')}>{t('office.day')}</button>
      <button type="button" className={`btn btn-sm ${mode === 'week' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('week')}>{t('office.week')}</button>
      <button type="button" className={`btn btn-sm ${mode === 'month' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('month')}>{t('office.month')}</button>
    </div>
    {data?.stats && <div className="tabel-stats">
      <article><span>{t('office.statTotal')}</span><b>{fmt(data.stats.total)}</b></article>
      <article className="is-ok"><span>{t('office.statCame')}</span><b>{fmt(data.stats.came)}</b></article>
      <article className="is-bad"><span>{t('office.statAbsent')}</span><b>{fmt(data.stats.absent)}</b></article>
      <article className="is-warn"><span>{t('office.statLate')}</span><b>{fmt(data.stats.late)}</b></article>
      <article><span>{t('office.statWait')}</span><b>{fmt(data.stats.waiting)}</b></article>
      <article><span>{t('office.statOff')}</span><b>{fmt(data.stats.off)}</b></article>
    </div>}
    <section className="card table-card">
      <div className="card-head">
        <h2>{t('office.tabelTitle')}</h2>
        <span className="card-meta">{ranged ? `${date(data?.from)} – ${date(data?.to)}` : `${date(day)} · ${data?.start}–${data?.end}`}</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr>
            {ranged && <th>{t('common.date')}</th>}
            <th>{t('office.colN')}</th><th>{t('office.colName')}</th><th>{t('office.colRole')}</th><th>{t('office.colStatus')}</th>
            <th>{t('office.colIn')}</th><th>{t('office.colOut')}</th><th>{t('office.colWork')}</th><th>{t('office.colLate')}</th>
          </tr></thead>
          <tbody>
            {rows.map(row => <tr key={`${row.date || day}-${row.accountId}`}>
              {ranged && <td>{date(row.date || '')}</td>}
              <td>{row.n}</td>
              <td><b>{row.name}</b></td>
              <td>{roleLabel(row.role)}</td>
              <td><span className={`tabel-pill is-${row.status}`}>{statusText(row.status)}</span></td>
              <td>{row.inHm || '—'}</td>
              <td>{row.outHm || '—'}</td>
              <td>{hhmm(row.workedMs)}</td>
              <td>{lateLabel(row.lateIn)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </section>
  </div>;
}

export function OfficeTasksPage() {
  const { t, date } = useI18n();
  const [people, setPeople] = useState<Person[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [dueDate, setDueDate] = useState(tashkentDay());
  const [dueTime, setDueTime] = useState('18:00');
  const [priority, setPriority] = useState('normal');
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  const loadTasks = async () => {
    const response = await fetch('/api/office/tasks', { headers: officeHeaders() });
    if (response.ok) setTasks((await response.json() as { items: Task[] }).items);
  };
  useEffect(() => {
    void loadTasks();
    void fetch('/api/office/people', { headers: officeHeaders() }).then(async response => {
      if (response.ok) setPeople((await response.json() as { items: Person[] }).items);
    });
  }, []);

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
    await loadTasks();
  };

  const statusOf = (status: Task['status']) => {
    if (status === 'assigned') return t('office.accept');
    if (status === 'accepted') return t('office.working');
    return t('office.finished');
  };

  return <div className="tabel">
    <div className="page-head">
      <div>
        <h1>{t('nav.officeTasks')}</h1>
        <p>{t('office.tasksLead')}</p>
      </div>
    </div>
    <section className="card">
      <div className="card-head"><h2>{t('office.newTask')}</h2></div>
      <div className="form-grid">
        <label className="field"><span>{t('office.taskName')}</span><input className="input" value={title} onChange={e => setTitle(e.target.value)} maxLength={200}/></label>
        <label className="field"><span>{t('office.taskText')}</span><textarea className="input" value={body} onChange={e => setBody(e.target.value)} rows={4} maxLength={2000}/></label>
      </div>
      <div className="tabel-people">
        {people.map(item => (
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
    <section className="card">
      <div className="card-head"><h2>{t('office.tasks')}</h2><span className="card-meta">{tasks.length}</span></div>
      {tasks.length ? tasks.map(task => <article className="tabel-task" key={task.id}>
        <b>{task.title}</b>
        <p>{task.description || t('office.noDesc')}</p>
        <small>{date(task.dueDate)} {task.dueTime} · {task.assignees.map(item => item.name).join(', ')} · {statusOf(task.status)}{task.late ? ` · ${t('office.late')}` : ''}</small>
      </article>) : <p className="muted">{t('office.noTasks')}</p>}
    </section>
  </div>;
}
