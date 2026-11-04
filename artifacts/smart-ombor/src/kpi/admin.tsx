import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, KeyRound, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { kpiFetch, uzs } from '@/kpi/api';
import './kpi.css';

type Dash = {
  agentsTotal: number; agentsActive: number; customersTotal: number; customersPending: number;
  salesTotal: string; paidTotal: string; dueTotal: string; overdueOrders: number; pendingApproval: number;
  kpiAccrued: string; kpiConfirmed: string; kpiPending: string; kpiExpired: string;
};
type Agent = {
  id: string; fullName: string; phone: string; login: string; status: string;
  salesPlan: string; customers: number; salesTotal: string; kpiTotal: string;
};
type Customer = {
  id: string; name: string; phone: string; type: string; status: string; address: string;
  agentId: string | null; notes?: string;
};
type Order = {
  id: string; number: string; status: string; total: string; paidAmount: string; orderDate: string;
  agentId: string; customerId: string; agentName?: string; customerName?: string;
};
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

function useMsSync() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: () => kpiFetch('/kpi/sync', { method: 'POST', body: '{}' }),
    onSuccess: () => {
      for (const k of ['kpi-dash', 'kpi-agents', 'kpi-customers', 'kpi-orders', 'kpi-calcs']) {
        void cache.invalidateQueries({ queryKey: [k] });
      }
    },
  });
}

