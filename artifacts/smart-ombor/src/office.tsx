import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import {
  ChevronLeft, Clock, LogIn, LogOut, Moon, QrCode, ScanFace, Sun, SwitchCamera, Wallet, X,
} from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { useI18n, type TKey } from '@/i18n';
import { OfficeMap } from '@/office-map-section';
import './office.css';

type Punch = { date: string; inAt: string | null; outAt: string | null; workedMs: number };
type Me = {
  id: string; name: string; login: string; role: string; director: boolean; face: boolean;
  office: { name: string; lat: number; lng: number; radiusM: number; accuracyM: number; start: string; end: string };
  clock: string; date: string; today: Punch | null; fiksa: number;
};
type Task = {
  id: string; title: string; description: string; dueDate: string; dueTime: string; priority: string;
  status: 'assigned' | 'accepted' | 'progress' | 'review' | 'done'; assignees: Array<{ id: string; name: string }>; late?: boolean;
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
function weekBounds(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  const dow = dt.getUTCDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  const from = new Date(dt); from.setUTCDate(dt.getUTCDate() + offset);
  const to = new Date(from); to.setUTCDate(from.getUTCDate() + 6);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
function monthDay(iso: string, months: string) {
  const [, month, day] = iso.split('-').map(Number);
  const label = months.split(',')[(month || 1) - 1] || '';
  return `${Number(day)} ${label}`;
}

export function OfficePage() {
  const { t, lang, setLang, date, time, money } = useI18n();
  const [, setLocation] = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  const [clock, setClock] = useState(tashkentClock());
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy: number; heading: number | null } | null>(null);
  const [gpsState, setGpsState] = useState<'pending' | 'ready' | 'denied' | 'error'>('pending');
  const [method, setMethod] = useState<'face' | 'qr'>('face');
  const [stage, setStage] = useState<null | 'face' | 'qr'>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [camDenied, setCamDenied] = useState(false);
  const [camReady, setCamReady] = useState(false);
  const [note, setNote] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState<'day' | 'week' | 'month'>('week');
  const [history, setHistory] = useState<Punch[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [payOpen, setPayOpen] = useState(false);
  const [section, setSection] = useState<'mark' | 'history' | 'pay' | 'tasks'>('mark');
  const video = useRef<HTMLVideoElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const payRef = useRef<HTMLDivElement>(null);
  const tasksRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => { void loadMe(); void loadHistory(); void loadTasks(); }, []);
  useEffect(() => {
    const id = window.setInterval(() => setClock(tashkentClock()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const gpsWatch = useRef<number | null>(null);
  const gpsFails = useRef(0);
  const applyGps = useRef<(pos: GeolocationPosition) => void>(() => undefined);
  const failGps = useRef<(err: GeolocationPositionError, fromUser: boolean) => void>(() => undefined);

  applyGps.current = (pos: GeolocationPosition) => {
    if (!Number.isFinite(pos.coords.latitude) || !Number.isFinite(pos.coords.longitude)) return;
    const accuracy = Number(pos.coords.accuracy);
    // Do not invent accuracy — fake 80m bypasses anti-spoof and breaks davomat checks
    if (!Number.isFinite(accuracy) || accuracy <= 0) return;
    const heading = Number(pos.coords.heading);
    gpsFails.current = 0;
    setGps({
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy,
      heading: Number.isFinite(heading) && heading >= 0 ? heading : null,
    });
    setGpsState('ready');
    setNote('');
  };
  failGps.current = (err, fromUser) => {
    if (err.code === err.PERMISSION_DENIED) {
      // Avtomatik so‘rov iOS’da denied berishi mumkin — faqat user gesture’dan keyin denied deb belgilaymiz.
      if (fromUser) setGpsState('denied');
      else setGpsState(prev => (prev === 'ready' ? prev : 'pending'));
      return;
    }
    gpsFails.current += 1;
    setGpsState(prev => {
      if (prev === 'ready') return prev;
      return gpsFails.current >= 3 ? 'error' : 'pending';
    });
  };

  const startGpsWatch = (fromUser: boolean) => {
    if (!navigator.geolocation) return;
    if (gpsWatch.current != null) navigator.geolocation.clearWatch(gpsWatch.current);
    gpsWatch.current = navigator.geolocation.watchPosition(
      pos => applyGps.current(pos),
      err => failGps.current(err, fromUser),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 25000 },
    );
  };

  const requestGpsFix = (fromUser: boolean) => {
    if (!window.isSecureContext || !navigator.geolocation) {
      setGpsState('error');
      return;
    }
    if (fromUser) setGpsState(prev => (prev === 'ready' ? prev : 'pending'));
    navigator.geolocation.getCurrentPosition(
      pos => {
        applyGps.current(pos);
        startGpsWatch(fromUser);
      },
      () => {
        navigator.geolocation.getCurrentPosition(
          pos => {
            applyGps.current(pos);
            startGpsWatch(fromUser);
          },
          err => failGps.current(err, fromUser),
          { enableHighAccuracy: false, maximumAge: 60_000, timeout: 15_000 },
        );
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 },
    );
  };

  useEffect(() => {
    if (!window.isSecureContext || !navigator.geolocation) {
      setGpsState('error');
      return;
    }
    let cancelled = false;
    let permStatus: PermissionStatus | null = null;
    const onPermChange = () => {
      if (!permStatus) return;
      if (permStatus.state === 'granted') requestGpsFix(false);
      if (permStatus.state === 'denied') setGpsState('denied');
    };
    const boot = async () => {
      // Safari/iOS: sahifa ochilishi bilan GPS so‘rash → ko‘pincha denied. Faqat allaqachon granted bo‘lsa auto-start.
      let granted = false;
      try {
        const perm = (navigator as Navigator & { permissions?: { query: (q: { name: PermissionName }) => Promise<PermissionStatus> } }).permissions;
        const status = await perm?.query({ name: 'geolocation' as PermissionName });
        if (cancelled) return;
        if (status) {
          permStatus = status;
          granted = status.state === 'granted';
          if (status.state === 'denied') setGpsState('denied');
          status.addEventListener('change', onPermChange);
        }
      } catch {
        /* permissions API yo‘q — user tugmasini kutamiz */
      }
      if (cancelled) return;
      if (granted) requestGpsFix(false);
      else setGpsState(prev => (prev === 'ready' || prev === 'denied' ? prev : 'pending'));
    };
    void boot();
    const onWake = () => {
      if (cancelled || document.visibilityState === 'hidden') return;
      void (navigator as Navigator & { permissions?: { query: (q: { name: PermissionName }) => Promise<PermissionStatus> } }).permissions
        ?.query({ name: 'geolocation' as PermissionName })
        .then(status => { if (status.state === 'granted') requestGpsFix(false); })
        .catch(() => undefined);
    };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      cancelled = true;
      if (gpsWatch.current != null) navigator.geolocation.clearWatch(gpsWatch.current);
      gpsWatch.current = null;
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
      permStatus?.removeEventListener('change', onPermChange);
    };
  }, []);
  useEffect(() => {
    const perm = (navigator as Navigator & { permissions?: { query: (q: { name: string }) => Promise<{ state: string }> } }).permissions;
    if (!perm?.query) return;
    void perm.query({ name: 'camera' }).then(status => {
      if (status.state === 'granted') setCamReady(true);
      if (status.state === 'denied') setCamDenied(true);
    }).catch(() => undefined);
  }, []);
  useEffect(() => () => {
    scanStop.current = true;
    stream.current?.getTracks().forEach(track => track.stop());
  }, []);

  const meters = me && gps ? haversine(gps.lat, gps.lng, me.office.lat, me.office.lng) : null;
  const maxAcc = me?.office.accuracyM || 150;
  const radiusM = me?.office.radiusM || 100;
  const gpsAccurate = Boolean(gps && Number.isFinite(gps.accuracy) && gps.accuracy > 0 && gps.accuracy <= maxAcc);
  const inZone = Boolean(
    me && gps && gpsAccurate && meters != null
    && meters <= radiusM
    && meters + Math.min(gps.accuracy * 0.5, 45) <= radiusM,
  );
  const geoStatus = !me
    ? t('common.loading')
    : gpsState === 'denied'
      ? t('office.gpsNeed')
      : gpsState === 'error' && !gps
        ? t('office.gpsOff')
        : !gps
          ? t('office.gpsWait')
          : inZone
            ? t('office.distHere', { m: Math.round(meters || 0) })
            : t('office.distFar', { m: Math.round(meters || 0) });
  const canPunch = Boolean(inZone && gps && !busy);
  const worked = me?.today?.inAt
    ? (me.today.outAt ? me.today.workedMs : Date.now() - Date.parse(me.today.inAt))
    : 0;
  const day = heading(me?.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date()), t('date.weekdaysLong'), t('date.months'));
  const nextKind: 'in' | 'out' = me?.today?.inAt && !me.today.outAt ? 'out' : 'in';
  const week = weekBounds(me?.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date()));
  const ranges: Array<{ id: 'day' | 'week' | 'month'; key: TKey }> = [
    { id: 'day', key: 'office.day' },
    { id: 'week', key: 'office.week' },
    { id: 'month', key: 'office.month' },
  ];

  const stopCam = () => {
    scanStop.current = true;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  };

  useEffect(() => {
    if (!stage || inZone) return;
    stopCam();
    setStage(null);
    setNote(t('office.distFar', { m: Math.round(meters || 0) }));
  }, [stage, inZone, meters, t]);

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
      setCamReady(true);
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
    if (!gps || gpsState === 'denied') { setNote(t('office.gpsNeed')); return false; }
    if (!gpsAccurate) { setNote(t('office.gpsBad', { m: Math.round(gps.accuracy) })); return false; }
    if (!inZone) {
      setNote(t('office.distFar', { m: Math.round(meters || 0) }));
      return false;
    }
    setBusy(true); setNote(''); setOk('');
    const response = await fetch('/api/office/punch', {
      method: 'POST', headers: officeHeaders(),
      body: JSON.stringify({ kind, method: used, lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy, ...extra }),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string; meters?: number };
    setBusy(false);
    if (!response.ok) {
      if (payload.error === 'radius') {
        setNote(t('office.distFar', { m: Math.round(payload.meters || meters || 0) }));
        return false;
      }
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
    if (!gps) { setNote(t('office.gpsNeed')); return; }
    if (!gpsAccurate) { setNote(t('office.gpsBad', { m: Math.round(gps.accuracy) })); return; }
    if (!inZone) { setNote(t('office.distFar', { m: Math.round(meters || 0) })); closeStage(); return; }
    if (!video.current) { setCamDenied(true); return; }
    const hash = faceHash(video.current);
    if (!hash) { setNote(t('office.faceDark')); return; }
    if (!me?.face) {
      const response = await fetch('/api/office/face', { method: 'POST', headers: officeHeaders(), body: JSON.stringify({ hash, lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy }) });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string; meters?: number };
        setNote(payload.error === 'radius' ? t('office.distFar', { m: Math.round(payload.meters || meters || 0) }) : t('office.faceFail'));
        return;
      }
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
    if (gpsState === 'denied' || !gps) { setNote(t('office.gpsNeed')); return; }
    if (!gpsAccurate) { setNote(t('office.gpsBad', { m: Math.round(gps.accuracy) })); return; }
    if (!inZone) { setNote(t('office.distFar', { m: Math.round(meters || 0) })); return; }
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

  const askCamera = async () => {
    const ready = await startCam(method === 'qr' ? 'environment' : 'user');
    stopCam();
    if (ready) { setCamReady(true); setNote(''); }
  };

  const goPunch = async () => {
    if (gpsState === 'denied' || !gps) { setNote(t('office.gpsNeed')); return; }
    if (!gpsAccurate) { setNote(t('office.gpsBad', { m: Math.round(gps.accuracy) })); return; }
    if (!inZone) { setNote(t('office.distFar', { m: Math.round(meters || 0) })); return; }
    if (!camReady) { await askCamera(); return; }
    await openStage(nextKind, method);
  };

  const flipCam = async () => {
    const next = facing === 'user' ? 'environment' : 'user';
    setFacing(next);
    await startCam(next);
  };

  const patchTask = async (id: string, status: 'accepted' | 'progress' | 'done') => {
    await fetch(`/api/office/tasks/${id}`, { method: 'PATCH', headers: officeHeaders(), body: JSON.stringify({ status }) });
    await loadTasks();
  };

  const pingGps = () => {
    setNote('');
    requestGpsFix(true);
  };

  const jumpSection = (id: 'mark' | 'history' | 'pay' | 'tasks') => {
    setSection(id);
    const node = id === 'mark' ? markRef.current : id === 'history' ? historyRef.current : id === 'pay' ? payRef.current : tasksRef.current;
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const ctaNeedCam = !camReady;
  const ownTasks = tasks;
  const endHour = Number((me?.office.end || '18:00').slice(0, 2)) || 18;
  const hourNow = Number(clock.slice(0, 2));
  const night = hourNow >= endHour || hourNow < 6;
  const heroSrc = `${import.meta.env.BASE_URL}office-hero.jpg`;
  const nightSrc = `${import.meta.env.BASE_URL}office-hero-night.jpg`;

  return <div className={`office-shell ${night ? 'is-night' : ''}`}>
    <div className="office-ambient" aria-hidden="true"/>
    <div className="office">
    <section className="office-hero">
      <img className={`office-hero-img ${night ? 'is-off' : ''}`} src={heroSrc} alt="" />
      <img className={`office-hero-img office-hero-night ${night ? 'is-on' : ''}`} src={nightSrc} alt="" />
      <div className="office-hero-fade"/>
      <div className="office-hero-bar">
        {me?.director
          ? <Link href="/dashboard" className="office-back"><ChevronLeft size={16}/> {t('common.back')}</Link>
          : me?.role === 'agent'
            ? <Link href="/my-kpi" className="office-back"><ChevronLeft size={16}/> {t('common.back')}</Link>
            : (me?.role === 'warehouse_staff' || me?.role === 'warehouse_manager')
              ? <Link href="/partners" className="office-back"><ChevronLeft size={16}/> {t('common.back')}</Link>
              : <span className="office-back">{t('office.cabinet')}</span>}
        <div className="office-day">
          <b>{night ? <Moon size={13}/> : <Sun size={13}/>} {day.weekday}</b>
          {day.line}
        </div>
      </div>
      <div className="office-hero-copy">
        <small>{me?.director ? t('office.hello') : t('office.cabinet')}</small>
        <h1>{me?.name || '—'}</h1>
        <p>{me?.director ? `${me?.login} · ${me?.office.name}` : t('office.cabinetLead')}</p>
      </div>
    </section>
    <div className="office-body">
      <div className="office-clocks">
        <div className="office-clock">
          <div className="office-clock-top"><span className="office-ico"><Clock size={15}/></span>{t('office.now')}</div>
          <b>{clock}</b>
          <small>{night ? t('office.niceNight') : t('office.nice')}</small>
        </div>
        <div className="office-hours">
          <div className="office-hours-top">{t('office.worked')}</div>
          <b>{hhmmss(worked)}</b>
          <small>{me?.today?.inAt ? t('office.working') : t('office.notStarted')}</small>
        </div>
      </div>
      <div className={`office-sections ${me?.director ? 'is-3' : 'is-4'}`} role="tablist" aria-label={t('nav.office')}>
        <button type="button" role="tab" aria-selected={section === 'mark'} className={section === 'mark' ? 'is-on' : ''} onClick={() => jumpSection('mark')}>{t('office.sectionMark')}</button>
        <button type="button" role="tab" aria-selected={section === 'history'} className={section === 'history' ? 'is-on' : ''} onClick={() => jumpSection('history')}>{t('office.sectionHistory')}</button>
        <button type="button" role="tab" aria-selected={section === 'pay'} className={section === 'pay' ? 'is-on' : ''} onClick={() => jumpSection('pay')}>{t('office.sectionPay')}</button>
        {!me?.director && <button type="button" role="tab" aria-selected={section === 'tasks'} className={section === 'tasks' ? 'is-on' : ''} onClick={() => jumpSection('tasks')}>{t('office.sectionTasks')}</button>}
      </div>
      <div ref={markRef} id="office-mark" className="office-block">
        <div className="office-pair">
          <button type="button" className="office-go is-in" disabled={!canPunch} onClick={() => void openStage('in', method)}>
            <span>
              <b>{t('office.in')} <Clock size={13}/></b>
              <em>{me?.today?.inAt ? time(me.today.inAt) : '—'}</em>
              <small>{t('office.plan', { time: me?.office.start || '09:00' })}</small>
            </span>
            <LogIn size={18} className="office-go-arrow"/>
          </button>
          <button type="button" className="office-go is-out" disabled={!canPunch} onClick={() => void openStage('out', method)}>
            <span>
              <b>{t('office.out')} <Clock size={13}/></b>
              <em>{me?.today?.outAt ? time(me.today.outAt) : '—'}</em>
              <small>{t('office.plan', { time: me?.office.end || '18:00' })}</small>
            </span>
            <LogOut size={18} className="office-go-arrow"/>
          </button>
        </div>
        {me && <OfficeMap
          officeLat={me.office.lat} officeLng={me.office.lng}
          radiusM={radiusM}
          here={inZone}
          user={gps ? { lat: gps.lat, lng: gps.lng, heading: gps.heading } : null}
          status={gps ? geoStatus : ''}
          gpsBlocked={!gps}
          meters={meters}
          onNudge={pingGps}
          onEnableGps={pingGps}
        />}
        {ok && <p className="office-ok">{ok}</p>}
        {note && !camDenied && note !== t('office.gpsNeed') && note !== t('office.gpsOff') && <p className="office-warn">{note}</p>}
        <h2>{t('office.method')}</h2>
        <p className="lead">{t('office.methodBody')}</p>
        <div className="office-methods">
          <button type="button" className={`office-method ${method === 'face' ? 'is-on' : ''}`} onClick={() => { scanStop.current = true; setMethod('face'); }}>
            <span className="office-method-ico"><ScanFace size={22}/></span>{method === 'face' && <em className="office-check">✓</em>}
            <b>Face ID</b><small>{me?.face ? t('office.faceReady') : t('office.faceEnroll')}</small>
          </button>
          <button type="button" className={`office-method ${method === 'qr' ? 'is-on' : ''}`} onClick={() => { scanStop.current = true; setMethod('qr'); }}>
            <span className="office-method-ico"><QrCode size={22}/></span>{method === 'qr' && <em className="office-check">✓</em>}
            <b>QR Scanner</b><small>{t('office.qrHint')}</small>
          </button>
        </div>
        <button type="button" className={`office-cam ${canPunch ? '' : 'is-locked'}`} disabled={busy} onClick={() => void goPunch()}>
          <b>→ {!canPunch ? t('office.locked') : ctaNeedCam ? t('office.camAsk') : t('office.continue')}</b>
          <small>{!canPunch
            ? (gpsState === 'denied' || !gps ? t('office.lockedGps') : inZone ? t('office.gpsBad', { m: Math.round(gps?.accuracy || 0) }) : t('office.distFar', { m: Math.round(meters || 0) }))
            : ctaNeedCam ? t('office.camBody') : (method === 'face' ? t('office.faceGo') : t('office.qrHint'))}</small>
        </button>
      </div>
      <div ref={historyRef} id="office-history" className="office-card office-block">
        <div className="office-card-top">
          <div className="office-card-title">
            <span className="is-clock"><Clock size={16}/></span>
            <div><b>{t('office.myDay')}</b><small>{t('office.history')}</small></div>
          </div>
          <div className="office-tabs">
            {ranges.map(item => <button key={item.id} type="button" className={range === item.id ? 'is-on' : ''} onClick={() => { setRange(item.id); void loadHistory(item.id); }}>{t(item.key)}</button>)}
          </div>
        </div>
        {history.length ? history.map(row => <div className="office-row" key={row.date}><span>{date(row.date)}</span><b>{row.inAt ? time(row.inAt) : '—'} → {row.outAt ? time(row.outAt) : '—'}</b></div>) : <p className="office-empty">{t('office.noRows')}</p>}
      </div>
      <div ref={payRef} id="office-pay" className="office-card office-block">
        <div className="office-card-top">
          <div className="office-card-title">
            <span className="is-pay"><Wallet size={16}/></span>
            <div>
              <b>{t('office.pay')}</b>
              <small>{t('office.payWeek', { from: monthDay(week.from, t('date.months')), to: monthDay(week.to, t('date.months')) })}</small>
            </div>
          </div>
          <button type="button" className="office-detail" onClick={() => setPayOpen(open => !open)}>{t('office.detail')}</button>
        </div>
        <div className="office-pay">
          <div>{t('office.fiksa')}<b>{money(me?.fiksa || 0)}</b></div>
          <div>{t('office.fine')}<b>{money(0)}</b></div>
          <div className="full">{t('office.left')}<b>{money(me?.fiksa || 0)}</b></div>
        </div>
        {payOpen && <p className="lead" style={{ marginTop: 10 }}>{t('office.payHint')}</p>}
      </div>
      {!me?.director && <div ref={tasksRef} id="office-tasks" className="office-block">
        <h2>{t('office.myTasks')}</h2>
        <p className="lead">{t('office.tasksBody')}</p>
        {ownTasks.length ? ownTasks.map(task => {
          const statusKey = task.status === 'assigned' ? 'office.stNew' : task.status === 'accepted' ? 'office.stAccepted' : task.status === 'progress' ? 'office.stProgress' : task.status === 'review' ? 'office.stReview' : 'office.colDone';
          const prioKey = task.priority === 'low' ? 'office.pLow' : task.priority === 'high' ? 'office.pHigh' : task.priority === 'urgent' ? 'office.pNow' : 'office.pMid';
          return <article className={`office-task is-${task.priority}${task.late ? ' is-late' : ''}`} key={task.id}>
            <div className="office-task-top">
              <span className={`office-pill is-${task.priority}`}>{t(prioKey as TKey)}</span>
              <span className={`office-pill is-${task.status}`}>{t(statusKey as TKey)}</span>
            </div>
            <b>{task.title}</b>
            <p>{task.description || t('office.noDesc')}</p>
            <small className="lead">{date(task.dueDate)} {task.dueTime}{task.late ? ` · ${t('office.late')}` : ''}</small>
            <div className="office-task-actions">
              {task.status === 'assigned' && <button type="button" onClick={() => void patchTask(task.id, 'accepted')}>{t('office.accept')}</button>}
              {task.status === 'accepted' && <button type="button" onClick={() => void patchTask(task.id, 'progress')}>{t('office.start')}</button>}
              {(task.status === 'accepted' || task.status === 'progress') && <button type="button" onClick={() => void patchTask(task.id, 'done')}>{t('office.done')}</button>}
              {task.status === 'review' && <span className="office-ok">{t('office.waitingReview')}</span>}
              {task.status === 'done' && <span className="office-ok">{t('office.finished')}</span>}
            </div>
          </article>;
        }) : <p className="office-empty">{t('office.noTasks')}</p>}
      </div>}
    </div>
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
  </div>
  </div>;
}
