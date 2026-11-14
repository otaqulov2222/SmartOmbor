import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, KeyRound, Pencil, RefreshCw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { kpiFetch, kpiStatusLabel, readStaffToken, uzs } from '@/kpi/api';
import './kpi.css';

function parseCoordPair(raw: string): { lat: number; lng: number } | null {
  const text = raw.trim().replace(/;/g, ',').replace(/\s+/g, ' ');
  const parts = text.includes(',')
    ? text.split(',').map((p) => p.trim())
    : text.split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) < 1 || Math.abs(lng) < 1) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function formatCoordPair(lat: number, lng: number) {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

/** Compact map: paste coords or click/drag marker. */
function CustomerPinMap({
  lat,
  lng,
  onPick,
}: {
  lat: number | null;
  lng: number | null;
  onPick: (lat: number, lng: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      const w = window as unknown as { L?: any };
      if (!w.L) {
        if (!document.getElementById('leaflet-css')) {
          const link = document.createElement('link');
          link.id = 'leaflet-css';
          link.rel = 'stylesheet';
          link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
          document.head.appendChild(link);
        }
        if (!document.getElementById('leaflet-js')) {
          await new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.id = 'leaflet-js';
            script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Leaflet yuklanmadi'));
            document.head.appendChild(script);
          });
        } else {
          await new Promise<void>((resolve) => {
            const wait = () => {
              if ((window as unknown as { L?: any }).L) resolve();
              else window.setTimeout(wait, 50);
            };
            wait();
          });
        }
      }
      if (cancelled || !boxRef.current || mapRef.current) return;
      const L = (window as unknown as { L: any }).L;
      const map = L.map(boxRef.current, { zoomControl: true }).setView([41.3111, 69.2797], 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
      map.on('click', (e: { latlng: { lat: number; lng: number } }) => {
        onPickRef.current(e.latlng.lat, e.latlng.lng);
      });
      mapRef.current = map;
      setTimeout(() => map.invalidateSize(), 80);
    };
    void boot().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const L = (window as unknown as { L?: any }).L;
    if (!map || !L || lat == null || lng == null) return;
    if (!markerRef.current) {
      markerRef.current = L.marker([lat, lng], { draggable: true }).addTo(map);
      markerRef.current.on('dragend', () => {
        const p = markerRef.current.getLatLng();
        onPickRef.current(p.lat, p.lng);
      });
    } else {
      markerRef.current.setLatLng([lat, lng]);
    }
    map.setView([lat, lng], Math.max(map.getZoom(), 16));
  }, [lat, lng]);

  useEffect(() => () => {
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
      markerRef.current = null;
    }
  }, []);

  return (
    <div
      ref={boxRef}
      style={{
        width: '100%',
        height: 220,
        borderRadius: 12,
        overflow: 'hidden',
        border: '1px solid #e2e8f0',
        marginTop: '.55rem',
      }}
    />
  );
}