/* ---------- 1. Boshqaruv (/kpi) ---------- */
export function KpiDashboardPage() {
  const q = useQuery({ queryKey: ['kpi-dash'], queryFn: () => kpiFetch<Dash>('/kpi/dashboard') });
  const agents = useQuery({ queryKey: ['kpi-agents'], queryFn: () => kpiFetch<Agent[]>('/kpi/agents') });
  const sync = useMsSync();
  const d = q.data;
  const sorted = useMemo(
    () => [...(agents.data || [])].sort((a, b) => Number(b.salesTotal) - Number(a.salesTotal)),
    [agents.data],
  );
  return (
    <div className="kpi-page" data-testid="page-kpi-dashboard">
      <header className="kpi-head">
        <div>
          <h1>KPI boshqaruv</h1>
          <p>MoySklad savdolari, to‘lovlar va agentlar komissiyasi</p>
        </div>
        <div className="kpi-actions">
          <a className="btn" href="/agent" target="_blank" rel="noreferrer"><ExternalLink size={15} /> Agent portal</a>
          <button type="button" className="btn btn-primary" disabled={sync.isPending} onClick={() => sync.mutate()}>
            <RefreshCw size={15} /> {sync.isPending ? 'MoySkladdan olinmoqda…' : 'MoySklad bilan yangilash'}
          </button>
        </div>
      </header>
      {q.error ? <p className="kpi-error">{(q.error as Error).message}</p> : null}
      {d ? (
        <div className="kpi-grid">
          <Card label="Agentlar (MoySklad)" value={d.agentsActive} tone="blue" />
          <Card label="Mijozlar (MoySklad)" value={d.customersTotal} tone="slate" />
          <Card label="Jami savdo" value={uzs(d.salesTotal)} tone="blue" />
          <Card label="To‘langan" value={uzs(d.paidTotal)} tone="ok" />
          <Card label="Qarzdorlik" value={uzs(d.dueTotal)} tone="bad" />
          <Card label="KPI tasdiqlangan" value={uzs(d.kpiConfirmed)} tone="ok" />
          <Card label="KPI kutilmoqda" value={uzs(d.kpiPending)} tone="warn" />
          <Card label="KPI jami hisob" value={uzs(d.kpiAccrued)} tone="purple" />
        </div>
      ) : null}
      <div className="kpi-table-wrap">
        <div className="kpi-panel-head" style={{ padding: '.4rem .5rem .8rem' }}>
          <h3>Agentlar reytingi (MoySklad)</h3>
          <div className="kpi-actions">
            {[
              ['orders', 'Savdolar CSV'],
              ['kpi', 'KPI CSV'],
              ['agents', 'Agentlar CSV'],
              ['customers', 'Mijozlar CSV'],
            ].map(([k, label]) => (
              <button key={k} type="button" className="btn" onClick={() => downloadCsv(k)}>
                <Download size={14} /> {label}
              </button>
            ))}
          </div>
        </div>
        <table className="kpi-table">
          <thead><tr><th>Agent</th><th>Login</th><th>Mijozlari</th><th>Savdo (MoySklad)</th><th>KPI daromad</th></tr></thead>
          <tbody>
            {sorted.map((a) => (
              <tr key={a.id}>
                <td data-label="Agent"><b>{a.fullName}</b></td>
                <td data-label="Login" className="kpi-muted">{a.login}</td>
                <td data-label="Mijozlari">{a.customers}</td>
                <td data-label="Savdo">{uzs(a.salesTotal)}</td>
                <td data-label="KPI daromad"><b className="is-ok">{uzs(a.kpiTotal)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- 2. Agentlar va mijozlar (/kpi/agents) ---------- */
export function KpiAgentsPage() {
  const [sub, setSub] = useState<'agents' | 'customers'>('agents');
  const sync = useMsSync();
  return (
    <div className="kpi-page" data-testid="page-kpi-agents">
      <header className="kpi-head">
        <div>
          <h1>Agentlar va mijozlar</h1>
          <p>MoySklad savdo kanallari, teglar va xaridorlar ro‘yxati</p>
        </div>
        <div className="kpi-actions">
          <div className="kpi-seg">
            <button type="button" className={sub === 'agents' ? 'active' : ''} onClick={() => setSub('agents')}>Agentlar</button>
            <button type="button" className={sub === 'customers' ? 'active' : ''} onClick={() => setSub('customers')}>Mijozlar</button>
          </div>
          <button type="button" className="btn" disabled={sync.isPending} onClick={() => sync.mutate()}>
            <RefreshCw size={15} /> Sinxronlash
          </button>
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
  const [editing, setEditing] = useState<{ id: string; password: string; salesPlan: string } | null>(null);
  const save = useMutation({
    mutationFn: (payload: { id: string; password?: string; salesPlan?: string }) =>
      kpiFetch(`/kpi/agents/${payload.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(payload.password ? { password: payload.password } : {}),
          ...(payload.salesPlan != null ? { salesPlan: payload.salesPlan } : {}),
        }),
      }),
    onSuccess: () => {
      setEditing(null);
      void cache.invalidateQueries({ queryKey: ['kpi-agents'] });
    },
  });
  return (
    <div className="kpi-table-wrap">
      <table className="kpi-table">
        <thead><tr><th>Agent (MoySklad)</th><th>Portal login</th><th>Mijozlar</th><th>Savdo</th><th>KPI</th><th>Reja / Parol</th></tr></thead>
        <tbody>
          {(list.data || []).map((a) => (
            <tr key={a.id}>
              <td data-label="Agent"><b>{a.fullName}</b></td>
              <td data-label="Portal login"><code>{a.login}</code></td>
              <td data-label="Mijozlar">{a.customers}</td>
              <td data-label="Savdo">{uzs(a.salesTotal)}</td>
              <td data-label="KPI"><b className="is-ok">{uzs(a.kpiTotal)}</b></td>
              <td data-label="">
                {editing?.id === a.id ? (
                  <div className="kpi-row-actions">
                    <input className="input" style={{ width: 120 }} placeholder="Yangi parol" value={editing.password} onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
                    <input className="input" style={{ width: 140 }} placeholder="Reja" value={editing.salesPlan} onChange={(e) => setEditing({ ...editing, salesPlan: e.target.value })} />
                    <button type="button" className="btn btn-primary" onClick={() => save.mutate(editing)}>Saqlash</button>
                  </div>
                ) : (
                  <button type="button" className="btn" onClick={() => setEditing({ id: a.id, password: '', salesPlan: a.salesPlan })}>
                    <KeyRound size={14} /> Sozlash
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CustomersSection() {
  const cache = useQueryClient();
  const [q, setQ] = useState('');
  const agents = useQuery({ queryKey: ['kpi-agents'], queryFn: () => kpiFetch<Agent[]>('/kpi/agents') });
  const list = useQuery({
    queryKey: ['kpi-customers', q],
    queryFn: () => kpiFetch<Customer[]>(`/kpi/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  });
  const assign = useMutation({
    mutationFn: (payload: { id: string; agentId: string }) =>
      kpiFetch(`/kpi/customers/${payload.id}/assign`, { method: 'POST', body: JSON.stringify({ agentId: payload.agentId }) }),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['kpi-customers'] }),
  });
  return (
    <>
      <div className="kpi-panel">
        <input className="input" placeholder="Mijoz qidirish (MoySklad)…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="kpi-table-wrap">
        <table className="kpi-table">
          <thead><tr><th>Mijoz (MoySklad)</th><th>Teglar</th><th>Mas’ul agent</th></tr></thead>
          <tbody>
            {(list.data || []).map((c) => (
              <tr key={c.id}>
                <td data-label="Mijoz"><b>{c.name}</b><div className="kpi-muted">{c.phone} {c.address}</div></td>
                <td data-label="Teglar" className="kpi-muted">{c.notes || '—'}</td>
                <td data-label="Mas’ul agent">
                  <select className="input" value={c.agentId || ''} onChange={(e) => assign.mutate({ id: c.id, agentId: e.target.value })}>
                    <option value="">— biriktirilmagan —</option>
                    {(agents.data || []).map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------- 3. Savdo, to‘lov va KPI qoidalari (/kpi/orders) ---------- */
export function KpiOrdersPage() {
  const [sub, setSub] = useState<'orders' | 'rules'>('orders');
  const sync = useMsSync();
  return (
    <div className="kpi-page" data-testid="page-kpi-orders">
      <header className="kpi-head">
        <div>
          <h1>Savdo, to‘lov va KPI</h1>
          <p>MoySklad отгрузка hujjatlari bo‘yicha avtomatik 3 bosqichli hisob</p>
        </div>
        <div className="kpi-actions">
          <div className="kpi-seg">
            <button type="button" className={sub === 'orders' ? 'active' : ''} onClick={() => setSub('orders')}>Savdo va KPI</button>
            <button type="button" className={sub === 'rules' ? 'active' : ''} onClick={() => setSub('rules')}>3 bosqich qoidalari</button>
          </div>
          <button type="button" className="btn" disabled={sync.isPending} onClick={() => sync.mutate()}>
            <RefreshCw size={15} /> Sinxronlash
          </button>
        </div>
      </header>
      {sub === 'orders' ? <OrdersAndKpiSection /> : <RulesSection />}
    </div>
  );
}

export const KpiPaymentsPage = KpiOrdersPage;
export const KpiSettingsPage = KpiOrdersPage;

function OrdersAndKpiSection() {
  const [agentFilter, setAgentFilter] = useState('');
  const agents = useQuery({ queryKey: ['kpi-agents'], queryFn: () => kpiFetch<Agent[]>('/kpi/agents') });
  const customers = useQuery({ queryKey: ['kpi-customers'], queryFn: () => kpiFetch<Customer[]>('/kpi/customers') });
  const orders = useQuery({ queryKey: ['kpi-orders'], queryFn: () => kpiFetch<Order[]>('/kpi/orders') });
  const calcs = useQuery({ queryKey: ['kpi-calcs'], queryFn: () => kpiFetch<Calc[]>('/kpi/calculations') });
  const maps = useMemo(() => {
    const a = new Map((agents.data || []).map((x) => [x.id, x.fullName]));
    const c = new Map((customers.data || []).map((x) => [x.id, x.name]));
    const k = new Map((calcs.data || []).map((x) => [x.orderId, x]));
    return { a, c, k };
  }, [agents.data, customers.data, calcs.data]);
  const rows = (orders.data || []).filter((o) => !agentFilter || o.agentId === agentFilter);
  return (
    <>
      <div className="kpi-panel">
        <select className="input" style={{ maxWidth: 260 }} value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
          <option value="">Barcha agentlar</option>
          {(agents.data || []).map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
        </select>
      </div>
      <div className="kpi-table-wrap">
        <table className="kpi-table">
          <thead>
            <tr>
              <th>Отгрузка</th>
              <th>Mijoz</th>
              <th>Agent</th>
              <th>Savdo</th>
              <th>To‘langan</th>
              <th>Bosqich</th>
              <th>KPI</th>
              <th>Holat</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const k = maps.k.get(o.id);
              return (
                <tr key={o.id}>
                  <td data-label="Отгрузка"><b>{o.number.replace(/^MS-/, '')}</b><div className="kpi-muted">{o.orderDate}</div></td>
                  <td data-label="Mijoz">{o.customerName || maps.c.get(o.customerId) || '—'}</td>
                  <td data-label="Agent"><b>{o.agentName || maps.a.get(o.agentId) || '—'}</b></td>
                  <td data-label="Savdo">{uzs(o.total)}</td>
                  <td data-label="To‘langan">{uzs(o.paidAmount)}</td>
                  <td data-label="Bosqich">{k ? `${k.stageName} (${Number(k.stagePercent)}%)` : '—'}<div className="kpi-muted">{k?.daysRemaining != null ? `${k.daysRemaining} kun qoldi` : ''}</div></td>
                  <td data-label="KPI"><b className="is-ok">{k ? uzs(k.kpiAmount) : '0 so‘m'}</b></td>
                  <td data-label="Holat"><span className={`kpi-chip ${o.status}`}>{o.status}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ['kpi-calcs'] });
      void cache.invalidateQueries({ queryKey: ['kpi-dash'] });
    },
  });
  return (
    <section className="kpi-panel">
      <h2>3 bosqichli KPI foizlari</h2>
      <p className="kpi-muted">MoySklad отгрузка sanasidan boshlab to‘lov necha kunda yopilishiga qarab foiz hisoblanadi.</p>
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
