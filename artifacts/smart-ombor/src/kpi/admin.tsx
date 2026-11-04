import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, RefreshCw, ShieldCheck, Users, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { kpiFetch, uzs } from '@/kpi/api';
import './kpi.css';

type Dash = {
  agentsTotal: number; agentsActive: number; customersTotal: number; customersPending: number;
  salesTotal: string; paidTotal: string; dueTotal: string; overdueOrders: number; pendingApproval: number;
  kpiAccrued: string; kpiConfirmed: string; kpiPending: string; kpiExpired: string;
};
type Agent = {
  id: string; fullName: string; phone: string; login: string; status: string; territoryId: string | null;
  salesPlan: string; customers: number; salesTotal: string; kpiTotal: string; startedAt?: string | null;
};
type Customer = {
  id: string; name: string; phone: string; type: string; status: string; address: string;
  contactName: string; agentId: string | null; stir?: string;
};
type Order = {
  id: string; number: string; status: string; total: string; paidAmount: string; orderDate: string;
  agentId: string; customerId: string; paymentDueDate?: string | null;
};
type Payment = { id: string; orderId: string; amount: string; status: string; method: string; reference: string };
type Policy = {
  id: string; name: string; baseType: string; startAnchor: string; warningDays: number;
  stages: Array<{ name: string; dayFrom: number; dayTo: number; percent: string; sortOrder: number }>;
};
type Calc = {
  id: string; orderId: string; agentId: string; baseAmount: string; stagePercent: string; kpiAmount: string;
  status: string; stageName: string; daysRemaining: number | null;
};

const tabs = [
  { href: '/kpi', label: 'Dashboard' },
  { href: '/kpi/agents', label: 'Agentlar' },
  { href: '/kpi/customers', label: 'Hamkorlar' },
  { href: '/kpi/orders', label: 'Savdolar' },
  { href: '/kpi/payments', label: 'To‘lovlar' },
  { href: '/kpi/settings', label: 'KPI sozlamalari' },
];

function KpiNav() {
  const [path] = useLocation();
  return (
    <nav className="kpi-tabs" aria-label="KPI bo‘limlari">
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href} className={path === tab.href ? 'kpi-tab active' : 'kpi-tab'}>
          {tab.label}
        </Link>
      ))}
      <a className="kpi-tab kpi-tab-link" href="/agent" target="_blank" rel="noreferrer">Agent portal</a>
    </nav>
  );
}