type Dash = {
  agentsTotal: number; agentsActive: number; customersTotal: number; customersPending: number;
  salesTotal: string; paidTotal: string; dueTotal: string; overdueOrders: number; pendingApproval: number;
  kpiAccrued: string; kpiConfirmed: string; kpiPending: string; kpiExpired: string;
  periodStart?: string; periodEnd?: string; periodLabel?: string;
};
type Agent = {
  id: string; fullName: string; phone: string; login: string; status: string;
  salesPlan: string; customers: number; salesTotal: string; monthSales?: string;
  paidTotal?: string; opening?: string; closing?: string; folderName?: string | null;
  planPct?: number | null; kpiTotal: string;
  periodStart?: string; periodEnd?: string; periodLabel?: string;
  msStatus?: 'ready' | 'stale' | 'warming';
};
type AgentSettlement = {
  agentId: string; agentName: string; agentLogin: string; folderName: string | null;
  period: { from: string; to: string }; periodLabel?: string;
  customers: number; income: string; expense: string; opening: string; closing: string;
  kpiTotal?: string;
  msStatus?: 'ready' | 'stale' | 'warming';
  rows: Array<{ id: string; name: string; opening: string; income: string; expense: string; closing: string }>;
};
type Customer = {
  id: string; name: string; phone: string; type: string; status: string; address: string;
  agentId: string | null; notes?: string;
  lat?: string | number | null; lng?: string | number | null; gpsSource?: string | null;
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

function Card({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: string }) {
  return (
    <article className={`kpi-card ${tone || ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small className="kpi-card-hint">{hint}</small> : null}
    </article>
  );
}

async function downloadExcel(kind: string, label: string) {
  try {
    const token = readStaffToken();
    const response = await fetch(`/api/kpi/export/${kind}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!response.ok) {
      let message = `Xato ${response.status}`;
      try {
        const body = await response.json() as { error?: string };
        if (body.error) message = body.error;
      } catch {
        /* keep */
      }
      throw new Error(message);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SmartOmbor-${label.replace(/\s+/g, '-')}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert((err as Error).message || 'Yuklab bo‘lmadi');
  }
}

type PeriodPreset = 'today' | 'yesterday' | 'week' | 'last_week' | 'month' | 'last_month' | 'days7' | 'days30' | 'quarter' | 'year' | 'custom';

const PERIOD_PRESETS: Array<{ id: PeriodPreset; label: string }> = [
  { id: 'today', label: 'Bugun' },
  { id: 'yesterday', label: 'Kecha' },
  { id: 'week', label: 'Shu hafta' },
  { id: 'last_week', label: 'O‘tgan hafta' },
  { id: 'month', label: 'Shu oy' },
  { id: 'last_month', label: 'O‘tgan oy' },
  { id: 'days7', label: '7 kun' },
  { id: 'days30', label: '30 kun' },
  { id: 'quarter', label: 'Chorak' },
  { id: 'year', label: 'Yil' },
  { id: 'custom', label: 'Maxsus' },
];

function tashkentToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function ymdNoon(ymd: string) {
  return new Date(`${ymd}T07:00:00.000Z`);
}

function addDays(ymd: string, days: number) {
  const dt = ymdNoon(ymd);
  dt.setUTCDate(dt.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
}

function mondayOf(ymd: string) {
  const dow = ymdNoon(ymd).getUTCDay();
  return addDays(ymd, dow === 0 ? -6 : 1 - dow);
}

function periodFromPreset(preset: PeriodPreset): { from: string; to: string } {
  const today = tashkentToday();
  switch (preset) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y }; }
    case 'week': return { from: mondayOf(today), to: today };
    case 'last_week': {
      const mon = mondayOf(today);
      return { from: addDays(mon, -7), to: addDays(mon, -1) };
    }
    case 'month': return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'last_month': {
      const thisStart = `${today.slice(0, 7)}-01`;
      const to = addDays(thisStart, -1);
      return { from: `${to.slice(0, 7)}-01`, to };
    }
    case 'days7': return { from: addDays(today, -6), to: today };
    case 'days30': return { from: addDays(today, -29), to: today };
    case 'quarter': {
      const m = Number(today.slice(5, 7));
      const q0 = Math.floor((m - 1) / 3) * 3 + 1;
      return { from: `${today.slice(0, 4)}-${String(q0).padStart(2, '0')}-01`, to: today };
    }
    case 'year': return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default: return { from: `${today.slice(0, 7)}-01`, to: today };
  }
}

function matchPreset(from: string, to: string): PeriodPreset {
  for (const p of PERIOD_PRESETS) {
    if (p.id === 'custom') continue;
    const hit = periodFromPreset(p.id);
    if (hit.from === from && hit.to === to) return p.id;
  }
  return 'custom';
}

function defaultPeriod() {
  return { ...periodFromPreset('month'), preset: 'month' as PeriodPreset };
}

function useMsSync(from?: string, to?: string, preset?: PeriodPreset) {
  const cache = useQueryClient();
  const period = defaultPeriod();
  return useMutation({
    mutationFn: () => kpiFetch('/kpi/sync', {
      method: 'POST',
      body: JSON.stringify({
        from: from || period.from,
        to: to || period.to,
        preset: preset || period.preset,
      }),
    }),
    onSuccess: () => {
      for (const k of ['kpi-dash', 'kpi-agents', 'kpi-customers', 'kpi-orders', 'kpi-calcs']) {
        void cache.invalidateQueries({ queryKey: [k] });
      }
    },
  });
}

