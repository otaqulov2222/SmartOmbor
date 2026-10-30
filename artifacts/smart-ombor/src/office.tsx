import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { Fingerprint, MapPin, QrCode, SwitchCamera, X } from 'lucide-react';
import { useLocation } from 'wouter';
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
export function officeHeaders() {
  return { authorization: `Bearer ${session()?.token || ''}`, 'content-type': 'application/json' };
}
function tashkentClock(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
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
export function faceHash(video: HTMLVideoElement) {
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

export function OfficePage() {
  const { t, lang, setLang, date, time, money } = useI18n();
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<'attend' | 'tasks'>('attend');
  const [me, setMe] = useState<Me | null>(null);
  const [clock, setClock] = useState(tashkentClock());
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [gpsErr, setGpsErr] = useState('');
  const [method, setMethod] = useState<'face' | 'qr'>('face');
  const [stage, setStage] = useState<null | 'face' | 'qr'>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [camDenied, setCamDenied] = useState(false);
  const [note, setNote] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState<'day' | 'week' | 'month'>('week');
  const [history, setHistory] = useState<Punch[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const scanStop = useRef(false);
  const punchKind = useRef<'in' | 'out'>('in');

  const loadMe = async () => {
    const response = await fetch('/api/office/me', { headers: officeHeaders() });
    if (response.status === 401) { sessionStorage.removeItem(SESSION); setLocation('/'); return; }
    if (response.ok) setMe(await response.json());
  };
  const loadHistory = async (next = range) => {
    const response = await fetch(`/api/office/history?range=${next}`, { headers: officeHeaders() });
    if (response.ok) setHistory((await response.json() as { items: Punch[] }).items);
  };
  const loadTasks = async () => {
    const response = await fetch('/api/office/tasks', { headers: officeHeaders() });
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
  const day = heading(me?.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date()), t('date.weekdaysLong'), t('date.months'));
  const nextKind: 'in' | 'out' = me?.today?.inAt && !me.today.outAt ? 'out' : 'in';
  const canIn = inZone && !me?.today?.inAt;
  const canOut = inZone && Boolean(me?.today?.inAt) && !me?.today?.outAt;

  const stopCam = () => {
    scanStop.current = true;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  };

  const startCam = async (mode: 'user' | 'environment') => {
    try {
      stream.current?.getTracks().forEach(track => track.stop());
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: mode }, audio: false });
      stream.current = media;
      if (video.current) {
        video.current.srcObject = media;
        await video.current.play();
      }
      setCamDenied(false);
      return true;
    } catch {
      setCamDenied(true);
      setNote(t('office.camNeed'));
      return false;
    }
  };

  const closeStage = () => {
    stopCam();
    setStage(null);
  };

  const doPunch = async (kind: 'in' | 'out', extra: { faceHash?: string; qrToken?: string }, used: 'face' | 'qr') => {
    if (!gps) { setNote(t('office.gpsNeed')); return false; }
    setBusy(true); setNote(''); setOk('');
    const response = await fetch('/api/office/punch', {
      method: 'POST', headers: officeHeaders(),
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
      return false;
    }
    setOk(kind === 'in' ? t('office.inOk') : t('office.outOk'));
    await loadMe();
    await loadHistory(range);
    closeStage();
    return true;
  };

  const confirmFace = async () => {
    if (!inZone) { setNote(t('office.far')); return; }
    if (!video.current) { setCamDenied(true); return; }
    const hash = faceHash(video.current);
    if (!hash) { setNote(t('office.faceDark')); return; }
    if (!me?.face) {
      const response = await fetch('/api/office/face', { method: 'POST', headers: officeHeaders(), body: JSON.stringify({ hash, lat: gps?.lat, lng: gps?.lng, accuracy: gps?.accuracy }) });
      if (!response.ok) { setNote(t('office.faceFail')); return; }
      await loadMe();
    }
    await doPunch(punchKind.current, { faceHash: hash }, 'face');
  };

  const readQr = async (el: HTMLVideoElement) => {
    const Detector = (window as Window & { BarcodeDetector?: new (opts: { formats: string[] }) => { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> } }).BarcodeDetector;
    if (Detector) {
      try {
        const codes = await new Detector({ formats: ['qr_code'] }).detect(el);
        if (codes[0]?.rawValue) return codes[0].rawValue;
      } catch { /* zxing */ }
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

  const openStage = async (kind: 'in' | 'out', used: 'face' | 'qr') => {
    if (!inZone) { setNote(t('office.far')); return; }
    punchKind.current = kind;
    setMethod(used);
    setNote('');
    const mode = used === 'qr' ? 'environment' : 'user';
    setFacing(mode);
    setStage(used);
    const ready = await startCam(mode);
    if (!ready) { setStage(null); return; }
    if (used !== 'qr') return;
    scanStop.current = false;
    const started = Date.now();
    const tick = async () => {
      if (scanStop.current || !video.current) return;
      const text = await readQr(video.current);
      if (text.includes('BORDO-OFFICE-') || text.startsWith('BORDO-')) {
        await doPunch(kind, { qrToken: text.trim() }, 'qr');
        return;
      }
      if (Date.now() - started > 25000) { setNote(t('office.qrNeed')); return; }
      window.setTimeout(() => { void tick(); }, 280);
    };
    void tick();
  };

  const flipCam = async () => {
    const next = facing === 'user' ? 'environment' : 'user';
    setFacing(next);
    await startCam(next);
  };

  const patchTask = async (id: string, status: 'accepted' | 'done') => {
    await fetch(`/api/office/tasks/${id}`, { method: 'PATCH', headers: officeHeaders(), body: JSON.stringify({ status }) });
    await loadTasks();
  };

  const bbox = me
    ? `${me.office.lng - 0.006},${me.office.lat - 0.004},${me.office.lng + 0.006},${me.office.lat + 0.004}`
    : '';
  const mapSrc = me
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${me.office.lat}%2C${me.office.lng}`
    : '';
  const ranges: Array<{ id: 'day' | 'week' | 'month'; key: TKey }> = [
    { id: 'day', key: 'office.day' },
    { id: 'week', key: 'office.week' },
    { id: 'month', key: 'office.month' },
  ];

  return <div className="office">
    <div className="office-top">
      <span/>
      <div className="office-top-right">
        {!me?.director && <button type="button" className="office-out" onClick={() => setLang(lang === 'uz' ? 'ru' : 'uz')}>{lang === 'uz' ? 'RU' : 'UZ'}</button>}
        {!me?.director && <button type="button" className="office-out" onClick={() => { sessionStorage.removeItem(SESSION); setLocation('/'); }}>{t('common.signOut')}</button>}
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
        <button type="button" className="office-go is-in" disabled={busy || !canIn} onClick={() => void openStage('in', method)}>
          <span><b>{t('office.in')}</b><small>{me?.today?.inAt ? time(me.today.inAt) : t('office.plan', { time: me?.office.start || '09:00' })}</small></span>
        </button>
        <button type="button" className="office-go is-out" disabled={busy || !canOut} onClick={() => void openStage('out', method)}>
          <span><b>{t('office.out')}</b><small>{me?.today?.outAt ? time(me.today.outAt) : t('office.plan', { time: me?.office.end || '18:00' })}</small></span>
        </button>
      </div>
      <div className="office-map">
        {mapSrc && <iframe title={t('office.map')} src={mapSrc}/>}
        <div className="office-pin"><span><MapPin size={18}/></span></div>
        {inZone && <div className="office-here">{t('office.here')}</div>}
        <button type="button" className="office-tap" onDoubleClick={() => navigator.geolocation.getCurrentPosition(pos => setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy || 0 }))}>{t('office.dbl')}</button>
        <div className="office-map-meta">
          <b>{me?.office.name}</b>
          <em>{t('office.radius')}</em>
        </div>
      </div>
      {!inZone && <p className="office-warn">{!gps ? (gpsErr || t('office.gpsNeed')) : (gpsErr || t('office.far'))}</p>}
      {ok && <p className="office-ok">{ok}</p>}
      {note && !camDenied && <p className="office-warn">{note}</p>}
      <h2>{t('office.method')}</h2>
      <p className="lead">{t('office.methodBody')}</p>
      <div className="office-methods">
        <button type="button" className={`office-method ${method === 'face' ? 'is-on' : ''}`} onClick={() => { scanStop.current = true; setMethod('face'); }}>
          <Fingerprint size={22}/>{method === 'face' && <em className="office-check">✓</em>}
          <b>Face ID</b><small>{me?.face ? t('office.faceReady') : t('office.faceEnroll')}</small>
        </button>
        <button type="button" className={`office-method ${method === 'qr' ? 'is-on' : ''}`} onClick={() => void openStage(nextKind, 'qr')}>
          <QrCode size={22}/><b>QR Scanner</b><small>{t('office.qrHint')}</small>
        </button>
      </div>
      <button type="button" className="office-cam" disabled={!inZone} onClick={() => void openStage(nextKind, method)}>
        <b>→ {t('office.continue')}</b>
        <small>{method === 'face' ? t('office.faceGo') : t('office.qrHint')}</small>
      </button>
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
    <nav className="office-nav">
      <button type="button" className={tab === 'attend' ? 'is-on' : ''} onClick={() => setTab('attend')}>{t('office.attend')}</button>
      <button type="button" className={tab === 'tasks' ? 'is-on' : ''} onClick={() => setTab('tasks')}>{t('office.tasks')}</button>
    </nav>
    {stage && <div className="office-stage">
      <video ref={video} className="is-on" playsInline muted autoPlay/>
      {stage === 'face' && <div className="office-oval"/>}
      {stage === 'qr' && <div className="office-qr-frame"/>}
      <div className="office-stage-top">
        <b>{stage === 'face' ? t('office.look') : punchKind.current === 'out' ? t('office.scanOut') : t('office.scanIn')}</b>
        <div>
          <button type="button" className="office-stage-btn" onClick={() => void flipCam()} aria-label={t('office.flip')}><SwitchCamera size={18}/></button>
          <button type="button" className="office-stage-btn" onClick={closeStage} aria-label={t('common.close')}><X size={18}/></button>
        </div>
      </div>
      <div className="office-stage-copy">
        {stage === 'face' ? t('office.look') : t('office.scanHint')}
        {stage === 'face' && <small>{t('office.frontCam')}</small>}
      </div>
      {stage === 'face' && <button type="button" className="office-cam office-stage-go" disabled={busy} onClick={() => void confirmFace()}>{t('office.continue')}</button>}
      {stage === 'qr' && <p className="office-stage-hint">{t('office.scanHint')}</p>}
      <button type="button" className="office-stage-cancel" onClick={closeStage}><X size={14}/> {t('common.cancel')}</button>
    </div>}
    {camDenied && <div className="office-toast">
      <button type="button" className="office-toast-x" onClick={() => setCamDenied(false)}><X size={14}/></button>
      <b>{t('office.deniedTitle')}</b>
      <p>{t('office.deniedBody')}</p>
    </div>}
  </div>;
}
