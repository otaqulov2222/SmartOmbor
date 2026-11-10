import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck, Bell, CheckCircle2, Clock, Compass, Crosshair, Fingerprint, LogOut, MapPin, Navigation, Phone, RefreshCw,
  Target, TrendingUp, Users, Wallet,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { clearAgentToken, kpiFetch, readAgentToken, readStaffToken, saveAgentToken, uzs } from './api';
import { RouteMap, type RouteStop } from './route-map';
import './kpi.css';

type StageRow = {
  name: string;
  percent: number;
  fromDate: string;
  untilDate: string;
  ifFullPaidKpi: string;
  onRemainingDebtKpi: string;
};

type DealRow = {
  id: string;
  number: string;
  orderDate: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  total: string;
  paidAmount: string;
  dueAmount: string;
  status: string;
  currentStage: string;
  currentPercent: number;
  daysRemaining: number | null;
  earnedKpi: string;
  stages: StageRow[];
};

type CustomerCard = {
  id: string;
  step: number;
  name: string;
  phone: string;
  address: string;
  lat: number;
  lng: number;
  exactGps?: boolean;
  debt: string;
  visitedToday: boolean;
  visitedAt?: string | null;
  isNext?: boolean;
  distanceM?: number | null;
};

type CabinetData = {
  agent: {
    id: string;
    fullName: string;
    login: string;
    phone: string;
    salesPlan: string;
    lat?: number | null;
    lng?: number | null;
  };
  summary: {
    customersCount: number;
    debtorsCount: number;
    visitedToday: number;
    visitPlanCount?: number;
    visitPct?: number;
    salesPlan?: string;
    monthSales?: string;
    planPct?: number | null;
    totalSales: string;
    totalPaid: string;
    totalDue: string;
    kpiEarned: string;
    kpiPotential: string;
  };
  track?: Array<{ lat: number; lng: number }>;
  customers: CustomerCard[];
  deals: DealRow[];
};

type NotifRow = {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
};

type Tab = 'today' | 'kpi' | 'customers';

