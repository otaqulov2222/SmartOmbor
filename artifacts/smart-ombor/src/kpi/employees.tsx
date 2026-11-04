import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Eye, EyeOff, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
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

const ROLE_META: Record<string, { label: string; group: 'admin' | 'warehouse' | 'agent' | 'office'; tone: string }> = {
  super_admin: { label: 'Rahbar / Super Admin', group: 'admin', tone: 'is-blue' },
  manager: { label: 'Menejer', group: 'admin', tone: 'is-blue' },
  sales_admin: { label: 'Savdo rahbari', group: 'admin', tone: 'is-blue' },
  warehouse_manager: { label: 'Ombor mudiri', group: 'warehouse', tone: 'is-amber' },
  warehouse_staff: { label: 'Ombor xodimi (Sklad)', group: 'warehouse', tone: 'is-amber' },
  agent: { label: 'Savdo agenti', group: 'agent', tone: 'is-green' },
  accountant: { label: 'Bugalter', group: 'office', tone: '' },
  analyst: { label: 'Tahlilchi', group: 'office', tone: '' },
  worker: { label: 'Ofis xodimi', group: 'office', tone: '' },
};

const ROLE_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'warehouse_staff', label: 'Ombor xodimi (Sklad)' },
  { value: 'warehouse_manager', label: 'Ombor mudiri' },
  { value: 'agent', label: 'Savdo agenti' },
  { value: 'worker', label: 'Ofis xodimi' },
  { value: 'accountant', label: 'Bugalter' },
  { value: 'sales_admin', label: 'Savdo rahbari' },
  { value: 'manager', label: 'Menejer' },
  { value: 'super_admin', label: 'Rahbar / Super Admin' },
];

function resolveRole(raw: string): string {
  const v = raw.trim();
  if (!v) return 'worker';
  if (ROLE_META[v]) return v;
  const low = v.toLowerCase();
  for (const [k, m] of Object.entries(ROLE_META)) {
    if (m.label.toLowerCase() === low || k === low) return k;
  }
  if (/agent|агент/i.test(v)) return 'agent';
  if (/ombor|sklad|склад/i.test(v)) return 'warehouse_staff';
  return v;
}

function roleInfo(role: string) {
  if (ROLE_META[role]) return ROLE_META[role];
  if (/agent|агент/i.test(role)) return { label: role, group: 'agent' as const, tone: 'is-green' };
  if (/ombor|sklad|склад/i.test(role)) return { label: role, group: 'warehouse' as const, tone: 'is-amber' };
  if (/admin|rahbar|menejer|direktor/i.test(role)) return { label: role, group: 'admin' as const, tone: 'is-blue' };
  return { label: role, group: 'office' as const, tone: '' };
}

