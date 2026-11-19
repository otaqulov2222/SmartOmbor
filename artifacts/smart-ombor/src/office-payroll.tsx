import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Pencil, Plus, RefreshCw, Trash2, Wallet, X } from 'lucide-react';
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
      invalidate();
    },
  });

  const delAdj = useMutation({
    mutationFn: (id: string) => api(`/api/office/payroll/adjustments/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(),
  });

  return (
    <div className="pay">
      <div className="pay-head">
        <div>
          <h1><Wallet size={22} /> {t('nav.officePayroll')}</h1>
          <p className="pay-sub">{t('pay.sub')}</p>
        </div>
        <div className="pay-month">
          <button type="button" className="btn" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="prev">
            <ChevronLeft size={16} />
          </button>
          <b>{month}</b>
          <button type="button" className="btn" onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label="next">
            <ChevronRight size={16} />
          </button>
          <button type="button" className="btn" onClick={() => query.refetch()} disabled={query.isFetching}>
            <RefreshCw size={15} className={query.isFetching ? 'pay-spin' : undefined} />
          </button>
        </div>
      </div>

      <div className="pay-settings">
        <label>
          <span>{t('pay.latePct')}</span>
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
          <small>{t('pay.latePctHint')}</small>
        </label>
        <div className="pay-meta">
          <span>{t('pay.workdays')}: <b>{data?.workdays ?? '—'}</b></span>
          <span>{data?.from} → {data?.to}</span>
        </div>
      </div>

      <div className="pay-stats">
        <article><span>{t('pay.fund')}</span><b>{money(data?.summary.salaryFund || 0)}</b></article>
        <article className="is-bad"><span>{t('pay.fines')}</span><b>{money(data?.summary.fineTotal || 0)}</b></article>
        <article className="is-warn"><span>{t('pay.advances')}</span><b>{money(data?.summary.advancesTotal || 0)}</b></article>
        <article className="is-ok"><span>{t('pay.net')}</span><b>{money(data?.summary.netTotal || 0)}</b></article>
      </div>

      <div className="pay-tools">
        <input className="input search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('pay.search')} />
      </div>

      {query.isError ? <p className="pay-err">{(query.error as Error).message}</p> : null}

      <div className="pay-table-wrap">
        <table className="pay-table">
          <thead>
            <tr>
              <th>{t('pay.employee')}</th>
              <th>{t('pay.monthly')}</th>
              <th>{t('pay.daily')}</th>
              <th>{t('pay.absent')}</th>
              <th>{t('pay.late')}</th>
              <th>{t('pay.fines')}</th>
              <th>{t('pay.advances')}</th>
              <th>{t('pay.net')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.accountId}>
                <td data-label={t('pay.employee')}>
                  <b>{p.name}</b>
                  <div className="pay-muted">{p.login}</div>
                </td>
                <td data-label={t('pay.monthly')}>
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
                      className="pay-edit"
                      onClick={() => setSalaryEdit({ id: p.accountId, value: String(p.monthly || '') })}
                    >
                      {money(p.monthly)} <Pencil size={13} />
                    </button>
                  )}
                </td>
                <td data-label={t('pay.daily')}>{money(p.daily)}</td>
                <td data-label={t('pay.absent')}>{p.absentDays}</td>
                <td data-label={t('pay.late')}>{p.lateDays}</td>
                <td data-label={t('pay.fines')}>{money(p.fineTotal)}</td>
                <td data-label={t('pay.advances')}>{money(p.advancesTotal)}</td>
                <td data-label={t('pay.net')}><b>{money(p.net)}</b></td>
                <td>
                  <button type="button" className="btn" onClick={() => setDetailId(p.accountId)}>
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
              <div>
                <h2>{selected.name}</h2>
                <p className="pay-muted">{selected.login} · {t('pay.net')}: {money(selected.net)}</p>
              </div>
              <button type="button" className="icon-btn" onClick={() => setDetailId(null)} aria-label="close">
                <X size={18} />
              </button>
            </div>

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
                      className="btn primary"
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
                      {t('pay.save')}
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
              <ul className="pay-list">
                {selected.advances.map((a) => (
                  <li key={a.id}>
                    <div>
                      <b>{money(a.amount)}</b> · {a.date}
                      {a.note ? <div className="pay-muted">{a.note}</div> : null}
                    </div>
                    <button type="button" className="btn" onClick={() => delAdvance.mutate(a.id)}>
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="pay-form">
                <input
                  className="input"
                  type="number"
                  placeholder={t('pay.amount')}
                  value={advanceForm.amount}
                  onChange={(e) => setAdvanceForm({ ...advanceForm, amount: e.target.value })}
                />
                <input
                  className="input"
                  type="date"
                  value={advanceForm.date}
                  onChange={(e) => setAdvanceForm({ ...advanceForm, date: e.target.value })}
                />
                <input
                  className="input"
                  placeholder={t('pay.note')}
                  value={advanceForm.note}
                  onChange={(e) => setAdvanceForm({ ...advanceForm, note: e.target.value })}
                />
                <button type="button" className="btn primary" onClick={() => addAdvance.mutate()} disabled={!advanceForm.amount}>
                  <Plus size={14} /> {t('pay.addAdvance')}
                </button>
              </div>
            </section>

            <section>
              <h3>{t('pay.adjust')}</h3>
              <ul className="pay-list">
                {selected.adjustments.map((a) => (
                  <li key={a.id}>
                    <div>
                      <b>{money(a.amount)}</b> · {a.kind}
                      {a.note ? <div className="pay-muted">{a.note}</div> : null}
                    </div>
                    <button type="button" className="btn" onClick={() => delAdj.mutate(a.id)}>
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="pay-form">
                <select
                  className="input"
                  value={adjForm.kind}
                  onChange={(e) => setAdjForm({ ...adjForm, kind: e.target.value })}
                >
                  <option value="bonus">{t('pay.bonus')}</option>
                  <option value="deduct">{t('pay.deduct')}</option>
                  <option value="other">{t('pay.other')}</option>
                </select>
                <input
                  className="input"
                  type="number"
                  placeholder={t('pay.amountSigned')}
                  value={adjForm.amount}
                  onChange={(e) => setAdjForm({ ...adjForm, amount: e.target.value })}
                />
                <input
                  className="input"
                  placeholder={t('pay.note')}
                  value={adjForm.note}
                  onChange={(e) => setAdjForm({ ...adjForm, note: e.target.value })}
                />
                <button type="button" className="btn primary" onClick={() => addAdj.mutate()} disabled={!adjForm.amount}>
                  <Plus size={14} /> {t('pay.addAdjust')}
                </button>
              </div>
            </section>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
