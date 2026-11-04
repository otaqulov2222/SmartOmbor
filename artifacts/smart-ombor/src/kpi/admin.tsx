import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, Plus, RefreshCw, ShieldCheck, Users, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { kpiFetch, uzs } from '@/kpi/api';
import './kpi.css';

type Dash = {
  agentsTotal: number; agentsActive: number; customersTotal: number; customersPending: number;
  salesTotal: string; paidTotal: string; dueTotal: string; overdueOrders: number; pendingApproval: number;
  kpiAccrued: string; kpiConfirmed: string; kpiPending: string; kpiExpired: string;
};
type Agent = {
  id: string; fullName: string; phone: string; login: string; status: string; territoryId: string | null;
  salesPlan: string; customers: number; salesTotal: string; kpiTotal: string;
};
type Customer = {
  id: string; name: string; phone: string; type: string; status: string; address: string;
  contactName: string; agentId: string | null;
};
type Order = {
  id: string; number: string; status: string; total: string; paidAmount: string; orderDate: string;
  agentId: string; customerId: string;
};
type Payment = { id: string; orderId: string; amount: string; status: string; reference: string };
type Policy = {
  id: string; name: string; baseType: string; startAnchor: string; warningDays: number;
  stages: Array<{ name: string; dayFrom: number; dayTo: number; percent: string; sortOrder: number }>;
};
type Calc = {
  id: string; orderId: string; agentId: string; baseAmount: string; stagePercent: string; kpiAmount: string;
  status: string; stageName: string; daysRemaining: number | null;
};

