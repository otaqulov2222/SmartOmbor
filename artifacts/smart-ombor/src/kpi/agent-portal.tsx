import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2, Clock, Compass, Fingerprint, LogOut, MapPin, Navigation, Phone, RefreshCw,
  Sparkles, TrendingUp, Users, Wallet,
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
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lng: number; accuracy: number; heading: number | null } | null>(null);
  const stopRefs = useRef<Record<string, HTMLElement | null>>({});
  const cache = useQueryClient();
  const mode = readAgentToken() ? 'agent' : 'admin';
  const q = useQuery({
    queryKey: ['kpi-agent-cabinet'],
    queryFn: () => kpiFetch<CabinetData>('/kpi/agent/cabinet', {}, mode),
    refetchInterval: 45_000,
  });

  const openNavigator = (stopId?: string | null) => {
    if (stopId) setSelectedStopId(stopId);
    setTab('today');
    setMapFullscreen(true);
  };

  useEffect(() => {
    if (!navigator.geolocation) return;
    let lastPosted = 0;
    const sendLoc = (pos: GeolocationPosition) => {
      const next = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy || 0,
        heading: pos.coords.heading != null && Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
      };
      // Local map follows immediately (navigator feel)
      setCoords(next);
      const now = Date.now();
      // Server + admin see live trail every ~8s
      if (now - lastPosted < 8_000) return;
      lastPosted = now;
      void kpiFetch('/kpi/agent/location', {
        method: 'POST',
        body: JSON.stringify({ ...next, source: 'live' }),
      }, mode)
        .then(() => cache.invalidateQueries({ queryKey: ['kpi-agent-cabinet'] }))
        .catch(() => undefined);
    };
    navigator.geolocation.getCurrentPosition(sendLoc, () => undefined, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 0,
    });
    const watchId = navigator.geolocation.watchPosition(sendLoc, () => undefined, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 15000,
    });
    return () => navigator.geolocation.clearWatch(watchId);
  }, [mode, cache]);

  const markVisit = useMutation({
    mutationFn: (customerId: string) =>
      kpiFetch(
        '/kpi/agent/visit',
        {
          method: 'POST',
          body: JSON.stringify({
            customerId,
            lat: coords?.lat ?? null,
            lng: coords?.lng ?? null,
            accuracy: coords?.accuracy ?? null,
            notes: 'Borildi / gaplashildi',
          }),
        },
        mode,
      ),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['kpi-agent-cabinet'] }),
  });

  const d = q.data;
  const s = d?.summary;
  // Full day route = ALL assigned customers (1→2→3…), server already nearest-neighbor ordered
  const routeStops = useMemo(() => d?.customers || [], [d?.customers]);
  const nextStop = routeStops.find((c) => c.isNext) || routeStops.find((c) => !c.visitedToday) || null;
  const targetCount = s ? (s.customersCount || 1) : 1;
  const visitPct = s ? Math.min(100, Math.round((s.visitedToday / targetCount) * 100)) : 0;

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

  const confirmVisit = (c: CustomerCard) => {
    if (c.distanceM != null && c.distanceM > 800 && coords) {
      const ok = window.confirm(
        `${c.name} sizdan ~${fmtDist(c.distanceM)} uzoqda.\nBaribir «Bordim / Gaplashdim» deb belgilaysizmi?`,
      );
      if (!ok) return;
    }
    markVisit.mutate(c.id);
  };

  return (
    <div className="ag-wrap" data-testid="page-agent-portal">
      <section className="ag-hero">
        <div className="ag-hero-main">
          <div className="ag-avatar">{(d?.agent.fullName || 'A').slice(0, 1).toUpperCase()}</div>
          <div className="ag-hero-copy">
            <span className="ag-badge"><Sparkles size={13} /> Savdo agenti</span>
            <h1>{d?.agent.fullName || 'Agent'}</h1>
            <p className={`ag-gps-line ${coords ? 'is-on' : ''}`}>
              <Navigation size={13} />
              {coords ? `GPS ulangan · ±${Math.round(coords.accuracy || 0)} m` : 'GPS kutilmoqda…'}
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
        <section className="ag-stats">
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
              <span>Qo‘shimcha KPI</span>
              <span className="ag-stat-ico"><TrendingUp size={18} /></span>
            </div>
            <strong>+{uzs(s.kpiPotential)}</strong>
            <small>1-bosqichda to‘liq olinsa</small>
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
              <span>Bugungi reja</span>
              <span className="ag-stat-ico"><Users size={18} /></span>
            </div>
            <strong>{s.visitedToday} / {s.customersCount}</strong>
            <div className="ag-bar"><i style={{ width: `${visitPct}%` }} /></div>
            <small>{s.customersCount} ta nuqta · {s.debtorsCount} qarzdor</small>
          </article>
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
            fullscreen={mapFullscreen}
            onFullscreenChange={setMapFullscreen}
            agentPos={
              coords
                ? { lat: coords.lat, lng: coords.lng, heading: coords.heading }
                : d?.agent.lat != null && d?.agent.lng != null
                  ? { lat: d.agent.lat, lng: d.agent.lng }
                  : null
            }
            selectedStopId={selectedStopId}
            onSelectStop={(st) => setSelectedStopId(st.id)}
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
                  onClick={() => setSelectedStopId(c.id)}
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
                    <span>Olinishi kerak</span>
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
                    {c.visitedToday ? (
                      <span className="ag-done-pill"><CheckCircle2 size={16} /> Bajarildi</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={markVisit.isPending}
                        onClick={() => confirmVisit(c)}
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
