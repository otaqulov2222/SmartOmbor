import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Banknote, CalendarRange, Download, ExternalLink, Gauge, Handshake,
  Pencil, RefreshCw, Trash2, Users, Wallet, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  agentId: string; customerId: string; agentName?: string; agentLogin?: string; customerName?: string;
  isHouseAccount?: boolean;
  kpi?: {
    id: string; orderId: string; baseAmount: string; stagePercent: string; kpiAmount: string;
    status: string; stageName: string; stageDayFrom?: number; stageDayTo?: number;
    daysRemaining: number | null;
  } | null;
};

/** KPI foizi — oddiy matn: «1–7 kun · 2%». Ofis uchun hech qachon foiz yo‘q. */
function kpiFoizLabel(
  k: NonNullable<Order['kpi']> | null | undefined,
  opts?: { isHouseAccount?: boolean; paid?: number },
): string {
  if (opts?.isHouseAccount) return '—';
  if (!k) return '—';
  const stage = String(k.stageName || '').toLowerCase();
  if (stage === 'ofis' || stage === '0%') {
    // To‘lov yo‘q / muddat o‘tgan — foiz 0
    if (!(Number(k.stagePercent || 0) > 0)) return Number(opts?.paid || 0) > 0 ? '15+ kun · 0%' : '—';
  }
  const pct = Number(k.stagePercent || 0);
  const from = Number(k.stageDayFrom ?? -1);
  const to = Number(k.stageDayTo ?? -1);
  if (!(pct > 0)) return Number(opts?.paid || 0) > 0 ? '15+ kun · 0%' : '—';
  if (from === 0 && to === 0) return 'Shu kun · 3%';
  if (from === 1 && to === 7) return '1–7 kun · 2%';
  if (from === 8 && to === 15) return '8–15 kun · 1%';
  if (from >= 0 && to >= from) return `${from}–${to} kun · ${pct}%`;
  return `${pct}%`;
}
type OrdersPayload = {
  rows: Order[];
  periodStart?: string;
  periodEnd?: string;
  periodLabel?: string;
};
type Policy = {
  id: string; name: string; baseType: string; startAnchor: string; warningDays: number;
  stages: Array<{ name: string; dayFrom: number; dayTo: number; percent: string; sortOrder: number }>;
};
type Calc = {
  id: string; orderId: string; agentId: string; baseAmount: string; stagePercent: string; kpiAmount: string;
  status: string; stageName: string; daysRemaining: number | null;
};

function Card({
  label, value, hint, tone, icon,
}: {
  label: string; value: string | number; hint?: string; tone?: string; icon?: ReactNode;
}) {
  return (
    <article className={`kpi-card ${tone || ''}`}>
      <div className="kpi-card-top">
        <span>{label}</span>
        {icon ? <span className="kpi-card-ico" aria-hidden>{icon}</span> : null}
      </div>
      <strong>{value}</strong>
      {hint ? <small className="kpi-card-hint">{hint}</small> : null}
    </article>
  );
}

function agentInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
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
      for (const k of ['kpi-dash', 'kpi-agents', 'kpi-customers', 'kpi-orders', 'kpi-calcs', 'kpi-agent-settle', 'kpi-gps']) {
        void cache.invalidateQueries({ queryKey: [k] });
      }
    },
  });
}

const PERIOD_SECONDARY: PeriodPreset[] = ['yesterday', 'last_week', 'last_month', 'days7', 'year', 'custom'];

