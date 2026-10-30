import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CalendarDays, CheckCircle2, ClipboardList, Eye, LayoutGrid, List, Plus, Search, X } from 'lucide-react';
import { useI18n, type TKey } from '@/i18n';
import { officeHeaders } from '@/office';
import './office-report.css';
import './office-tasks.css';

type Status = 'assigned' | 'accepted' | 'progress' | 'review' | 'done';
type Priority = 'low' | 'normal' | 'high' | 'urgent';
type Column = 'late' | 'today' | 'progress' | 'review' | 'done';
type Person = { id: string; name: string; login: string; role: string };
type Task = {
  id: string; title: string; description: string; dueDate: string; dueTime: string; priority: Priority;
  status: Status; remind?: boolean; late?: boolean; note?: string;
  assignees: Array<{ id: string; name: string }>;
};

function tashkentDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
}
function shift(day: string, by: number) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
}
function columnOf(task: Task, today: string): Column {
  if (task.status === 'done') return 'done';
  if (task.status === 'review') return 'review';
  if (task.late) return 'late';
  if (task.dueDate === today) return 'today';
  return 'progress';
}

export function OfficeTasksPage() {
  const { t, date } = useI18n();
  const today = tashkentDay();
  const [people, setPeople] = useState<Person[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<'kanban' | 'list'>('kanban');
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState<'all' | 'today' | 'week' | 'urgent' | 'late' | 'review'>('all');
  const [openNew, setOpenNew] = useState(false);
  const [open, setOpen] = useState<Task | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [dueDate, setDueDate] = useState(today);
  const [dueTime, setDueTime] = useState('18:00');
  const [priority, setPriority] = useState<Priority>('normal');
  const [picked, setPicked] = useState<string[]>([]);
  const [remind, setRemind] = useState(true);
  const [note, setNote] = useState('');
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const weekFrom = shift(today, -6);
    return tasks.filter(task => {
      if (q && !`${task.title} ${task.description} ${task.assignees.map(item => item.name).join(' ')}`.toLowerCase().includes(q)) return false;
      if (chip === 'today') return task.dueDate === today && task.status !== 'done';
      if (chip === 'week') return task.dueDate >= weekFrom && task.dueDate <= today;
      if (chip === 'urgent') return task.priority === 'urgent' || task.priority === 'high';
      if (chip === 'late') return Boolean(task.late) && task.status !== 'done';
      if (chip === 'review') return task.status === 'review';
      return true;
    });
  }, [tasks, search, chip, today]);

  const columns: Array<{ id: Column; title: TKey; empty: TKey; icon: typeof AlertTriangle; tone: string }> = [
    { id: 'late', title: 'office.colLateTasks', empty: 'office.emptyLate', icon: AlertTriangle, tone: 'late' },
    { id: 'today', title: 'office.colToday', empty: 'office.emptyToday', icon: CalendarDays, tone: 'today' },
    { id: 'progress', title: 'office.colProgress', empty: 'office.emptyProgress', icon: ClipboardList, tone: 'progress' },
    { id: 'review', title: 'office.colReview', empty: 'office.emptyReview', icon: Eye, tone: 'review' },
    { id: 'done', title: 'office.colDone', empty: 'office.emptyDone', icon: CheckCircle2, tone: 'done' },
  ];
  const grouped = Object.fromEntries(columns.map(col => [col.id, filtered.filter(task => columnOf(task, today) === col.id)])) as Record<Column, Task[]>;
  const stats = {
    total: tasks.length,
    late: tasks.filter(task => task.late && task.status !== 'done').length,
    today: tasks.filter(task => columnOf(task, today) === 'today').length,
    progress: tasks.filter(task => columnOf(task, today) === 'progress').length,
    review: tasks.filter(task => task.status === 'review').length,
    done: tasks.filter(task => task.status === 'done').length,
  };
  const pct = (n: number) => stats.total ? Math.round((n / stats.total) * 100) : 0;

  const resetForm = () => {
    setTitle(''); setBody(''); setPicked([]); setPriority('normal'); setDueDate(today); setDueTime('18:00'); setRemind(true); setNote('');
  };
  const createTask = async () => {
    setBusy(true); setNote('');
    const response = await fetch('/api/office/tasks', {
      method: 'POST', headers: officeHeaders(),
      body: JSON.stringify({ title, description: body, assignedTo: picked, dueDate, dueTime, priority, remind }),
    });
    setBusy(false);
    if (!response.ok) { setNote(t('office.taskNeed')); return; }
    resetForm();
    setOpenNew(false);
    await loadTasks();
  };
  const patch = async (id: string, status: Status) => {
    await fetch(`/api/office/tasks/${id}`, { method: 'PATCH', headers: officeHeaders(), body: JSON.stringify({ status }) });
    await loadTasks();
    setOpen(current => current && current.id === id ? { ...current, status, late: status === 'done' ? false : current.late } : current);
  };

  const statusLabel = (status: Status) => {
    if (status === 'assigned') return t('office.stNew');
    if (status === 'accepted') return t('office.stAccepted');
    if (status === 'progress') return t('office.stProgress');
    if (status === 'review') return t('office.stReview');
    return t('office.colDone');
  };
  const prioLabel = (value: Priority) => t((value === 'low' ? 'office.pLow' : value === 'high' ? 'office.pHigh' : value === 'urgent' ? 'office.pNow' : 'office.pMid') as TKey);
  const chips: Array<['all' | 'today' | 'week' | 'urgent' | 'late' | 'review', TKey]> = [
    ['all', 'common.all'], ['today', 'office.quickToday'], ['week', 'office.quickWeek'],
    ['urgent', 'office.quickUrgent'], ['late', 'office.quickLate'], ['review', 'office.quickReview'],
  ];

  const card = (task: Task) => (
    <article key={task.id} className={`task-card is-${task.priority}`} onClick={() => setOpen(task)}>
      <b>{task.title}</b>
      <p>{task.description || t('office.noDesc')}</p>
      <small>{date(task.dueDate)} {task.dueTime} · {task.assignees.map(item => item.name).join(', ') || '—'}</small>
      <div className="task-card-foot">
        <span className={`tabel-pill is-${task.priority}`}>{prioLabel(task.priority)}</span>
        <span className={`tabel-pill is-${task.status}`}>{statusLabel(task.status)}</span>
      </div>
    </article>
  );

  return <div className="tasks">
    <div className="page-head">
      <div>
        <h1>{t('nav.officeTasks')}</h1>
        <p>{t('office.tasksLead')}</p>
      </div>
      <div className="page-actions">
        <div className="tabel-day-modes">
          <button type="button" className={`btn btn-sm ${view === 'kanban' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('kanban')}><LayoutGrid size={15}/> {t('office.viewKanban')}</button>
          <button type="button" className={`btn btn-sm ${view === 'list' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('list')}><List size={15}/> {t('office.viewList')}</button>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => { resetForm(); setOpenNew(true); }}><Plus size={16}/> {t('office.addTask')}</button>
      </div>
    </div>
    <div className="task-stats">
      {([
        ['total', t('common.total'), stats.total, ''],
        ['late', t('office.colLateTasks'), stats.late, 'is-late'],
        ['today', t('office.colToday'), stats.today, 'is-today'],
        ['progress', t('office.colProgress'), stats.progress, 'is-progress'],
        ['review', t('office.colReview'), stats.review, 'is-review'],
        ['done', t('office.colDone'), stats.done, 'is-done'],
      ] as const).map(([id, label, value, tone]) => (
        <button type="button" key={id} className={`task-stat ${tone} ${(id === 'total' && chip === 'all') || chip === id ? 'is-on' : ''}`} onClick={() => setChip(id === 'total' ? 'all' : id === 'progress' ? 'all' : id === 'done' ? 'all' : id)}>
          <span>{label}</span>
          <b>{value}</b>
          <small>{pct(value)}%</small>
        </button>
      ))}
    </div>
    <div className="task-tools">
      <label className="search"><Search size={16}/><input className="input" value={search} onChange={event => setSearch(event.target.value)} placeholder={t('common.search')} aria-label={t('common.search')}/></label>
      <div className="tabel-chips">
        {chips.map(([id, key]) => (
          <button type="button" key={id} className={chip === id ? 'is-on' : ''} onClick={() => setChip(id)}>{t(key)}</button>
        ))}
      </div>
    </div>
    {view === 'kanban' ? <div className="task-board">
      {columns.map(col => (
        <section key={col.id} className={`task-col is-${col.tone}`}>
          <header>
            <col.icon size={16}/>
            <b>{t(col.title)}</b>
            <em>{grouped[col.id].length}</em>
          </header>
          {grouped[col.id].length ? grouped[col.id].map(card) : <p className="task-empty">{t(col.empty)}</p>}
        </section>
      ))}
    </div> : <section className="card">
      {filtered.length ? filtered.map(task => <article className="tabel-task" key={task.id} onClick={() => setOpen(task)}>
        <b>{task.title}</b>
        <p>{task.description || t('office.noDesc')}</p>
        <small>{date(task.dueDate)} {task.dueTime} · {task.assignees.map(item => item.name).join(', ')} · {statusLabel(task.status)}{task.late ? ` · ${t('office.late')}` : ''}</small>
      </article>) : <p className="muted">{t('office.noTasks')}</p>}
    </section>}

    {openNew && createPortal(<div className="backdrop" onClick={() => setOpenNew(false)}>
      <form className="modal task-editor" onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void createTask(); }} role="dialog" aria-labelledby="task-new-title">
        <div className="modal-top">
          <div>
            <p className="eyebrow">{t('office.addTask')}</p>
            <h2 id="task-new-title">{t('office.newTask')}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={() => setOpenNew(false)} aria-label={t('common.close')}><X size={18}/></button>
        </div>
        <div className="task-editor-grid">
          <div>
            <label className="field"><span>{t('office.taskName')} · {title.length}/200</span><input className="input" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required/></label>
            <label className="field"><span>{t('office.taskText')} · {body.length}/2000</span><textarea className="input" value={body} onChange={event => setBody(event.target.value)} rows={5} maxLength={2000}/></label>
            <p className="field-label">{t('office.assignees')}</p>
            <div className="tabel-people">
              {people.length ? people.map(item => (
                <button type="button" key={item.id} className={picked.includes(item.id) ? 'is-on' : ''} onClick={() => setPicked(list => list.includes(item.id) ? list.filter(id => id !== item.id) : [...list, item.id])}>{item.name}</button>
              )) : <p className="muted">{t('office.noPeople')}</p>}
            </div>
          </div>
          <div>
            <div className="form-grid">
              <label className="field"><span>{t('common.date')}</span><input className="input" type="date" value={dueDate} onChange={event => setDueDate(event.target.value)}/></label>
              <label className="field"><span>{t('office.dueTime')}</span><input className="input" type="time" value={dueTime} onChange={event => setDueTime(event.target.value)}/></label>
            </div>
            <p className="field-label">{t('office.importance')}</p>
            <div className="tabel-prio">
              {([['low', 'office.pLow'], ['normal', 'office.pMid'], ['high', 'office.pHigh'], ['urgent', 'office.pNow']] as const).map(([id, key]) => (
                <button type="button" key={id} className={`is-${id} ${priority === id ? 'is-on' : ''}`} onClick={() => setPriority(id)}>{t(key)}</button>
              ))}
            </div>
            <label className="task-check"><input type="checkbox" checked={remind} onChange={event => setRemind(event.target.checked)}/> {t('office.remind')}</label>
            <ol className="task-flow">
              <li className="is-on"><b>{t('office.stNew')}</b><span>{t('office.stNewHint')}</span></li>
              <li><b>{t('office.stAccepted')}</b><span>{t('office.stAcceptedHint')}</span></li>
              <li><b>{t('office.stProgress')}</b><span>{t('office.stProgressHint')}</span></li>
              <li><b>{t('office.stReview')}</b><span>{t('office.stReviewHint')}</span></li>
              <li><b>{t('office.colDone')}</b><span>{t('office.stDoneHint')}</span></li>
            </ol>
          </div>
        </div>
        {note && <p className="muted">{note}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setOpenNew(false)}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !title.trim() || !picked.length}>{t('office.createTask')}</button>
        </div>
      </form>
    </div>, document.body)}

    {open && createPortal(<div className="backdrop" onClick={() => setOpen(null)}>
      <div className="modal" onClick={event => event.stopPropagation()} role="dialog" aria-labelledby="task-open-title">
        <div className="modal-top">
          <div>
            <p className="eyebrow">{date(open.dueDate)} {open.dueTime} · {statusLabel(open.status)}</p>
            <h2 id="task-open-title">{open.title}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={() => setOpen(null)} aria-label={t('common.close')}><X size={18}/></button>
        </div>
        <p>{open.description || t('office.noDesc')}</p>
        <p className="muted">{open.assignees.map(item => item.name).join(', ')} · {prioLabel(open.priority)}{open.late ? ` · ${t('office.late')}` : ''}</p>
        <div className="form-actions">
          {open.status === 'assigned' && <button type="button" className="btn btn-secondary" onClick={() => void patch(open.id, 'accepted')}>{t('office.accept')}</button>}
          {open.status === 'accepted' && <button type="button" className="btn btn-secondary" onClick={() => void patch(open.id, 'progress')}>{t('office.start')}</button>}
          {(open.status === 'assigned' || open.status === 'accepted' || open.status === 'progress') && <button type="button" className="btn btn-secondary" onClick={() => void patch(open.id, 'review')}>{t('office.sendReview')}</button>}
          {open.status === 'review' && <button type="button" className="btn btn-primary" onClick={() => void patch(open.id, 'done')}>{t('office.confirm')}</button>}
          {open.status === 'done' && <span className="task-ok">{t('office.finished')}</span>}
        </div>
      </div>
    </div>, document.body)}
  </div>;
}
