import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, BarChart3, CalendarDays, CheckCircle2, ClipboardList, Eye, FileText,
  Check, ChevronDown, LayoutGrid, List, MessageSquare, Paperclip, PlayCircle, Plus, Search, Send, ShieldCheck, X,
} from 'lucide-react';
import { useI18n, type TKey } from '@/i18n';
import { officeHeaders } from '@/office';
import './office-report.css';
import './office-tasks.css';

type Status = 'assigned' | 'accepted' | 'progress' | 'review' | 'done';
type Priority = 'low' | 'normal' | 'high' | 'urgent';
type Column = 'late' | 'today' | 'progress' | 'review' | 'done';
type View = 'kanban' | 'calendar' | 'analysis' | 'list';
type Person = { id: string; name: string; login: string; role: string };
type Task = {
  id: string; title: string; description: string; dueDate: string; dueTime: string; priority: Priority;
  status: Status; remind?: boolean; late?: boolean; note?: string; comment?: string;
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
function sessionName() {
  try {
    return (JSON.parse(sessionStorage.getItem('smart-ombor-session') || '') as { name?: string }).name || 'Administrator';
  } catch {
    return 'Administrator';
  }
}

export function OfficeTasksPage() {
  const { t, date } = useI18n();
  const today = tashkentDay();
  const [people, setPeople] = useState<Person[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<View>('kanban');
  const [search, setSearch] = useState('');
  const [prioFilter, setPrioFilter] = useState<'all' | Priority>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [chip, setChip] = useState<'all' | 'week' | 'month' | 'urgent'>('all');
  const [openNew, setOpenNew] = useState(false);
  const [open, setOpen] = useState<Task | null>(null);
  const [sideTab, setSideTab] = useState<'chat' | 'files' | 'history'>('chat');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [dueDate, setDueDate] = useState(today);
  const [dueTime, setDueTime] = useState('18:00');
  const [priority, setPriority] = useState<Priority>('normal');
  const [picked, setPicked] = useState<string[]>([]);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [remindBefore, setRemindBefore] = useState('1d');
  const [recurring, setRecurring] = useState(false);
  const [recurringKind, setRecurringKind] = useState<'weekly' | 'daily' | 'monthly'>('weekly');
  const [acceptDeadline, setAcceptDeadline] = useState(false);
  const [visibility, setVisibility] = useState<'shared' | 'private'>('shared');
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [draftMsg, setDraftMsg] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const me = sessionName();

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
    const monthFrom = `${today.slice(0, 8)}01`;
    return tasks.filter(task => {
      if (q && !`${task.title} ${task.description} ${task.assignees.map(item => item.name).join(' ')}`.toLowerCase().includes(q)) return false;
      if (prioFilter !== 'all' && task.priority !== prioFilter) return false;
      if (from && task.dueDate < from) return false;
      if (to && task.dueDate > to) return false;
      if (chip === 'week') return task.dueDate >= weekFrom && task.dueDate <= today;
      if (chip === 'month') return task.dueDate >= monthFrom && task.dueDate <= today;
      if (chip === 'urgent') return task.priority === 'urgent' || task.priority === 'high';
      return true;
    });
  }, [tasks, search, chip, today, prioFilter, from, to]);

  const columns: Array<{ id: Column; title: TKey; empty: TKey; emptyOk?: TKey; icon: typeof AlertTriangle; tone: string; add?: boolean }> = [
    { id: 'late', title: 'office.colLateTasks', empty: 'office.emptyLate', emptyOk: 'office.emptyLateOk', icon: AlertTriangle, tone: 'late' },
    { id: 'today', title: 'office.colToday', empty: 'office.emptyToday', icon: CalendarDays, tone: 'today', add: true },
    { id: 'progress', title: 'office.colProgress', empty: 'office.emptyProgress', icon: PlayCircle, tone: 'progress', add: true },
    { id: 'review', title: 'office.colReview', empty: 'office.emptyReview', icon: ShieldCheck, tone: 'review' },
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

  const roleLabel = (role: string) => {
    const key = `role.${role}` as TKey;
    const label = t(key);
    return label === key ? role : label;
  };
  const peopleFiltered = useMemo(() => {
    const q = peopleQuery.trim().toLowerCase();
    return people.filter(item => {
      if (q && !`${item.name} ${item.login} ${item.role}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [people, peopleQuery]);
  const togglePerson = (id: string) => {
    setPicked(list => list.includes(id) ? list.filter(item => item !== id) : [...list, id]);
  };
  const resetForm = () => {
    setTitle(''); setBody(''); setPicked([]); setPriority('normal'); setDueDate(today); setDueTime('18:00');
    setRemindBefore('1d'); setRecurring(false); setRecurringKind('weekly'); setAcceptDeadline(false);
    setVisibility('shared'); setComment(''); setFiles([]); setDraftMsg(''); setNote(''); setSideTab('chat');
    setPeopleOpen(false); setPeopleQuery('');
  };
  const openCreate = () => { resetForm(); setOpenNew(true); };
  const createTask = async () => {
    setBusy(true); setNote('');
    const response = await fetch('/api/office/tasks', {
      method: 'POST', headers: officeHeaders(),
      body: JSON.stringify({
        title, description: body, assignedTo: picked, dueDate, dueTime, priority,
        remindBefore, recurring: recurring ? recurringKind : '', acceptDeadline, visibility, comment,
        splitAssignees: true,
      }),
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
  const views: Array<[View, TKey, typeof LayoutGrid]> = [
    ['kanban', 'office.viewKanban', LayoutGrid],
    ['calendar', 'office.viewCalendar', CalendarDays],
    ['analysis', 'office.viewAnalysis', BarChart3],
    ['list', 'office.viewList', List],
  ];
  const chips: Array<['all' | 'week' | 'month' | 'urgent', TKey]> = [
    ['all', 'common.all'], ['week', 'office.quickWeek'], ['month', 'office.quickMonth'], ['urgent', 'office.quickUrgent'],
  ];
  const statCards: Array<{ label: string; value: number; tone: string; icon: ReactNode }> = [
    { label: t('common.total'), value: stats.total, tone: '', icon: <ClipboardList size={18}/> },
    { label: t('office.colLateTasks'), value: stats.late, tone: 'is-late', icon: <AlertTriangle size={18}/> },
    { label: t('office.colToday'), value: stats.today, tone: 'is-today', icon: <CalendarDays size={18}/> },
    { label: t('office.colProgress'), value: stats.progress, tone: 'is-progress', icon: <PlayCircle size={18}/> },
    { label: t('office.colReview'), value: stats.review, tone: 'is-review', icon: <ShieldCheck size={18}/> },
    { label: t('office.colDone'), value: stats.done, tone: 'is-done', icon: <CheckCircle2 size={18}/> },
  ];

  const card = (task: Task) => (
    <article key={task.id} className={`task-card is-${task.priority}${task.late ? ' is-late-card' : ''}`} onClick={() => setOpen(task)}>
      <div className="task-card-top">
        <span className={`tabel-pill is-${task.priority}`}>{prioLabel(task.priority)}</span>
        <span className={`tabel-pill is-${task.status}`}>{statusLabel(task.status)}</span>
      </div>
      <b>{task.title}</b>
      <p>{task.description || t('office.noDesc')}</p>
      <div className="task-card-meta">
        <span><CalendarDays size={13}/> {date(task.dueDate)} {task.dueTime}</span>
        <span className="task-card-people">
          {task.assignees.slice(0, 3).map(item => <i key={item.id} title={item.name}>{item.name.slice(0, 1)}</i>)}
          <em>{task.assignees.map(item => item.name).join(', ') || '—'}</em>
        </span>
      </div>
    </article>
  );

  const monthDays = useMemo(() => {
    const [y, m] = today.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const startPad = (first.getUTCDay() + 6) % 7;
    const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells: Array<{ day: string; n: number } | null> = [];
    for (let i = 0; i < startPad; i++) cells.push(null);
    for (let d = 1; d <= daysIn; d++) {
      const day = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ day, n: d });
    }
    return cells;
  }, [today]);

  return <div className="tasks">
    <div className="task-hero">
      <div className="page-head">
        <div>
          <p className="task-kicker">{t('nav.office')}</p>
          <h1>{t('nav.officeTasks')}</h1>
          <p>{t('office.tasksLead')}</p>
        </div>
        <div className="page-actions task-head-actions">
          <div className="task-view-modes">
            {views.map(([id, key, Icon]) => (
              <button type="button" key={id} className={view === id ? 'is-on' : ''} onClick={() => setView(id)}>
                <Icon size={15}/> {t(key)}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-primary task-cta" onClick={openCreate}><Plus size={16}/> {t('office.addTask')}</button>
        </div>
      </div>

      <div className="task-stats">
        {statCards.map(item => (
          <div key={item.label} className={`task-stat ${item.tone}`}>
            <span className="task-stat-ico">{item.icon}</span>
            <span>{item.label}</span>
            <b>{item.value}</b>
            <div className="task-stat-bar"><i style={{ width: `${pct(item.value)}%` }}/></div>
            <small>{pct(item.value)}%</small>
          </div>
        ))}
      </div>
    </div>

    <div className="task-tools">
      <label className="task-search"><Search size={16}/><input className="input" value={search} onChange={event => setSearch(event.target.value)} placeholder={t('office.taskSearch')} aria-label={t('office.taskSearch')}/></label>
      <select className="input task-select" value={prioFilter} onChange={event => setPrioFilter(event.target.value as 'all' | Priority)} aria-label={t('office.importance')}>
        <option value="all">{t('office.allPriority')}</option>
        <option value="low">{t('office.pLow')}</option>
        <option value="normal">{t('office.pMid')}</option>
        <option value="high">{t('office.pHigh')}</option>
        <option value="urgent">{t('office.pNow')}</option>
      </select>
      <label className="task-date-chip"><span>{t('office.from')}</span><input className="input" type="date" value={from} onChange={event => setFrom(event.target.value)}/></label>
      <label className="task-date-chip"><span>{t('office.to')}</span><input className="input" type="date" value={to} onChange={event => setTo(event.target.value)}/></label>
      <div className="task-chips">
        {chips.map(([id, key]) => (
          <button type="button" key={id} className={`${chip === id ? 'is-on' : ''} ${id === 'urgent' ? 'is-warn' : ''}`} onClick={() => setChip(id)}>{t(key)}</button>
        ))}
      </div>
    </div>

    {view === 'kanban' && <div className="task-board">
      {columns.map(col => {
        const rows = grouped[col.id];
        const share = stats.total ? Math.round((rows.length / stats.total) * 100) : 0;
        return <section key={col.id} className={`task-col is-${col.tone}`}>
          <header>
            <span className="task-col-ico"><col.icon size={15}/></span>
            <div>
              <b>{t(col.title)}</b>
              <div className="task-col-bar"><i style={{ width: `${share}%` }}/></div>
            </div>
            <em>{rows.length}</em>
          </header>
          <div className="task-col-body">
            {rows.length ? rows.map(card) : <div className="task-empty-box">
              <span className="task-empty-mark"><col.icon size={22}/></span>
              <p className="task-empty">{t(col.emptyOk || col.empty)}</p>
              {col.add && <button type="button" className="task-ghost-add" onClick={openCreate}><Plus size={14}/> {t('office.addInCol')}</button>}
            </div>}
          </div>
          <button type="button" className="task-col-add" onClick={openCreate}><Plus size={14}/> {t('office.addTask')}</button>
        </section>;
      })}
    </div>}

    {view === 'list' && <section className="card">
      {filtered.length ? filtered.map(task => <article className="tabel-task" key={task.id} onClick={() => setOpen(task)}>
        <b>{task.title}</b>
        <p>{task.description || t('office.noDesc')}</p>
        <small>{date(task.dueDate)} {task.dueTime} · {task.assignees.map(item => item.name).join(', ')} · {statusLabel(task.status)}{task.late ? ` · ${t('office.late')}` : ''}</small>
      </article>) : <p className="muted">{t('office.noTasks')}</p>}
    </section>}

    {view === 'calendar' && <section className="card task-calendar">
      <div className="card-head"><h2>{t('office.viewCalendar')}</h2><span className="card-meta">{date(today)}</span></div>
      <div className="task-cal-grid">
        {monthDays.map((cell, index) => cell ? (
          <button type="button" key={cell.day} className={`task-cal-day ${cell.day === today ? 'is-today' : ''} ${tasks.some(task => task.dueDate === cell.day) ? 'has-task' : ''}`} onClick={() => { setFrom(cell.day); setTo(cell.day); setChip('all'); setView('list'); }}>
            <b>{cell.n}</b>
            <em>{tasks.filter(task => task.dueDate === cell.day).length || ''}</em>
          </button>
        ) : <span key={`pad-${index}`} className="task-cal-day is-pad"/>)}
      </div>
    </section>}

    {view === 'analysis' && <section className="card task-analysis">
      <div className="card-head"><h2>{t('office.viewAnalysis')}</h2></div>
      <div className="task-analysis-grid">
        {statCards.map(item => (
          <div key={item.id} className={`task-analysis-card ${item.tone}`}>
            <span>{item.label}</span>
            <b>{item.value}</b>
            <div className="task-col-bar"><i style={{ width: `${pct(item.value)}%` }}/></div>
            <small>{pct(item.value)}%</small>
          </div>
        ))}
      </div>
    </section>}

    {openNew && createPortal(<div className="backdrop task-backdrop" onClick={() => setOpenNew(false)}>
      <form className="modal task-editor-full" onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void createTask(); }} role="dialog" aria-labelledby="task-new-title">
        <div className="modal-top task-editor-top">
          <div>
            <span className="task-role-badge">{t('office.giver')}</span>
            <h2 id="task-new-title">{t('office.newTaskFull')}</h2>
            <p>{t('office.newTaskSub')}</p>
          </div>
          <button type="button" className="icon-btn" onClick={() => setOpenNew(false)} aria-label={t('common.close')}><X size={18}/></button>
        </div>

        <div className="task-editor-3">
          <div className="task-pane">
            <section className="task-block">
              <h3>{t('office.mainInfo')}</h3>
              <label className="field"><span>{t('office.taskName')}<em>{title.length}/200</em></span>
                <input className="input" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} placeholder={t('office.taskNamePh')} required/>
              </label>
              <label className="field"><span>{t('office.taskDesc')}<em>{body.length}/2000</em></span>
                <textarea className="input task-textarea" value={body} onChange={event => setBody(event.target.value)} rows={5} maxLength={2000} placeholder={t('office.taskText')}/>
              </label>
            </section>
            <section className="task-block task-assignee-block">
              <div className="task-block-head">
                <h3>{t('office.assignees')}</h3>
                <span className="task-picked">{picked.length} {t('office.selected')}</span>
              </div>
              <p className="muted task-hint">{t('office.assigneesHint')}</p>
              <div className={`task-picker ${peopleOpen ? 'is-open' : ''}`}>
                <button type="button" className="task-picker-trigger" onClick={() => setPeopleOpen(open => !open)} aria-expanded={peopleOpen}>
                  <span>{picked.length ? t('office.selectedCount', { n: picked.length }) : t('office.pickEmployee')}</span>
                  <ChevronDown size={16}/>
                </button>
                {peopleOpen && <div className="task-picker-menu">
                  <label className="task-picker-search"><Search size={15}/><input className="input" value={peopleQuery} onChange={event => setPeopleQuery(event.target.value)} placeholder={t('office.taskSearch')} autoFocus/></label>
                  <div className="task-picker-list">
                    {peopleFiltered.length ? peopleFiltered.map(item => {
                      const on = picked.includes(item.id);
                      return <button type="button" key={item.id} className={on ? 'is-on' : ''} onClick={() => togglePerson(item.id)}>
                        <span className="task-avatar">{item.name.slice(0, 1)}</span>
                        <span className="task-picker-meta"><b>{item.name}</b><small>{roleLabel(item.role)}</small></span>
                        {on && <Check size={16}/>}
                      </button>;
                    }) : <p className="muted task-picker-empty">{people.length ? t('office.empty') : t('office.noPeople')}</p>}
                  </div>
                </div>}
              </div>
              {picked.length > 0 && <div className="task-people">
                {picked.map(id => {
                  const item = people.find(row => row.id === id);
                  if (!item) return null;
                  return <button type="button" key={id} className="is-on" onClick={() => togglePerson(id)}>
                    <span className="task-avatar">{item.name.slice(0, 1)}</span>
                    {item.name}
                    <X size={14}/>
                  </button>;
                })}
              </div>}
            </section>
            <section className="task-block">
              <h3>{t('office.deadlineBlock')}</h3>
              <div className="form-grid">
                <label className="field"><span>{t('common.date')}</span><input className="input" type="date" value={dueDate} onChange={event => setDueDate(event.target.value)}/></label>
                <label className="field"><span>{t('office.dueTime')}</span><input className="input" type="time" value={dueTime} onChange={event => setDueTime(event.target.value)}/></label>
              </div>
              <p className="field-label">{t('office.importance')}</p>
              <div className="task-prio">
                {([['low', 'office.pLow'], ['normal', 'office.pMid'], ['high', 'office.pHigh'], ['urgent', 'office.pNow']] as const).map(([id, key]) => (
                  <button type="button" key={id} className={`is-${id} ${priority === id ? 'is-on' : ''}`} onClick={() => setPriority(id)}>{t(key)}</button>
                ))}
              </div>
              <label className="task-check"><input type="checkbox" checked={acceptDeadline} onChange={event => setAcceptDeadline(event.target.checked)}/> <span><b>{t('office.acceptDeadline')}</b><small>{t('office.acceptDeadlineHint')}</small></span></label>
            </section>
            <section className="task-block">
              <h3>{t('office.filesBlock')}</h3>
              <label className="task-drop">
                <span className="task-drop-ico"><Paperclip size={18}/></span>
                <span>{t('office.filesDrop')}</span>
                <small>{t('office.filesHint')}</small>
                <input type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.mp4" onChange={event => setFiles(Array.from(event.target.files || []).slice(0, 5))}/>
              </label>
              {files.length > 0 && <ul className="task-file-list">{files.map(file => <li key={file.name}>{file.name}</li>)}</ul>}
              <label className="field"><span>{t('office.extraComment')}<em>{comment.length}/500</em></span>
                <textarea className="input" value={comment} onChange={event => setComment(event.target.value)} rows={2} maxLength={500} placeholder={t('office.extraCommentPh')}/>
              </label>
            </section>
          </div>

          <div className="task-pane">
            <section className="task-block task-giver">
              <span className="task-avatar is-lg">{me.slice(0, 1)}</span>
              <div>
                <span className="task-role-badge">{t('office.giver')}</span>
                <b>{t('office.you')} · {me}</b>
                <em>{t('office.auto')}</em>
              </div>
            </section>
            <section className="task-block">
              <h3>{t('office.taskStatus')}</h3>
              <ol className="task-flow">
                {([
                  ['office.stNew', 'office.stNewHint', true],
                  ['office.stAccepted', 'office.stAcceptedHint', false],
                  ['office.stProgress', 'office.stProgressHint', false],
                  ['office.late', 'office.stLateHint', false],
                  ['office.stReview', 'office.stReviewHint', false],
                  ['office.colDone', 'office.stDoneHint', false],
                ] as const).map(([titleKey, hintKey, on]) => (
                  <li key={titleKey} className={on ? 'is-on' : ''}>
                    <span className="task-flow-dot"/>
                    <div>
                      <b>{t(titleKey)}{on && <i>{t('office.nowTag')}</i>}</b>
                      <span>{t(hintKey)}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
            <section className="task-block">
              <h3>{t('office.remind')}</h3>
              <select className="input" value={remindBefore} onChange={event => setRemindBefore(event.target.value)}>
                <option value="none">{t('office.remindNone')}</option>
                <option value="1h">{t('office.remind1h')}</option>
                <option value="1d">{t('office.remind1d')}</option>
                <option value="2d">{t('office.remind2d')}</option>
                <option value="1w">{t('office.remind1w')}</option>
              </select>
              <p className="muted task-hint">{t('office.remindHint')}</p>
              <label className="task-check"><input type="checkbox" checked={recurring} onChange={event => setRecurring(event.target.checked)}/> <span><b>{t('office.recurring')}</b></span></label>
              {recurring && <select className="input" value={recurringKind} onChange={event => setRecurringKind(event.target.value as 'weekly' | 'daily' | 'monthly')}>
                <option value="daily">{t('office.recDaily')}</option>
                <option value="weekly">{t('office.recWeekly')}</option>
                <option value="monthly">{t('office.recMonthly')}</option>
              </select>}
              <p className="field-label">{t('office.visibility')}</p>
              <div className="task-seg">
                <button type="button" className={visibility === 'shared' ? 'is-on' : ''} onClick={() => setVisibility('shared')}>{t('office.visShared')}</button>
                <button type="button" className={visibility === 'private' ? 'is-on' : ''} onClick={() => setVisibility('private')}>{t('office.visPrivate')}</button>
              </div>
            </section>
          </div>

          <div className="task-pane task-side">
            <div className="task-side-tabs">
              <button type="button" className={sideTab === 'chat' ? 'is-on' : ''} onClick={() => setSideTab('chat')}><MessageSquare size={15}/> {t('office.tabChat')}</button>
              <button type="button" className={sideTab === 'files' ? 'is-on' : ''} onClick={() => setSideTab('files')}><FileText size={15}/> {t('office.tabFiles')}</button>
              <button type="button" className={sideTab === 'history' ? 'is-on' : ''} onClick={() => setSideTab('history')}><ClipboardList size={15}/> {t('office.tabHistory')}</button>
            </div>
            <div className="task-side-body">
              {sideTab === 'chat' && <>
                <p className="task-side-head">{picked.length ? picked.map(id => people.find(item => item.id === id)?.name || id).join(', ') : t('office.pickAssigneesFirst')}</p>
                <div className="task-side-empty">
                  <span className="task-empty-ico"><MessageSquare size={28}/></span>
                  <b>{t('office.noChat')}</b>
                  <span>{t('office.noChatBody')}</span>
                </div>
                <div className="task-chat-input">
                  <input className="input" value={draftMsg} onChange={event => setDraftMsg(event.target.value)} placeholder={t('office.chatPh')} disabled={!picked.length}/>
                  <button type="button" className="btn btn-primary btn-sm" disabled={!picked.length || !draftMsg.trim()} onClick={() => setDraftMsg('')} aria-label={t('office.tabChat')}><Send size={14}/></button>
                </div>
                <p className="muted task-hint">{t('office.chatSaveHint')}</p>
              </>}
              {sideTab === 'files' && <div className="task-side-empty">
                <span className="task-empty-ico"><Paperclip size={28}/></span>
                <b>{files.length ? `${files.length}` : t('office.noFiles')}</b>
                <span>{files.length ? files.map(file => file.name).join(', ') : t('office.filesHint')}</span>
              </div>}
              {sideTab === 'history' && <div className="task-side-empty">
                <span className="task-empty-ico"><ClipboardList size={28}/></span>
                <b>{t('office.noHistory')}</b>
                <span>{t('office.noHistoryBody')}</span>
              </div>}
            </div>
          </div>
        </div>

        <div className="task-editor-foot">
          {note && <p className="muted">{note}</p>}
          <div className="task-create-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setOpenNew(false)}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !title.trim() || !picked.length}><Send size={16}/> {t('office.createTask')}</button>
          </div>
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
        {open.comment && <p className="muted">{open.comment}</p>}
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