function Card({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <article className={`kpi-card ${tone || ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

export function KpiDashboardPage() {
  const q = useQuery({ queryKey: ['kpi-dash'], queryFn: () => kpiFetch<Dash>('/kpi/dashboard') });
  const d = q.data;
  return (
    <div className="kpi-page" data-testid="page-kpi-dashboard">
      <KpiNav />
      <header className="kpi-head">
        <div>
          <h1>KPI boshqaruv</h1>
          <p>Agentlar savdosi, to‘lovlar va komissiya holati</p>
        </div>
        <button type="button" className="btn" onClick={() => void q.refetch()}><RefreshCw size={16} /> Yangilash</button>
      </header>
      {q.isLoading ? <p className="kpi-muted">Yuklanmoqda…</p> : null}
      {q.error ? <p className="kpi-error">{(q.error as Error).message}</p> : null}
      {d ? (
        <div className="kpi-grid">
          <Card label="Jami agentlar" value={d.agentsTotal} />
          <Card label="Faol agentlar" value={d.agentsActive} tone="ok" />
          <Card label="Hamkorlar" value={d.customersTotal} />
          <Card label="Tasdiq kutayotgan" value={d.customersPending} tone="warn" />
          <Card label="Jami savdo" value={uzs(d.salesTotal)} />
          <Card label="To‘langan" value={uzs(d.paidTotal)} tone="ok" />
          <Card label="Qarzdorlik" value={uzs(d.dueTotal)} tone="warn" />
          <Card label="Muddati o‘tgan" value={d.overdueOrders} tone="bad" />
          <Card label="KPI hisoblangan" value={uzs(d.kpiAccrued)} />
          <Card label="KPI tasdiqlangan" value={uzs(d.kpiConfirmed)} tone="ok" />
          <Card label="KPI kutilmoqda" value={uzs(d.kpiPending)} />
          <Card label="Tasdiqlanmagan savdo" value={d.pendingApproval} tone="warn" />
        </div>
      ) : null}
      <section className="kpi-panel">
        <h2>Eksport</h2>
        <div className="kpi-actions">
          {['orders', 'payments', 'kpi', 'agents', 'customers'].map((kind) => (
            <a key={kind} className="btn" href={`/api/kpi/export/${kind}`} onClick={(e) => {
              e.preventDefault();
              void kpiFetch<string>(`/kpi/export/${kind}`).then((text) => {
                const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `kpi-${kind}.csv`; a.click();
                URL.revokeObjectURL(url);
              }).catch((err: Error) => alert(err.message));
            }}><Download size={14} /> {kind}</a>
          ))}
        </div>
      </section>
    </div>
  );
}

export function KpiAgentsPage() {
  const cache = useQueryClient();
  const list = useQuery({ queryKey: ['kpi-agents'], queryFn: () => kpiFetch<Agent[]>('/kpi/agents') });
  const [form, setForm] = useState({ fullName: '', phone: '', login: '', password: '', salesPlan: '' });
  const create = useMutation({
    mutationFn: () => kpiFetch('/kpi/agents', { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => {
      setForm({ fullName: '', phone: '', login: '', password: '', salesPlan: '' });
      void cache.invalidateQueries({ queryKey: ['kpi-agents'] });
    },
  });
  return (
    <div className="kpi-page" data-testid="page-kpi-agents">
      <KpiNav />
      <header className="kpi-head"><div><h1>Agentlar</h1><p>Yaratish, faollashtirish va KPI ko‘rsatkichlari</p></div></header>
      <section className="kpi-panel">
        <h2><Users size={16} /> Yangi agent</h2>
        <div className="kpi-form">
          <input className="input" placeholder="F.I.Sh." value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          <input className="input" placeholder="Telefon" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input className="input" placeholder="Login" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
          <input className="input" type="password" placeholder="Parol" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <input className="input" placeholder="Savdo rejasi (so‘m)" value={form.salesPlan} onChange={(e) => setForm({ ...form, salesPlan: e.target.value })} />
          <button type="button" className="btn btn-primary" disabled={create.isPending} onClick={() => create.mutate()}><Plus size={16} /> Qo‘shish</button>
        </div>
        {create.error ? <p className="kpi-error">{(create.error as Error).message}</p> : null}
      </section>
      <div className="kpi-table-wrap">
        <table className="kpi-table">
          <thead><tr><th>Agent</th><th>Login</th><th>Holat</th><th>Mijozlar</th><th>Savdo</th><th>KPI</th></tr></thead>
          <tbody>
            {(list.data || []).map((a) => (
              <tr key={a.id}>
                <td><b>{a.fullName}</b><div className="kpi-muted">{a.phone}</div></td>
                <td>{a.login}</td>
                <td><span className={`kpi-chip ${a.status}`}>{a.status}</span></td>
                <td>{a.customers}</td>
                <td>{uzs(a.salesTotal)}</td>
                <td>{uzs(a.kpiTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function KpiCustomersPage() {
  const cache = useQueryClient();
  const agents = useQuery({ queryKey: ['kpi-agents'], queryFn: () => kpiFetch<Agent[]>('/kpi/agents') });
  const list = useQuery({ queryKey: ['kpi-customers'], queryFn: () => kpiFetch<Customer[]>('/kpi/customers') });
  const [form, setForm] = useState({ name: '', phone: '', type: 'store', address: '', contactName: '', agentId: '' });
  const create = useMutation({
    mutationFn: () => kpiFetch('/kpi/customers', { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => {
      setForm({ name: '', phone: '', type: 'store', address: '', contactName: '', agentId: '' });
      void cache.invalidateQueries({ queryKey: ['kpi-customers'] });
    },
  });
  const assign = useMutation({
    mutationFn: (payload: { id: string; agentId: string }) =>
      kpiFetch(`/kpi/customers/${payload.id}/assign`, { method: 'POST', body: JSON.stringify({ agentId: payload.agentId }) }),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['kpi-customers'] }),
  });
  const approve = useMutation({
    mutationFn: (id: string) => kpiFetch(`/kpi/customers/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) }),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['kpi-customers'] }),
  });
  return (
    <div className="kpi-page" data-testid="page-kpi-customers">
      <KpiNav />
      <header className="kpi-head"><div><h1>Hamkorlar</h1><p>Do‘kon / zavod bazasi va agent biriktirish</p></div></header>
      <section className="kpi-panel">
        <h2>Yangi hamkor</h2>
        <div className="kpi-form">
          <input className="input" placeholder="Nomi" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" placeholder="Telefon" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input className="input" placeholder="Mas’ul shaxs" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
          <input className="input" placeholder="Manzil" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="store">Do‘kon</option>
            <option value="factory">Zavod</option>
            <option value="distributor">Distribyutor</option>
            <option value="other">Boshqa</option>
          </select>
          <select className="input" value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
            <option value="">Agent tanlang</option>
            {(agents.data || []).map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
          </select>
          <button type="button" className="btn btn-primary" onClick={() => create.mutate()}><Plus size={16} /> Saqlash</button>
        </div>
        {create.error ? <p className="kpi-error">{(create.error as Error).message}</p> : null}
      </section>
      <div className="kpi-table-wrap">
        <table className="kpi-table">
          <thead><tr><th>Hamkor</th><th>Tur</th><th>Holat</th><th>Agent</th><th></th></tr></thead>
          <tbody>
            {(list.data || []).map((c) => (
              <tr key={c.id}>
                <td><b>{c.name}</b><div className="kpi-muted">{c.phone} · {c.address}</div></td>
                <td>{c.type}</td>
                <td><span className={`kpi-chip ${c.status}`}>{c.status}</span></td>
                <td>
                  <select className="input" value={c.agentId || ''} onChange={(e) => assign.mutate({ id: c.id, agentId: e.target.value })}>
                    <option value="">—</option>
                    {(agents.data || []).map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
                  </select>
                </td>
                <td>
                  {c.status === 'pending' ? (
                    <button type="button" className="btn btn-primary" onClick={() => approve.mutate(c.id)}><ShieldCheck size={14} /> Tasdiqlash</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function KpiOrdersPage() {
  const cache = useQueryClient();
  const agents = useQuery({ queryKey: ['kpi-agents'], queryFn: () => kpiFetch<Agent[]>('/kpi/agents') });
  const customers = useQuery({ queryKey: ['kpi-customers'], queryFn: () => kpiFetch<Customer[]>('/kpi/customers') });
  const products = useQuery({ queryKey: ['kpi-products'], queryFn: () => kpiFetch<Array<{ id: string; name: string; code: string; price: string }>>('/kpi/products') });
  const orders = useQuery({ queryKey: ['kpi-orders'], queryFn: () => kpiFetch<Order[]>('/kpi/orders') });
  const [form, setForm] = useState({ customerId: '', agentId: '', productId: '', quantity: '1', unitPrice: '', paymentDueDays: '14', notes: '' });
  const create = useMutation({
    mutationFn: async () => {
      const product = (products.data || []).find((p) => p.id === form.productId);
      return kpiFetch('/kpi/orders', {
        method: 'POST',
        body: JSON.stringify({
          customerId: form.customerId,
          agentId: form.agentId,
          paymentDueDays: Number(form.paymentDueDays) || null,
          notes: form.notes,
          lines: [{
            productId: form.productId || undefined,
            productName: product?.name || 'Mahsulot',
            productCode: product?.code || '',
            quantity: form.quantity,
            unitPrice: form.unitPrice || product?.price || 0,
          }],
        }),
      });
    },
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['kpi-orders'] }),
  });
  const confirm = useMutation({
    mutationFn: (id: string) => kpiFetch(`/kpi/orders/${id}/confirm`, { method: 'POST', body: '{}' }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ['kpi-orders'] });
      void cache.invalidateQueries({ queryKey: ['kpi-dash'] });
    },
  });
  const reject = useMutation({
    mutationFn: (id: string) => kpiFetch(`/kpi/orders/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason: 'Rad etildi' }) }),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['kpi-orders'] }),
  });
  const nameOf = useMemo(() => {
    const a = new Map((agents.data || []).map((x) => [x.id, x.fullName]));
    const c = new Map((customers.data || []).map((x) => [x.id, x.name]));
    return { a, c };
  }, [agents.data, customers.data]);
  return (
    <div className="kpi-page" data-testid="page-kpi-orders">
      <KpiNav />
      <header className="kpi-head"><div><h1>Savdolar</h1><p>Buyurtma, tasdiq va qarzdorlik</p></div></header>
      <section className="kpi-panel">
        <h2>Yangi savdo</h2>
        <div className="kpi-form">
          <select className="input" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
            <option value="">Hamkor</option>
            {(customers.data || []).filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="input" value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
            <option value="">Agent</option>
            {(agents.data || []).map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
          </select>
          <select className="input" value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })}>
            <option value="">Mahsulot</option>
            {(products.data || []).map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
          </select>
          <input className="input" placeholder="Miqdor" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          <input className="input" placeholder="Narx" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} />
          <input className="input" placeholder="To‘lov muddati (kun)" value={form.paymentDueDays} onChange={(e) => setForm({ ...form, paymentDueDays: e.target.value })} />
          <button type="button" className="btn btn-primary" onClick={() => create.mutate()}>Yuborish</button>
        </div>
        {create.error ? <p className="kpi-error">{(create.error as Error).message}</p> : null}
        {(products.data || []).length === 0 ? (
          <p className="kpi-muted">Avval Sozlamalarda mahsulot qo‘shing yoki pastdagi tezkor tugmadan.</p>
        ) : null}
      </section>
      <div className="kpi-table-wrap">
        <table className="kpi-table">
          <thead><tr><th>Raqam</th><th>Hamkor / Agent</th><th>Summa</th><th>To‘langan</th><th>Holat</th><th></th></tr></thead>
          <tbody>
            {(orders.data || []).map((o) => (
              <tr key={o.id}>
                <td><b>{o.number}</b><div className="kpi-muted">{o.orderDate}</div></td>
                <td>{nameOf.c.get(o.customerId) || o.customerId}<div className="kpi-muted">{nameOf.a.get(o.agentId) || o.agentId}</div></td>
                <td>{uzs(o.total)}</td>
                <td>{uzs(o.paidAmount)}</td>
                <td><span className={`kpi-chip ${o.status}`}>{o.status}</span></td>
                <td className="kpi-row-actions">
                  {o.status === 'pending_approval' || o.status === 'draft' ? (
                    <>
                      <button type="button" className="btn btn-primary" onClick={() => confirm.mutate(o.id)}>Tasdiqlash</button>
                      <button type="button" className="btn" onClick={() => reject.mutate(o.id)}>Rad</button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function KpiPaymentsPage() {
  const cache = useQueryClient();
  const orders = useQuery({ queryKey: ['kpi-orders'], queryFn: () => kpiFetch<Order[]>('/kpi/orders') });
  const payments = useQuery({ queryKey: ['kpi-payments'], queryFn: () => kpiFetch<Payment[]>('/kpi/payments') });
  const calcs = useQuery({ queryKey: ['kpi-calcs'], queryFn: () => kpiFetch<Calc[]>('/kpi/calculations') });
  const [form, setForm] = useState({ orderId: '', amount: '', reference: '' });
  const create = useMutation({
    mutationFn: () => kpiFetch('/kpi/payments', {
      method: 'POST',
      body: JSON.stringify({ ...form, confirm: true, idempotencyKey: `pay-${form.orderId}-${form.amount}-${Date.now()}` }),
    }),
    onSuccess: () => {
      setForm({ orderId: '', amount: '', reference: '' });
      void cache.invalidateQueries({ queryKey: ['kpi-payments'] });
      void cache.invalidateQueries({ queryKey: ['kpi-orders'] });
      void cache.invalidateQueries({ queryKey: ['kpi-calcs'] });
      void cache.invalidateQueries({ queryKey: ['kpi-dash'] });
    },
  });
  return (
    <div className="kpi-page" data-testid="page-kpi-payments">
      <KpiNav />
      <header className="kpi-head"><div><h1>To‘lovlar va KPI</h1><p>Tasdiqlangan tushumlar asosida hisob-kitob</p></div></header>
      <section className="kpi-panel">
        <h2><Wallet size={16} /> To‘lov qayd etish</h2>
        <div className="kpi-form">
          <select className="input" value={form.orderId} onChange={(e) => setForm({ ...form, orderId: e.target.value })}>
            <option value="">Savdo</option>
            {(orders.data || []).filter((o) => !['draft', 'cancelled', 'paid'].includes(o.status)).map((o) => (
              <option key={o.id} value={o.id}>{o.number} — {uzs(o.total)} / {uzs(o.paidAmount)}</option>
            ))}
          </select>
          <input className="input" placeholder="Summa" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <input className="input" placeholder="Hujjat / izoh" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          <button type="button" className="btn btn-primary" onClick={() => create.mutate()}>Tasdiqlash</button>
        </div>
        {create.error ? <p className="kpi-error">{(create.error as Error).message}</p> : null}
      </section>
      <div className="kpi-split">
        <div className="kpi-table-wrap">
          <h3>To‘lovlar</h3>
          <table className="kpi-table">
            <thead><tr><th>Summa</th><th>Holat</th><th>Reference</th></tr></thead>
            <tbody>
              {(payments.data || []).map((p) => (
                <tr key={p.id}><td>{uzs(p.amount)}</td><td>{p.status}</td><td>{p.reference || p.orderId.slice(0, 8)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="kpi-table-wrap">
          <h3>KPI hisoblar</h3>
          <table className="kpi-table">
            <thead><tr><th>Bosqich</th><th>%</th><th>KPI</th><th>Kun</th><th>Holat</th></tr></thead>
            <tbody>
              {(calcs.data || []).map((c) => (
                <tr key={c.id}>
                  <td>{c.stageName}</td>
                  <td>{c.stagePercent}%</td>
                  <td>{uzs(c.kpiAmount)}</td>
                  <td>{c.daysRemaining ?? '—'}</td>
                  <td><span className={`kpi-chip ${c.status}`}>{c.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function KpiSettingsPage() {
  const cache = useQueryClient();
  const policy = useQuery({ queryKey: ['kpi-policy'], queryFn: () => kpiFetch<Policy>('/kpi/policy') });
  const [stages, setStages] = useState<Policy['stages'] | null>(null);
  const [product, setProduct] = useState({ code: '', name: '', price: '' });
  const current = stages || policy.data?.stages || [];
  const save = useMutation({
    mutationFn: () => kpiFetch('/kpi/policy', {
      method: 'PUT',
      body: JSON.stringify({
        name: policy.data?.name || 'Standart 3 bosqich',
        baseType: policy.data?.baseType || 'paid_amount',
        startAnchor: policy.data?.startAnchor || 'order_confirmed',
        warningDays: policy.data?.warningDays ?? 2,
        stages: current,
      }),
    }),
    onSuccess: () => {
      setStages(null);
      void cache.invalidateQueries({ queryKey: ['kpi-policy'] });
    },
  });
  const addProduct = useMutation({
    mutationFn: () => kpiFetch('/kpi/products', { method: 'POST', body: JSON.stringify(product) }),
    onSuccess: () => {
      setProduct({ code: '', name: '', price: '' });
      void cache.invalidateQueries({ queryKey: ['kpi-products'] });
    },
  });
  const recalc = useMutation({
    mutationFn: () => kpiFetch('/kpi/recalculate', { method: 'POST', body: '{}' }),
  });
  return (
    <div className="kpi-page" data-testid="page-kpi-settings">
      <KpiNav />
      <header className="kpi-head"><div><h1>KPI sozlamalari</h1><p>3 bosqichli foiz va muddatlar — kodga hardcode yo‘q</p></div></header>
      <section className="kpi-panel">
        <h2>Bosqichlar</h2>
        <div className="kpi-stages">
          {current.map((stage, index) => (
            <div className="kpi-stage" key={index}>
              <input className="input" value={stage.name} onChange={(e) => {
                const next = [...current];
                next[index] = { ...stage, name: e.target.value };
                setStages(next);
              }} />
              <input className="input" type="number" value={stage.dayFrom} onChange={(e) => {
                const next = [...current];
                next[index] = { ...stage, dayFrom: Number(e.target.value) };
                setStages(next);
              }} />
              <input className="input" type="number" value={stage.dayTo} onChange={(e) => {
                const next = [...current];
                next[index] = { ...stage, dayTo: Number(e.target.value) };
                setStages(next);
              }} />
              <input className="input" value={stage.percent} onChange={(e) => {
                const next = [...current];
                next[index] = { ...stage, percent: e.target.value };
                setStages(next);
              }} />
            </div>
          ))}
        </div>
        <p className="kpi-muted">Ustunlar: nom · kun dan · kun gacha · foiz</p>
        <div className="kpi-actions">
          <button type="button" className="btn btn-primary" onClick={() => save.mutate()}>Saqlash</button>
          <button type="button" className="btn" onClick={() => recalc.mutate()}>Qayta hisoblash</button>
        </div>
        {save.error ? <p className="kpi-error">{(save.error as Error).message}</p> : null}
        {recalc.isSuccess ? <p className="kpi-ok">Hisoblar yangilandi</p> : null}
      </section>
      <section className="kpi-panel">
        <h2>KPI mahsulotlari</h2>
        <div className="kpi-form">
          <input className="input" placeholder="Kod" value={product.code} onChange={(e) => setProduct({ ...product, code: e.target.value })} />
          <input className="input" placeholder="Nomi" value={product.name} onChange={(e) => setProduct({ ...product, name: e.target.value })} />
          <input className="input" placeholder="Narx" value={product.price} onChange={(e) => setProduct({ ...product, price: e.target.value })} />
          <button type="button" className="btn btn-primary" onClick={() => addProduct.mutate()}>Mahsulot qo‘shish</button>
        </div>
        {addProduct.error ? <p className="kpi-error">{(addProduct.error as Error).message}</p> : null}
      </section>
    </div>
  );
}
