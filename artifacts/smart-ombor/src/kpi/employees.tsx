import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, KeyRound, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { kpiFetch, uzs } from '@/kpi/api';
import './kpi.css';

type Staff = {
  id: string;
  name: string;
  login: string;
  password: string;
  role: string;
  phone: string;
};

type AgentRow = {
  id: string;
  fullName: string;
  login: string;
  customers: number;
  salesTotal: string;
  kpiTotal: string;
  salesPlan: string;
};

const ROLE_LABELS: Record<string, { label: string; group: 'admin' | 'warehouse' | 'agent' | 'office'; access: string }> = {
  super_admin: { label: 'Rahbar / Super Admin', group: 'admin', access: 'To‘liq tizim: Ombor, KPI, Xodimlar, Davomat, Sozlamalar' },
  manager: { label: 'Menejer', group: 'admin', access: 'Ombor, KPI, Xodimlar, Davomat hisobot' },
  sales_admin: { label: 'Savdo rahbari', group: 'admin', access: 'KPI, Agentlar, Savdolar, Mijozlar' },
  warehouse_manager: { label: 'Ombor mudiri', group: 'warehouse', access: 'Zavod yuk xatlari (MoySklad kirim), Ombor, Skaner, Davomat' },
  warehouse_staff: { label: 'Ombor xodimi (Sklad)', group: 'warehouse', access: 'Zavod yuk xatlarini tekshirish va MoySkladga kiritish, Skaner, Davomat' },
  agent: { label: 'Savdo agenti', group: 'agent', access: 'Shaxsiy kabinet: Mijozlar, Qarzdorlik, Bugungi nuqtalar, 3 bosqichli KPI, Davomat' },
  accountant: { label: 'Bugalter', group: 'office', access: 'Shaxsiy kabinet: Davomat, Topshiriqlar, Oylik fiksa' },
  analyst: { label: 'Tahlilchi', group: 'office', access: 'Tahlil, Hisobotlar, Davomat' },
  worker: { label: 'Ofis / Ishchi xodim', group: 'office', access: 'Shaxsiy kabinet: Davomat, Topshiriqlar, Oylik fiksa' },
};

