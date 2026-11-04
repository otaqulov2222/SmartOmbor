import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2, Clock, Compass, Fingerprint, LogOut, MapPin, Navigation, Phone, RefreshCw,
  Sparkles, TrendingUp, Users, Wallet,
} from 'lucide-react';
import { useEffect, useState } from 'react';
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
  const [coords, setCoords] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const cache = useQueryClient();
  const mode = readAgentToken() ? 'agent' : 'admin';
  const q = useQuery({
    queryKey: ['kpi-agent-cabinet'],
    queryFn: () => kpiFetch<CabinetData>('/kpi/agent/cabinet', {}, mode),
  });

  useEffect(() => {
    if (!navigator.geolocation) return;
    const sendLoc = (pos: GeolocationPosition) => {
      const next = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy || 0 };
      setCoords(next);
      void kpiFetch('/kpi/agent/location', { method: 'POST', body: JSON.stringify(next) }, mode).catch(() => undefined);
    };
    navigator.geolocation.getCurrentPosition(sendLoc, () => undefined, { enableHighAccuracy: true, timeout: 10000 });
    const watchId = navigator.geolocation.watchPosition(sendLoc, () => undefined, {
      enableHighAccuracy: true,
      maximumAge: 30000,
      timeout: 15000,
    });
    return () => navigator.geolocation.clearWatch(watchId);
  }, [mode]);

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
  const debtors = (d?.customers || []).filter((c) => Number(c.debt) > 0);
  const targetCount = s ? (s.debtorsCount || s.customersCount || 1) : 1;
  const visitPct = s ? Math.min(100, Math.round((s.visitedToday / targetCount) * 100)) : 0;

  return (
    <div className="ag-wrap" data-testid="page-agent-portal">
      {/* Hero Banner */}
      <section className="ag-hero">
        <div className="ag-hero-main">
          <div className="ag-avatar">{(d?.agent.fullName || 'A').slice(0, 1).toUpperCase()}</div>
          <div>
            <span className="ag-badge"><Sparkles size={13} /> Savdo agenti kabineti</span>
            <h1>{d?.agent.fullName || 'Agent'}</h1>
            <p>Bugungi yo‘nalish, mijozlar qarzdorligi va shaxsiy KPI daromadingiz</p>
          </div>
        </div>
        <div className="ag-hero-actions">
          <span className="ag-btn ag-btn-glass" title="GPS holati">
            <Navigation size={15} /> {coords ? 'GPS ulangan' : 'GPS kutilmoqda'}
          </span>
          <Link href="/office" className="ag-btn ag-btn-glass">
            <Fingerprint size={16} /> Davomat va hisobot
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

      {/* 4 Primary Stat Cards */}
      {s ? (
        <section className="ag-stats">
          <article className="ag-stat is-green">
            <div className="ag-stat-head">
              <span>Tasdiqlangan KPI bonusim</span>
              <span className="ag-stat-ico"><Wallet size={18} /></span>
            </div>
            <strong>{uzs(s.kpiEarned)}</strong>
            <small>Olingan to‘lovlardan: {uzs(s.totalPaid)}</small>
          </article>

          <article className="ag-stat is-blue">
            <div className="ag-stat-head">
              <span>Qarz olinsa qo‘shiladigan KPI</span>
              <span className="ag-stat-ico"><TrendingUp size={18} /></span>
            </div>
            <strong>+{uzs(s.kpiPotential)}</strong>
            <small>1-bosqich muddatida to‘liq olinsa</small>
          </article>

          <article className="ag-stat is-amber">
            <div className="ag-stat-head">
              <span>Mijozlarda turgan pul (Qarz)</span>
              <span className="ag-stat-ico"><Clock size={18} /></span>
            </div>
            <strong>{uzs(s.totalDue)}</strong>
            <small>{s.debtorsCount} ta qarzdor mijozda</small>
          </article>

          <article className="ag-stat">
            <div className="ag-stat-head">
              <span>Bugungi tashrif rejasi</span>
              <span className="ag-stat-ico"><Users size={18} /></span>
            </div>
            <strong>{s.visitedToday} / {s.debtorsCount || s.customersCount} nuqta</strong>
            <div className="ag-bar"><i style={{ width: `${visitPct}%` }} /></div>
            <small>Jami biriktirilgan mijozlar: {s.customersCount} ta</small>
          </article>
        </section>
      ) : null}

      {/* Navigation Switch */}
      <nav className="ag-nav">
        <button type="button" className={tab === 'today' ? 'is-active' : ''} onClick={() => setTab('today')}>
          <Compass size={16} />
          <span>Bugungi nuqtalar</span>
          <em>{debtors.length || d?.customers.length || 0}</em>
        </button>
        <button type="button" className={tab === 'kpi' ? 'is-active' : ''} onClick={() => setTab('kpi')}>
          <Wallet size={16} />
          <span>KPI muddatlar va foizlar</span>
          <em>{d?.deals.length || 0}</em>
        </button>
        <button type="button" className={tab === 'customers' ? 'is-active' : ''} onClick={() => setTab('customers')}>
          <Users size={16} />
          <span>Barcha mijozlarim</span>
          <em>{d?.customers.length || 0}</em>
        </button>
      </nav>

      {/* TAB 1: Today's Route & Stops */}
      {tab === 'today' ? (
        <section className="ag-section">
          <RouteMap
            stops={(debtors.length ? debtors : d?.customers || []) as RouteStop[]}
            track={d?.track || []}
            agentPos={
              coords
                ? { lat: coords.lat, lng: coords.lng }
                : d?.agent.lat != null && d?.agent.lng != null
                  ? { lat: d.agent.lat, lng: d.agent.lng }
                  : null
            }
            selectedStopId={selectedStopId}
            onSelectStop={(st) => setSelectedStopId(st.id)}
          />

          <div className="ag-section-head">
            <div>
              <h2>Bugungi marshrut nuqtalari (1 → {(debtors.length ? debtors : d?.customers || []).length})</h2>
              <p>Nuqtaga borgach «Bordim / Gaplashdim» tugmasini bosing — <b>✓ pitichka</b> tushadi va navbat keyingi nuqtaga o‘tadi.</p>
            </div>
          </div>
          <div className="ag-stops">
            {(debtors.length ? debtors : d?.customers || []).map((c, idx) => {
              const hasDebt = Number(c.debt) > 0;
              const stepNum = c.step || idx + 1;
              return (
                <article
                  key={c.id}
                  className={`ag-stop ${c.visitedToday ? 'is-done' : c.isNext ? 'is-next-stop' : hasDebt ? 'is-due' : ''}`}
                  onClick={() => setSelectedStopId(c.id)}
                >
                  <div className={`ag-stop-num ${c.visitedToday ? 'is-done' : c.isNext ? 'is-next' : ''}`}>
                    {c.visitedToday ? '✓' : stepNum}
                  </div>
                  <div className="ag-stop-info">
                    <div className="ag-stop-title">
                      <b>#{stepNum}. {c.name}</b>
                      {c.visitedToday ? (
                        <span className="kpi-chip ok">✓ Borildi</span>
                      ) : c.isNext ? (
                        <span className="kpi-chip active">Navbatdagi nuqta</span>
                      ) : hasDebt ? (
                        <span className="kpi-chip pending">Pul olish kerak</span>
                      ) : null}
                      {c.distanceM != null ? (
                        <span className="kpi-muted">
                          · {c.distanceM >= 1000 ? `${(c.distanceM / 1000).toFixed(1)} km` : `${c.distanceM} m`}
                        </span>
                      ) : null}
                    </div>
                    <div className="ag-stop-meta">
                      {c.phone ? (
                        <a href={`tel:${c.phone}`} className="ag-meta-link" onClick={(e) => e.stopPropagation()}>
                          <Phone size={13} /> {c.phone}
                        </a>
                      ) : null}
                      <span><MapPin size={13} /> {c.address || 'Manzil xaritada belgilangan'}</span>
                    </div>
                  </div>
                  <div className="ag-stop-amount">
                    <span>Olinishi kerak</span>
                    <strong className={hasDebt ? 'is-warn' : 'is-ok'}>{uzs(c.debt)}</strong>
                  </div>
                  <div className="ag-stop-actions" onClick={(e) => e.stopPropagation()}>
                    <a
                      className="btn"
                      href={`https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Navigation size={15} /> Yo‘nalish
                    </a>
                    {c.visitedToday ? (
                      <span className="ag-done-pill"><CheckCircle2 size={16} /> Bajarildi ✓</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={markVisit.isPending}
                        onClick={() => markVisit.mutate(c.id)}
                      >
                        <CheckCircle2 size={15} /> Bordim / Gaplashdim
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
            {!d?.customers.length && !q.isLoading ? (
              <div className="ag-empty">Hozircha sizga biriktirilgan mijoz topilmadi.</div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* TAB 2: 3-Stage KPI Deadlines */}
      {tab === 'kpi' ? (
        <section className="ag-section">
          <div className="ag-section-head">
            <div>
              <h2>Har bir savdo bo‘yicha KPI muddatlari</h2>
              <p>Qaysi sanagacha pul olinsa necha foiz va qancha so‘m KPI chiqishi aniq ko‘rsatilgan.</p>
            </div>
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
                        Sana: <b>{deal.orderDate}</b> · Joriy bosqich: <b>{deal.currentStage} ({deal.currentPercent}%)</b>
                        {deal.daysRemaining != null ? ` · ${deal.daysRemaining} kun qoldi` : ''}
                      </p>
                    </div>
                    <div className="ag-deal-sums">
                      <div><span>Savdo summasi</span><b>{uzs(deal.total)}</b></div>
                      <div><span>To‘langan</span><b className="is-ok">{uzs(deal.paidAmount)}</b></div>
                      <div><span>Qolgan qarz</span><b className={hasDue ? 'is-warn' : 'is-ok'}>{uzs(deal.dueAmount)}</b></div>
                      <div><span>Yozilgan KPI</span><b className="is-blue">{uzs(deal.earnedKpi)}</b></div>
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
                          <Clock size={13} /> <b>{st.untilDate}</b> gacha olinsa
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

      {/* TAB 3: All Customers */}
      {tab === 'customers' ? (
        <section className="ag-section">
          <div className="ag-stops">
            {(d?.customers || []).map((c, idx) => (
              <article key={c.id} className="ag-stop">
                <div className="ag-stop-num">{idx + 1}</div>
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
                  <span>Joriy qarz</span>
                  <strong className={Number(c.debt) > 0 ? 'is-warn' : 'is-ok'}>{uzs(c.debt)}</strong>
                </div>
                <div className="ag-stop-actions">
                  <a
                    className="btn"
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address || c.name)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <MapPin size={15} /> Xarita
                  </a>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
