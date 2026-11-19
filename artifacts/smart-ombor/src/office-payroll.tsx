import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Banknote, CalendarDays, Check, ChevronLeft, ChevronRight, CircleAlert,
  Pencil, Percent, RefreshCw, Save, Search, Trash2, Wallet, X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/i18n';
import { officeHeaders } from '@/office';
import './office-payroll.css';

type FineLine = {
  date: string;
  kind: 'absent' | 'late';
  status: string;
  lateMin: number;
  autoAmount: number;
  amount: number;
  overridden: boolean;
  note: string;
};
type Advance = { id: string; accountId: string; amount: number; date: string; note: string };
type Adjustment = { id: string; accountId: string; month: string; amount: number; note: string; kind: string };
type Person = {
  accountId: string;
  name: string;
  login: string;
  role: string;
  monthly: number;
  daily: number;
  workdays: number;
  absentDays: number;
  lateDays: number;
  presentDays: number;
  excusedDays: number;
  absentFine: number;
  lateFine: number;
  fineTotal: number;
  advancesTotal: number;
  adjustmentsTotal: number;
  net: number;
  fines: FineLine[];
  advances: Advance[];
  adjustments: Adjustment[];
};
type Payroll = {
  month: string;
  from: string;
  to: string;
  workdays: number;
  settings: { latePenaltyPct: number };
  summary: {
    headcount: number;
    salaryFund: number;
    fineTotal: number;
    advancesTotal: number;
    adjustmentsTotal: number;
    netTotal: number;
  };
  people: Person[];
};