export function EmployeesPage() {
  const cache = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'agent' | 'warehouse' | 'office' | 'admin'>('all');
  const [showPass, setShowPass] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<Staff | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', login: '', password: '', role: 'warehouse_staff' });

  const staff = useQuery({
    queryKey: ['bordo-staff'],
    queryFn: () => kpiFetch<Staff[]>('/local-accounts'),
  });
  const agents = useQuery({
    queryKey: ['kpi-agents'],
    queryFn: () => kpiFetch<AgentRow[]>('/kpi/agents'),
  });

  const create = useMutation({
    mutationFn: () =>
      kpiFetch('/local-accounts', {
        method: 'POST',
        body: JSON.stringify(form),
      }),
    onSuccess: () => {
      setForm({ name: '', phone: '', login: '', password: '', role: 'warehouse_staff' });
      void cache.invalidateQueries({ queryKey: ['bordo-staff'] });
    },
  });

  const update = useMutation({
    mutationFn: (row: Staff) =>
      kpiFetch(`/local-accounts/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify(row),
      }),
    onSuccess: () => {
      setEditing(null);
      void cache.invalidateQueries({ queryKey: ['bordo-staff'] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => kpiFetch(`/local-accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['bordo-staff'] }),
  });

  const agentByLogin = new Map((agents.data || []).map((a) => [a.login.toLowerCase(), a]));
  const rows = (staff.data || []).filter((s) => {
    if (filter === 'all') return true;
    const meta = ROLE_LABELS[s.role] || ROLE_LABELS.worker;
    return meta.group === filter;
  });

  return (
    <div className="kpi-page" data-testid="page-employees">
      <header className="kpi-head">
        <div>
          <h1>Xodimlar va ruxsatlar</h1>
          <p>Ofis, Sklad, Agentlar va Rahbariyat — yagona kirish (login/parol) va shaxsiy kabinetlar</p>
        </div>
        <div className="kpi-seg">
          <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Barchasi ({staff.data?.length || 0})</button>
          <button type="button" className={filter === 'agent' ? 'active' : ''} onClick={() => setFilter('agent')}>Agentlar</button>
          <button type="button" className={filter === 'warehouse' ? 'active' : ''} onClick={() => setFilter('warehouse')}>Sklad</button>
          <button type="button" className={filter === 'office' ? 'active' : ''} onClick={() => setFilter('office')}>Ofis</button>
          <button type="button" className={filter === 'admin' ? 'active' : ''} onClick={() => setFilter('admin')}>Rahbariyat</button>
        </div>
      </header>

      <section className="kpi-panel">
        <h2><Users size={16} /> Yangi xodim qo‘shish</h2>
        <div className="kpi-form">
          <input className="input" placeholder="F.I.Sh. (masalan: Sardor Sklad)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" placeholder="Telefon" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input className="input" placeholder="Login" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
          <input className="input" placeholder="Parol (kamida 4 belgi)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {Object.entries(ROLE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <button type="button" className="btn btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>
            <Plus size={16} /> Qo‘shish
          </button>
        </div>
        <p className="kpi-muted">
          <b>Kabinet huquqi:</b> {(ROLE_LABELS[form.role] || ROLE_LABELS.worker).access}
        </p>
        {create.error ? <p className="kpi-error">{(create.error as Error).message}</p> : null}
      </section>

      <div className="kpi-table-wrap">
        <table className="kpi-table">
          <thead>
            <tr>
              <th>Xodim</th>
              <th>Lavozim va kabinet huquqi</th>
              <th>Login</th>
              <th>Parol</th>
              <th>Ko‘rsatkich (Agent bo‘lsa)</th>
              <th>Amallar</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const meta = ROLE_LABELS[s.role] || { label: s.role, group: 'office', access: 'Davomat va topshiriqlar' };
              const ag = agentByLogin.get(s.login.toLowerCase());
              const isEdit = editing?.id === s.id;
              return (
                <tr key={s.id}>
                  <td>
                    {isEdit ? (
                      <div style={{ display: 'grid', gap: '.3rem' }}>
                        <input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                        <input className="input" placeholder="Telefon" value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
                      </div>
                    ) : (
                      <>
                        <b>{s.name}</b>
                        {s.phone ? <div className="kpi-muted">{s.phone}</div> : null}
                      </>
                    )}
                  </td>
                  <td>
                    {isEdit && s.login !== 'bordouzadmin' ? (
                      <select className="input" value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
                        {Object.entries(ROLE_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>{v.label}</option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <span className="kpi-chip active">{meta.label}</span>
                        <div className="kpi-muted" style={{ maxWidth: 320 }}>{meta.access}</div>
                      </>
                    )}
                  </td>
                  <td>
                    {isEdit && s.login !== 'bordouzadmin' ? (
                      <input className="input" value={editing.login} onChange={(e) => setEditing({ ...editing, login: e.target.value })} />
                    ) : (
                      <code>{s.login}</code>
                    )}
                  </td>
                  <td>
                    {isEdit && s.login !== 'bordouzadmin' ? (
                      <input className="input" value={editing.password} onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
                    ) : (
                      <span className="kpi-row-actions" style={{ alignItems: 'center' }}>
                        <code>{showPass[s.id] ? s.password : '••••••'}</code>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => setShowPass((p) => ({ ...p, [s.id]: !p[s.id] }))}
                          title="Parolni ko‘rsatish"
                        >
                          {showPass[s.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </span>
                    )}
                  </td>
                  <td>
                    {ag ? (
                      <div>
                        <div>{ag.customers} mijoz · savdo {uzs(ag.salesTotal)}</div>
                        <div className="kpi-muted">KPI: <b>{uzs(ag.kpiTotal)}</b></div>
                      </div>
                    ) : (
                      <span className="kpi-muted">—</span>
                    )}
                  </td>
                  <td>
                    <div className="kpi-row-actions">
                      {isEdit ? (
                        <>
                          <button type="button" className="btn btn-primary" onClick={() => update.mutate(editing)}>Saqlash</button>
                          <button type="button" className="btn" onClick={() => setEditing(null)}>Bekor</button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="btn" onClick={() => setEditing({ ...s })} title="Tahrirlash / parol berish">
                            <Pencil size={14} /> <KeyRound size={14} />
                          </button>
                          {s.login !== 'bordouzadmin' ? (
                            <button
                              type="button"
                              className="btn"
                              onClick={() => {
                                if (confirm(`${s.name} o‘chirilsinmi?`)) remove.mutate(s.id);
                              }}
                              title="O‘chirish"
                            >
                              <Trash2 size={14} />
                            </button>
                          ) : null}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