export function EmployeesPage() {
  const cache = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'agent' | 'warehouse' | 'office' | 'admin'>('all');
  const [showPass, setShowPass] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Staff | null>(null);
  const [customMode, setCustomMode] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', login: '', password: '', role: 'warehouse_staff' });

  const staff = useQuery({
    queryKey: ['bordo-staff'],
    queryFn: () => kpiFetch<Staff[]>('/local-accounts'),
  });
  const agents = useQuery({
    queryKey: ['kpi-agents'],
    queryFn: () => kpiFetch<AgentRow[]>('/kpi/agents'),
  });

  const extraRoles = useMemo(() => {
    const known = new Set(ROLE_PRESETS.map((r) => r.value));
    const extras: string[] = [];
    for (const s of staff.data || []) {
      if (s.role && !known.has(s.role) && !extras.includes(s.role)) extras.push(s.role);
    }
    return extras;
  }, [staff.data]);

  const create = useMutation({
    mutationFn: () =>
      kpiFetch('/local-accounts', {
        method: 'POST',
        body: JSON.stringify({ ...form, role: resolveRole(form.role) }),
      }),
    onSuccess: () => {
      setForm({ name: '', phone: '', login: '', password: '', role: 'warehouse_staff' });
      setCustomMode(false);
      void cache.invalidateQueries({ queryKey: ['bordo-staff'] });
    },
  });

  const update = useMutation({
    mutationFn: (row: Staff) =>
      kpiFetch(`/local-accounts/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...row, role: resolveRole(row.role) }),
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

  const copyCredentials = async (s: Staff) => {
    const text = `login: ${s.login}\nparol: ${s.password}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedId(s.id);
    window.setTimeout(() => setCopiedId((prev) => (prev === s.id ? null : prev)), 2000);
  };

  const agentByLogin = new Map((agents.data || []).map((a) => [a.login.toLowerCase(), a]));
  const rows = (staff.data || []).filter((s) => {
    if (filter === 'all') return true;
    return roleInfo(s.role).group === filter;
  });

  return (
    <div className="kpi-page" data-testid="page-employees">
      <header className="kpi-head">
        <div>
          <h1>Xodimlar</h1>
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
        <div className="emp-add-grid">
          <input className="input" placeholder="F.I.Sh." value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" placeholder="Telefon" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input className="input" placeholder="Login" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
          <input className="input" placeholder="Parol (min 4 belgi)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          {customMode ? (
            <div className="emp-role-custom">
              <input
                className="input"
                placeholder="Lavozim nomini yozing (masalan: Kassir, Haydovchi…)"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                autoFocus
              />
              <button
                type="button"
                className="btn"
                onClick={() => { setCustomMode(false); setForm({ ...form, role: 'warehouse_staff' }); }}
              >
                Ro‘yxat
              </button>
            </div>
          ) : (
            <select
              className="input"
              value={form.role}
              onChange={(e) => {
                if (e.target.value === '__custom__') {
                  setCustomMode(true);
                  setForm({ ...form, role: '' });
                } else {
                  setForm({ ...form, role: e.target.value });
                }
              }}
            >
              {ROLE_PRESETS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
              {extraRoles.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
              <option value="__custom__">+ Yangi lavozim yozish…</option>
            </select>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={create.isPending || !form.login.trim() || form.password.length < 4}
            onClick={() => create.mutate()}
          >
            <Plus size={16} /> Qo‘shish
          </button>
        </div>
        {create.error ? <p className="kpi-error">{(create.error as Error).message}</p> : null}
      </section>

      <div className="kpi-table-wrap">
        <table className="kpi-table emp-table">
          <thead>
            <tr>
              <th>Xodim</th>
              <th>Lavozim</th>
              <th>Login</th>
              <th>Parol</th>
              <th>Ko‘rsatkich</th>
              <th style={{ textAlign: 'right' }}>Amallar</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const info = roleInfo(s.role);
              const ag = agentByLogin.get(s.login.toLowerCase());
              const isEdit = editing?.id === s.id;
              const isCopied = copiedId === s.id;
              return (
                <tr key={s.id}>
                  <td>
                    {isEdit ? (
                      <div style={{ display: 'grid', gap: '.3rem' }}>
                        <input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                        <input className="input" placeholder="Telefon" value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
                      </div>
                    ) : (
                      <div className="emp-user-cell">
                        <span className={`emp-avatar ${info.tone}`}>{(s.name || s.login).slice(0, 1).toUpperCase()}</span>
                        <div>
                          <b>{s.name}</b>
                          {s.phone ? <div className="kpi-muted">{s.phone}</div> : null}
                        </div>
                      </div>
                    )}
                  </td>
                  <td>
                    {isEdit && s.login !== 'bordouzadmin' ? (
                      <>
                        <input
                          className="input"
                          list="emp-role-options"
                          placeholder="Tanlang yoki yozing…"
                          value={ROLE_META[editing.role]?.label || editing.role}
                          onChange={(e) => setEditing({ ...editing, role: e.target.value })}
                        />
                        <datalist id="emp-role-options">
                          {ROLE_PRESETS.map((r) => (
                            <option key={r.value} value={r.label} />
                          ))}
                          {extraRoles.map((r) => (
                            <option key={r} value={r} />
                          ))}
                        </datalist>
                      </>
                    ) : (
                      <span className={`emp-role-badge ${info.tone}`}>{info.label}</span>
                    )}
                  </td>
                  <td>
                    {isEdit && s.login !== 'bordouzadmin' ? (
                      <input className="input" value={editing.login} onChange={(e) => setEditing({ ...editing, login: e.target.value })} />
                    ) : (
                      <code className="emp-code">{s.login}</code>
                    )}
                  </td>
                  <td>
                    {isEdit && s.login !== 'bordouzadmin' ? (
                      <input className="input" value={editing.password} onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
                    ) : (
                      <span className="emp-pass-cell">
                        <code className="emp-code">{showPass[s.id] ? s.password : '••••••••'}</code>
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
                        <div><b>{ag.customers} mijoz</b> · {uzs(ag.salesTotal)}</div>
                        <div className="kpi-muted">KPI: <b className="is-ok">{uzs(ag.kpiTotal)}</b></div>
                      </div>
                    ) : (
                      <span className="kpi-muted">—</span>
                    )}
                  </td>
                  <td>
                    <div className="kpi-row-actions" style={{ justifyContent: 'flex-end' }}>
                      {isEdit ? (
                        <>
                          <button type="button" className="btn btn-primary" onClick={() => update.mutate(editing)}>Saqlash</button>
                          <button type="button" className="btn" onClick={() => setEditing(null)}>Bekor</button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={`btn ${isCopied ? 'emp-copied-btn' : ''}`}
                            onClick={() => void copyCredentials(s)}
                            title="Login va parolni nusxalash"
                          >
                            {isCopied ? <><Check size={14} /> Nusxalandi</> : <><Copy size={14} /> Nusxalash</>}
                          </button>
                          <button type="button" className="btn" onClick={() => setEditing({ ...s })} title="Tahrirlash">
                            <Pencil size={14} />
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
