import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType, EncodeHintType, QRCodeWriter } from '@zxing/library';
import { Clock3, Fingerprint, LogOut, MapPin, QrCode } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { useI18n, type TKey } from '@/i18n';
import './office.css';

type Punch = { date: string; inAt: string | null; outAt: string | null; workedMs: number };
type Me = {
  id: string; name: string; login: string; role: string; director: boolean; face: boolean;
  office: { name: string; lat: number; lng: number; radiusM: number; accuracyM: number; start: string; end: string };
  clock: string; date: string; today: Punch | null; fiksa: number;
};
type Task = {
  id: string; title: string; description: string; dueDate: string; dueTime: string; priority: string;
  status: 'assigned' | 'accepted' | 'done'; assignees: Array<{ id: string; name: string }>; late?: boolean;
};
type Person = { id: string; name: string; login: string; role: string };
type BoardRow = { accountId: string; name: string; login: string; inAt: string | null; outAt: string | null; workedMs: number };

const SESSION = 'smart-ombor-session';
const QR_HINTS = new Map<DecodeHintType, unknown>([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]]]);

function session() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SESSION) || '') as { token?: string; role?: string };
    return parsed.token ? parsed : null;
  } catch {
    return null;
  }
}
function headers() {
  return { authorization: `Bearer ${session()?.token || ''}`, 'content-type': 'application/json' };
}
function tashkentClock(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
}
function tashkentDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(date);
}
function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = (n: number) => n * Math.PI / 180;
  const dLat = r(lat2 - lat1); const dLng = r(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function hhmmss(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
function faceHash(video: HTMLVideoElement) {
  const canvas = document.createElement('canvas');
  canvas.width = 9; canvas.height = 8;
  const ctx = canvas.getContext('2d');
  if (!ctx || !video.videoWidth) return null;
  const side = Math.min(video.videoWidth, video.videoHeight) * 0.72;
  const sx = (video.videoWidth - side) / 2;
  const sy = Math.max(0, (video.videoHeight - side) / 2 - side * 0.08);
  ctx.drawImage(video, sx, sy, side, side, 0, 0, 9, 8);
  const data = ctx.getImageData(0, 0, 9, 8).data;
  const gray: number[] = [];
  for (let i = 0; i < 72; i += 1) {
    const p = i * 4;
    gray.push(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
  }
  const avg = gray.reduce((sum, value) => sum + value, 0) / gray.length;
  const variance = gray.reduce((sum, value) => sum + (value - avg) ** 2, 0) / gray.length;
  if (variance < 48) return null;
  let bits = '';
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) bits += gray[y * 9 + x] > gray[y * 9 + x + 1] ? '1' : '0';
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
function heading(iso: string, weekdays: string, months: string) {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return { weekday: '', line: iso };
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  const weekday = weekdays.split(',')[date.getUTCDay()] || '';
  const label = months.split(',')[month - 1] || '';
  const cap = label ? label.charAt(0).toUpperCase() + label.slice(1) : '';
  return { weekday, line: `${day} ${cap} ${year}` };
}

function QrMark({ value }: { value: string }) {
  const svg = useMemo(() => {
    try {
      const hints = new Map<EncodeHintType, unknown>([[EncodeHintType.MARGIN, 1]]);
      const matrix = new QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 160, 160, hints);
      const n = matrix.getWidth();
      const cells: string[] = [];
      for (let y = 0; y < n; y += 1) {
        for (let x = 0; x < n; x += 1) {
          if (matrix.get(x, y)) cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
        }
      }
      return { n, html: cells.join('') };
    } catch {
      return { n: 1, html: '' };
    }
  }, [value]);
  return <svg className="office-qr" viewBox={`0 0 ${svg.n} ${svg.n}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg.html }}/>;
}

export function OfficePage() {
  const { t, lang, setLang, date, time, money } = useI18n();
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<'attend' | 'tasks' | 'admin'>('attend');
  const [me, setMe] = useState<Me | null>(null);
  const [clock, setClock] = useState(tashkentClock());
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [gpsErr, setGpsErr] = useState('');
  const [method, setMethod] = useState<'face' | 'qr'>('face');
  const [cam, setCam] = useState<'off' | 'ask' | 'on' | 'denied'>('ask');
  const [note, setNote] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState<'day' | 'week' | 'month'>('week');
  const [history, setHistory] = useState<Punch[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [board, setBoard] = useState<BoardRow[]>([]);
  const [qr, setQr] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [dueDate, setDueDate] = useState(tashkentDay());
  const [dueTime, setDueTime] = useState('18:00');
  const [priority, setPriority] = useState('normal');
  const [picked, setPicked] = useState<string[]>([]);
  const [remind, setRemind] = useState(true);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const scanStop = useRef(false);

  const loadMe = async () => {
    const response = await fetch('/api/office/me', { headers: headers() });
    if (response.status === 401) { sessionStorage.removeItem(SESSION); setLocation('/'); return; }
    if (response.ok) setMe(await response.json());
  };
  const loadHistory = async (next = range) => {
    const response = await fetch(`/api/office/history?range=${next}`, { headers: headers() });
    if (response.ok) setHistory((await response.json() as { items: Punch[] }).items);
  };
  const loadTasks = async () => {
    const response = await fetch('/api/office/tasks', { headers: headers() });
    if (response.ok) setTasks((await response.json() as { items: Task[] }).items);
  };

  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = '#07111f';
    return () => { document.body.style.background = prev; };
  }, []);
  useEffect(() => { void loadMe(); void loadHistory(); void loadTasks(); }, []);
  useEffect(() => {
    const id = window.setInterval(() => setClock(tashkentClock()), 1000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (!navigator.geolocation) { setGpsErr(t('office.gpsOff')); return; }
    const id = navigator.geolocation.watchPosition(
      pos => { setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy || 0 }); setGpsErr(''); },
      () => setGpsErr(t('office.gpsNeed')),
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 12000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [t]);
  useEffect(() => () => {
    scanStop.current = true;
    stream.current?.getTracks().forEach(track => track.stop());
  }, []);

  const meters = me && gps ? haversine(gps.lat, gps.lng, me.office.lat, me.office.lng) : null;
  const inZone = Boolean(me && gps && meters != null && meters <= me.office.radiusM && gps.accuracy <= (me.office.accuracyM || 150));
  const worked = me?.today?.inAt
    ? (me.today.outAt ? me.today.workedMs : Date.now() - Date.parse(me.today.inAt))
    : 0;
  const day = heading(me?.date || tashkentDay(), t('date.weekdaysLong'), t('date.months'));

  const startCam = async () => {
    setNote('');
    try {
      stream.current?.getTracks().forEach(track => track.stop());
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: method === 'qr' ? 'environment' : 'user' }, audio: false });
      stream.current = media;
      if (video.current) {
        video.current.srcObject = media;
        await video.current.play();
      }
      setCam('on');
      return true;
    } catch {
      setCam('denied');
      setNote(t('office.camNeed'));
      return false;
    }
  };

  const enroll = async () => {
    if (!video.current || !gps) return;
    const hash = faceHash(video.current);
    if (!hash) { setNote(t('office.faceDark')); return; }
    setBusy(true); setNote('');
    const response = await fetch('/api/office/face', { method: 'POST', headers: headers(), body: JSON.stringify({ hash, lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy }) });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    setBusy(false);
    if (!response.ok) { setNote(payload.error === 'radius' ? t('office.far') : t('office.faceFail')); return; }
    setOk(t('office.faceOk'));
    await loadMe();
  };

  const doPunch = async (kind: 'in' | 'out', extra: { faceHash?: string; qrToken?: string }, used: 'face' | 'qr') => {
    if (!gps) { setNote(t('office.gpsNeed')); return; }
    setBusy(true); setNote(''); setOk('');
    const response = await fetch('/api/office/punch', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ kind, method: used, lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy, ...extra }),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    setBusy(false);
    if (!response.ok) {
      const map: Record<string, TKey> = {
        radius: 'office.far', face: 'office.faceBad', enroll: 'office.needFace', qr: 'office.qrBad',
        'already-in': 'office.alreadyIn', 'already-out': 'office.alreadyOut', 'need-in': 'office.needIn',
      };
      setNote(t(map[payload.error || ''] || 'office.fail'));
      return;
    }
    setOk(kind === 'in' ? t('office.inOk') : t('office.outOk'));
    await loadMe();
    await loadHistory(range);
  };

  const punchFace = async (kind: 'in' | 'out') => {
    if (!inZone) { setNote(t('office.far')); return; }
    if (!me?.face) { await enroll(); return; }
    if (!video.current) { setNote(t('office.camNeed')); return; }
    const hash = faceHash(video.current);
    if (!hash) { setNote(t('office.faceDark')); return; }
    await doPunch(kind, { faceHash: hash }, 'face');
  };

  const readQr = async (el: HTMLVideoElement) => {
    const Detector = (window as Window & { BarcodeDetector?: new (opts: { formats: string[] }) => { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> } }).BarcodeDetector;
    if (Detector) {
      try {
        const codes = await new Detector({ formats: ['qr_code'] }).detect(el);
        if (codes[0]?.rawValue) return codes[0].rawValue;
      } catch { /* zxing fallback */ }
    }
    if (!el.videoWidth) return '';
    const canvas = document.createElement('canvas');
    canvas.width = el.videoWidth;
    canvas.height = el.videoHeight;
    canvas.getContext('2d')?.drawImage(el, 0, 0);
    try {
      return new BrowserMultiFormatReader(QR_HINTS).decodeFromCanvas(canvas).getText();
    } catch {
      return '';
    }
  };

  const startQr = async (kind: 'in' | 'out') => {
    setMethod('qr'); setNote('');
    if (!inZone) { setNote(t('office.far')); return; }
    const ready = await startCam();
    if (!ready || !video.current) return;
    scanStop.current = false;
    const started = Date.now();
    const tick = async () => {
      if (scanStop.current || !video.current) return;
      const text = await readQr(video.current);
      if (text.startsWith('BORDO-')) {
        await doPunch(kind, { qrToken: text }, 'qr');
        return;
      }
      if (Date.now() - started > 20000) { setNote(t('office.qrNeed')); return; }
      window.setTimeout(() => { void tick(); }, 280);
    };
    void tick();
  };

  const loadAdmin = async () => {
    if (!me?.director) return;
    const [qrRes, peopleRes, boardRes] = await Promise.all([
      fetch('/api/office/qr', { headers: headers() }),
      fetch('/api/office/people', { headers: headers() }),
      fetch('/api/office/board', { headers: headers() }),
    ]);
    if (qrRes.ok) setQr((await qrRes.json() as { token: string }).token);
    if (peopleRes.ok) setPeople((await peopleRes.json() as { items: Person[] }).items);
    if (boardRes.ok) setBoard((await boardRes.json() as { items: BoardRow[] }).items);
  };

  useEffect(() => { if (tab === 'admin') void loadAdmin(); }, [tab, me?.director]);
  useEffect(() => {
    if (tab !== 'admin' || !me?.director) return;
    const id = window.setInterval(() => { void loadAdmin(); }, 20000);
    return () => window.clearInterval(id);
  }, [tab, me?.director]);

  const createTask = async () => {
    setBusy(true); setNote('');
    const response = await fetch('/api/office/tasks', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ title, description: body, assignedTo: picked, dueDate, dueTime, priority, remind }),
    });
    setBusy(false);
    if (!response.ok) { setNote(t('office.taskNeed')); return; }
    setTitle(''); setBody(''); setPicked([]);
    setOk(t('office.taskOk'));
    await loadTasks();
    setTab('tasks');
  };

  const patchTask = async (id: string, status: 'accepted' | 'done') => {
    await fetch(`/api/office/tasks/${id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ status }) });
    await loadTasks();
  };

  const leave = () => {
    sessionStorage.removeItem(SESSION);
    setLocation('/');
  };

  const bbox = me
    ? `${me.office.lng - 0.006},${me.office.lat - 0.004},${me.office.lng + 0.006},${me.office.lat + 0.004}`
    : '';
  const mapSrc = me
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${me.office.lat}%2C${me.office.lng}`
    : '';
  const nextKind: 'in' | 'out' = me?.today?.inAt && !me.today.outAt ? 'out' : 'in';
  const canIn = inZone && !me?.today?.inAt;
  const canOut = inZone && Boolean(me?.today?.inAt) && !me?.today?.outAt;
  const ranges: Array<{ id: 'day' | 'week' | 'month'; key: TKey }> = [
    { id: 'day', key: 'office.day' },
    { id: 'week', key: 'office.week' },
    { id: 'month', key: 'office.month' },
  ];

  return <div className="office">
    <div className="office-top">
      {me?.director ? <Link href="/dashboard" className="office-back">← {t('office.back')}</Link> : <span/>}
      <div className="office-top-right">
        <button type="button" className="office-out" onClick={() => setLang(lang === 'uz' ? 'ru' : 'uz')}>{lang === 'uz' ? 'RU' : 'UZ'}</button>
        <button type="button" className="office-out" onClick={leave}>{t('common.signOut')}</button>
        <div className="office-day"><b>{day.weekday}</b>{day.line}</div>
      </div>
    </div>
    <section className="office-hero">
      <small>{t('office.hello')}</small>
      <h1>{me?.name || '—'}</h1>
      <p>{me?.login} · {me?.office.name}</p>
    </section>
    {tab === 'attend' && <>
      <div className="office-clocks">
        <div className="office-clock"><span>{t('office.now')}</span><b>{clock}</b><small>{t('office.nice')}</small></div>
        <div className="office-hours"><span>{t('office.worked')}</span><b>{hhmmss(worked)}</b><small>{me?.today?.inAt ? t('office.working') : t('office.notStarted')}</small></div>
      </div>
      <div className="office-pair">
        <button type="button" className="office-go is-in" disabled={busy || !canIn} onClick={() => { if (method === 'qr') void startQr('in'); else void punchFace('in'); }}>
          <span><b>{t('office.in')}</b><small>{me?.today?.inAt ? time(me.today.inAt) : t('office.plan', { time: me?.office.start || '09:00' })}</small></span>
          <Clock3 size={18}/>
        </button>
        <button type="button" className="office-go is-out" disabled={busy || !canOut} onClick={() => { if (method === 'qr') void startQr('out'); else void punchFace('out'); }}>
          <span><b>{t('office.out')}</b><small>{me?.today?.outAt ? time(me.today.outAt) : t('office.plan', { time: me?.office.end || '18:00' })}</small></span>
          <LogOut size={18}/>
        </button>
      </div>
      <div className="office-map">
        {mapSrc && <iframe title={t('office.map')} src={mapSrc}/>}
        <div className="office-pin"><span><MapPin size={18}/></span></div>
        <button type="button" className="office-tap" onDoubleClick={() => navigator.geolocation.getCurrentPosition(pos => setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy || 0 }))}>{t('office.dbl')}</button>
        <div className="office-map-meta">
          <b>{me?.office.name}</b>
          <em>{t('office.radius')} · {meters != null ? `${Math.round(meters)} m` : '—'}</em>
        </div>
      </div>
      {!inZone && <p className="office-warn">{!gps ? (gpsErr || t('office.gpsNeed')) : (gpsErr || t('office.far'))}</p>}
      {ok && <p className="office-ok">{ok}</p>}
      {note && <p className="office-warn">{note}</p>}
      <h2>{t('office.method')}</h2>
      <p className="lead">{t('office.methodBody')}</p>
      <div className="office-methods">
        <button type="button" className={`office-method ${method === 'face' ? 'is-on' : ''}`} onClick={() => { scanStop.current = true; setMethod('face'); }}>
          <Fingerprint size={22}/><b>Face ID</b><small>{me?.face ? t('office.faceReady') : t('office.faceEnroll')}</small>
        </button>
        <button type="button" className={`office-method ${method === 'qr' ? 'is-on' : ''}`} onClick={() => void startQr(nextKind)}>
          <QrCode size={22}/><b>QR Scanner</b><small>{t('office.qrHint')}</small>
        </button>
      </div>
      {cam !== 'on' && <button type="button" className="office-cam" onClick={() => void startCam()}><b>{cam === 'denied' ? t('office.camNeed') : t('office.camAsk')}</b><small>{t('office.camBody')}</small></button>}
      <video ref={video} className={cam === 'on' ? 'is-on' : ''} playsInline muted autoPlay/>
      {cam === 'on' && method === 'face' && !me?.face && <button type="button" className="office-cam" disabled={busy || !inZone} onClick={() => void enroll()}>{t('office.enrollNow')}</button>}
      {cam === 'on' && method === 'face' && me?.face && <button type="button" className="office-cam" disabled={busy || !inZone} onClick={() => void punchFace(nextKind)}>{nextKind === 'in' ? t('office.in') : t('office.out')}</button>}
      <div className="office-card">
        <div className="office-card-top">
          <div><b>{t('office.myDay')}</b><small className="lead">{t('office.history')}</small></div>
          <div className="office-tabs">
            {ranges.map(item => <button key={item.id} type="button" className={range === item.id ? 'is-on' : ''} onClick={() => { setRange(item.id); void loadHistory(item.id); }}>{t(item.key)}</button>)}
          </div>
        </div>
        {history.length ? history.map(row => <div className="office-row" key={row.date}><span>{date(row.date)}</span><b>{row.inAt ? time(row.inAt) : '—'} → {row.outAt ? time(row.outAt) : '—'}</b></div>) : <p className="office-empty">{t('office.noRows')}</p>}
      </div>
      <div className="office-card">
        <div className="office-card-top"><div><b>{t('office.pay')}</b></div></div>
        <div className="office-pay">
          <div>{t('office.fiksa')}<b>{money(me?.fiksa || 0)}</b></div>
          <div>{t('office.fine')}<b>{money(0)}</b></div>
          <div className="full">{t('office.left')}<b>{money(me?.fiksa || 0)}</b></div>
        </div>
        <button type="button" className="office-report" onClick={() => window.print()}>{t('office.report')}</button>
      </div>
    </>}
    {tab === 'tasks' && <>
      <h2>{t('office.tasks')}</h2>
      <p className="lead">{t('office.tasksBody')}</p>
      {tasks.length ? tasks.map(task => <article className="office-task" key={task.id}>
        <b>{task.title}</b>
        <p>{task.description || t('office.noDesc')}</p>
        <small className="lead">{date(task.dueDate)} {task.dueTime} · {task.assignees.map(item => item.name).join(', ')}{task.late ? ` · ${t('office.late')}` : ''}</small>
        <div className="office-task-actions">
          {task.status === 'assigned' && <button type="button" onClick={() => void patchTask(task.id, 'accepted')}>{t('office.accept')}</button>}
          {task.status === 'accepted' && <button type="button" onClick={() => void patchTask(task.id, 'done')}>{t('office.done')}</button>}
          {task.status === 'done' && <span className="office-ok">{t('office.finished')}</span>}
        </div>
      </article>) : <p className="office-empty">{t('office.noTasks')}</p>}
    </>}
    {tab === 'admin' && me?.director && <>
      <div className="office-station office-card">
        <h2>{t('office.qrTitle')}</h2>
        <p className="lead">{t('office.qrBody')}</p>
        {qr ? <QrMark value={qr}/> : <p className="office-empty">{t('common.loading')}</p>}
      </div>
      <div className="office-card">
        <h2>{t('office.board')}</h2>
        {board.length ? board.map(row => <div className="office-row" key={row.accountId}><span>{row.name}</span><b>{row.inAt ? time(row.inAt) : '—'} → {row.outAt ? time(row.outAt) : '—'}</b></div>) : <p className="office-empty">{t('office.noRows')}</p>}
      </div>
      <div className="office-card office-form">
        <h2>{t('office.newTask')}</h2>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t('office.taskName')} maxLength={200}/>
        <textarea value={body} onChange={e => setBody(e.target.value)} placeholder={t('office.taskText')} maxLength={2000} rows={4}/>
        <div className="office-people">
          {people.filter(item => item.role === 'office' || item.role === 'worker' || item.role === 'accountant').map(item => (
            <button type="button" key={item.id} className={picked.includes(item.id) ? 'is-on' : ''} onClick={() => setPicked(list => list.includes(item.id) ? list.filter(id => id !== item.id) : [...list, item.id])}>{item.name}</button>
          ))}
        </div>
        <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}/>
        <input type="time" value={dueTime} onChange={e => setDueTime(e.target.value)}/>
        <div className="office-prio">
          {([['low', 'office.pLow'], ['normal', 'office.pMid'], ['high', 'office.pHigh'], ['urgent', 'office.pNow']] as const).map(([id, key]) => (
            <button type="button" key={id} className={priority === id ? 'is-on' : ''} onClick={() => setPriority(id)}>{t(key)}</button>
          ))}
        </div>
        <label className="lead"><input type="checkbox" checked={remind} onChange={e => setRemind(e.target.checked)}/> {t('office.remind')}</label>
        {note && <p className="office-warn">{note}</p>}
        <button type="button" className="office-save" disabled={busy || !title.trim() || !picked.length} onClick={() => void createTask()}>{t('office.createTask')}</button>
      </div>
    </>}
    <nav className={`office-nav ${me?.director ? 'is-three' : ''}`}>
      <button type="button" className={tab === 'attend' ? 'is-on' : ''} onClick={() => setTab('attend')}>{t('office.attend')}</button>
      <button type="button" className={tab === 'tasks' ? 'is-on' : ''} onClick={() => setTab('tasks')}>{t('office.tasks')}</button>
      {me?.director && <button type="button" className={tab === 'admin' ? 'is-on' : ''} onClick={() => setTab('admin')}>{t('office.admin')}</button>}
    </nav>
  </div>;
}
