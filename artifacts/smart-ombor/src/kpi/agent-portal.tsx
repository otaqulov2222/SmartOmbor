import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, Fingerprint, LogOut, MapPin, Phone, RefreshCw, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { clearAgentToken, kpiFetch, readAgentToken, readStaffToken, saveAgentToken, uzs } from './api';
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
  name: string;
  phone: string;
  address: string;
  debt: string;
  visitedToday: boolean;
};

type CabinetData = {
  agent: { id: string; fullName: string; login: string; phone: string; salesPlan: string };
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
  const cache = useQueryClient();
  const mode = readAgentToken() ? 'agent' : 'admin';
  const q = useQuery({
    queryKey: ['kpi-agent-cabinet'],
    queryFn: () => kpiFetch<CabinetData>('/kpi/agent/cabinet', {}, mode),
  });
  const markVisit = useMutation({
    mutationFn: (customerId: string) =>
      kpiFetch('/kpi/agent/visit', { method: 'POST', body: JSON.stringify({ customerId, notes: 'Borildi / gaplashildi' }) }, mode),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['kpi-agent-cabinet'] }),
  });

  const d = q.data;
  const s = d?.summary;
  const debtors = (d?.customers || []).filter((c) => Number(c.debt) > 0);
  const openDeals = (d?.deals || []).filter((x) => Number(x.dueAmount) > 0);

  return (
    <div className={standalone ? 'kpi-agent' : 'kpi-page'} data-testid="page-agent-portal">
      {standalone ? (
        <header className="kpi-agent-top">
          <div>
            <strong>{d?.agent.fullName || 'Agent'}</strong>
            <span>Login: {d?.agent.login}</span>
          </div>
          <div className="kpi-actions">
            <Link href="/office" className="btn"><Fingerprint size={15} /> Davomat</Link>
            <button type="button" className="btn" onClick={() => void q.refetch()}><RefreshCw size={15} /></button>
            {onLogout ? <button type="button" className="btn" onClick={onLogout}><LogOut size={15} /> Chiqish</button> : null}
          </div>
        </header>
      ) : (
        <header className="kpi-head">
          <div>
            <h1>{d?.agent.fullName || 'Agent'} — Shaxsiy kabinet</h1>
            <p>Bugungi nuqtalar, olinishi kerak bo‘lgan pullar va 3 bosqichli KPI hisobingiz</p>
          </div>
          <div className="kpi-actions">
            <Link href="/office" className="btn"><Fingerprint size={15} /> Davomat</Link>
            <button type="button" className="btn" onClick={() => void q.refetch()}><RefreshCw size={15} /> Yangilash</button>
          </div>
        </header>
      )}

      <div className={standalone ? 'kpi-agent-body' : ''}>
        {q.isLoading ? <p className="kpi-muted">Yuklanmoqda…</p> : null}
        {q.error ? <p className="kpi-error">{(q.error as Error).message}</p> : null}

        {s ? (
          <div className="kpi-grid" style={{ marginBottom: '1rem' }}>
            <article className="kpi-card"><span>Jami mijozlarim</span><strong>{s.customersCount} ta</strong></article>
            <article className="kpi-card warn"><span>Pul olinadigan nuqtalar</span><strong>{s.debtorsCount} ta mijoz</strong></article>
            <article className="kpi-card ok"><span>Bugun borildi / gaplashildi</span><strong>{s.visitedToday} / {s.debtorsCount || s.customersCount}</strong></article>
            <article className="kpi-card warn"><span>Mijozlarda turgan pul (Qarz)</span><strong>{uzs(s.totalDue)}</strong></article>
            <article className="kpi-card ok"><span>Olingan pul (To‘langan)</span><strong>{uzs(s.totalPaid)}</strong></article>
            <article className="kpi-card ok"><span>Tasdiqlangan KPI bonusim</span><strong>{uzs(s.kpiEarned)}</strong></article>
            <article className="kpi-card"><span>Qarz olinsa qo‘shiladigan KPI (1-bosqichda)</span><strong>+{uzs(s.kpiPotential)}</strong></article>
          </div>
        ) : null}

        <div className="kpi-seg" style={{ marginBottom: '1rem' }}>
          <button type="button" className={tab === 'today' ? 'active' : ''} onClick={() => setTab('today')}>
            Bugungi vazifa ({debtors.length} nuqta)
          </button>
          <button type="button" className={tab === 'kpi' ? 'active' : ''} onClick={() => setTab('kpi')}>
            Qachon olinsa qancha KPI ({d?.deals.length || 0})
          </button>
          <button type="button" className={tab === 'customers' ? 'active' : ''} onClick={() => setTab('customers')}>
            Barcha mijozlarim ({d?.customers.length || 0})
          </button>
        </div>

        {tab === 'today' ? (
          <section className="kpi-panel">
            <h2>Bugun borish va gaplashish kerak bo‘lgan nuqtalar</h2>
            <p className="kpi-muted">Qarzdorligi bor mijozlar birinchi chiqadi. Borib gaplashgach «Bordim / Gaplashdim» tugmasini bosing.</p>
            <div className="kpi-list">
              {(debtors.length ? debtors : d?.customers || []).map((c, idx) => (
                <article key={c.id} className="kpi-list-item">
                  <div>
                    <b>{idx + 1}. {c.name}</b>
                    <div className="kpi-muted">
                      {c.phone ? <><Phone size={12} /> {c.phone} · </> : null}
                      <MapPin size={12} /> {c.address || 'Manzil ko‘rsatilmagan'}
                    </div>
                  </div>
                  <div>
                    <div className="kpi-muted">Olinishi kerak:</div>
                    <strong style={{ color: Number(c.debt) > 0 ? '#b45309' : '#15803d' }}>{uzs(c.debt)}</strong>
                  </div>
                  <div className="kpi-row-actions">
                    <a
                      className="btn"
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address || c.name)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <MapPin size={14} /> Xarita
                    </a>
                    {c.visitedToday ? (
                      <span className="kpi-chip ok"><CheckCircle2 size={14} /> Bugun borildi</span>
                    ) : (
                      <button type="button" className="btn btn-primary" onClick={() => markVisit.mutate(c.id)}>
                        Bordim / Gaplashdim
                      </button>
                    )}
                  </div>
                </article>
              ))}
              {!d?.customers.length ? <p className="kpi-muted">Sizga hali mijoz biriktirilmagan.</p> : null}
            </div>
          </section>
        ) : null}

        {tab === 'kpi' ? (
          <section className="kpi-list">
            {(openDeals.length ? openDeals : d?.deals || []).map((deal) => (
              <article key={deal.id} className="kpi-panel">
                <div className="kpi-panel-head">
                  <div>
                    <h3>Отгрузка №{deal.number} — {deal.customerName}</h3>
                    <div className="kpi-muted">Sana: {deal.orderDate} · Hozirgi bosqich: <b>{deal.currentStage} ({deal.currentPercent}%)</b> {deal.daysRemaining != null ? `· ${deal.daysRemaining} kun qoldi` : ''}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div>Jami savdo: <b>{uzs(deal.total)}</b></div>
                    <div className="kpi-muted">To‘langan: {uzs(deal.paidAmount)} · <b style={{ color: '#b45309' }}>Qolgan qarz: {uzs(deal.dueAmount)}</b></div>
                  </div>
                </div>
                <div className="kpi-grid">
                  {deal.stages.map((st, i) => (
                    <div key={i} className={`kpi-card ${i === 0 ? 'ok' : i === 1 ? 'warn' : ''}`}>
                      <span><Clock size={12} /> {st.name}: <b>{st.untilDate} gacha</b> olinsa ({st.percent}%)</span>
                      <strong>
                        <Wallet size={14} /> {uzs(Number(deal.dueAmount) > 0 ? st.onRemainingDebtKpi : st.ifFullPaidKpi)}
                      </strong>
                      <small className="kpi-muted">
                        {Number(deal.dueAmount) > 0
                          ? `Qolgan ${uzs(deal.dueAmount)} shu sanagacha tushsa`
                          : `To‘liq savdodan (${st.percent}%)`}
                      </small>
                    </div>
                  ))}
                  <div className="kpi-card bad">
                    <span>Muddat o‘tib ketsa</span>
                    <strong>0 so‘m (0%)</strong>
                    <small className="kpi-muted">Oxirgi bosqichdan keyin bonus kuyadi</small>
                  </div>
                </div>
              </article>
            ))}
            {!d?.deals.length ? <p className="kpi-muted">Savdolar topilmadi.</p> : null}
          </section>
        ) : null}

        {tab === 'customers' ? (
          <div className="kpi-table-wrap">
            <table className="kpi-table">
              <thead><tr><th>Mijoz</th><th>Telefon / Manzil</th><th>Joriy qarz</th><th>Bugungi holat</th></tr></thead>
              <tbody>
                {(d?.customers || []).map((c) => (
                  <tr key={c.id}>
                    <td><b>{c.name}</b></td>
                    <td className="kpi-muted">{c.phone} {c.address}</td>
                    <td><b>{uzs(c.debt)}</b></td>
                    <td>{c.visitedToday ? <span className="kpi-chip ok">Borildi</span> : <span className="kpi-chip">Rejada</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