function fmtDist(m: number | null | undefined) {
  if (m == null || !Number.isFinite(m)) return null;
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

export function AgentPortal() {
  const [tokenTick, setTokenTick] = useState(0);
  const hasToken = Boolean(readAgentToken() || readStaffToken());
  if (!hasToken) return <AgentLogin onOk={() => setTokenTick((n) => n + 1)} />;
  return (
    <AgentCabinetView
      key={tokenTick}
      standalone
      onLogout={() => {
        clearAgentToken();
        sessionStorage.removeItem('smart-ombor-session');
        setTokenTick((n) => n + 1);
      }}
    />
  );
}

export function AgentCabinetPage() {
  return <AgentCabinetView standalone={false} />;
}

function AgentLogin({ onOk }: { onOk: () => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = await kpiFetch<{ token: string }>(
        '/kpi/agent/login',
        { method: 'POST', body: JSON.stringify({ login, password }) },
        'admin',
      );
      saveAgentToken(body.token);
      onOk();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="kpi-agent-gate" data-testid="page-agent-login">
      <form className="kpi-agent-card" onSubmit={(e) => void submit(e)}>
        <h1>Agent kabineti</h1>
        <p>Mijozlar, qarzdorlik, tashriflar va 3 bosqichli KPI</p>
        <label className="field"><span>Login</span><input className="input" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" /></label>
        <label className="field"><span>Parol</span><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
        {error ? <p className="kpi-error">{error}</p> : null}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>Kirish</button>
      </form>
    </main>
  );
}

function AgentCabinetView({ standalone, onLogout }: { standalone: boolean; onLogout?: () => void }) {
  const [tab, setTab] = useState<Tab>('today');
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [focusStopId, setFocusStopId] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lng: number; accuracy: number; heading: number | null } | null>(null);
  const [gpsHint, setGpsHint] = useState<string | null>(null);
  const stopRefs = useRef<Record<string, HTMLElement | null>>({});
  const cache = useQueryClient();
  const mode = readAgentToken() ? 'agent' : 'admin';
  const q = useQuery({
    queryKey: ['kpi-agent-cabinet'],
    queryFn: () => kpiFetch<CabinetData>('/kpi/agent/cabinet', {}, mode),
    refetchInterval: 45_000,
  });
  const notifs = useQuery({
    queryKey: ['kpi-agent-notifs'],
    queryFn: () => kpiFetch<NotifRow[]>('/kpi/agent/notifications', {}, mode),
    refetchInterval: 60_000,
  });
  const markNotifRead = useMutation({
    mutationFn: (id: string) =>
      kpiFetch(`/kpi/agent/notifications/${id}/read`, { method: 'POST', body: '{}' }, mode),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['kpi-agent-notifs'] }),
  });

  const focusStop = (stopId: string) => {
    setSelectedStopId(stopId);
    setFocusStopId(stopId);
    setFocusNonce((n) => n + 1);
  };

  const openNavigator = (stopId?: string | null) => {
    if (stopId) focusStop(stopId);
    setTab('today');
    setMapFullscreen(true);
  };

  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsHint('Telefon GPS qo‘llab-quvvatlamaydi.');
      return;
    }
    let lastPosted = 0;
    const onGpsFail = () => {
      setGpsHint('GPS ruxsati yo‘q yoki o‘chiq. Sozlamadan GPS ni yoqing.');
    };
    const sendLoc = (pos: GeolocationPosition) => {
      const accuracy = Number(pos.coords.accuracy);
      if (!Number.isFinite(pos.coords.latitude) || !Number.isFinite(pos.coords.longitude)) return;
      if (!Number.isFinite(accuracy) || accuracy <= 0) return;
      const next = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy,
        heading: pos.coords.heading != null && Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
      };
      setGpsHint(null);
      // Local map follows immediately (navigator feel) — only real phone GPS
      setCoords(next);
      const now = Date.now();
      // Server + admin see live trail every ~8s
      if (now - lastPosted < 8_000) return;
      lastPosted = now;
      void kpiFetch('/kpi/agent/location', {
        method: 'POST',
        body: JSON.stringify({ ...next, source: 'live' }),
      }, mode).catch(() => undefined);
      // Do NOT invalidate cabinet on every GPS ping — it remounts stop arrays and
      // aborts in-flight 1→2→3… OSRM draws before amber legs appear.
    };
    navigator.geolocation.getCurrentPosition(sendLoc, onGpsFail, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 0,
    });
    const watchId = navigator.geolocation.watchPosition(sendLoc, onGpsFail, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 15000,
    });
    return () => navigator.geolocation.clearWatch(watchId);
  }, [mode, cache]);

  const readFreshGps = () =>
    new Promise<{ lat: number; lng: number; accuracy: number; heading: number | null }>((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Telefon GPS qo‘llab-quvvatlamaydi.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          const accuracy = Number(pos.coords.accuracy);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            reject(new Error('GPS koordinata olinmadi.'));
            return;
          }
          if (!Number.isFinite(accuracy) || accuracy <= 0) {
            reject(new Error('GPS aniqlik (accuracy) yo‘q. Biroz kutib qayta urinib ko‘ring.'));
            return;
          }
          const heading = pos.coords.heading != null && Number.isFinite(pos.coords.heading) ? pos.coords.heading : null;
          const next = { lat, lng, accuracy, heading };
          setCoords(next);
          resolve(next);
        },
        () => reject(new Error('GPS ruxsati yo‘q yoki o‘chiq. Sozlamadan GPS ni yoqing.')),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
      );
    });

  const markVisit = useMutation({
    mutationFn: async (customerId: string) => {
      const gps = coords?.lat != null && coords?.lng != null && coords.accuracy > 0
        ? coords
        : await readFreshGps();
      return kpiFetch(
        '/kpi/agent/visit',
        {
          method: 'POST',
          body: JSON.stringify({
            customerId,
            lat: gps.lat,
            lng: gps.lng,
            accuracy: gps.accuracy,
            notes: 'Borildi / gaplashildi',
          }),
        },
        mode,
      );
    },
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['kpi-agent-cabinet'] }),
    onError: (err) => {
      window.alert((err as Error).message || 'Tashrif saqlanmadi');
    },
  });

  const savePin = useMutation({
    mutationFn: async (customerId: string) => {
      const gps = await readFreshGps();
      return kpiFetch(
        `/kpi/agent/customers/${customerId}/pin`,
        {
          method: 'POST',
          body: JSON.stringify({ lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy }),
        },
        mode,
      );
    },
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['kpi-agent-cabinet'] }),
  });

  const d = q.data;
  const s = d?.summary;
  // Full day route = ALL assigned customers (1→2→3…), server already nearest-neighbor ordered
  const routeStops = useMemo(() => d?.customers || [], [d?.customers]);
  const nextStop = routeStops.find((c) => c.isNext) || routeStops.find((c) => !c.visitedToday) || null;
  const targetCount = s ? (s.visitPlanCount || s.customersCount || 1) : 1;
  const visitPct = s
    ? (s.visitPct != null ? s.visitPct : Math.min(100, Math.round((s.visitedToday / targetCount) * 100)))
    : 0;
  const unreadNotifs = (notifs.data || []).filter((n) => !n.readAt);

  useEffect(() => {
    if (q.isSuccess) void cache.invalidateQueries({ queryKey: ['kpi-agent-notifs'] });
  }, [q.dataUpdatedAt, q.isSuccess, cache]);

  useEffect(() => {
    if (!routeStops.length) return;
    const next = routeStops.find((c) => c.isNext) || routeStops.find((c) => !c.visitedToday);
    setSelectedStopId((prev) => {
      if (prev && routeStops.some((c) => c.id === prev)) return prev;
      return next?.id || routeStops[0]?.id || null;
    });
  }, [routeStops]);

  useEffect(() => {
    if (!selectedStopId || tab !== 'today') return;
    const el = stopRefs.current[selectedStopId];
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectedStopId, tab]);

  const confirmVisit = async (c: CustomerCard) => {
    try {
      const gps = coords?.lat != null && coords.accuracy > 0 ? coords : await readFreshGps();
      const distLive =
        Number.isFinite(c.lat) && Number.isFinite(c.lng)
          ? Math.round(
              2 *
                6371000 *
                Math.asin(
                  Math.sqrt(
                    Math.sin((((c.lat - gps.lat) * Math.PI) / 180) / 2) ** 2 +
                      Math.cos((gps.lat * Math.PI) / 180) *
                        Math.cos((c.lat * Math.PI) / 180) *
                        Math.sin((((c.lng - gps.lng) * Math.PI) / 180) / 2) ** 2,
                  ),
                ),
            )
          : c.distanceM ?? null;
      if (distLive != null && distLive > 800) {
        const ok = window.confirm(
          `${c.name} sizdan ~${fmtDist(distLive)} uzoqda.\nBaribir «Bordim / Gaplashdim» deb belgilaysizmi?`,
        );
        if (!ok) return;
      }
      markVisit.mutate(c.id);
    } catch (err) {
      window.alert((err as Error).message || 'GPS olinmadi');
    }
  };

  const confirmPin = async (c: CustomerCard) => {
    try {
      await savePin.mutateAsync(c.id);
      window.alert(`${c.name} uchun aniq GPS saqlandi.`);
    } catch (err) {
      window.alert((err as Error).message || 'GPS saqlanmadi');
    }
  };

  return (
    <div className="ag-wrap" data-testid="page-agent-portal">
      <section className="ag-hero">
        <div className="ag-hero-main">
          <div className="ag-avatar">{(d?.agent.fullName || 'A').slice(0, 1).toUpperCase()}</div>
          <div className="ag-hero-copy">
            <span className="ag-badge"><BadgeCheck size={13} /> Savdo agenti</span>
            <h1>{d?.agent.fullName || 'Agent'}</h1>
            <p className={`ag-gps-line ${coords ? 'is-on' : ''}`}>
              <Crosshair size={13} />
              {coords
                ? `GPS ulangan · ±${Math.round(coords.accuracy)} m`
                : gpsHint || 'GPS kutilmoqda…'}
            </p>
          </div>
        </div>
        <div className="ag-hero-actions">
          <Link href="/office" className="ag-btn ag-btn-glass">
            <Fingerprint size={16} /> Davomat
          </Link>
          <button type="button" className="ag-btn ag-btn-glass" onClick={() => void q.refetch()}>
            <RefreshCw size={16} /> Yangilash
          </button>
          {standalone && onLogout ? (
            <button type="button" className="ag-btn ag-btn-glass" onClick={onLogout}>
              <LogOut size={16} /> Chiqish
            </button>
          ) : null}
        </div>
      </section>

      {q.isLoading ? <p className="kpi-muted">Ma’lumotlar yuklanmoqda…</p> : null}
      {q.error ? <p className="kpi-error">{(q.error as Error).message}</p> : null}

      {s ? (
        <section className="ag-stats ag-stats-5">
          <article className="ag-stat is-green">
            <div className="ag-stat-head">
              <span>KPI bonus</span>
              <span className="ag-stat-ico"><Wallet size={18} /></span>
            </div>
            <strong>{uzs(s.kpiEarned)}</strong>
            <small>To‘lovlardan {uzs(s.totalPaid)}</small>
          </article>
          <article className="ag-stat is-blue">
            <div className="ag-stat-head">
              <span>Oylik reja</span>
              <span className="ag-stat-ico"><Target size={18} /></span>
            </div>
            <strong>{s.planPct != null ? `${s.planPct}%` : '—'}</strong>
            <small>Reja {uzs(s.salesPlan || 0)} · Fakt {uzs(s.monthSales || 0)}</small>
          </article>
          <article className="ag-stat is-amber">
            <div className="ag-stat-head">
              <span>Qarz</span>
              <span className="ag-stat-ico"><Clock size={18} /></span>
            </div>
            <strong>{uzs(s.totalDue)}</strong>
            <small>{s.debtorsCount} ta qarzdor</small>
          </article>
          <article className="ag-stat">
            <div className="ag-stat-head">
              <span>Kunlik reja</span>
              <span className="ag-stat-ico"><Users size={18} /></span>
            </div>
            <strong>{s.visitedToday} / {targetCount}</strong>
            <div className="ag-bar"><i style={{ width: `${visitPct}%` }} /></div>
            <small>{visitPct}% · {s.debtorsCount} qarzdor</small>
          </article>
          <article className="ag-stat is-blue">
            <div className="ag-stat-head">
              <span>Qo‘shimcha KPI</span>
              <span className="ag-stat-ico"><TrendingUp size={18} /></span>
            </div>
            <strong>+{uzs(s.kpiPotential)}</strong>
            <small>1-bosqichda to‘liq olinsa</small>
          </article>
        </section>
      ) : null}

      {(notifs.data || []).length ? (
        <section className="ag-notifs">
          <div className="ag-section-head">
            <h2><Bell size={16} /> Bildirishnomalar</h2>
            <p>{unreadNotifs.length ? `${unreadNotifs.length} ta o‘qilmagan` : 'Hammasi o‘qilgan'}</p>
          </div>
          <div className="ag-notif-list">
            {(notifs.data || []).slice(0, 8).map((n) => (
              <article key={n.id} className={`ag-notif ${n.readAt ? '' : 'is-unread'}`}>
                <div>
                  <b>{n.title}</b>
                  <p>{n.body}</p>
                  <small>{new Date(n.createdAt).toLocaleString('uz-UZ')}</small>
                </div>
                {!n.readAt ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={markNotifRead.isPending}
                    onClick={() => markNotifRead.mutate(n.id)}
                  >
                    O‘qildi
                  </button>
                ) : (
                  <span className="kpi-chip ok">O‘qildi</span>
                )}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <nav className="ag-nav" aria-label="Kabinet bo‘limlari">
        <button type="button" className={tab === 'today' ? 'is-active' : ''} onClick={() => setTab('today')}>
          <Compass size={16} />
          <span>Marshrut</span>
          <em>{routeStops.length}</em>
        </button>
        <button type="button" className={tab === 'kpi' ? 'is-active' : ''} onClick={() => setTab('kpi')}>
          <Wallet size={16} />
          <span>KPI</span>
          <em>{d?.deals.length || 0}</em>
        </button>
        <button type="button" className={tab === 'customers' ? 'is-active' : ''} onClick={() => setTab('customers')}>
          <Users size={16} />
          <span>Mijozlar</span>
          <em>{d?.customers.length || 0}</em>
        </button>
      </nav>

      {tab === 'today' ? (
        <section className="ag-section ag-section-route">
          {nextStop ? (
            <div className="ag-next-banner">
              <div>
                <span>Navbatdagi nuqta</span>
                <b>#{nextStop.step}. {nextStop.name}</b>
                <small>
                  {fmtDist(nextStop.distanceM) || 'Masofa hisoblanmoqda'}
                  {Number(nextStop.debt) > 0 ? ` · olish: ${uzs(nextStop.debt)}` : ''}
                </small>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => openNavigator(nextStop.id)}
              >
                <Navigation size={15} /> <span className="ag-nav-cta-label">Navigator</span>
              </button>
            </div>
          ) : null}

          <RouteMap
            stops={routeStops as RouteStop[]}
            track={d?.track || []}
            agentName={d?.agent.fullName}
            follow
            viewer="agent"
            fullscreen={mapFullscreen}
            onFullscreenChange={setMapFullscreen}
            agentPos={
              coords ? { lat: coords.lat, lng: coords.lng, heading: coords.heading } : null
            }
            selectedStopId={selectedStopId}
            focusStopId={focusStopId}
            focusNonce={focusNonce}
            onSelectStop={(st) => focusStop(st.id)}
          />

          <div className="ag-section-head">
            <h2>Marshrut nuqtalari</h2>
            <p>1 → {routeStops.length} · barcha mijozlar ketma-ket · eng yaqindan</p>
          </div>
          <div className="ag-stops">
            {routeStops.map((c) => {
              const hasDebt = Number(c.debt) > 0;
              const selected = selectedStopId === c.id;
              return (
                <article
                  key={c.id}
                  ref={(node) => { stopRefs.current[c.id] = node; }}
                  className={`ag-stop ${c.visitedToday ? 'is-done' : c.isNext ? 'is-next-stop' : hasDebt ? 'is-due' : ''} ${selected ? 'is-selected' : ''}`}
                  onClick={() => focusStop(c.id)}
                >
                  <div className={`ag-stop-num ${c.visitedToday ? 'is-done' : c.isNext ? 'is-next' : ''}`}>
                    {c.visitedToday ? '✓' : c.step}
                  </div>
                  <div className="ag-stop-info">
                    <div className="ag-stop-title">
                      <b>#{c.step}. {c.name}</b>
                      {c.visitedToday ? (
                        <span className="kpi-chip ok">Borildi</span>
                      ) : c.isNext ? (
                        <span className="kpi-chip active">Navbatdagi</span>
                      ) : hasDebt ? (
                        <span className="kpi-chip pending">Qarz</span>
                      ) : null}
                    </div>
                    <div className="ag-stop-meta">
                      {fmtDist(c.distanceM) ? <span><Compass size={13} /> {fmtDist(c.distanceM)}</span> : null}
                      {c.phone ? (
                        <a href={`tel:${c.phone}`} className="ag-meta-link" onClick={(e) => e.stopPropagation()}>
                          <Phone size={13} /> {c.phone}
                        </a>
                      ) : null}
                      <span><MapPin size={13} /> {c.address || (c.exactGps ? 'GPS aniq' : 'Taxminiy joy')}</span>
                    </div>
                  </div>
                  <div className="ag-stop-amount">
                    <span>{hasDebt ? 'Olinishi kerak' : 'Qarz yo‘q'}</span>
                    <strong className={hasDebt ? 'is-warn' : 'is-ok'}>{uzs(c.debt)}</strong>
                  </div>
                  <div className="ag-stop-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => openNavigator(c.id)}
                    >
                      <MapPin size={15} /> Xaritada
                    </button>
                    {!c.exactGps ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={savePin.isPending}
                        onClick={() => void confirmPin(c)}
                      >
                        <Crosshair size={15} /> GPS saqlash
                      </button>
                    ) : null}
                    {c.visitedToday ? (
                      <span className="ag-done-pill"><CheckCircle2 size={16} /> Bajarildi</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={markVisit.isPending}
                        onClick={() => void confirmVisit(c)}
                      >
                        <CheckCircle2 size={15} /> Bordim
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
            {!routeStops.length && !q.isLoading ? (
              <div className="ag-empty">Hozircha marshrut nuqtasi yo‘q.</div>
            ) : null}
          </div>
        </section>
      ) : null}

      {tab === 'kpi' ? (
        <section className="ag-section">
          <div className="ag-section-head">
            <h2>KPI muddatlari</h2>
            <p>Har bir otgruzka uchun 3 bosqich</p>
          </div>
          <div className="ag-deals">
            {(d?.deals || []).map((deal) => {
              const hasDue = Number(deal.dueAmount) > 0;
              return (
                <article key={deal.id} className="ag-deal">
                  <div className="ag-deal-top">
                    <div>
                      <span className="ag-deal-no">Отгрузка №{deal.number}</span>
                      <h3>{deal.customerName}</h3>
                      <p>
                        Sana: <b>{deal.orderDate}</b> · Joriy: <b>{deal.currentStage} ({deal.currentPercent}%)</b>
                        {deal.daysRemaining != null ? ` · ${deal.daysRemaining} kun` : ''}
                      </p>
                    </div>
                    <div className="ag-deal-sums">
                      <div><span>Savdo</span><b>{uzs(deal.total)}</b></div>
                      <div><span>To‘langan</span><b className="is-ok">{uzs(deal.paidAmount)}</b></div>
                      <div><span>Qarz</span><b className={hasDue ? 'is-warn' : 'is-ok'}>{uzs(deal.dueAmount)}</b></div>
                      <div><span>KPI</span><b className="is-blue">{uzs(deal.earnedKpi)}</b></div>
                    </div>
                  </div>
                  <div className="ag-stages">
                    {deal.stages.map((st, i) => (
                      <div key={i} className={`ag-stage s-${i + 1}`}>
                        <div className="ag-stage-top">
                          <b>{st.name}</b>
                          <em>{st.percent}%</em>
                        </div>
                        <div className="ag-stage-date">
                          <Clock size={13} /> <b>{st.untilDate}</b> gacha
                        </div>
                        <strong className="ag-stage-kpi">
                          +{uzs(hasDue ? st.onRemainingDebtKpi : st.ifFullPaidKpi)}
                        </strong>
                      </div>
                    ))}
                    <div className="ag-stage s-expired">
                      <div className="ag-stage-top">
                        <b>Muddat o‘tsa</b>
                        <em>0%</em>
                      </div>
                      <div className="ag-stage-date">Oxirgi sanadan keyin</div>
                      <strong className="ag-stage-kpi">0 so‘m</strong>
                    </div>
                  </div>
                </article>
              );
            })}
            {!d?.deals.length ? <div className="ag-empty">Savdolar topilmadi.</div> : null}
          </div>
        </section>
      ) : null}

      {tab === 'customers' ? (
        <section className="ag-section">
          <div className="ag-section-head">
            <h2>Barcha mijozlar</h2>
            <p>{d?.customers.length || 0} ta biriktirilgan</p>
          </div>
          <div className="ag-stops">
            {(d?.customers || []).map((c) => (
              <article key={c.id} className="ag-stop">
                <div className="ag-stop-num">{c.step || '·'}</div>
                <div className="ag-stop-info">
                  <div className="ag-stop-title">
                    <b>{c.name}</b>
                    {c.visitedToday ? <span className="kpi-chip ok">Bugun borildi</span> : null}
                  </div>
                  <div className="ag-stop-meta">
                    {c.phone ? <a href={`tel:${c.phone}`} className="ag-meta-link"><Phone size={13} /> {c.phone}</a> : null}
                    <span><MapPin size={13} /> {c.address || 'Manzil kiritilmagan'}</span>
                  </div>
                </div>
                <div className="ag-stop-amount">
                  <span>Qarz</span>
                  <strong className={Number(c.debt) > 0 ? 'is-warn' : 'is-ok'}>{uzs(c.debt)}</strong>
                </div>
                <div className="ag-stop-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => openNavigator(c.id)}
                  >
                    <MapPin size={15} /> Xaritada
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {tab === 'today' && nextStop && !mapFullscreen ? (
        <div className="ag-mobile-dock">
          <button type="button" className="btn btn-primary" onClick={() => openNavigator(nextStop.id)}>
            <Navigation size={16} /> Navigator
          </button>
          <button
            type="button"
            className="btn"
            disabled={markVisit.isPending}
            onClick={() => confirmVisit(nextStop)}
          >
            <CheckCircle2 size={16} /> Bordim · #{nextStop.step}
          </button>
        </div>
      ) : null}
    </div>
  );
}
