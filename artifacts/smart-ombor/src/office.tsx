import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import {
  ChevronLeft, Clock, LogIn, LogOut, Moon, QrCode, ScanFace, Sun, SwitchCamera, Wallet, X,
} from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { useI18n, type TKey } from '@/i18n';
import { detectFaceDescriptor, ensureFaceModels, euclidean, type FaceScanStatus } from '@/office-face';
import { OfficeMap } from '@/office-map-section';
import './office.css';

type Punch = { date: string; inAt: string | null; outAt: string | null; workedMs: number };
type Me = {
  id: string; name: string; login: string; role: string; director: boolean; face: boolean;
  office: { name: string; lat: number; lng: number; radiusM: number; accuracyM: number; start: string; end: string };
  clock: string; date: string; today: Punch | null; fiksa?: number;
};
const SESSION = 'smart-ombor-session';
const QR_HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]],
  [DecodeHintType.TRY_HARDER, true],
]);
function isOfficeQr(text: string) {
  const value = text.trim();
  return value.includes('BORDO-OFFICE-') || value.startsWith('BORDO-');
}

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

function MyPayrollCard() {
  const { t } = useI18n();
  const [month] = useState(() =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date()).slice(0, 7),
  );
  const [person, setPerson] = useState<{
    monthly: number;
    daily: number;
    fineTotal: number;
    advancesTotal: number;
    net: number;
    absentDays: number;
    lateDays: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/office/payroll/me?month=${month}`, { headers: officeHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body?.person) return;
        setPerson(body.person);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [month]);

  const fmt = (n: number) => new Intl.NumberFormat('uz-UZ').format(Math.round(n || 0));

  return (
    <div id="office-pay" className="office-card office-block">
      <div className="office-card-top">
        <div className="office-card-title">
          <span className="is-clock"><Wallet size={16} /></span>
          <div>
            <b>{t('pay.myTitle')}</b>
            <small>{month}</small>
          </div>
        </div>
      </div>
      {!person || !person.monthly ? (
        <p className="office-empty">{t('pay.myEmpty')}</p>
      ) : (
        <>
          <div className="office-row"><span>{t('pay.monthly')}</span><b>{fmt(person.monthly)}</b></div>
          <div className="office-row"><span>{t('pay.daily')}</span><b>{fmt(person.daily)}</b></div>
          <div className="office-row"><span>{t('pay.absent')} / {t('pay.late')}</span><b>{person.absentDays} / {person.lateDays}</b></div>
          <div className="office-row"><span>{t('office.fine')}</span><b>{fmt(person.fineTotal)}</b></div>
          <div className="office-row"><span>{t('pay.advances')}</span><b>{fmt(person.advancesTotal)}</b></div>
          <div className="office-row"><span>{t('office.left')}</span><b>{fmt(person.net)}</b></div>
        </>
      )}
    </div>
  );
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
  const { t, lang, setLang, date, time } = useI18n();
  const [, setLocation] = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  const [clock, setClock] = useState(tashkentClock());
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy: number; heading: number | null } | null>(null);
  const [gpsState, setGpsState] = useState<'pending' | 'ready' | 'denied' | 'error'>('pending');
  const [method, setMethod] = useState<'face' | 'qr'>('face');
  const [stage, setStage] = useState<null | 'face' | 'enroll' | 'qr' | 'qr-confirm' | 'face-confirm'>(null);
  const pendingQr = useRef('');
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [camDenied, setCamDenied] = useState(false);
  const [camReady, setCamReady] = useState(false);
  const [note, setNote] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState<'day' | 'week' | 'month'>('week');
  const [history, setHistory] = useState<Punch[]>([]);
  const [section, setSection] = useState<'mark' | 'history' | 'settings'>('mark');
  const matchStreak = useRef(0);
  const qrStreak = useRef<{ token: string; n: number }>({ token: '', n: 0 });
  const [scanStatus, setScanStatus] = useState<FaceScanStatus>('loading');
  const [faceReady, setFaceReady] = useState(false);
  const [enrollCount, setEnrollCount] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const scanStop = useRef(false);
  const punchKind = useRef<'in' | 'out'>('in');
  const matchedDesc = useRef<number[] | null>(null);
  const enrollBag = useRef<number[][]>([]);
  const checkAt = useRef(0);
  const enrollAuto = useRef(false);
  const confirmFaceRef = useRef<() => Promise<void>>(async () => undefined);
  const ENROLL_NEED = 3;

  // Modelni oldindan yuklash — kamera ochilganda kutish kamayadi.
  useEffect(() => {
    void ensureFaceModels().catch(() => undefined);
  }, []);

  const loadMe = async () => {
    const response = await fetch('/api/office/me', { headers: officeHeaders() });
    if (response.status === 401) { sessionStorage.removeItem(SESSION); setLocation('/'); return; }
    if (response.ok) setMe(await response.json());
  };
  const loadHistory = async (next = range) => {
    const response = await fetch(`/api/office/history?range=${next}`, { headers: officeHeaders() });
    if (response.ok) setHistory((await response.json() as { items: Punch[] }).items);
  };
  useEffect(() => { void loadMe(); void loadHistory(); }, []);
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
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 25000 },
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
  const maxAcc = me?.office.accuracyM || 500;
  const radiusM = me?.office.radiusM || 100;
  const gpsAccurate = Boolean(gps && Number.isFinite(gps.accuracy) && gps.accuracy > 0 && gps.accuracy <= maxAcc);
  // Qattiq geofence: faqat belgilangan radius ichida — soft buffer yo‘q.
  const nearOffice = Boolean(meters != null && meters <= radiusM);
  const inZone = Boolean(me && gps && gpsAccurate && nearOffice);
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
            : nearOffice && !gpsAccurate
              ? t('office.gpsBad', { m: Math.round(gps?.accuracy || 0) })
              : t('office.distFar', { m: Math.round(meters || 0) });
  const alreadyIn = Boolean(me?.today?.inAt);
  const alreadyOut = Boolean(me?.today?.outAt);
  const nextKind: 'in' | 'out' = alreadyIn && !alreadyOut ? 'out' : 'in';
  const canIn = Boolean(inZone && gps && !busy && !alreadyIn && !alreadyOut);
  const canOut = Boolean(inZone && gps && !busy && alreadyIn && !alreadyOut);
  const canPunch = nextKind === 'in' ? canIn : canOut;
  const worked = me?.today?.inAt
    ? (me.today.outAt ? me.today.workedMs : Date.now() - Date.parse(me.today.inAt))
    : 0;
  const day = heading(me?.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date()), t('date.weekdaysLong'), t('date.months'));
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

  // GPS flicker stage ni yopmasin — faqat 8 soniya ketma-ket zonadan tashqarida bo‘lsa.
  useEffect(() => {
    if (!stage) return;
    if (inZone) return;
    const timer = window.setTimeout(() => {
      stopCam();
      pendingQr.current = '';
      setStage(null);
      setNote(t('office.distFar', { m: Math.round(meters || 0) }));
    }, 8000);
    return () => window.clearTimeout(timer);
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
    pendingQr.current = '';
    matchedDesc.current = null;
    enrollBag.current = [];
    enrollAuto.current = false;
    setFaceReady(false);
    setEnrollCount(0);
    setScanStatus('loading');
    setStage(null);
  };

  const freshGps = () => new Promise<{ lat: number; lng: number; accuracy: number } | null>((resolve) => {
    if (!navigator.geolocation) {
      resolve(gps ? { lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy } : null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const next = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy || 0,
        };
        setGps((cur) => ({
          lat: next.lat,
          lng: next.lng,
          accuracy: next.accuracy,
          heading: pos.coords.heading ?? cur?.heading ?? null,
        }));
        resolve(next);
      },
      () => resolve(gps ? { lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy } : null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    );
  });

  const doPunch = async (
    kind: 'in' | 'out',
    extra: { faceDescriptors?: number[][]; qrToken?: string },
    used: 'face' | 'qr',
    fixOverride?: { lat: number; lng: number; accuracy: number } | null,
  ) => {
    const fix = fixOverride || (gps ? { lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy } : null);
    if (!fix || gpsState === 'denied') { setNote(t('office.gpsNeed')); return false; }
    const accLimit = me?.office.accuracyM || 500;
    const accOk = Number.isFinite(fix.accuracy) && fix.accuracy > 0 && fix.accuracy <= accLimit;
    if (!accOk) { setNote(t('office.gpsBad', { m: Math.round(fix.accuracy) })); return false; }
    const distNow = me ? haversine(fix.lat, fix.lng, me.office.lat, me.office.lng) : null;
    const zoneOk = Boolean(distNow != null && distNow <= (me?.office.radiusM || 100));
    if (!zoneOk) {
      setNote(t('office.distFar', { m: Math.round(distNow || 0) }));
      return false;
    }
    setBusy(true); setNote(''); setOk('');
    const response = await fetch('/api/office/punch', {
      method: 'POST', headers: officeHeaders(),
      body: JSON.stringify({ kind, method: used, lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, ...extra }),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string; meters?: number };
    setBusy(false);
    if (!response.ok) {
      if (payload.error === 'radius') {
        setNote(t('office.distFar', { m: Math.round(payload.meters || distNow || 0) }));
        return false;
      }
      if (payload.error === 'geo') {
        setNote(t('office.gpsBad', { m: Math.round(fix.accuracy) }));
        return false;
      }
      const map: Record<string, TKey> = {
        radius: 'office.far', face: 'office.faceBad', enroll: 'office.needFace', qr: 'office.qrBad',
        'already-in': 'office.alreadyIn', 'already-out': 'office.alreadyOut', 'need-in': 'office.needIn',
        'too-soon': 'office.tooSoon', busy: 'office.busy', method: 'office.fail', kind: 'office.fail',
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
    if (busy) return;
    // face-confirm: kamera allaqachon yopilgan, video DOM dan olingan — bu ruxsat xatosi EMAS
    if (stage === 'face-confirm') {
      const descriptor = matchedDesc.current;
      if (!descriptor) {
        setNote(t('office.faceWait'));
        return;
      }
      setBusy(true); setNote(''); setOk(''); setCamDenied(false);
      const fix = await freshGps();
      if (!fix) {
        setBusy(false);
        setNote(t('office.gpsNeed'));
        return;
      }
      const distNow = me ? haversine(fix.lat, fix.lng, me.office.lat, me.office.lng) : null;
      const accOk = Number.isFinite(fix.accuracy) && fix.accuracy > 0 && fix.accuracy <= (me?.office.accuracyM || 500);
      const zoneOk = Boolean(distNow != null && distNow <= (me?.office.radiusM || 100));
      if (!accOk) {
        setBusy(false);
        setNote(t('office.gpsBad', { m: Math.round(fix.accuracy) }));
        return;
      }
      if (!zoneOk) {
        setBusy(false);
        setNote(t('office.distFar', { m: Math.round(distNow || 0) }));
        return;
      }
      setBusy(false);
      await doPunch(punchKind.current, { faceDescriptors: [descriptor] }, 'face', fix);
      return;
    }
    if (!video.current) {
      const okCam = await startCam(facing);
      if (!okCam || !video.current) {
        setNote(t('office.camNeed'));
        return;
      }
    }
    if (!faceReady) {
      setNote(t('office.faceWait'));
      return;
    }
    setBusy(true); setNote(''); setOk('');
    const fix = await freshGps();
    if (!fix) {
      setBusy(false);
      setNote(t('office.gpsNeed'));
      return;
    }
    const distNow = me ? haversine(fix.lat, fix.lng, me.office.lat, me.office.lng) : null;
    const accOk = Number.isFinite(fix.accuracy) && fix.accuracy > 0 && fix.accuracy <= (me?.office.accuracyM || 500);
    const zoneOk = Boolean(distNow != null && distNow <= (me?.office.radiusM || 100));
    if (!accOk) {
      setBusy(false);
      setNote(t('office.gpsBad', { m: Math.round(fix.accuracy) }));
      return;
    }
    if (!zoneOk) {
      setBusy(false);
      setNote(t('office.distFar', { m: Math.round(distNow || 0) }));
      return;
    }
    const replacing = (stage === 'enroll') && Boolean(me?.face);
    if (stage === 'enroll' || !me?.face) {
      const descriptors = enrollBag.current.slice(0, ENROLL_NEED);
      if (descriptors.length < ENROLL_NEED) {
        setBusy(false);
        setNote(t('office.faceDark'));
        return;
      }
      const response = await fetch('/api/office/face', {
        method: 'POST',
        headers: officeHeaders(),
        body: JSON.stringify({
          descriptors,
          lat: fix.lat,
          lng: fix.lng,
          accuracy: fix.accuracy,
          replace: replacing,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; meters?: number };
      setBusy(false);
      if (!response.ok) {
        enrollAuto.current = false;
        if (payload.error === 'radius') setNote(t('office.distFar', { m: Math.round(payload.meters || distNow || 0) }));
        else if (payload.error === 'taken') setNote(t('office.faceTaken'));
        else if (payload.error === 'exists') setNote(t('office.faceExists'));
        else setNote(t('office.faceFail'));
        return;
      }
      await loadMe();
      setOk(t('office.faceOk'));
      closeStage();
      return;
    }
    const descriptor = matchedDesc.current;
    if (!descriptor) {
      setBusy(false);
      setNote(t('office.faceWait'));
      return;
    }
    setBusy(false);
    await doPunch(punchKind.current, { faceDescriptors: [descriptor] }, 'face', fix);
  };
  confirmFaceRef.current = () => confirmFace();

  const reconnectFace = async () => {
    if (gpsState === 'denied' || !gps) { setNote(t('office.gpsNeed')); return; }
    punchKind.current = nextKind;
    setMethod('face');
    setFacing('user');
    setNote('');
    setOk('');
    matchedDesc.current = null;
    enrollBag.current = [];
    setFaceReady(false);
    setEnrollCount(0);
    setScanStatus('loading');
    setStage('enroll');
    const readyEnroll = await startCam('user');
    if (!readyEnroll) setStage(null);
  };

  // Live Face ID scan — enroll tez namuna + auto-bog‘lash; punchda tanib olgach tugma.
  useEffect(() => {
    if (stage !== 'face' && stage !== 'enroll') return;
    let alive = true;
    scanStop.current = false;
    matchedDesc.current = null;
    enrollBag.current = [];
    enrollAuto.current = false;
    setFaceReady(false);
    setEnrollCount(0);
    setScanStatus('loading');
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const loop = async () => {
      try {
        await ensureFaceModels();
      } catch {
        if (alive) {
          setScanStatus('error');
          setNote(t('office.faceFail'));
        }
        return;
      }
      if (!alive) return;
      setScanStatus('searching');
      matchStreak.current = 0;
      while (alive && !scanStop.current) {
        const el = video.current;
        if (!el || el.readyState < 2) {
          await sleep(80);
          continue;
        }
        try {
          const shot = await detectFaceDescriptor(el);
          if (!alive || scanStop.current) break;
          if (shot.status === 'multi') {
            matchStreak.current = 0;
            setScanStatus('multi');
            setFaceReady(false);
            matchedDesc.current = null;
            await sleep(120);
            continue;
          }
          if (shot.status === 'partial') {
            matchStreak.current = 0;
            setScanStatus('partial');
            setFaceReady(false);
            matchedDesc.current = null;
            await sleep(80);
            continue;
          }
          if (!shot.descriptor) {
            matchStreak.current = 0;
            setScanStatus('searching');
            if (stage === 'face') {
              setFaceReady(false);
              matchedDesc.current = null;
            }
            await sleep(60);
            continue;
          }
          if (stage === 'enroll') {
            // Faqat sifatli + deyarli bir xil emas freymlar.
            const near = enrollBag.current.some((item) => euclidean(item, shot.descriptor!) < 0.02);
            if (!near && enrollBag.current.length < ENROLL_NEED) {
              enrollBag.current.push(shot.descriptor);
              setEnrollCount(enrollBag.current.length);
            }
            const enough = enrollBag.current.length >= ENROLL_NEED;
            setFaceReady(enough);
            setScanStatus(enough ? 'recognized' : 'found');
            if (enough && !enrollAuto.current) {
              enrollAuto.current = true;
              scanStop.current = true;
              await sleep(60);
              if (alive) void confirmFaceRef.current();
              break;
            }
            await sleep(50);
            continue;
          }
          setScanStatus('found');
          const now = Date.now();
          if (now - checkAt.current < 400) {
            await sleep(70);
            continue;
          }
          checkAt.current = now;
          const response = await fetch('/api/office/face/check', {
            method: 'POST',
            headers: officeHeaders(),
            body: JSON.stringify({ descriptor: shot.descriptor }),
          });
          const payload = await response.json().catch(() => ({})) as { match?: boolean; needEnroll?: boolean };
          if (!alive || scanStop.current) break;
          if (payload.needEnroll) {
            matchStreak.current = 0;
            setScanStatus('loading');
            setFaceReady(false);
            enrollBag.current = [];
            enrollAuto.current = false;
            setEnrollCount(0);
            setOk('');
            setNote(t('office.faceUpgrade'));
            setStage('enroll');
            break;
          }
          if (payload.match) {
            matchStreak.current += 1;
            matchedDesc.current = shot.descriptor;
            // 2 marta ketma-ket to‘liq yuz — keyin to‘liq ekran tasdiqlash.
            if (matchStreak.current >= 2) {
              setFaceReady(true);
              setScanStatus('recognized');
              scanStop.current = true;
              stopCam();
              setCamDenied(false);
              setNote('');
              setStage('face-confirm');
              break;
            }
            setFaceReady(false);
            setScanStatus('found');
          } else {
            matchStreak.current = 0;
            matchedDesc.current = null;
            setFaceReady(false);
            setScanStatus('unknown');
          }
        } catch {
          if (alive) setScanStatus('error');
        }
        await sleep(120);
      }
    };
    void loop();
    return () => {
      alive = false;
    };
  }, [stage, t]);

  const confirmQrPunch = async () => {
    const token = pendingQr.current.trim();
    if (!token) { setNote(t('office.qrNeed')); closeStage(); return; }
    await doPunch(punchKind.current, { qrToken: token }, 'qr');
  };

  /** QR yashil ramka ichida, yetarli katta va deyarli to‘liq ko‘rinsin. */
  const qrBoxInGuide = (
    box: { x: number; y: number; width: number; height: number },
    vw: number,
    vh: number,
  ) => {
    const guide = Math.min(vw, vh) * 0.72;
    const gx = (vw - guide) / 2;
    const gy = vh * 0.46 - guide / 2;
    const area = Math.max(1, box.width * box.height);
    const overlapX = Math.max(0, Math.min(box.x + box.width, gx + guide) - Math.max(box.x, gx));
    const overlapY = Math.max(0, Math.min(box.y + box.height, gy + guide) - Math.max(box.y, gy));
    const overlap = overlapX * overlapY;
    if (overlap / area < 0.82) return false;
    const minSide = Math.min(vw, vh);
    if (box.width < minSide * 0.22 || box.height < minSide * 0.22) return false;
    if (box.width < guide * 0.34 || box.height < guide * 0.34) return false;
    // Markaz guide ichida.
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    return cx >= gx && cx <= gx + guide && cy >= gy && cy <= gy + guide;
  };

  const readQr = async (el: HTMLVideoElement): Promise<string> => {
    if (!el.videoWidth || el.readyState < 2) return '';
    const vw = el.videoWidth;
    const vh = el.videoHeight;
    const guide = Math.min(vw, vh) * 0.72;
    const gx = (vw - guide) / 2;
    const gy = vh * 0.46 - guide / 2;

    type Detected = { rawValue?: string; boundingBox?: { x: number; y: number; width: number; height: number } };
    const Detector = (window as Window & {
      BarcodeDetector?: new (opts: { formats: string[] }) => { detect: (source: CanvasImageSource) => Promise<Detected[]> };
    }).BarcodeDetector;

    // 1) Native detector — faqat bbox guide ichida bo‘lsa qabul.
    if (Detector) {
      try {
        const codes = await new Detector({ formats: ['qr_code'] }).detect(el);
        for (const code of codes) {
          if (!code.rawValue || !isOfficeQr(code.rawValue)) continue;
          const box = code.boundingBox;
          if (box && qrBoxInGuide(box, vw, vh)) return code.rawValue.trim();
        }
      } catch { /* zxing */ }
    }

    // 2) Faqat yashil ramka zonasi — kichik chetki QR o‘tmasin.
    const reader = new BrowserMultiFormatReader(QR_HINTS);
    const tryGuide = (pad = 0, scale = 1.35, invert = false) => {
      const sx = Math.max(0, gx - pad);
      const sy = Math.max(0, gy - pad);
      const sw = Math.min(vw - sx, guide + pad * 2);
      const sh = Math.min(vh - sy, guide + pad * 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sw * scale));
      canvas.height = Math.max(1, Math.round(sh * scale));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return '';
      ctx.drawImage(el, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      if (invert) {
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < img.data.length; i += 4) {
          img.data[i] = 255 - img.data[i]!;
          img.data[i + 1] = 255 - img.data[i + 1]!;
          img.data[i + 2] = 255 - img.data[i + 2]!;
        }
        ctx.putImageData(img, 0, 0);
      }
      try {
        return reader.decodeFromCanvas(canvas).getText();
      } catch {
        return '';
      }
    };

    for (const [pad, scale, invert] of [[0, 1.4, false], [0, 1.7, false], [8, 1.5, true]] as const) {
      const text = tryGuide(pad, scale, invert);
      if (text && isOfficeQr(text)) {
        // Guide crop dan topildi — QR asosan ramkada.
        return text.trim();
      }
      if (Detector) {
        try {
          const canvas = document.createElement('canvas');
          const sx = Math.max(0, gx - pad);
          const sy = Math.max(0, gy - pad);
          const sw = Math.min(vw - sx, guide + pad * 2);
          const sh = Math.min(vh - sy, guide + pad * 2);
          canvas.width = Math.round(sw * scale);
          canvas.height = Math.round(sh * scale);
          canvas.getContext('2d')?.drawImage(el, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
          const codes = await new Detector({ formats: ['qr_code'] }).detect(canvas);
          for (const code of codes) {
            if (!code.rawValue || !isOfficeQr(code.rawValue)) continue;
            // Crop ichidagi bbox — butun crop guide, shuning uchun QR cropning >=35% ini egallasin.
            const box = code.boundingBox;
            if (!box) continue;
            if (box.width < canvas.width * 0.34 || box.height < canvas.height * 0.34) continue;
            return code.rawValue.trim();
          }
        } catch { /* next */ }
      }
    }
    return '';
  };

  const openStage = async (kind: 'in' | 'out', used: 'face' | 'qr') => {
    if (gpsState === 'denied' || !gps) { setNote(t('office.gpsNeed')); return; }
    if (!gpsAccurate) { setNote(t('office.gpsBad', { m: Math.round(gps.accuracy) })); return; }
    if (!inZone) { setNote(t('office.distFar', { m: Math.round(meters || 0) })); return; }
    if (kind === 'in' && (alreadyIn || alreadyOut)) { setNote(t(alreadyOut ? 'office.alreadyOut' : 'office.alreadyIn')); return; }
    if (kind === 'out' && !alreadyIn) { setNote(t('office.needIn')); return; }
    if (kind === 'out' && alreadyOut) { setNote(t('office.alreadyOut')); return; }
    punchKind.current = kind;
    setMethod(used);
    setNote('');
    setOk('');
    pendingQr.current = '';
    matchedDesc.current = null;
    enrollBag.current = [];
    setFaceReady(false);
    setEnrollCount(0);
    setScanStatus('loading');
    // Face ID yo‘q — avval enroll (boshqa odam yuzi bilan punch ochilmasin).
    if (used === 'face' && !me?.face) {
      setFacing('user');
      setStage('enroll');
      const readyEnroll = await startCam('user');
      if (!readyEnroll) setStage(null);
      return;
    }
    const mode = used === 'qr' ? 'environment' : 'user';
    setFacing(mode);
    setStage(used);
    const ready = await startCam(mode);
    if (!ready) { setStage(null); return; }
    if (used !== 'qr') return;
    scanStop.current = false;
    qrStreak.current = { token: '', n: 0 };
    const started = Date.now();
    const tick = async () => {
      if (scanStop.current || !video.current) return;
      const text = await readQr(video.current);
      if (text && isOfficeQr(text)) {
        const token = text.trim();
        if (qrStreak.current.token === token) qrStreak.current.n += 1;
        else qrStreak.current = { token, n: 1 };
        // 2 marta ketma-ket to‘liq QR — tasodifiy bo‘lak bilan ochilmasin.
        if (qrStreak.current.n >= 2) {
          scanStop.current = true;
          pendingQr.current = token;
          stopCam();
          setStage('qr-confirm');
          return;
        }
      } else {
        qrStreak.current = { token: '', n: 0 };
      }
      if (Date.now() - started > 45000) { setNote(t('office.qrNeed')); return; }
      window.setTimeout(() => { void tick(); }, 180);
    };
    void tick();
  };

  const askCamera = async () => {
    const ready = await startCam(method === 'qr' ? 'environment' : 'user');
    stopCam();
    if (ready) { setCamReady(true); setNote(''); }
  };

  const goPunch = async () => {
    if (alreadyOut) { setNote(t('office.alreadyOut')); return; }
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


  const pingGps = () => {
    setNote('');
    requestGpsFix(true);
  };

  const jumpSection = (id: 'mark' | 'history' | 'settings') => {
    setSection(id);
    const node = id === 'mark'
      ? markRef.current
      : id === 'history'
        ? historyRef.current
        : settingsRef.current;
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const ctaNeedCam = !camReady;
  const endHour = Number((me?.office.end || '18:00').slice(0, 2)) || 18;
  const startHour = Number((me?.office.start || '06:00').slice(0, 2)) || 6;
  const hourNow = Number(clock.slice(0, 2));
  const night = hourNow >= endHour || hourNow < startHour;
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
        {(me?.role === 'warehouse_staff' || me?.role === 'warehouse_manager')
          ? <Link href="/partners" className="office-back"><ChevronLeft size={16}/> {t('common.back')}</Link>
          : me?.director
            ? <Link href="/dashboard" className="office-back"><ChevronLeft size={16}/> {t('common.back')}</Link>
            : me?.role === 'agent'
              ? <Link href="/my-kpi" className="office-back"><ChevronLeft size={16}/> {t('common.back')}</Link>
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
      <div className="office-sections is-3" role="tablist" aria-label={t('nav.office')}>
        <button type="button" role="tab" aria-selected={section === 'mark'} className={section === 'mark' ? 'is-on' : ''} onClick={() => jumpSection('mark')}>{t('office.sectionMark')}</button>
        <button type="button" role="tab" aria-selected={section === 'history'} className={section === 'history' ? 'is-on' : ''} onClick={() => jumpSection('history')}>{t('office.sectionHistory')}</button>
        <button type="button" role="tab" aria-selected={section === 'settings'} className={section === 'settings' ? 'is-on' : ''} onClick={() => jumpSection('settings')}>{t('office.sectionSettings')}</button>
      </div>
      <div ref={markRef} id="office-mark" className="office-block">
        <div className="office-pair">
          <button type="button" className="office-go is-in" disabled={!canIn} onClick={() => void openStage('in', method)}>
            <span>
              <b>{t('office.in')} <Clock size={13}/></b>
              <em>{me?.today?.inAt ? time(me.today.inAt) : '—'}</em>
              <small>{t('office.plan', { time: me?.office.start || '06:00' })}</small>
            </span>
            <LogIn size={18} className="office-go-arrow"/>
          </button>
          <button type="button" className="office-go is-out" disabled={!canOut} onClick={() => void openStage('out', method)}>
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
        <button type="button" className={`office-cam ${canPunch ? '' : 'is-locked'}`} disabled={busy || alreadyOut} onClick={() => void goPunch()}>
          <b>→ {alreadyOut
            ? t('office.alreadyOut')
            : !canPunch
              ? t('office.locked')
              : ctaNeedCam
                ? t('office.camAsk')
                : method === 'face' && !me?.face
                  ? t('office.enrollSave')
                  : t('office.continue')}</b>
          <small>{alreadyOut
            ? t('office.doneDay')
            : !canPunch
              ? (gpsState === 'denied' || !gps
                ? t('office.lockedGps')
                : nearOffice && !gpsAccurate
                  ? t('office.gpsBad', { m: Math.round(gps?.accuracy || 0) })
                  : t('office.distFar', { m: Math.round(meters || 0) }))
              : ctaNeedCam
                ? t('office.camBody')
                : method === 'face'
                  ? (me?.face ? t('office.faceGo') : t('office.faceEnroll'))
                  : t('office.qrHint')}</small>
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
      <MyPayrollCard />
      <div ref={settingsRef} id="office-settings" className="office-card office-block">
        <div className="office-card-top">
          <div className="office-card-title">
            <span className="is-clock"><ScanFace size={16}/></span>
            <div><b>{t('office.sectionSettings')}</b><small>{t('office.settingsLead')}</small></div>
          </div>
        </div>
        <div className="office-settings-row">
          <div>
            <b>Face ID</b>
            <small>{me?.face ? t('office.faceReady') : t('office.faceEnroll')}</small>
          </div>
          <button
            type="button"
            className="office-face-refresh"
            disabled={busy || !inZone || gpsState === 'denied'}
            onClick={() => void reconnectFace()}
          >
            {me?.face ? t('office.faceReconnect') : t('office.enrollSave')}
          </button>
        </div>
        <p className="lead" style={{ marginTop: 8 }}>{t('office.faceCardBody')}</p>
      </div>
    </div>
    {stage && <div className={`office-stage ${(stage === 'face-confirm' || stage === 'qr-confirm') ? 'is-confirm' : ''}`}>
      {(stage === 'face-confirm' || stage === 'qr-confirm') ? (
        <div className="office-confirm">
          <button type="button" className="office-stage-btn office-confirm-close" onClick={closeStage} aria-label={t('common.close')}><X size={18}/></button>
          <div className="office-confirm-card">
            <span className={`office-confirm-ico ${punchKind.current === 'out' ? 'is-out' : 'is-in'}`}>
              {stage === 'qr-confirm' ? <QrCode size={34}/> : <ScanFace size={34}/>}
            </span>
            <small>{stage === 'qr-confirm' ? t('office.confirmViaQr') : t('office.confirmViaFace')}</small>
            <h2>{punchKind.current === 'out' ? t('office.qrConfirmOut') : t('office.qrConfirmIn')}</h2>
            <p>{stage === 'qr-confirm'
              ? (punchKind.current === 'out' ? t('office.confirmOutBodyQr') : t('office.confirmInBodyQr'))
              : (punchKind.current === 'out' ? t('office.confirmOutBodyFace') : t('office.confirmInBodyFace'))}</p>
            {busy && <em className="office-stage-busy">{t('office.checking')}</em>}
            {note && <p className="office-stage-err">{note}</p>}
            <button
              type="button"
              className="office-cam office-stage-go"
              disabled={busy}
              onClick={() => void (stage === 'qr-confirm' ? confirmQrPunch() : confirmFace())}
            >
              {busy
                ? t('office.checking')
                : (punchKind.current === 'out' ? t('office.qrConfirmGoOut') : t('office.qrConfirmGoIn'))}
            </button>
            <button type="button" className="office-stage-cancel" onClick={closeStage}><X size={14}/> {t('common.cancel')}</button>
          </div>
        </div>
      ) : (
        <>
          <video ref={video} className="is-on" playsInline muted autoPlay/>
          <div className="office-stage-shade" aria-hidden="true"/>
          {(stage === 'face' || stage === 'enroll') && (
            <div className={`office-oval ${
              scanStatus === 'recognized' ? 'is-ok'
                : scanStatus === 'unknown' || scanStatus === 'multi' || scanStatus === 'partial' ? 'is-bad'
                  : scanStatus === 'found' ? 'is-found'
                    : ''
            }`}/>
          )}
          {stage === 'qr' && <div className="office-qr-frame"/>}
          <div className="office-stage-top">
            <div className="office-stage-title">
              {stage === 'qr' ? <QrCode size={16}/> : <ScanFace size={16}/>}
              <b>{stage === 'enroll'
                ? t('office.enrollTitle')
                : stage === 'face'
                  ? t('office.faceScan')
                  : punchKind.current === 'out' ? t('office.scanOut') : t('office.scanIn')}</b>
            </div>
            <div>
              <button type="button" className="office-stage-btn" onClick={() => void flipCam()} aria-label={t('office.flip')}><SwitchCamera size={18}/></button>
              <button type="button" className="office-stage-btn" onClick={closeStage} aria-label={t('common.close')}><X size={18}/></button>
            </div>
          </div>
          <div className="office-stage-copy">
            {stage === 'enroll'
              ? (faceReady ? t('office.enrollReady') : t('office.enrollBody'))
              : stage === 'face'
                ? (scanStatus === 'unknown'
                  ? t('office.faceUnknown')
                  : scanStatus === 'partial'
                    ? t('office.facePartial')
                    : scanStatus === 'multi'
                      ? t('office.faceMulti')
                      : scanStatus === 'loading'
                        ? t('office.faceLoading')
                        : t('office.faceScanBody'))
                : t('office.scanHint')}
            {(stage === 'face' || stage === 'enroll') && (
              <small>
                {stage === 'enroll'
                  ? t('office.enrollProgress', { n: Math.min(enrollCount, ENROLL_NEED), max: ENROLL_NEED })
                  : t('office.frontCam')}
              </small>
            )}
            {busy && <em className="office-stage-busy">{t('office.checking')}</em>}
            {!busy && (stage === 'face' || stage === 'enroll') && scanStatus === 'searching' && (
              <em className="office-stage-busy">{t('office.faceSearching')}</em>
            )}
          </div>
          {stage === 'enroll' && (
            <button type="button" className="office-cam office-stage-go" disabled={busy || !faceReady} onClick={() => void confirmFace()}>
              {busy ? t('office.checking') : faceReady ? t('office.enrollSave') : t('office.faceWait')}
            </button>
          )}
          {note && <p className="office-stage-err">{note}</p>}
          <button type="button" className="office-stage-cancel" onClick={closeStage}><X size={14}/> {t('common.cancel')}</button>
        </>
      )}
    </div>}
    {camDenied && stage !== 'face-confirm' && stage !== 'qr-confirm' && <div className="office-toast">
      <button type="button" className="office-toast-x" onClick={() => setCamDenied(false)}><X size={14}/></button>
      <b>{t('office.deniedTitle')}</b>
      <p>{t('office.deniedBody')}</p>
    </div>}
  </div>
  </div>;
}
