import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, MapPin, Plus, Wallet } from 'lucide-react';
import { useState } from 'react';
import { clearAgentToken, kpiFetch, readAgentToken, saveAgentToken, uzs } from './api';
import './kpi.css';

type Me = { id: string; fullName: string; login: string; phone: string; salesPlan: string };
type Dash = {
  customers: number; salesTotal: string; paidTotal: string; awaitingPayments: number;
  kpiConfirmed: string; kpiPending: string; kpiAtRisk: string;
  nearestDue: { number: string; due: string; total: string; paid: string } | null;
};
type Customer = { id: string; name: string; phone: string; address: string; status: string; contactName: string };
type Order = { id: string; number: string; status: string; total: string; paidAmount: string; orderDate: string };
type Calc = { id: string; orderId: string; baseAmount: string; stagePercent: string; kpiAmount: string; status: string; stageName: string; daysRemaining: number | null };
type Product = { id: string; name: string; code: string; price: string };

type Tab = 'home' | 'customers' | 'orders' | 'kpi';

export function AgentPortal() {
  const [tokenTick, setTokenTick] = useState(0);
  const token = readAgentToken();
  if (!token) return <AgentLogin onOk={() => setTokenTick((n) => n + 1)} />;
  return <AgentShell key={tokenTick} onLogout={() => { clearAgentToken(); setTokenTick((n) => n + 1); }} />;
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
      const body = await kpiFetch<{ token: string }>('/kpi/agent/login', {
        method: 'POST',
        body: JSON.stringify({ login, password }),
      }, 'admin');
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
        <h1>Agent panel</h1>
        <p>Savdo, mijozlar va KPI daromadingiz</p>
        <label className="field"><span>Login</span><input className="input" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" /></label>
        <label className="field"><span>Parol</span><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
        {error ? <p className="kpi-error">{error}</p> : null}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>Kirish</button>
      </form>
    </main>
  );
}