function Card({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <article className={`kpi-card ${tone || ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function downloadCsv(kind: string) {
  void kpiFetch<string>(`/kpi/export/${kind}`)
    .then((text) => {
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kpi-${kind}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    })
    .catch((err: Error) => alert(err.message));
}

/* ---------- 1. Boshqaruv (/kpi) ---------- */
export function KpiDashboardPage() {
  const q = useQuery({ queryKey: ['kpi-dash'], queryFn: () => kpiFetch<Dash>('/kpi/dashboard') });
  const d = q.data;
  return (
    <div className="kpi-page" data-testid="page-kpi-dashboard">
      <header className="kpi-head">
        <div>
          <h1>KPI boshqaruv</h1>
          <p>Agentlar, savdo, qarzdorlik va 3 bosqichli komissiya nazorati</p>
        </div>
        <div className="kpi-actions">
          <a className="btn" href="/agent" target="_blank" rel="noreferrer"><ExternalLink size={15} /> Agent portal</a>
          <button type="button" className="btn" onClick={() => void q.refetch()}><RefreshCw size={15} /> Yangilash</button>
        </div>
      </header>
      {q.isLoading ? <p className="kpi-muted">Yuklanmoqda…</p> : null}
      {q.error ? <p className="kpi-error">{(q.error as Error).message}</p> : null}
      {d ? (
        <div className="kpi-grid">
          <Card label="Faol agentlar" value={`${d.agentsActive} / ${d.agentsTotal}`} tone="ok" />
          <Card label="Hamkorlar" value={d.customersTotal} />
          <Card label="Tasdiq kutayotgan hamkor" value={d.customersPending} tone={d.customersPending ? 'warn' : ''} />
          <Card label="Tasdiq kutayotgan savdo" value={d.pendingApproval} tone={d.pendingApproval ? 'warn' : ''} />
          <Card label="Jami savdo" value={uzs(d.salesTotal)} />
          <Card label="To‘langan" value={uzs(d.paidTotal)} tone="ok" />
          <Card label="Qarzdorlik" value={uzs(d.dueTotal)} tone="warn" />
          <Card label="Muddati o‘tgan" value={d.overdueOrders} tone={d.overdueOrders ? 'bad' : ''} />
          <Card label="KPI tasdiqlangan" value={uzs(d.kpiConfirmed)} tone="ok" />
          <Card label="KPI kutilmoqda" value={uzs(d.kpiPending)} />
          <Card label="KPI jami hisob" value={uzs(d.kpiAccrued)} />
          <Card label="Muddat tugagan KPI" value={uzs(d.kpiExpired)} tone={Number(d.kpiExpired) > 0 ? 'bad' : ''} />
        </div>
      ) : null}
      <section className="kpi-panel">
        <div className="kpi-panel-head">
          <h2>Hisobot eksport (CSV)</h2>
          <div className="kpi-actions">
            {[
              ['orders', 'Savdolar'],
              ['payments', 'To‘lovlar'],
              ['kpi', 'KPI hisob'],
              ['agents', 'Agentlar'],
              ['customers', 'Hamkorlar'],
            ].map(([k, label]) => (
              <button key={k} type="button" className="btn" onClick={() => downloadCsv(k)}>
                <Download size={14} /> {label}
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

/* ---------- 2. Agentlar va hamkorlar (/kpi/agents) ---------- */
export function KpiAgentsPage() {
  const [sub, setSub] = useState<'agents' | 'customers'>('agents');
  return (
    <div className="kpi-page" data-testid="page-kpi-agents">
      <header className="kpi-head">
        <div>
          <h1>Agentlar va hamkorlar</h1>
          <p>Agent yaratish, do‘kon/zavod ro‘yxati va biriktirish</p>
        </div>
        <div className="kpi-seg">
          <button type="button" className={sub === 'agents' ? 'active' : ''} onClick={() => setSub('agents')}>Agentlar</button>
          <button type="button" className={sub === 'customers' ? 'active' : ''} onClick={() => setSub('customers')}>Hamkorlar</button>
        </div>
      </header>
      {sub === 'agents' ? <AgentsSection /> : <CustomersSection />}
    </div>
  );
}

export const KpiCustomersPage = KpiAgentsPage;

function AgentsSection() {
  const cache = useQueryClient();
  const list = useQuery({ queryKey: ['kpi-agents'], queryFn: () => kpiFetch<Agent[]>('/kpi/agents') });
  const [form, setForm] = useState({ fullName: '', phone: '', login: '', password: '', salesPlan: '' });
  const create = useMutation({
    mutationFn: () => kpiFetch('/kpi/agents', { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => {
      setForm({ fullName: '', phone: '', login: '', password: '', salesPlan: '' });
      void cache.invalidateQueries({ queryKey: ['kpi-agents'] });
      void cache.invalidateQueries({ queryKey: ['kpi-dash'] });
    },
  });
  return (
    <>
      <section className="kpi-panel">
        <h2><Users size={16} /> Yangi agent</h2>
        <div className="kpi-form">
          <input className="input" placeholder="F.I.Sh." value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          <input className="input" placeholder="Telefon" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input className="input" placeholder="Login" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
          <input className="input" type="password" placeholder="Parol (min 4)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <input className="input" placeholder="Oylik reja (so‘m)" value={form.salesPlan} onChange={(e) => setForm({ ...form, salesPlan: e.target.value })} />
          <button type="button" className="btn btn-primary" disabled={create.isPending} onClick={() => create.mutate()}><Plus size={16} /> Qo‘shish</button>
        </div>
        {create.error ? <p className="kpi-error">{(create.error as Error).message}</p> : null}
      </section>
      <div className="kpi-table-wrap">
        <table className="kpi-table">
          <thead><tr><th>Agent</th><th>Login</th><th>Holat</th><th>Hamkorlar</th><th>Savdo</th><th>KPI</th></tr></thead>
          <tbody>
            {(list.data || []).map((a) => (
              <tr key={a.id}>
                <td><b>{a.fullName}</b><div className="kpi-muted">{a.phone}</div></td>
                <td>{a.login}</td>
                <td><span className={`kpi-chip ${a.status}`}>{a.status}</span></td>
                <td>{a.customers}</td>
                <td>{uzs(a.salesTotal)}</td>
                <td><b>{uzs(a.kpiTotal)}</b></td>
              </tr>
            ))}
            {!list.data?.length && !list.isLoading ? <tr><td colSpan={6} className="kpi-muted">Hali agent yo‘q.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CustomersSection() {
  const cache = useQueryClient();
  const agents = useQuery({ queryKey: ['kpi-agents'], queryFn: () => kpiFetch<Agent[]>('/kpi/agents') });
  const list = useQuery({ queryKey: ['kpi-customers'], queryFn: () => kpiFetch<Customer[]>('/kpi/customers') });
  const [form, setForm] = useState({ name: '', phone: '', type: 'store', address: '', contactName: '', agentId: '' });
  const create = useMutation({
    mutationFn: () => kpiFetch('/kpi/customers', { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => {
      setForm({ name: '', phone: '', type: 'store', address: '', contactName: '', agentId: '' });
      void cache.invalidateQueries({ queryKey: ['kpi-customers'] });
      void cache.invalidateQueries({ queryKey: ['kpi-dash'] });
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
    <>
      <section className="kpi-panel">
        <h2>Yangi hamkor (do‘kon / zavod)</h2>
        <div className="kpi-form">
          <input className="input" placeholder="Korxona nomi" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" placeholder="Telefon" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input className="input" placeholder="Mas’ul shaxs" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
          <input className="input" placeholder="Manzil" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="store">Do‘kon</option>
            <option value="factory">Zavod</option>
            <option value="distributor">Distribyutor</option>
          </select>
          <select className="input" value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
            <option value="">Agent biriktirish</option>
            {(agents.data || []).map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
          </select>
          <button type="button" className="btn btn-primary" onClick={() => create.mutate()}><Plus size={16} /> Saqlash</button>
        </div>
        {create.error ? <p className="kpi-error">{(create.error as Error).message}</p> : null}
      </section>
      <div className="kpi-table-wrap">
        <table className="kpi-table">
          <thead><tr><th>Hamkor</th><th>Tur</th><th>Holat</th><th>Mas’ul agent</th><th></th></tr></thead>
          <tbody>
            {(list.data || []).map((c) => (
              <tr key={c.id}>
                <td><b>{c.name}</b><div className="kpi-muted">{c.phone} · {c.address}</div></td>
                <td>{c.type === 'factory' ? 'Zavod' : c.type === 'distributor' ? 'Distribyutor' : 'Do‘kon'}</td>
                <td><span className={`kpi-chip ${c.status}`}>{c.status}</span></td>
                <td>
                  <select className="input" value={c.agentId || ''} onChange={(e) => assign.mutate({ id: c.id, agentId: e.target.value })}>
                    <option value="">— tanlanmagan —</option>
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
            {!list.data?.length && !list.isLoading ? <tr><td colSpan={5} className="kpi-muted">Hali hamkor yo‘q.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------- 3. Savdo, to‘lov va KPI qoidalari (/kpi/orders) ---------- */
export function KpiOrdersPage() {
  const [sub, setSub] = useState<'orders' | 'payments' | 'rules'>('orders');
  return (
    <div className="kpi-page" data-testid="page-kpi-orders">
      <header className="kpi-head">
        <div>
          <h1>Savdo va to‘lovlar</h1>
          <p>Buyurtmalarni tasdiqlash, tushum kiritish va 3 bosqichli KPI qoidalari</p>
        </div>
        <div className="kpi-seg">
          <button type="button" className={sub === 'orders' ? 'active' : ''} onClick={() => setSub('orders')}>Savdolar</button>
          <button type="button" className={sub === 'payments' ? 'active' : ''} onClick={() => setSub('payments')}>To‘lov va KPI</button>
          <button type="button" className={sub === 'rules' ? 'active' : ''} onClick={() => setSub('rules')}>Qoidalar</button>
        </div>
      </header>
      {sub === 'orders' ? <OrdersSection /> : null}
      {sub === 'payments' ? <PaymentsSection /> : null}
      {sub === 'rules' ? <RulesSection /> : null}
    </div>
  );
}

export const KpiPaymentsPage = KpiOrdersPage;
export const KpiSettingsPage = KpiOrdersPage;

function OrdersSection() {
  const cache = useQueryClient();
  const agents = useQuery({ queryKey: ['kpi-agents'], queryFn: () => kpiFetch<Agent[]>('/kpi/agents') });
  const customers = useQuery({ queryKey: ['kpi-customers'], queryFn: () => kpiFetch<Customer[]>('/kpi/customers') });
  const products = useQuery({ queryKey: ['kpi-products'], queryFn: () => kpiFetch<Array<{ id: string; name: string; code: string; price: string }>>('/kpi/products') });
  const orders = useQuery({ queryKey: ['kpi-orders'], queryFn: () => kpiFetch<Order[]>('/kpi/orders') });
  const [form, setForm] = useState({ customerId: '', agentId: '', productId: '', productName: '', quantity: '1', unitPrice: '', paymentDueDays: '14' });
  const create = useMutation({
    mutationFn: async () => {
      const product = (products.data || []).find((p) => p.id === form.productId);
      return kpiFetch('/kpi/orders', {
        method: 'POST',
        body: JSON.stringify({
          customerId: form.customerId,
          agentId: form.agentId,
          paymentDueDays: Number(form.paymentDueDays) || null,
          lines: [{
            productId: form.productId || undefined,
            productName: form.productName.trim() || product?.name || 'Savdo pozitsiyasi',
            productCode: product?.code || '',
            quantity: form.quantity,
            unitPrice: form.unitPrice || product?.price || 0,
          }],
        }),
      });
    },
    onSuccess: () => {
      setForm({ ...form, productName: '', unitPrice: '' });
      void cache.invalidateQueries({ queryKey: ['kpi-orders'] });
      void cache.invalidateQueries({ queryKey: ['kpi-dash'] });
    },
  });
  const confirm = useMutation({
    mutationFn: (id: string) => kpiFetch(`/kpi/orders/${id}/confirm`, { method: 'POST', body: '{}' }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ['kpi-orders'] });
      void cache.invalidateQueries({ queryKey: ['kpi-calcs'] });
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
    <>
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
          <input className="input" placeholder="Mahsulot nomi" value={form.productName} onChange={(e) => setForm({ ...form, productName: e.target.value })} />
          <input className="input" placeholder="Miqdor" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          <input className="input" placeholder="Narx (so‘m)" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} />
          <input className="input" placeholder="Muddat (kun)" value={form.paymentDueDays} onChange={(e) => setForm({ ...form, paymentDueDays: e.target.value })} />
          <button type="button" className="btn btn-primary" onClick={() => create.mutate()}><Plus size={16} /> Qo‘shish</button>
        </div>
        {create.error ? <p className="kpi-error">{(create.error as Error).message}</p> : null}
      </section>
      <div className="kpi-table-wrap">
        <table className="kpi-table">
          <thead><tr><th>Raqam</th><th>Hamkor / Agent</th><th>Summa</th><th>To‘langan</th><th>Holat</th><th></th></tr></thead>
          <tbody>
            {(orders.data || []).map((o) => (
              <tr key={o.id}>
                <td><b>{o.number}</b><div className="kpi-muted">{o.orderDate}</div></td>
                <td>{nameOf.c.get(o.customerId) || '—'}<div className="kpi-muted">{nameOf.a.get(o.agentId) || '—'}</div></td>
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
            {!orders.data?.length && !orders.isLoading ? <tr><td colSpan={6} className="kpi-muted">Savdolar yo‘q.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PaymentsSection() {
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
    <>
      <section className="kpi-panel">
        <h2><Wallet size={16} /> To‘lov qabul qilish</h2>
        <div className="kpi-form">
          <select className="input" value={form.orderId} onChange={(e) => setForm({ ...form, orderId: e.target.value })}>
            <option value="">Tasdiqlangan savdoni tanlang</option>
            {(orders.data || []).filter((o) => !['draft', 'cancelled', 'paid'].includes(o.status)).map((o) => (
              <option key={o.id} value={o.id}>{o.number} — jami {uzs(o.total)} (to‘langan {uzs(o.paidAmount)})</option>
            ))}
          </select>
          <input className="input" placeholder="To‘lov summasi" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <input className="input" placeholder="Hujjat / izoh" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          <button type="button" className="btn btn-primary" onClick={() => create.mutate()}>Qayd etish</button>
        </div>
        {create.error ? <p className="kpi-error">{(create.error as Error).message}</p> : null}
      </section>
      <div className="kpi-split">
        <div className="kpi-table-wrap">
          <h3>To‘lovlar</h3>
          <table className="kpi-table">
            <thead><tr><th>Summa</th><th>Holat</th><th>Izoh</th></tr></thead>
            <tbody>
              {(payments.data || []).map((p) => (
                <tr key={p.id}><td>{uzs(p.amount)}</td><td><span className={`kpi-chip ${p.status}`}>{p.status}</span></td><td>{p.reference || '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="kpi-table-wrap">
          <h3>KPI hisob-kitob</h3>
          <table className="kpi-table">
            <thead><tr><th>Bosqich</th><th>Foiz</th><th>KPI</th><th>Kun qoldi</th><th>Holat</th></tr></thead>
            <tbody>
              {(calcs.data || []).map((c) => (
                <tr key={c.id}>
                  <td>{c.stageName}</td>
                  <td>{Number(c.stagePercent)}%</td>
                  <td><b>{uzs(c.kpiAmount)}</b></td>
                  <td>{c.daysRemaining ?? '—'}</td>
                  <td><span className={`kpi-chip ${c.status}`}>{c.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function RulesSection() {
  const cache = useQueryClient();
  const policy = useQuery({ queryKey: ['kpi-policy'], queryFn: () => kpiFetch<Policy>('/kpi/policy') });
  const [stages, setStages] = useState<Policy['stages'] | null>(null);
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
  const recalc = useMutation({
    mutationFn: () => kpiFetch('/kpi/recalculate', { method: 'POST', body: '{}' }),
  });
  return (
    <section className="kpi-panel">
      <h2>3 bosqichli KPI qoidalari</h2>
      <p className="kpi-muted">Savdo tasdiqlangan kundan boshlab to‘lov necha kunda tushishiga qarab foiz o‘zgaradi.</p>
      <div className="kpi-stages">
        {current.map((stage, index) => (
          <div className="kpi-stage" key={index}>
            <input className="input" value={stage.name} onChange={(e) => {
              const next = [...current]; next[index] = { ...stage, name: e.target.value }; setStages(next);
            }} />
            <input className="input" type="number" value={stage.dayFrom} onChange={(e) => {
              const next = [...current]; next[index] = { ...stage, dayFrom: Number(e.target.value) }; setStages(next);
            }} />
            <input className="input" type="number" value={stage.dayTo} onChange={(e) => {
              const next = [...current]; next[index] = { ...stage, dayTo: Number(e.target.value) }; setStages(next);
            }} />
            <input className="input" value={stage.percent} onChange={(e) => {
              const next = [...current]; next[index] = { ...stage, percent: e.target.value }; setStages(next);
            }} />
          </div>
        ))}
      </div>
      <div className="kpi-actions">
        <button type="button" className="btn btn-primary" onClick={() => save.mutate()}>Saqlash</button>
        <button type="button" className="btn" onClick={() => recalc.mutate()}>Qayta hisoblash</button>
      </div>
      {save.error ? <p className="kpi-error">{(save.error as Error).message}</p> : null}
      {recalc.isSuccess ? <p className="kpi-ok">Hisoblar yangilandi</p> : null}
    </section>
  );
}