function tashkentMonth() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date()).slice(0, 7);
}
function shiftMonth(month: string, by: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}
function money(n: number) {
  return new Intl.NumberFormat('uz-UZ').format(Math.round(n || 0));
}
function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] || '?';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] || '');
  return (a + b).toUpperCase();
}
function MoneyCell({ value, emptyLabel }: { value: number; emptyLabel?: string }) {
  if (!value && emptyLabel) {
    return <span className="pay-edit is-empty">{emptyLabel}</span>;
  }
  return (
    <span>
      {money(value)}
      <span className="pay-som">so‘m</span>
    </span>
  );
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...officeHeaders(), ...(init?.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  return body as T;
}

export function OfficePayrollPage() {
  const { t } = useI18n();
  const cache = useQueryClient();
  const [month, setMonth] = useState(tashkentMonth);
  const [q, setQ] = useState('');
  const [latePct, setLatePct] = useState('100');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [salaryEdit, setSalaryEdit] = useState<{ id: string; value: string } | null>(null);
  const [advanceForm, setAdvanceForm] = useState({ amount: '', date: '', note: '' });
  const [adjForm, setAdjForm] = useState({ amount: '', note: '', kind: 'bonus' });
  const [fineEdit, setFineEdit] = useState<{ date: string; kind: 'absent' | 'late'; amount: string; note: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), 2200);
    return () => window.clearTimeout(id);
  }, [flash]);

  const query = useQuery({
    queryKey: ['office-payroll', month],
    queryFn: () => api<Payroll>(`/api/office/payroll?month=${month}`),
  });

  const data = query.data;
  useEffect(() => {
    if (data?.settings?.latePenaltyPct != null) setLatePct(String(data.settings.latePenaltyPct));
  }, [data?.settings?.latePenaltyPct]);

  const people = useMemo(() => {
    const list = data?.people || [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        p.login.toLowerCase().includes(needle) ||
        p.role.toLowerCase().includes(needle),
    );
  }, [data?.people, q]);

  const selected = people.find((p) => p.accountId === detailId) || null;

  const invalidate = () => cache.invalidateQueries({ queryKey: ['office-payroll', month] });

  const saveSettings = useMutation({
    mutationFn: () =>
      api('/api/office/payroll/settings', {
        method: 'PUT',
        body: JSON.stringify({ latePenaltyPct: Number(latePct) }),
      }),
    onSuccess: () => invalidate(),
  });

  const saveSalary = useMutation({
    mutationFn: (input: { accountId: string; monthly: number }) =>
      api('/api/office/payroll/salary', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      setSalaryEdit(null);
      invalidate();
    },
  });

  const addAdvance = useMutation({
    mutationFn: () =>
      api('/api/office/payroll/advances', {
        method: 'POST',
        body: JSON.stringify({
          accountId: detailId,
          amount: Number(advanceForm.amount),
          date: advanceForm.date || `${month}-01`,
          note: advanceForm.note,
        }),
      }),
    onSuccess: () => {
      setAdvanceForm({ amount: '', date: '', note: '' });
      setFlash(t('pay.savedOk'));
      invalidate();
    },
  });

  const delAdvance = useMutation({
    mutationFn: (id: string) => api(`/api/office/payroll/advances/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(),
  });

  const saveFine = useMutation({
    mutationFn: (input: { accountId: string; date: string; kind: string; amount: number | null; note?: string }) =>
      api('/api/office/payroll/fine-override', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      setFineEdit(null);
      setFlash(t('pay.savedOk'));
      invalidate();
    },
  });

  const addAdj = useMutation({
    mutationFn: () =>
      api('/api/office/payroll/adjustments', {
        method: 'POST',
        body: JSON.stringify({
          accountId: detailId,
          month,
          amount: Number(adjForm.amount),
          note: adjForm.note,
          kind: adjForm.kind,
        }),
      }),
    onSuccess: () => {
      setAdjForm({ amount: '', note: '', kind: 'bonus' });
      setFlash(t('pay.savedOk'));
      invalidate();
    },
  });

  const delAdj = useMutation({
    mutationFn: (id: string) => api(`/api/office/payroll/adjustments/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(),
  });

  const fund = data?.summary.salaryFund || 0;
  const needSalary = !query.isLoading && fund <= 0 && (data?.people.length || 0) > 0;

  return (
    <div className="pay">
      <div className="pay-head">
        <div>
          <div className="pay-head-title">
            <h1><Wallet size={22} strokeWidth={2.1} /> {t('nav.officePayroll')}</h1>
            <span className="pay-badge"><CalendarDays size={13} /> {month}</span>
          </div>
          <p className="pay-sub">{t('pay.sub')}</p>
        </div>
        <div className="pay-month">
          <button type="button" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="prev">
            <ChevronLeft size={16} />
          </button>
          <b>{month}</b>
          <button type="button" onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label="next">
            <ChevronRight size={16} />
          </button>
          <button type="button" onClick={() => query.refetch()} disabled={query.isFetching} aria-label="refresh">
            <RefreshCw size={15} className={query.isFetching ? 'pay-spin' : undefined} />
          </button>
        </div>
      </div>

      <div className="pay-panel">
        <div className="pay-panel-grid">
          <div>
            <div className="pay-label"><Percent size={13} /> {t('pay.latePct')}</div>
            <div className="pay-settings-row">
              <input
                className="input"
                type="number"
                min={0}
                max={100}
                value={latePct}
                onChange={(e) => setLatePct(e.target.value)}
              />
              <button type="button" className="btn primary" disabled={saveSettings.isPending} onClick={() => saveSettings.mutate()}>
                {t('pay.save')}
              </button>
            </div>
            <p className="pay-hint">{t('pay.latePctHint')}</p>
          </div>
          <div className="pay-meta">
            <div className="pay-meta-card">
              <span>{t('pay.workdays')}</span>
              <b>{data?.workdays ?? '—'}</b>
              <small>{data?.from || '—'} → {data?.to || '—'}</small>
            </div>
          </div>
        </div>
      </div>

      <div className="pay-stats">
        <article className="pay-stat is-blue">
          <div className="pay-stat-head">
            <span>{t('pay.fund')}</span>
            <span className="pay-stat-ico"><Banknote size={16} /></span>
          </div>
          <strong>{money(data?.summary.salaryFund || 0)}<span className="pay-som">so‘m</span></strong>
          <small>{data?.summary.headcount || 0} {t('pay.employee').toLowerCase()}</small>
        </article>
        <article className="pay-stat is-red">
          <div className="pay-stat-head">
            <span>{t('pay.fines')}</span>
            <span className="pay-stat-ico"><CircleAlert size={16} /></span>
          </div>
          <strong>{money(data?.summary.fineTotal || 0)}<span className="pay-som">so‘m</span></strong>
          <small>{t('pay.absent')} / {t('pay.late')}</small>
        </article>
        <article className="pay-stat is-amber">
          <div className="pay-stat-head">
            <span>{t('pay.advances')}</span>
            <span className="pay-stat-ico"><Wallet size={16} /></span>
          </div>
          <strong>{money(data?.summary.advancesTotal || 0)}<span className="pay-som">so‘m</span></strong>
          <small>{t('pay.advances')}</small>
        </article>
        <article className="pay-stat is-green">
          <div className="pay-stat-head">
            <span>{t('pay.net')}</span>
            <span className="pay-stat-ico"><Banknote size={16} /></span>
          </div>
          <strong>{money(data?.summary.netTotal || 0)}<span className="pay-som">so‘m</span></strong>
          <small>{t('pay.net')}</small>
        </article>
      </div>

      {needSalary ? (
        <p className="pay-banner">
          <AlertTriangle size={15} />
          <span>{t('pay.needSalary')}</span>
        </p>
      ) : null}

      <div className="pay-tools">
        <label className="pay-search">
          <Search size={15} />
          <input className="input search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('pay.search')} />
        </label>
        <span className="pay-count">{people.length} / {data?.people.length || 0}</span>
      </div>

      {query.isError ? <p className="pay-err">{(query.error as Error).message}</p> : null}

      <div className="pay-table-wrap">
        <table className="pay-table">
          <thead>
            <tr>
              <th>{t('pay.employee')}</th>
              <th className="is-num">{t('pay.monthly')}</th>
              <th className="is-num">{t('pay.daily')}</th>
              <th className="is-num">{t('pay.absent')}</th>
              <th className="is-num">{t('pay.late')}</th>
              <th className="is-num">{t('pay.fines')}</th>
              <th className="is-num">{t('pay.advances')}</th>
              <th className="is-num">{t('pay.net')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.accountId}>
                <td data-label={t('pay.employee')}>
                  <div className="pay-person">
                    <span className="pay-avatar">{initials(p.name)}</span>
                    <span>
                      <b>{p.name}</b>
                      <small>{p.login}</small>
                    </span>
                  </div>
                </td>
                <td className="is-num" data-label={t('pay.monthly')}>
                  {salaryEdit?.id === p.accountId ? (
                    <span className="pay-inline">
                      <input
                        className="input"
                        value={salaryEdit.value}
                        onChange={(e) => setSalaryEdit({ id: p.accountId, value: e.target.value })}
                      />
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() =>
                          saveSalary.mutate({ accountId: p.accountId, monthly: Number(salaryEdit.value) || 0 })
                        }
                      >
                        OK
                      </button>
                      <button type="button" className="btn" onClick={() => setSalaryEdit(null)}>
                        <X size={14} />
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={`pay-edit ${p.monthly ? '' : 'is-empty'}`}
                      onClick={() => setSalaryEdit({ id: p.accountId, value: String(p.monthly || '') })}
                    >
                      {p.monthly ? <>{money(p.monthly)} <span className="pay-som">so‘m</span></> : t('pay.setSalary')}
                      {' '}<Pencil size={13} />
                    </button>
                  )}
                </td>
                <td className="is-num" data-label={t('pay.daily')}>
                  <MoneyCell value={p.daily} emptyLabel="—" />
                </td>
                <td className="is-num" data-label={t('pay.absent')}>
                  <span className={`pay-chip ${p.absentDays ? 'is-bad' : ''}`}>{p.absentDays}</span>
                </td>
                <td className="is-num" data-label={t('pay.late')}>
                  <span className={`pay-chip ${p.lateDays ? 'is-warn' : ''}`}>{p.lateDays}</span>
                </td>
                <td className="is-num" data-label={t('pay.fines')}>
                  <MoneyCell value={p.fineTotal} />
                </td>
                <td className="is-num" data-label={t('pay.advances')}>
                  <MoneyCell value={p.advancesTotal} />
                </td>
                <td className="is-num" data-label={t('pay.net')}>
                  <span className={`pay-net ${p.net < 0 ? 'is-neg' : p.net === 0 ? 'is-zero' : ''}`}>
                    {money(p.net)}
                    <span className="pay-som">so‘m</span>
                  </span>
                </td>
                <td>
                  <button type="button" className="pay-detail-btn" onClick={() => setDetailId(p.accountId)}>
                    {t('pay.detail')}
                  </button>
                </td>
              </tr>
            ))}
            {!people.length && !query.isLoading ? (
              <tr><td colSpan={9} className="pay-empty">{t('pay.empty')}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {selected ? (
        <div className="pay-drawer-bg" onClick={() => setDetailId(null)}>
          <aside className="pay-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="pay-drawer-top">
              <div className="pay-person">
                <span className="pay-avatar">{initials(selected.name)}</span>
                <span>
                  <h2>{selected.name}</h2>
                  <p className="pay-muted">{selected.login}</p>
                </span>
              </div>
              <button type="button" className="icon-btn" onClick={() => setDetailId(null)} aria-label="close">
                <X size={18} />
              </button>
            </div>
            <div className="pay-drawer-summary">
              <article>
                <span>{t('pay.monthly')}</span>
                <b>{money(selected.monthly)}</b>
              </article>
              <article>
                <span>{t('pay.fines')}</span>
                <b>{money(selected.fineTotal)}</b>
              </article>
              <article>
                <span>{t('pay.net')}</span>
                <b className={selected.net < 0 ? 'pay-net is-neg' : 'pay-net'}>{money(selected.net)}</b>
              </article>
            </div>

            {flash ? (
              <p className="pay-flash"><Check size={15} /> {flash}</p>
            ) : null}

            <section>
              <h3>{t('pay.fines')}</h3>
              {selected.fines.length ? (
                <ul className="pay-list">
                  {selected.fines.map((f) => (
                    <li key={`${f.kind}-${f.date}`}>
                      <div>
                        <b>{f.date}</b>{' '}
                        <span className={`pay-pill is-${f.kind}`}>
                          {f.kind === 'absent' ? t('pay.absent') : t('pay.late')}
                          {f.lateMin ? ` · ${f.lateMin} ${t('pay.min')}` : ''}
                        </span>
                        {f.overridden ? <em className="pay-muted"> · {t('pay.overridden')}</em> : null}
                        <div className="pay-muted">{money(f.amount)} ({t('pay.auto')}: {money(f.autoAmount)})</div>
                      </div>
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          setFineEdit({
                            date: f.date,
                            kind: f.kind,
                            amount: String(f.amount),
                            note: f.note || '',
                          })
                        }
                      >
                        <Pencil size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pay-muted">{t('pay.noFines')}</p>
              )}
              {fineEdit ? (
                <div className="pay-form">
                  <p>
                    {fineEdit.date} · {fineEdit.kind === 'absent' ? t('pay.absent') : t('pay.late')}
                  </p>
                  <input
                    className="input"
                    type="number"
                    value={fineEdit.amount}
                    onChange={(e) => setFineEdit({ ...fineEdit, amount: e.target.value })}
                    placeholder={t('pay.amount')}
                  />
                  <input
                    className="input"
                    value={fineEdit.note}
                    onChange={(e) => setFineEdit({ ...fineEdit, note: e.target.value })}
                    placeholder={t('pay.note')}
                  />
                  <div className="pay-form-actions">
                    <button
                      type="button"
                      className="pay-save-btn"
                      disabled={saveFine.isPending}
                      onClick={() =>
                        saveFine.mutate({
                          accountId: selected.accountId,
                          date: fineEdit.date,
                          kind: fineEdit.kind,
                          amount: Number(fineEdit.amount),
                          note: fineEdit.note,
                        })
                      }
                    >
                      <Save size={16} />
                      {saveFine.isPending ? t('pay.saving') : t('pay.save')}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        saveFine.mutate({
                          accountId: selected.accountId,
                          date: fineEdit.date,
                          kind: fineEdit.kind,
                          amount: null,
                        })
                      }
                    >
                      {t('pay.resetAuto')}
                    </button>
                    <button type="button" className="btn" onClick={() => setFineEdit(null)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            <section>
              <h3>{t('pay.advances')}</h3>
              {selected.advances.length ? (
                <ul className="pay-list">
                  {selected.advances.map((a) => (
                    <li key={a.id}>
                      <div>
                        <b>{money(a.amount)} <span className="pay-som">so‘m</span></b> · {a.date}
                        {a.note ? <div className="pay-muted">{a.note}</div> : null}
                      </div>
                      <button type="button" className="btn" onClick={() => delAdvance.mutate(a.id)} aria-label="delete">
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pay-muted">{t('pay.noAdvances')}</p>
              )}
              <div className="pay-form">
                <p className="pay-form-hint">{t('pay.formHint')}</p>
                <label className="pay-field">
                  <span>{t('pay.amount')}</span>
                  <input
                    className="input"
                    type="number"
                    placeholder="500000"
                    value={advanceForm.amount}
                    onChange={(e) => setAdvanceForm({ ...advanceForm, amount: e.target.value })}
                  />
                </label>
                <label className="pay-field">
                  <span>{t('pay.date')}</span>
                  <input
                    className="input"
                    type="date"
                    value={advanceForm.date}
                    onChange={(e) => setAdvanceForm({ ...advanceForm, date: e.target.value })}
                  />
                </label>
                <label className="pay-field">
                  <span>{t('pay.note')}</span>
                  <input
                    className="input"
                    placeholder={t('pay.note')}
                    value={advanceForm.note}
                    onChange={(e) => setAdvanceForm({ ...advanceForm, note: e.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="pay-save-btn"
                  onClick={() => addAdvance.mutate()}
                  disabled={!advanceForm.amount || addAdvance.isPending}
                >
                  <Save size={16} />
                  {addAdvance.isPending ? t('pay.saving') : t('pay.addAdvance')}
                </button>
                {addAdvance.isError ? <p className="pay-err">{(addAdvance.error as Error).message}</p> : null}
              </div>
            </section>

            <section>
              <h3>{t('pay.adjust')}</h3>
              {selected.adjustments.length ? (
                <ul className="pay-list">
                  {selected.adjustments.map((a) => (
                    <li key={a.id}>
                      <div>
                        <b>{money(a.amount)} <span className="pay-som">so‘m</span></b> · {a.kind}
                        {a.note ? <div className="pay-muted">{a.note}</div> : null}
                      </div>
                      <button type="button" className="btn" onClick={() => delAdj.mutate(a.id)} aria-label="delete">
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pay-muted">{t('pay.noAdjust')}</p>
              )}
              <div className="pay-form">
                <p className="pay-form-hint">{t('pay.formHint')}</p>
                <label className="pay-field">
                  <span>{t('pay.bonus')}</span>
                  <select
                    className="input"
                    value={adjForm.kind}
                    onChange={(e) => setAdjForm({ ...adjForm, kind: e.target.value })}
                  >
                    <option value="bonus">{t('pay.bonus')}</option>
                    <option value="deduct">{t('pay.deduct')}</option>
                    <option value="other">{t('pay.other')}</option>
                  </select>
                </label>
                <label className="pay-field">
                  <span>{t('pay.amount')}</span>
                  <input
                    className="input"
                    type="number"
                    placeholder={t('pay.amountSigned')}
                    value={adjForm.amount}
                    onChange={(e) => setAdjForm({ ...adjForm, amount: e.target.value })}
                  />
                </label>
                <label className="pay-field">
                  <span>{t('pay.note')}</span>
                  <input
                    className="input"
                    placeholder={t('pay.note')}
                    value={adjForm.note}
                    onChange={(e) => setAdjForm({ ...adjForm, note: e.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="pay-save-btn"
                  onClick={() => addAdj.mutate()}
                  disabled={!adjForm.amount || addAdj.isPending}
                >
                  <Save size={16} />
                  {addAdj.isPending ? t('pay.saving') : t('pay.addAdjust')}
                </button>
                {addAdj.isError ? <p className="pay-err">{(addAdj.error as Error).message}</p> : null}
              </div>
            </section>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