function AgentShell({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('home');
  const me = useQuery({ queryKey: ['kpi-agent-me'], queryFn: () => kpiFetch<Me>('/kpi/agent/me', {}, 'agent') });
  const logout = async () => {
    try { await kpiFetch('/kpi/agent/logout', { method: 'POST', body: '{}' }, 'agent'); } catch { /* ignore */ }
    onLogout();
  };
  return (
    <div className="kpi-agent" data-testid="page-agent-portal">
      <header className="kpi-agent-top">
        <div>
          <strong>{me.data?.fullName || 'Agent'}</strong>
          <span>{me.data?.login}</span>
        </div>
        <button type="button" className="btn" onClick={() => void logout()}><LogOut size={16} /> Chiqish</button>
      </header>
      <div className="kpi-agent-body">
        {tab === 'home' ? <AgentHome /> : null}
        {tab === 'customers' ? <AgentCustomers /> : null}
        {tab === 'orders' ? <AgentOrders /> : null}
        {tab === 'kpi' ? <AgentKpi /> : null}
      </div>
      <nav className="kpi-agent-nav">
        <button type="button" className={tab === 'home' ? 'active' : ''} onClick={() => setTab('home')}>Bosh</button>
        <button type="button" className={tab === 'customers' ? 'active' : ''} onClick={() => setTab('customers')}>Mijozlar</button>
        <button type="button" className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>Savdo</button>
        <button type="button" className={tab === 'kpi' ? 'active' : ''} onClick={() => setTab('kpi')}>KPI</button>
      </nav>
    </div>
  );
}

function AgentHome() {
  const dash = useQuery({ queryKey: ['kpi-agent-dash'], queryFn: () => kpiFetch<Dash>('/kpi/agent/dashboard', {}, 'agent') });
  const d = dash.data;
  return (
    <section>
      <h2>Bugungi holat</h2>
      {dash.isLoading ? <p className="kpi-muted">Yuklanmoqda…</p> : null}
      {d ? (
        <div className="kpi-grid">
          <article className="kpi-card"><span>Mijozlar</span><strong>{d.customers}</strong></article>
          <article className="kpi-card"><span>Jami savdo</span><strong>{uzs(d.salesTotal)}</strong></article>
          <article className="kpi-card ok"><span>To‘langan</span><strong>{uzs(d.paidTotal)}</strong></article>
          <article className="kpi-card"><span>To‘lov kutilmoqda</span><strong>{d.awaitingPayments}</strong></article>
          <article className="kpi-card ok"><span>Tasdiqlangan KPI</span><strong>{uzs(d.kpiConfirmed)}</strong></article>
          <article className="kpi-card warn"><span>Kutilayotgan KPI</span><strong>{uzs(d.kpiPending)}</strong></article>
          <article className="kpi-card bad"><span>Xavf ostida KPI</span><strong>{uzs(d.kpiAtRisk)}</strong></article>
        </div>
      ) : null}
      {d?.nearestDue ? (
        <div className="kpi-panel">
          <h3>Eng yaqin to‘lov</h3>
          <p><b>{d.nearestDue.number}</b> — muddat {d.nearestDue.due}</p>
          <p>{uzs(d.nearestDue.paid)} / {uzs(d.nearestDue.total)}</p>
        </div>
      ) : null}
    </section>
  );
}

function AgentCustomers() {
  const cache = useQueryClient();
  const list = useQuery({ queryKey: ['kpi-agent-customers'], queryFn: () => kpiFetch<Customer[]>('/kpi/agent/customers', {}, 'agent') });
  const [form, setForm] = useState({ name: '', phone: '', address: '', contactName: '', notes: '' });
  const create = useMutation({
    mutationFn: () => kpiFetch('/kpi/agent/customers', { method: 'POST', body: JSON.stringify(form) }, 'agent'),
    onSuccess: () => {
      setForm({ name: '', phone: '', address: '', contactName: '', notes: '' });
      void cache.invalidateQueries({ queryKey: ['kpi-agent-customers'] });
    },
  });
  return (
    <section>
      <h2>Mening mijozlarim</h2>
      <div className="kpi-panel">
        <h3><Plus size={14} /> Yangi hamkorlik (admin tasdig‘iga)</h3>
        <div className="kpi-form">
          <input className="input" placeholder="Korxona" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" placeholder="Telefon" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input className="input" placeholder="Mas’ul" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
          <input className="input" placeholder="Manzil" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <button type="button" className="btn btn-primary" onClick={() => create.mutate()}>Yuborish</button>
        </div>
        {create.error ? <p className="kpi-error">{(create.error as Error).message}</p> : null}
      </div>
      <div className="kpi-list">
        {(list.data || []).map((c) => (
          <article key={c.id} className="kpi-list-item">
            <div>
              <b>{c.name}</b>
              <div className="kpi-muted">{c.contactName} · {c.phone}</div>
              <div className="kpi-muted"><MapPin size={12} /> {c.address || 'Manzil yo‘q'}</div>
            </div>
            <span className={`kpi-chip ${c.status}`}>{c.status}</span>
            {c.address ? (
              <a className="btn" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address)}`} target="_blank" rel="noreferrer">Xarita</a>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function AgentOrders() {
  const cache = useQueryClient();
  const customers = useQuery({ queryKey: ['kpi-agent-customers'], queryFn: () => kpiFetch<Customer[]>('/kpi/agent/customers', {}, 'agent') });
  const products = useQuery({ queryKey: ['kpi-agent-products'], queryFn: () => kpiFetch<Product[]>('/kpi/agent/products', {}, 'agent') });
  const orders = useQuery({ queryKey: ['kpi-agent-orders'], queryFn: () => kpiFetch<Order[]>('/kpi/agent/orders', {}, 'agent') });
  const [form, setForm] = useState({ customerId: '', productId: '', quantity: '1', unitPrice: '', paymentDueDays: '14' });
  const create = useMutation({
    mutationFn: async () => {
      const product = (products.data || []).find((p) => p.id === form.productId);
      return kpiFetch('/kpi/agent/orders', {
        method: 'POST',
        body: JSON.stringify({
          customerId: form.customerId,
          paymentDueDays: Number(form.paymentDueDays) || 14,
          lines: [{
            productId: form.productId || undefined,
            productName: product?.name || 'Mahsulot',
            productCode: product?.code || '',
            quantity: form.quantity,
            unitPrice: form.unitPrice || product?.price || 0,
          }],
        }),
      }, 'agent');
    },
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['kpi-agent-orders'] }),
  });
  return (
    <section>
      <h2>Savdo rasmiylashtirish</h2>
      <div className="kpi-panel">
        <div className="kpi-form">
          <select className="input" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
            <option value="">Mijoz</option>
            {(customers.data || []).filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="input" value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })}>
            <option value="">Mahsulot</option>
            {(products.data || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className="input" placeholder="Miqdor" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          <input className="input" placeholder="Narx (bo‘sh = katalog)" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} />
          <button type="button" className="btn btn-primary" onClick={() => create.mutate()}>Tasdiqqa yuborish</button>
        </div>
        {create.error ? <p className="kpi-error">{(create.error as Error).message}</p> : null}
      </div>
      <div className="kpi-list">
        {(orders.data || []).map((o) => (
          <article key={o.id} className="kpi-list-item">
            <div>
              <b>{o.number}</b>
              <div className="kpi-muted">{o.orderDate}</div>
            </div>
            <div>{uzs(o.total)}</div>
            <span className={`kpi-chip ${o.status}`}>{o.status}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function AgentKpi() {
  const list = useQuery({ queryKey: ['kpi-agent-kpi'], queryFn: () => kpiFetch<Calc[]>('/kpi/agent/kpi', {}, 'agent') });
  return (
    <section>
      <h2><Wallet size={16} /> Mening KPI daromadim</h2>
      <div className="kpi-list">
        {(list.data || []).map((c) => (
          <article key={c.id} className="kpi-list-item kpi-kpi-card">
            <div>
              <b>{c.stageName}</b>
              <div className="kpi-muted">Baza {uzs(c.baseAmount)} · {c.stagePercent}%</div>
              <div className="kpi-muted">Qolgan kun: {c.daysRemaining ?? '—'}</div>
            </div>
            <strong>{uzs(c.kpiAmount)}</strong>
            <span className={`kpi-chip ${c.status}`}>{c.status}</span>
          </article>
        ))}
        {!list.data?.length && !list.isLoading ? <p className="kpi-muted">Hali KPI hisobi yo‘q.</p> : null}
      </div>
    </section>
  );
}