/** ISO yyyy-mm-dd ↔ ko‘rinish: dd/mm/yyyy (UZ standart). */
function isoToDmy(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}
function dmyToIso(raw: string) {
  const m = /^(\d{1,2})[/./-](\d{1,2})[/./-](\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (yyyy < 2000 || yyyy > 2100 || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const iso = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const check = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(check.getTime())) return null;
  if (check.getUTCDate() !== dd || check.getUTCMonth() + 1 !== mm) return null;
  return iso;
}

function DateDmyInput({
  value, onChange, ariaLabel,
}: {
  value: string; onChange: (iso: string) => void; ariaLabel: string;
}) {
  const [text, setText] = useState(() => isoToDmy(value));
  const pickerRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    setText(isoToDmy(value));
  }, [value]);
  const openPicker = () => {
    const el = pickerRef.current;
    if (!el) return;
    try {
      if (typeof el.showPicker === 'function') el.showPicker();
      else el.click();
    } catch {
      el.click();
    }
  };
  return (
    <div className="kpi-date-field">
      <div className="kpi-date-combo">
        <input
          type="text"
          inputMode="numeric"
          className="kpi-date-dmy"
          placeholder="DD/MM/YYYY"
          lang="uz"
          autoComplete="off"
          aria-label={ariaLabel}
          value={text}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            const iso = dmyToIso(next);
            if (iso) onChange(iso);
          }}
          onBlur={() => {
            const iso = dmyToIso(text);
            if (iso) {
              onChange(iso);
              setText(isoToDmy(iso));
            } else {
              setText(isoToDmy(value));
            }
          }}
        />
        <button type="button" className="kpi-date-cal" aria-label={`${ariaLabel} — kalendar`} onClick={openPicker}>
          <CalendarRange size={15} />
        </button>
        <input
          ref={pickerRef}
          type="date"
          className="kpi-date-native"
          lang="en-GB"
          value={value}
          onChange={(e) => {
            const iso = e.target.value;
            if (!iso) return;
            onChange(iso);
            setText(isoToDmy(iso));
          }}
          tabIndex={-1}
          aria-hidden
        />
      </div>
    </div>
  );
}