function PeriodBar({
  from, to, preset, onPreset, onFrom, onTo, onSync, syncing,
}: {
  from: string; to: string; preset: PeriodPreset;
  onPreset: (p: PeriodPreset) => void;
  onFrom: (v: string) => void; onTo: (v: string) => void;
  onSync: () => void; syncing: boolean;
}) {
  return (
    <div className="kpi-period-wrap">
      <div className="kpi-period-presets" role="tablist" aria-label="Davr">
        {PERIOD_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={preset === p.id}
            className={preset === p.id ? 'is-on' : ''}
            onClick={() => onPreset(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="kpi-period-bar">
        <label>
          <span>Dan</span>
          <input type="date" value={from} onChange={(e) => onFrom(e.target.value)} />
        </label>
        <span className="kpi-period-dash">→</span>
        <label>
          <span>Gacha</span>
          <input type="date" value={to} onChange={(e) => onTo(e.target.value)} />
        </label>
        <button type="button" className="btn btn-primary" disabled={syncing} onClick={onSync}>
          <RefreshCw size={15} /> {syncing ? 'MoySkladdan olinmoqda…' : 'MS dan yangilash'}
        </button>
      </div>
    </div>
  );
}

/* ---------- 1. Boshqaruv (/kpi) ---------- */
export function KpiDashboardPage() {
  const initial = useMemo(() => defaultPeriod(), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [preset, setPreset] = useState<PeriodPreset>(initial.preset);
  const qs = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&preset=${encodeURIComponent(preset)}`;
  const q = useQuery({ queryKey: ['kpi-dash', from, to, preset], queryFn: () => kpiFetch<Dash>(`/kpi/dashboard${qs}`) });
  const agents = useQuery({
    queryKey: ['kpi-agents', from, to, preset],
    queryFn: () => kpiFetch<Agent[]>(`/kpi/agents${qs}`),
    refetchInterval: (query) => {
      const rows = query.state.data;
      if (rows?.some((a) => a.msStatus === 'warming' || a.msStatus === 'stale')) return 1500;
      return false;
    },
  });
  const sync = useMsSync(from, to, preset);
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const d = q.data;
  const msWarming = Boolean(agents.data?.some((a) => a.msStatus === 'warming'));
  const sorted = useMemo(
    () => [...(agents.data || [])].sort((a, b) => Number(b.salesTotal) - Number(a.salesTotal)),
    [agents.data],
  );
  const detail = useQuery({
    queryKey: ['kpi-agent-settle', openAgentId, from, to, preset],
    enabled: Boolean(openAgentId),
    queryFn: () => kpiFetch<AgentSettlement>(
      `/kpi/agents/${openAgentId}/settlements?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&preset=${encodeURIComponent(preset)}`,
    ),
    refetchInterval: (query) => {
      const st = query.state.data?.msStatus;
      if (st === 'warming' || st === 'stale') return 1200;
      return false;
    },
  });
  const openAgent = sorted.find((a) => a.id === openAgentId);
  const detailWarming = detail.data?.msStatus === 'warming' || (detail.isFetching && !(detail.data?.rows?.length));
  const applyPreset = (next: PeriodPreset) => {
    if (next === 'custom') {
      setPreset('custom');
      return;
    }
    const range = periodFromPreset(next);
    setPreset(next);
    setFrom(range.from);
    setTo(range.to);
  };
  return (
    <div className="kpi-page" data-testid="page-kpi-dashboard">
      <header className="kpi-head">
        <div>
          <h1>KPI boshqaruv</h1>
          <p>MoySklad Взаиморасчеты (davr aylanmasi) — GPS marshrutdagi barcha mijozlar emas</p>
          <p className="kpi-muted" style={{ margin: '.35rem 0 0' }}>
            Davr: <b>{PERIOD_PRESETS.find((p) => p.id === preset)?.label || 'Maxsus'}</b> · {from} — {to}
          </p>
        </div>
        <div className="kpi-actions">
          <a className="btn" href="/agent" target="_blank" rel="noreferrer"><ExternalLink size={15} /> Agent portal</a>
        </div>
      </header>
      <PeriodBar
        from={from} to={to} preset={preset}
        onPreset={applyPreset}
        onFrom={(v) => { setFrom(v); setPreset(matchPreset(v, to)); }}
        onTo={(v) => { setTo(v); setPreset(matchPreset(from, v)); }}
        syncing={sync.isPending}
        onSync={() => sync.mutate()}
      />
      {q.error ? <p className="kpi-error">{(q.error as Error).message}</p> : null}
      {msWarming ? <p className="kpi-muted">MS hisobot fonda yangilanmoqda…</p> : null}
      {d ? (
        <div className="kpi-grid">
          <Card label="Agentlar" value={d.agentsActive} hint="Faol savdo agentlari" tone="blue" />
          <Card label="KPI tasdiqlangan" value={uzs(d.kpiConfirmed)} hint="To‘lov tasdiqlangan komissiya" tone="ok" />
          <Card label="KPI kutilmoqda" value={uzs(d.kpiPending)} hint="Hali tasdiqlanmagan" tone="warn" />
          <Card label="KPI jami" value={uzs(d.kpiAccrued)} hint="Tanlangan davr bo‘yicha jami" tone="purple" />
        </div>
      ) : null}
      <div className="kpi-table-wrap">
        <div className="kpi-panel-head" style={{ padding: '.4rem .5rem .8rem' }}>
          <h3>Agentlar — MoySklad взаиморасчеты</h3>
          <p className="kpi-muted" style={{ margin: '.25rem 0 0' }}>
            {from} — {to} · Mijozlar = MS teg (nol aylanmasizlar yashirin) · Agentga bosing → batafsil
          </p>
        </div>
        <table className="kpi-table">
          <thead>
            <tr>
              <th>Agent</th><th>Login</th><th>Mijozlari</th>
              <th>Kirim (Приход)</th><th>Chiqim (Расход)</th><th>Reja %</th><th>KPI</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
              <tr key={a.id} className="kpi-row-click" onClick={() => setOpenAgentId(a.id)}>
                <td data-label="Agent"><button type="button" className="kpi-link">{a.fullName}</button></td>
                <td data-label="Login" className="kpi-muted">{a.login}</td>
                <td data-label="Mijozlari">{a.customers}</td>
                <td data-label="Kirim">{uzs(a.paidTotal ?? 0)}</td>
                <td data-label="Chiqim">{uzs(a.salesTotal)}</td>
                <td data-label="Reja %">{a.planPct != null ? `${a.planPct}%` : '—'}</td>
                <td data-label="KPI"><b className="is-ok">{uzs(a.kpiTotal)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openAgentId ? (
        <div className="kpi-drawer-bg" role="presentation" onClick={() => setOpenAgentId(null)}>
          <div className="kpi-drawer" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="kpi-drawer-head">
              <div>
                <h3>{detail.data?.agentName || openAgent?.fullName || 'Agent'}</h3>
                <p className="kpi-muted">
                  MS teg: <b>{detail.data?.folderName || openAgent?.folderName || (detail.isLoading ? '…' : 'topilmadi')}</b>
                  {' · '}Взаиморасчеты · {from} — {to}
                </p>
              </div>
              <button type="button" className="btn" onClick={() => setOpenAgentId(null)}><X size={16} /> Yopish</button>
            </div>
            <div style={{ marginBottom: '.85rem' }}>
              <PeriodBar
                from={from} to={to} preset={preset}
                onPreset={applyPreset}
                onFrom={(v) => { setFrom(v); setPreset(matchPreset(v, to)); }}
                onTo={(v) => { setTo(v); setPreset(matchPreset(from, v)); }}
                syncing={sync.isPending}
                onSync={() => sync.mutate()}
              />
            </div>
            {detailWarming ? <p className="kpi-muted">MS fonda yangilanmoqda — jadval ochiq qoladi…</p> : null}
            {detail.error ? <p className="kpi-error">{(detail.error as Error).message}</p> : null}
            <>
                <div className="kpi-grid" style={{ marginBottom: '.75rem' }}>
                  <Card label="Mijozlar" value={detail.data?.customers ?? openAgent?.customers ?? '…'} tone="slate" />
                  <Card label="Kirim (Приход)" value={uzs(detail.data?.income ?? openAgent?.paidTotal ?? 0)} tone="ok" />
                  <Card label="Chiqim (Расход)" value={uzs(detail.data?.expense ?? openAgent?.salesTotal ?? 0)} tone="blue" />
                  <Card label="KPI (komissiya)" value={uzs(detail.data?.kpiTotal ?? openAgent?.kpiTotal ?? 0)} tone="purple" />
                </div>
                {detail.data && !detail.data.folderName && detail.data.msStatus === 'ready' ? (
                  <p className="kpi-error">MS da bu agent uchun teg topilmadi — mijozlar ochilmaydi.</p>
                ) : null}
                <div className="kpi-table-wrap" style={{ maxHeight: '52vh' }}>
                  <table className="kpi-table">
                    <thead>
                      <tr>
                        <th>Kontragent</th>
                        <th>Boshlang‘ich</th>
                        <th>Kirim</th>
                        <th>Chiqim</th>
                        <th>Yakuniy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(detail.data?.rows?.length || 0) === 0 ? (
                        <tr>
                          <td colSpan={5} className="kpi-muted">
                            {detailWarming ? 'Hujjatlar fonda hisoblanmoqda…' : 'Bu davrda mijoz yo‘q yoki teg bo‘sh.'}
                          </td>
                        </tr>
                      ) : null}
                      {(detail.data?.rows || []).map((row) => (
                        <tr key={row.id}>
                          <td data-label="Kontragent"><b>{row.name}</b></td>
                          <td data-label="Boshlang‘ich">{uzs(row.opening)}</td>
                          <td data-label="Kirim">{uzs(row.income)}</td>
                          <td data-label="Chiqim">{uzs(row.expense)}</td>
                          <td data-label="Yakuniy">{uzs(row.closing)}</td>
                        </tr>
                      ))}
                    </tbody>
                    {(detail.data?.rows?.length || 0) > 0 ? (
                      <tfoot>
                        <tr>
                          <td><b>Jami ({detail.data?.customers})</b></td>
                          <td><b>{uzs(detail.data?.opening)}</b></td>
                          <td><b>{uzs(detail.data?.income)}</b></td>
                          <td><b>{uzs(detail.data?.expense)}</b></td>
                          <td><b>{uzs(detail.data?.closing)}</b></td>
                        </tr>
                      </tfoot>
                    ) : null}
                  </table>
                </div>
              </>
          </div>
        </div>
      ) : null}
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
        <thead><tr><th>Agent (MoySklad)</th><th>Portal login</th><th>Mijozlar</th><th>Savdo</th><th>Oylik fakt</th><th>Reja %</th><th>KPI</th><th>Reja / Parol</th></tr></thead>
        <tbody>
          {(list.data || []).map((a) => (
            <tr key={a.id}>
              <td data-label="Agent"><b>{a.fullName}</b></td>
              <td data-label="Portal login"><code>{a.login}</code></td>
              <td data-label="Mijozlar">{a.customers}</td>
              <td data-label="Savdo">{uzs(a.salesTotal)}</td>
              <td data-label="Oylik fakt">{uzs(a.monthSales ?? 0)}</td>
              <td data-label="Reja %">{a.planPct != null ? `${a.planPct}%` : '—'}</td>
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [coords, setCoords] = useState('');
  const [agentId, setAgentId] = useState('');
  const [phone, setPhone] = useState('');
  const [addressPreview, setAddressPreview] = useState('');
  const [geoBusy, setGeoBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const agents = useQuery({ queryKey: ['kpi-agents'], queryFn: () => kpiFetch<Agent[]>('/kpi/agents') });
  const list = useQuery({
    queryKey: ['kpi-customers', q],
    queryFn: () => kpiFetch<Customer[]>(`/kpi/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  });
  const parsed = useMemo(() => parseCoordPair(coords), [coords]);
  const resetForm = () => {
    setEditingId(null);
    setName('');
    setCoords('');
    setAgentId('');
    setPhone('');
    setAddressPreview('');
    setFormError('');
    setGeoBusy(false);
  };
  const startEdit = (c: Customer) => {
    setEditingId(c.id);
    setName(c.name || '');
    setPhone(c.phone || '');
    const la = c.lat != null && c.lat !== '' ? Number(c.lat) : NaN;
    const ln = c.lng != null && c.lng !== '' ? Number(c.lng) : NaN;
    setCoords(Number.isFinite(la) && Number.isFinite(ln) ? formatCoordPair(la, ln) : '');
    setAgentId(c.agentId || '');
    setAddressPreview(c.address || '');
    setFormError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const applyPick = useCallback((lat: number, lng: number) => {
    setCoords(formatCoordPair(lat, lng));
  }, []);
  useEffect(() => {
    if (!parsed) {
      if (coords.trim()) setAddressPreview('');
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setGeoBusy(true);
      void kpiFetch<{ address: string; displayName?: string }>(
        `/kpi/geo/reverse?lat=${encodeURIComponent(parsed.lat.toFixed(6))}&lng=${encodeURIComponent(parsed.lng.toFixed(6))}`,
      )
        .then((data) => {
          if (cancelled) return;
          setFormError('');
          setAddressPreview(data.address || data.displayName || '');
        })
        .catch((err) => {
          if (cancelled) return;
          setAddressPreview('');
          setFormError((err as Error).message || 'Manzil topilmadi');
        })
        .finally(() => {
          if (!cancelled) setGeoBusy(false);
        });
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [parsed, coords]);
  const assign = useMutation({
    mutationFn: (payload: { id: string; agentId: string }) => {
      // Bo‘sh agent — PATCH orqali biriktirishni yechish (assign endpoint agentId talab qiladi)
      if (!payload.agentId) {
        return kpiFetch(`/kpi/customers/${payload.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ agentId: '' }),
        });
      }
      return kpiFetch(`/kpi/customers/${payload.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({ agentId: payload.agentId }),
      });
    },
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ['kpi-customers'] });
      void cache.invalidateQueries({ queryKey: ['kpi-gps'] });
    },
  });
  const saveCustomer = useMutation({
    mutationFn: async () => {
      const pair = parseCoordPair(coords);
      if (!name.trim()) throw new Error('Mijoz nomi kerak.');
      if (!pair) throw new Error('Koordinata kiriting: 41.355233, 69.386437');
      if (!agentId) throw new Error('Mas’ul agentni tanlang.');
      const body = {
        name: name.trim(),
        phone: phone.trim(),
        lat: Number(pair.lat.toFixed(6)),
        lng: Number(pair.lng.toFixed(6)),
        agentId,
        address: addressPreview.trim() || undefined,
        status: 'active',
      };
      if (editingId) {
        return kpiFetch(`/kpi/customers/${editingId}`, { method: 'PATCH', body: JSON.stringify(body) });
      }
      return kpiFetch('/kpi/customers', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      resetForm();
      void cache.invalidateQueries({ queryKey: ['kpi-customers'] });
      void cache.invalidateQueries({ queryKey: ['kpi-gps'] });
    },
    onError: (err) => setFormError((err as Error).message || 'Saqlanmadi'),
  });
  const removeCustomer = useMutation({
    mutationFn: (id: string) => kpiFetch(`/kpi/customers/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      if (editingId === id) resetForm();
      void cache.invalidateQueries({ queryKey: ['kpi-customers'] });
      void cache.invalidateQueries({ queryKey: ['kpi-gps'] });
    },
    onError: (err) => window.alert((err as Error).message || 'O‘chirilmadi'),
  });
  const agentOptions = (agents.data || []).filter((a) => a.login !== 'ofis' && a.login !== 'vanseling');
  return (
    <>
      <div className="kpi-panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '.75rem', alignItems: 'center', marginBottom: '.55rem' }}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>{editingId ? 'Mijozni tahrirlash' : 'Yangi mijoz (aniq GPS)'}</h3>
          {editingId ? (
            <button type="button" className="btn" onClick={resetForm}><X size={14} /> Bekor</button>
          ) : null}
        </div>
        <p className="kpi-muted" style={{ marginTop: 0 }}>
          Koordinata yozing — tizim tuman/ko‘cha/uyni o‘zi topadi. Bordim faqat shu nuqta atrofida (250 m) ishlaydi.
        </p>
        <div className="kpi-form">
          <input className="input" placeholder="Mijoz nomi (masalan Alisher aka Samarqand)" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" placeholder="Telefon (ixtiyoriy)" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">— mas’ul agent —</option>
            {agentOptions.map((a) => (
              <option key={a.id} value={a.id}>{a.fullName}</option>
            ))}
          </select>
          <button type="button" className="btn btn-primary" disabled={saveCustomer.isPending} onClick={() => saveCustomer.mutate()}>
            {saveCustomer.isPending ? 'Saqlanmoqda…' : editingId ? 'Saqlash' : 'Qo‘shish'}
          </button>
        </div>
        <label className="field" style={{ display: 'grid', gap: '.35rem', marginTop: '.75rem' }}>
          <b>Koordinata (kenglik, uzunlik)</b>
          <input
            className="input"
            placeholder="41.355233, 69.386437"
            value={coords}
            onChange={(e) => setCoords(e.target.value)}
          />
          <span className="kpi-muted">
            Koordinatani yozing — tizim aniq nuqtani xaritaga o‘zi qo‘yadi. Xaritani bosib yoki belgini tortib ham belgilash mumkin.
          </span>
        </label>
        <CustomerPinMap
          lat={parsed?.lat ?? null}
          lng={parsed?.lng ?? null}
          onPick={applyPick}
        />
        {geoBusy ? <p className="kpi-muted">Manzil aniqlanmoqda…</p> : null}
        {addressPreview ? (
          <p style={{ margin: '.55rem 0 0', color: '#0f766e', fontWeight: 600 }}>
            Aniqlangan manzil: {addressPreview}
          </p>
        ) : null}
        {formError ? <p className="kpi-muted" style={{ color: '#b91c1c' }}>{formError}</p> : null}
      </div>
      <div className="kpi-panel">
        <input className="input" placeholder="Mijoz qidirish…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="kpi-table-wrap">
        <table className="kpi-table">
          <thead><tr><th>Mijoz</th><th>Manzil / GPS</th><th>Mas’ul agent</th><th></th></tr></thead>
          <tbody>
            {(list.data || []).map((c) => (
              <tr key={c.id} className={editingId === c.id ? 'is-selected' : undefined}>
                <td data-label="Mijoz"><b>{c.name}</b><div className="kpi-muted">{c.phone || '—'}</div></td>
                <td data-label="Manzil / GPS">
                  <div>{c.address || '—'}</div>
                  <div className="kpi-muted">
                    {c.lat != null && c.lng != null ? `${Number(c.lat).toFixed(5)}, ${Number(c.lng).toFixed(5)}` : 'koordinata yo‘q'}
                    {' · '}
                    {c.gpsSource === 'admin' ? 'aniq GPS (admin)' : c.gpsSource === 'agent' ? 'agent pin' : 'taxminiy'}
                  </div>
                </td>
                <td data-label="Mas’ul agent">
                  <select className="input" value={c.agentId || ''} onChange={(e) => assign.mutate({ id: c.id, agentId: e.target.value })}>
                    <option value="">— biriktirilmagan —</option>
                    {(agents.data || []).map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
                  </select>
                </td>
                <td data-label="Amallar">
                  <div className="kpi-row-actions">
                    <button type="button" className="btn" onClick={() => startEdit(c)} title="Tahrirlash">
                      <Pencil size={14} /> Tahrirlash
                    </button>
                    <button
                      type="button"
                      className="btn"
                      style={{ color: '#b91c1c' }}
                      disabled={removeCustomer.isPending}
                      onClick={() => {
                        if (!window.confirm(`«${c.name}» o‘chirilsinmi?`)) return;
                        removeCustomer.mutate(c.id);
                      }}
                      title="O‘chirish"
                    >
                      <Trash2 size={14} /> O‘chirish
                    </button>
                  </div>
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
                  <td data-label="Holat"><span className={`kpi-chip ${o.status}`}>{kpiStatusLabel(o.status)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

const STAGE_HINTS = [
  'Shu kunning o‘zida to‘lansa',
  '1 hafta ichida (1–7 kun)',
  '15 kun ichida (8–15 kun)',
];

function RulesSection() {
  const cache = useQueryClient();
  const policy = useQuery({ queryKey: ['kpi-policy'], queryFn: () => kpiFetch<Policy>('/kpi/policy') });
  const [stages, setStages] = useState<Policy['stages'] | null>(null);
  const current = stages || policy.data?.stages || [];
  const save = useMutation({
    mutationFn: () => kpiFetch<{ recalculated?: number }>('/kpi/policy', {
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
      void cache.invalidateQueries({ queryKey: ['kpi-orders'] });
      void cache.invalidateQueries({ queryKey: ['kpi-calcs'] });
      void cache.invalidateQueries({ queryKey: ['kpi-dash'] });
    },
  });
  const recalc = useMutation({
    mutationFn: () => kpiFetch<{ updated: number }>('/kpi/recalculate', { method: 'POST', body: '{}' }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ['kpi-orders'] });
      void cache.invalidateQueries({ queryKey: ['kpi-calcs'] });
      void cache.invalidateQueries({ queryKey: ['kpi-dash'] });
    },
  });
  return (
    <section className="kpi-panel">
      <h2>3 bosqichli KPI foizlari</h2>
      <p className="kpi-muted">
        MoySklad отгрузка sanasidan to‘lov yopilgunga qadar necha kun o‘tganiga qarab foiz.
        Saqlash → savdo KPI avtomatik qayta hisoblanadi.
      </p>
      <div className="kpi-stages-table">
        <div className="kpi-stages-head">
          <span>Bosqich</span>
          <span>Dan (kun)</span>
          <span>Gacha (kun)</span>
          <span>Foiz %</span>
          <span>Qachon</span>
        </div>
        {current.map((stage, index) => (
          <div className="kpi-stage" key={index}>
            <input className="input" value={stage.name} onChange={(e) => {
              const next = [...current]; next[index] = { ...stage, name: e.target.value }; setStages(next);
            }} />
            <label className="kpi-stage-field">
              <span className="kpi-stage-mobile">Dan (kun)</span>
              <input className="input" type="number" min={0} value={stage.dayFrom} onChange={(e) => {
                const next = [...current]; next[index] = { ...stage, dayFrom: Number(e.target.value) }; setStages(next);
              }} />
            </label>
            <label className="kpi-stage-field">
              <span className="kpi-stage-mobile">Gacha (kun)</span>
              <input className="input" type="number" min={0} value={stage.dayTo} onChange={(e) => {
                const next = [...current]; next[index] = { ...stage, dayTo: Number(e.target.value) }; setStages(next);
              }} />
            </label>
            <label className="kpi-stage-field">
              <span className="kpi-stage-mobile">Foiz %</span>
              <input className="input" value={stage.percent} onChange={(e) => {
                const next = [...current]; next[index] = { ...stage, percent: e.target.value }; setStages(next);
              }} />
            </label>
            <div className="kpi-stage-hint">{STAGE_HINTS[index] || `${stage.dayFrom}–${stage.dayTo} kun`}</div>
          </div>
        ))}
      </div>
      <div className="kpi-actions">
        <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saqlanmoqda…' : 'Saqlash + KPI yangilash'}
        </button>
        <button type="button" className="btn" disabled={recalc.isPending} onClick={() => recalc.mutate()}>
          {recalc.isPending ? 'Hisoblanmoqda…' : 'Qayta hisoblash'}
        </button>
      </div>
      {save.error ? <p className="kpi-error">{(save.error as Error).message}</p> : null}
      {save.isSuccess ? <p className="kpi-ok">Qoidalar saqlandi va savdo KPI yangilandi</p> : null}
      {recalc.isSuccess ? <p className="kpi-ok">Hisoblar yangilandi ({recalc.data?.updated ?? 0} ta)</p> : null}
    </section>
  );
}