function PeriodBar({
  from, to, preset, onPreset, onFrom, onTo, onSync, syncing, compact,
}: {
  from: string; to: string; preset: PeriodPreset;
  onPreset: (p: PeriodPreset) => void;
  onFrom: (v: string) => void; onTo: (v: string) => void;
  onSync: () => void; syncing: boolean;
  compact?: boolean;
}) {
  return (
    <div className={`kpi-period-wrap${compact ? ' is-compact' : ''}`}>
      <div className="kpi-period-toolbar">
        <div className="kpi-period-left">
          <div className="kpi-period-label">
            <CalendarRange size={15} />
            <span>Davr</span>
          </div>
          <div className="kpi-period-rail" role="tablist" aria-label="Davr tanlash">
            {PERIOD_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={preset === p.id}
                className={`kpi-period-chip${preset === p.id ? ' is-on' : ''}${PERIOD_SECONDARY.includes(p.id) ? ' is-soft' : ''}`}
                onClick={() => onPreset(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="kpi-period-bar">
          <div className="kpi-period-range">
            <DateDmyInput ariaLabel="Boshlanish sanasi" value={from} onChange={onFrom} />
            <span className="kpi-period-dash" aria-hidden>—</span>
            <DateDmyInput ariaLabel="Tugash sanasi" value={to} onChange={onTo} />
          </div>
          <button type="button" className="btn btn-primary kpi-sync-btn" disabled={syncing} onClick={onSync}>
            <RefreshCw size={15} className={syncing ? 'kpi-spin' : undefined} />
            {syncing ? 'Yangilanmoqda…' : 'MS yangilash'}
          </button>
        </div>
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
  const queryClient = useQueryClient();
  const agents = useQuery({
    queryKey: ['kpi-agents', from, to, preset],
    queryFn: () => kpiFetch<Agent[]>(`/kpi/agents${qs}`),
    refetchInterval: (query) => {
      const rows = query.state.data;
      if (rows?.some((a) => a.msStatus === 'warming' || a.msStatus === 'stale')) return 800;
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
      if (st === 'warming' || st === 'stale') return 1000;
      return false;
    },
  });
  // Modal tayyor bo‘lsa — ro‘yxatdagi soxta 0 yangilansin.
  useEffect(() => {
    if (!openAgentId) return;
    if ((detail.data?.rows?.length || 0) === 0) return;
    if (detail.data?.msStatus === 'warming') return;
    void queryClient.invalidateQueries({ queryKey: ['kpi-agents', from, to, preset] });
  }, [openAgentId, detail.data?.rows?.length, detail.data?.msStatus, detail.data?.income, detail.data?.expense, from, to, preset, queryClient]);
  const openAgent = sorted.find((a) => a.id === openAgentId);
  const detailHasRows = (detail.data?.rows?.length || 0) > 0;
  const detailWarming = Boolean(openAgentId) && (detail.isFetching || detail.isLoading) && !detailHasRows;
  const agentMsPending = (a: Agent) =>
    (a.msStatus === 'warming' || a.msStatus === 'stale') &&
    Number(a.paidTotal || 0) === 0 &&
    Number(a.salesTotal || 0) === 0 &&
    (a.customers || 0) === 0;
  /** Ro‘yxatda bor bo‘lsa modal kartochkalari darhol ko‘rinsin. */
  const listHintReady = Boolean(openAgent && !agentMsPending(openAgent));
  const cardCustomers = detailWarming
    ? (listHintReady ? openAgent!.customers : '…')
    : (detail.data?.customers ?? 0);
  const cardKirim = detailWarming
    ? (listHintReady ? uzs(openAgent!.paidTotal ?? 0) : '…')
    : uzs(detail.data?.income ?? 0);
  const cardChiqim = detailWarming
    ? (listHintReady ? uzs(openAgent!.salesTotal) : '…')
    : uzs(detail.data?.expense ?? 0);
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
    <div className="kpi-page kpi-dash" data-testid="page-kpi-dashboard">
      <header className="kpi-head kpi-dash-head">
        <div className="kpi-dash-title">
          <div className="kpi-dash-title-row">
            <h1>KPI boshqaruv</h1>
          </div>
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
      {msWarming ? <p className="kpi-status-banner">Tez yuklanmoqda…</p> : null}
      {d ? (
        <div className="kpi-grid kpi-grid-4">
          <Card label="Agentlar" value={d.agentsActive} tone="blue" icon={<Users size={16} />} />
          <Card label="KPI tasdiqlangan" value={uzs(d.kpiConfirmed)} tone="ok" icon={<Banknote size={16} />} />
          <Card label="KPI kutilmoqda" value={uzs(d.kpiPending)} tone="warn" icon={<Wallet size={16} />} />
          <Card label="KPI jami" value={uzs(d.kpiAccrued)} tone="purple" icon={<Gauge size={16} />} />
        </div>
      ) : null}
      <section className="kpi-panel kpi-agents-panel">
        <div className="kpi-panel-head">
          <div>
            <h2><Handshake size={17} /> Agentlar</h2>
          </div>
          <span className="kpi-count-pill">{sorted.length} agent</span>
        </div>
        <div className="kpi-table-wrap is-flush">
          <table className="kpi-table kpi-table-agents">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Login</th>
                <th className="is-num">Mijozlari</th>
                <th className="is-num">Kirim</th>
                <th className="is-num">Chiqim</th>
                <th className="is-num">Reja %</th>
                <th className="is-num">KPI</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => (
                <tr key={a.id} className="kpi-row-click" onClick={() => setOpenAgentId(a.id)}>
                  <td data-label="Agent">
                    <button type="button" className="kpi-agent-cell">
                      <span className="kpi-avatar" aria-hidden>{agentInitials(a.fullName)}</span>
                      <span className="kpi-agent-name">{a.fullName}</span>
                    </button>
                  </td>
                  <td data-label="Login" className="kpi-muted">{a.login}</td>
                  <td data-label="Mijozlari" className="is-num">{agentMsPending(a) ? '…' : a.customers}</td>
                  <td data-label="Kirim" className="is-num">{agentMsPending(a) ? '…' : uzs(a.paidTotal ?? 0)}</td>
                  <td data-label="Chiqim" className="is-num">{agentMsPending(a) ? '…' : uzs(a.salesTotal)}</td>
                  <td data-label="Reja %" className="is-num">{a.planPct != null ? `${a.planPct}%` : '—'}</td>
                  <td data-label="KPI" className="is-num"><b className="is-ok">{uzs(a.kpiTotal)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {openAgentId ? (
        <div className="kpi-drawer-bg" role="presentation" onClick={() => setOpenAgentId(null)}>
          <div className="kpi-drawer" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="kpi-drawer-head">
              <div>
                <h3>{detail.data?.agentName || openAgent?.fullName || 'Agent'}</h3>
                <p className="kpi-muted">
                  Guruh: <b>{detail.data?.folderName || openAgent?.folderName || (detail.isLoading ? '…' : 'topilmadi')}</b>
                  {' · '}{isoToDmy(from)} — {isoToDmy(to)}
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
            {detailWarming ? <p className="kpi-muted">Yuklanmoqda…</p> : null}
            {detail.error ? <p className="kpi-error">{(detail.error as Error).message}</p> : null}
            <>
                <div className="kpi-grid kpi-grid-4" style={{ marginBottom: '.75rem' }}>
                  <Card label="Mijozlar" value={cardCustomers} tone="slate" />
                  <Card label="Kirim" value={cardKirim} tone="ok" />
                  <Card label="Chiqim" value={cardChiqim} tone="blue" />
                  <Card label="KPI" value={uzs(detail.data?.kpiTotal ?? openAgent?.kpiTotal ?? 0)} tone="purple" />
                </div>
                {detail.data && !detail.data.folderName && !detailWarming ? (
                  <p className="kpi-error">Bu agent uchun MS guruh topilmadi.</p>
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
                      {!detailHasRows ? (
                        <tr>
                          <td colSpan={5} className="kpi-muted">
                            {detailWarming
                              ? 'Yuklanmoqda…'
                              : detail.data?.folderName
                                ? 'Bu davrda aylanma yo‘q.'
                                : 'MS guruh (teg) topilmadi.'}
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
  const initial = useMemo(() => defaultPeriod(), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [preset, setPreset] = useState<PeriodPreset>(initial.preset);
  const sync = useMsSync(from, to, preset);
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
    <div className="kpi-page kpi-dash" data-testid="page-kpi-agents">
      <header className="kpi-head kpi-dash-head">
        <div className="kpi-dash-title">
          <div className="kpi-dash-title-row">
            <h1>Agentlar va mijozlar</h1>
          </div>
        </div>
        <div className="kpi-actions">
          <div className="kpi-seg">
            <button type="button" className={sub === 'agents' ? 'active' : ''} onClick={() => setSub('agents')}>Agentlar</button>
            <button type="button" className={sub === 'customers' ? 'active' : ''} onClick={() => setSub('customers')}>Mijozlar</button>
          </div>
        </div>
      </header>
      <PeriodBar
        from={from}
        to={to}
        preset={preset}
        onPreset={applyPreset}
        onFrom={(v) => { setFrom(v); setPreset(matchPreset(v, to)); }}
        onTo={(v) => { setTo(v); setPreset(matchPreset(from, v)); }}
        syncing={sync.isPending}
        onSync={() => sync.mutate()}
      />
      {sub === 'agents' ? (
        <AgentsSection from={from} to={to} preset={preset} />
      ) : (
        <CustomersSection />
      )}
    </div>
  );
}

export const KpiCustomersPage = KpiAgentsPage;

function AgentsSection({
  from, to, preset,
}: {
  from: string; to: string; preset: PeriodPreset;
}) {
  const qs = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&preset=${encodeURIComponent(preset)}`;
  const list = useQuery({
    queryKey: ['kpi-agents', from, to, preset],
    queryFn: () => kpiFetch<Agent[]>(`/kpi/agents${qs}`),
    refetchInterval: (query) => {
      const rows = query.state.data;
      if (rows?.some((a) => a.msStatus === 'warming' || a.msStatus === 'stale')) return 800;
      return false;
    },
  });
  const rows = list.data || [];
  const agentMsPending = (a: Agent) =>
    (a.msStatus === 'warming' || a.msStatus === 'stale') &&
    Number(a.paidTotal || 0) === 0 &&
    Number(a.salesTotal || 0) === 0 &&
    (a.customers || 0) === 0;
  const totals = useMemo(() => {
    let kpi = 0;
    let kirim = 0;
    let chiqim = 0;
    let mijoz = 0;
    let ready = 0;
    for (const a of rows) {
      if (agentMsPending(a)) continue;
      ready += 1;
      kpi += Number(a.kpiTotal || 0);
      kirim += Number(a.paidTotal || 0);
      chiqim += Number(a.salesTotal || 0);
      mijoz += Number(a.customers || 0);
    }
    return { kpi, kirim, chiqim, mijoz, ready, all: rows.length };
  }, [rows]);
  const msWarming = rows.some((a) => a.msStatus === 'warming');
  const sorted = useMemo(
    () => [...rows].sort((a, b) => Number(b.kpiTotal || 0) - Number(a.kpiTotal || 0)),
    [rows],
  );

  return (
    <>
      {list.error ? <p className="kpi-error">{(list.error as Error).message}</p> : null}
      {msWarming ? <p className="kpi-status-banner">MS ma’lumotlari yangilanmoqda…</p> : null}
      <div className="kpi-grid kpi-grid-4" style={{ marginBottom: '.85rem' }}>
        <Card
          label="Agentlar"
          value={`${totals.ready}/${totals.all || rows.length}`}
          tone="blue"
          icon={<Users size={16} />}
        />
        <Card
          label="Kirim"
          value={msWarming && totals.kirim === 0 ? '…' : uzs(totals.kirim)}
          tone="ok"
          icon={<Banknote size={16} />}
        />
        <Card
          label="Chiqim"
          value={msWarming && totals.chiqim === 0 ? '…' : uzs(totals.chiqim)}
          tone="blue"
          icon={<Wallet size={16} />}
        />
        <Card
          label="KPI jami"
          value={uzs(totals.kpi)}
          tone="purple"
          icon={<Gauge size={16} />}
        />
      </div>
      <div className="kpi-table-wrap">
        <table className="kpi-table kpi-table-agents">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Portal login</th>
              <th className="is-num">Mijozlar</th>
              <th className="is-num">Kirim</th>
              <th className="is-num">Chiqim</th>
              <th className="is-num">Reja %</th>
              <th className="is-num">KPI</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => {
              const pending = agentMsPending(a);
              return (
                <tr key={a.id}>
                  <td data-label="Agent">
                    <b>{a.fullName}</b>
                    {a.folderName ? <div className="kpi-muted">Guruh: {a.folderName}</div> : null}
                  </td>
                  <td data-label="Portal login"><code>{a.login}</code></td>
                  <td data-label="Mijozlar" className="is-num">{pending ? '…' : a.customers}</td>
                  <td data-label="Kirim" className="is-num">{pending ? '…' : uzs(a.paidTotal ?? 0)}</td>
                  <td data-label="Chiqim" className="is-num">{pending ? '…' : uzs(a.salesTotal)}</td>
                  <td data-label="Reja %" className="is-num">{a.planPct != null ? `${a.planPct}%` : '—'}</td>
                  <td data-label="KPI" className="is-num"><b className="is-ok">{uzs(a.kpiTotal)}</b></td>
                </tr>
              );
            })}
            {!sorted.length && !list.isLoading ? (
              <tr>
                <td colSpan={7} className="kpi-muted">Agentlar topilmadi.</td>
              </tr>
            ) : null}
            {list.isLoading ? (
              <tr>
                <td colSpan={7} className="kpi-muted">Yuklanmoqda…</td>
              </tr>
            ) : null}
          </tbody>
          {sorted.length > 0 ? (
            <tfoot>
              <tr>
                <td colSpan={2}><b>Jami ({totals.ready})</b></td>
                <td className="is-num"><b>{totals.mijoz}</b></td>
                <td className="is-num"><b>{uzs(totals.kirim)}</b></td>
                <td className="is-num"><b>{uzs(totals.chiqim)}</b></td>
                <td />
                <td className="is-num"><b className="is-ok">{uzs(totals.kpi)}</b></td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </>
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
  const initial = useMemo(() => defaultPeriod(), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [preset, setPreset] = useState<PeriodPreset>(initial.preset);
  const sync = useMsSync(from, to, preset);
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
    <div className="kpi-page kpi-dash" data-testid="page-kpi-orders">
      <header className="kpi-head kpi-dash-head">
        <div className="kpi-dash-title">
          <div className="kpi-dash-title-row">
            <h1>Savdo, to‘lov va KPI</h1>
          </div>
        </div>
        <div className="kpi-actions">
          <div className="kpi-seg">
            <button type="button" className={sub === 'orders' ? 'active' : ''} onClick={() => setSub('orders')}>Savdo va KPI</button>
            <button type="button" className={sub === 'rules' ? 'active' : ''} onClick={() => setSub('rules')}>3 bosqich qoidalari</button>
          </div>
        </div>
      </header>
      {sub === 'orders' ? (
        <>
          <PeriodBar
            from={from}
            to={to}
            preset={preset}
            onPreset={applyPreset}
            onFrom={(v) => { setFrom(v); setPreset(matchPreset(v, to)); }}
            onTo={(v) => { setTo(v); setPreset(matchPreset(from, v)); }}
            syncing={sync.isPending}
            onSync={() => sync.mutate()}
          />
          <OrdersAndKpiSection from={from} to={to} preset={preset} />
        </>
      ) : (
        <RulesSection />
      )}
    </div>
  );
}

export const KpiPaymentsPage = KpiOrdersPage;
export const KpiSettingsPage = KpiOrdersPage;

function OrdersAndKpiSection({
  from, to, preset,
}: {
  from: string; to: string; preset: PeriodPreset;
}) {
  const [agentFilter, setAgentFilter] = useState('');
  const qs = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&preset=${encodeURIComponent(preset)}${agentFilter ? `&agentId=${encodeURIComponent(agentFilter)}` : ''}`;
  const agents = useQuery({
    queryKey: ['kpi-agents', from, to, preset],
    queryFn: () => kpiFetch<Agent[]>(`/kpi/agents?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&preset=${encodeURIComponent(preset)}`),
  });
  const orders = useQuery({
    queryKey: ['kpi-orders', from, to, preset, agentFilter],
    queryFn: () => kpiFetch<OrdersPayload>(`/kpi/orders${qs}`),
  });
  // Ofis/Van seling KPI olmaydi — ro‘yxatda ko‘rsatilmaydi.
  const rows = useMemo(
    () => (orders.data?.rows || []).filter((o) => !o.isHouseAccount),
    [orders.data],
  );
  const totals = useMemo(() => {
    let savdo = 0;
    let tolangan = 0;
    let kpi = 0;
    for (const o of rows) {
      savdo += Number(o.total || 0);
      tolangan += Number(o.paidAmount || 0);
      kpi += Number(o.kpi?.kpiAmount || 0);
    }
    return { savdo, tolangan, kpi, n: rows.length };
  }, [rows]);

  return (
    <>
      <div className="kpi-grid kpi-grid-4" style={{ marginBottom: '.85rem' }}>
        <Card label="Jo‘natmalar" value={totals.n} tone="blue" icon={<Users size={16} />} />
        <Card label="Savdo" value={uzs(totals.savdo)} tone="slate" icon={<Wallet size={16} />} />
        <Card label="To‘langan" value={uzs(totals.tolangan)} tone="ok" icon={<Banknote size={16} />} />
        <Card label="KPI" value={uzs(totals.kpi)} tone="purple" icon={<Gauge size={16} />} />
      </div>
      <div className="kpi-panel" style={{ display: 'flex', gap: '.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="input" style={{ maxWidth: 260 }} value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
          <option value="">Barcha agentlar</option>
          {(agents.data || []).map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
        </select>
      </div>
      <div className="kpi-table-wrap">
        <table className="kpi-table">
          <thead>
            <tr>
              <th>Jo‘natma</th>
              <th>Mijoz</th>
              <th>Agent</th>
              <th className="is-num">Savdo</th>
              <th className="is-num">To‘langan</th>
              <th>Foiz</th>
              <th className="is-num">KPI</th>
              <th>Holat</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const k = o.kpi;
              const paid = Number(o.paidAmount || 0);
              const house = Boolean(o.isHouseAccount);
              const foiz = kpiFoizLabel(k, { isHouseAccount: house, paid });
              const kpiText = house ? '—' : paid > 0 ? uzs(k?.kpiAmount || 0) : '0 so‘m';
              return (
                <tr key={o.id}>
                  <td data-label="Jo‘natma"><b>{o.number.replace(/^MS-/, '')}</b><div className="kpi-muted">{isoToDmy(o.orderDate)}</div></td>
                  <td data-label="Mijoz">{o.customerName || '—'}</td>
                  <td data-label="Agent"><b>{o.agentName || '—'}</b></td>
                  <td data-label="Savdo" className="is-num">{uzs(o.total)}</td>
                  <td data-label="To‘langan" className="is-num">{uzs(o.paidAmount)}</td>
                  <td data-label="Foiz">{foiz}</td>
                  <td data-label="KPI" className="is-num"><b className="is-ok">{kpiText}</b></td>
                  <td data-label="Holat"><span className={`kpi-chip ${o.status}`}>{kpiStatusLabel(o.status)}</span></td>
                </tr>
              );
            })}
            {!rows.length && !orders.isLoading ? (
              <tr><td colSpan={8} className="kpi-muted">Bu davrda jo‘natma yo‘q.</td></tr>
            ) : null}
            {orders.isLoading ? (
              <tr><td colSpan={8} className="kpi-muted">Yuklanmoqda…</td></tr>
            ) : null}
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
        Jo‘natma sanasidan to‘lov yopilgungacha o‘tgan kunlarga qarab foiz hisoblanadi.
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
