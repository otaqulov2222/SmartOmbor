import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2, Clock, Compass, MapPin, Navigation, RefreshCw, Route as RouteIcon, Users,
} from 'lucide-react';
import { useState } from 'react';
import { kpiFetch, uzs } from '@/kpi/api';
import { RouteMap, type RouteStop } from './route-map';
import './kpi.css';

type WatchStatus = 'live' | 'away' | 'silent' | 'no_signal' | 'off_hours';

type AgentPin = {
  id: string;
  fullName: string;
  login: string;
  phone: string;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  lastSeenAt: string | null;
  firstSeenAt?: string | null;
  leftAt?: string | null;
  pingCountToday?: number;
  watchStatus?: WatchStatus;
  watchSource?: string | null;
  watchLabel?: string;
  customersCount: number;
  debtorsCount: number;
  visitedToday: number;
};

type GpsPoint = {
  id: string;
  step: number;
  name: string;
  phone: string;
  address: string;
  agentId: string | null;
  agentName: string;
  lat: number;
  lng: number;
  exactGps?: boolean;
  debt: string;
  visitedToday: boolean;
  visitedAt: string | null;
  visitNotes: string;
  isNext?: boolean;
  distanceM?: number | null;
};

type RouteEntry = {
  id: string;
  agentId: string;
  agentName: string;
  customerId: string;
  customerName: string;
  address: string;
  lat: number | null;
  lng: number | null;
  at: string;
  notes: string;
};

type Overview = {
  date: string;
  selectedAgentId?: string;
  agents: AgentPin[];
  points: GpsPoint[];
  routeLog: RouteEntry[];
  agentTrack?: Array<{ lat: number; lng: number; at: string }>;
  workHours?: { start: string; end: string; active: boolean; label: string };
  watchSummary?: { live: number; away: number; silent: number; noSignal: number; total: number };
  watchAlerts?: Array<{ agentId: string; fullName: string; watchLabel: string; lastSeenAt: string | null }>;
};

function fmtTime(iso: string | null) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('uz-UZ', {
      timeZone: 'Asia/Tashkent',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

/** Oxirgi GPS qancha oldin — admin uchun tushunarli */
function fmtAgo(iso: string | null, now = Date.now()) {
  if (!iso) return 'bugun umuman yo‘q';
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return 'noma’lum';
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 60) return `${sec} soniya oldin`;
  if (sec < 3600) return `${Math.floor(sec / 60)} daqiqa oldin`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} soat oldin`;
  return `${Math.floor(sec / 86_400)} kun oldin`;
}

function agentWatch(a: AgentPin, workActive?: boolean): WatchStatus {
  if (workActive === false) return 'off_hours';
  if (a.watchStatus) return a.watchStatus;
  if (a.lat == null || a.lng == null || !a.lastSeenAt) return 'no_signal';
  const age = Date.now() - new Date(a.lastSeenAt).getTime();
  if (Number.isFinite(age) && age >= 0 && age <= 5 * 60_000) return 'live';
  if (Number.isFinite(age) && age >= 0 && age <= 20 * 60_000) return 'away';
  return a.pingCountToday ? 'silent' : 'no_signal';
}

function isAgentLive(a: AgentPin, workActive?: boolean) {
  return agentWatch(a, workActive) === 'live';
}

function hasDayPosition(a: AgentPin) {
  return a.lat != null && a.lng != null && Boolean(a.lastSeenAt);
}

function watchChipClass(status: WatchStatus) {
  if (status === 'live') return 'ok';
  if (status === 'away') return 'active';
  if (status === 'silent') return 'pending';
  return '';
}

export function GpsPage() {
  const cache = useQueryClient();
  const [agentId, setAgentId] = useState('');
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [focusStopId, setFocusStopId] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const [sub, setSub] = useState<'points' | 'agents' | 'route'>('points');
  const [coordEdit, setCoordEdit] = useState<{ id: string; coords: string; address: string } | null>(null);

  const q = useQuery({
    queryKey: ['kpi-gps', agentId],
    queryFn: () => kpiFetch<Overview>(`/kpi/gps/overview${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`),
    refetchInterval: 8_000,
  });

  const saveCoords = useMutation({
    mutationFn: async (payload: { id: string; coords: string; address: string }) => {
      const text = payload.coords.trim().replace(/;/g, ',').replace(/\s+/g, ' ');
      const parts = text.includes(',') ? text.split(',').map((p) => p.trim()) : text.split(' ').filter(Boolean);
      const lat = Number(parts[0]);
      const lng = Number(parts[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) < 1 || Math.abs(lng) < 1) {
        throw new Error('Koordinata kiriting: 41.355233, 69.386437');
      }
      let address = payload.address.trim();
      if (!address) {
        const geo = await kpiFetch<{ address: string }>(
          `/kpi/geo/reverse?lat=${encodeURIComponent(lat.toFixed(6))}&lng=${encodeURIComponent(lng.toFixed(6))}`,
        );
        address = geo.address || '';
      }
      return kpiFetch(`/kpi/customers/${payload.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          lat: Number(lat.toFixed(6)),
          lng: Number(lng.toFixed(6)),
          address,
        }),
      });
    },
    onSuccess: () => {
      setCoordEdit(null);
      void cache.invalidateQueries({ queryKey: ['kpi-gps'] });
      void cache.invalidateQueries({ queryKey: ['kpi-customers'] });
    },
  });

  const d = q.data;
  const workActive = d?.workHours?.active;
  const currentAgentId = agentId || d?.selectedAgentId || '';
  const liveAgents = (d?.agents || []).filter((a) => isAgentLive(a, workActive));
  const silentAgents = (d?.agents || []).filter((a) => {
    const s = agentWatch(a, workActive);
    return s === 'silent' || s === 'no_signal';
  });
  const visitedCount = (d?.points || []).filter((p) => p.visitedToday).length;
  const selectedAgent = (d?.agents || []).find((a) => a.id === currentAgentId);
  const selectedLive = selectedAgent ? isAgentLive(selectedAgent, workActive) : false;
  const selectedHasPos = selectedAgent ? hasDayPosition(selectedAgent) : false;

  const focusStop = (stopId: string) => {
    setSelectedStopId(stopId);
    setFocusStopId(stopId);
    setFocusNonce((n) => n + 1);
  };

  return (
    <div className="kpi-page" data-testid="page-gps">
      <header className="kpi-head">
        <div>
          <h1>GPS va marshrut {selectedAgent ? `— ${selectedAgent.fullName}` : ''}</h1>
          <p className="kpi-muted" style={{ margin: '.25rem 0 0' }}>
            Kuzatuv: {d?.workHours?.label || '06:00–18:00 (Toshkent)'}
            {d?.workHours?.active ? ' · hozir ish soati' : ' · ish soati tashqarida'}
          </p>
        </div>
        <div className="kpi-actions">
          <button type="button" className="btn" onClick={() => void q.refetch()}>
            <RefreshCw size={15} /> Yangilash
          </button>
        </div>
      </header>

      {d?.workHours?.active && silentAgents.length ? (
        <div className="kpi-status-banner kpi-status-banner-block" role="status">
          <b>
            GPS kelmayapti — telefon signal yubormayapti ({silentAgents.length}/{d?.agents.length || 0})
          </b>
          <p>
            Bu tizim xatosi emas: agent Smart Ombor / Fon GPS APK ochiq bo‘lmasa, brauzer yopilsa yoki
            GPS ruxsati o‘chsa — kuzatuv to‘xtaydi. Ish soatida har bir agent telefonida kabinet yoki
            Fon GPS yoqilgan bo‘lishi shart.
          </p>
          <ul className="kpi-status-list">
            {silentAgents.map((a) => {
              const st = agentWatch(a, workActive);
              return (
                <li key={a.id}>
                  <strong>{a.fullName}</strong>
                  {' — '}
                  {st === 'silent'
                    ? `uzilgan (${fmtAgo(a.lastSeenAt)}, bugun ${a.pingCountToday || 0} ping)`
                    : a.lastSeenAt
                      ? `signal yo‘q (oxirgi ${fmtAgo(a.lastSeenAt)})`
                      : 'hech qachon GPS yubormagan'}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Clickable Agent Selector Pills (one agent at a time) */}
      <div className="gps-agent-strip">
        {(d?.agents || []).map((a) => {
          const status = agentWatch(a, workActive);
          const isOnline = status === 'live';
          const isActive = currentAgentId === a.id;
          return (
            <button
              key={a.id}
              type="button"
              className={`gps-agent-pill ${isActive ? 'is-active' : ''}`}
              onClick={() => { setAgentId(a.id); setSelectedStopId(null); }}
            >
              <span className="gps-agent-pill-top">
                <i className={`gps-dot ${isOnline ? 'is-on' : status === 'away' ? 'is-away' : status === 'silent' ? 'is-silent' : ''}`} />
                <b>{a.fullName}</b>
              </span>
              <small className="gps-agent-pill-meta">✓ {a.visitedToday} / {a.customersCount} nuqta</small>
              <small className="gps-agent-pill-status">
                {isOnline
                  ? (a.watchSource === 'native' || a.watchSource === 'heartbeat' ? 'Fon GPS' : 'Jonli GPS')
                  : status === 'away'
                    ? `Yaqinda · ${fmtAgo(a.lastSeenAt)}`
                    : status === 'silent'
                      ? `Uzilgan · ${fmtAgo(a.lastSeenAt)}`
                      : status === 'off_hours'
                        ? 'Ish soati tashqarida'
                        : a.lastSeenAt
                          ? `Yo‘q · ${fmtAgo(a.lastSeenAt)}`
                          : 'GPS yo‘q'}
              </small>
            </button>
          );
        })}
      </div>

      <div className="ag-stats">
        <article className="ag-stat is-blue">
          <div className="ag-stat-head">
            <span>GPS faol</span>
            <span className="ag-stat-ico"><Navigation size={18} /></span>
          </div>
          <strong>{d?.watchSummary?.live ?? liveAgents.length} / {d?.agents.length || 0}</strong>
        </article>
        <article className="ag-stat is-green">
          <div className="ag-stat-head">
            <span>Bajarilgan</span>
            <span className="ag-stat-ico"><CheckCircle2 size={18} /></span>
          </div>
          <strong>{visitedCount} / {d?.points.length || 0}</strong>
        </article>
        <article className="ag-stat is-amber">
          <div className="ag-stat-head">
            <span>Qolgan</span>
            <span className="ag-stat-ico"><Compass size={18} /></span>
          </div>
          <strong>{Math.max(0, (d?.points.length || 0) - visitedCount)}</strong>
        </article>
        <article className="ag-stat">
          <div className="ag-stat-head">
            <span>Tashriflar</span>
            <span className="ag-stat-ico"><MapPin size={18} /></span>
          </div>
          <strong>{d?.routeLog.length || 0}</strong>
        </article>
      </div>

      {/* Live navigator-style map for selected agent (admin sees same trail) */}
      <RouteMap
        stops={(d?.points || []) as RouteStop[]}
        agents={selectedAgent && selectedHasPos ? [selectedAgent] : []}
        agentName={selectedAgent?.fullName}
        viewer="admin"
        agentPos={
          selectedHasPos && selectedAgent?.lat != null && selectedAgent?.lng != null
            ? { lat: selectedAgent.lat, lng: selectedAgent.lng }
            : null
        }
        follow={selectedLive}
        track={d?.agentTrack || []}
        selectedStopId={selectedStopId}
        focusStopId={focusStopId}
        focusNonce={focusNonce}
        onSelectStop={(st) => focusStop(st.id)}
        onSelectAgent={(id) => setAgentId(id)}
        fullscreen={mapFullscreen}
        onFullscreenChange={setMapFullscreen}
      />

      <div className="kpi-seg">
        <button type="button" className={sub === 'points' ? 'active' : ''} onClick={() => setSub('points')}>
          <MapPin size={14} /> Marshrut nuqtalari 1 → {d?.points.length || 0}
        </button>
        <button type="button" className={sub === 'agents' ? 'active' : ''} onClick={() => setSub('agents')}>
          <Users size={14} /> Agentlar holati ({d?.agents.length || 0})
        </button>
        <button type="button" className={sub === 'route' ? 'active' : ''} onClick={() => setSub('route')}>
          <RouteIcon size={14} /> Tashriflar tarixi ({d?.routeLog.length || 0})
        </button>
      </div>

      {sub === 'points' ? (
        <div className="kpi-table-wrap">
          <table className="kpi-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Savdo nuqtasi (Mijoz)</th>
                <th>Agent</th>
                <th>Qarzdorlik</th>
                <th>Holat</th>
                <th>Manzil / GPS</th>
                <th>Amal</th>
              </tr>
            </thead>
            <tbody>
              {(d?.points || []).map((p) => {
                const isEd = coordEdit?.id === p.id;
                return (
                  <tr key={p.id} onClick={() => setSelectedStopId(p.id)} style={{ cursor: 'pointer' }}>
                    <td data-label="#">
                      <span className={`ag-stop-num ${p.visitedToday ? 'is-done' : p.isNext ? 'is-next' : ''}`}>
                        {p.visitedToday ? '✓' : p.step}
                      </span>
                    </td>
                    <td data-label="Savdo nuqtasi"><b>{p.name}</b><div className="kpi-muted">{p.phone}</div></td>
                    <td data-label="Agent"><b>{p.agentName}</b></td>
                    <td data-label="Qarzdorlik"><b className={Number(p.debt) > 0 ? 'is-warn' : 'is-ok'}>{uzs(p.debt)}</b></td>
                    <td data-label="Holat">
                      {p.visitedToday ? (
                        <span className="kpi-chip ok">✓ Borildi · {fmtTime(p.visitedAt)}</span>
                      ) : p.isNext ? (
                        <span className="kpi-chip active">Navbatdagi (#{p.step})</span>
                      ) : (
                        <span className="kpi-chip pending">Rejada (#{p.step})</span>
                      )}
                    </td>
                    <td data-label="Manzil / GPS" onClick={(e) => e.stopPropagation()}>
                      {isEd ? (
                        <div style={{ display: 'grid', gap: '.3rem' }}>
                          <input
                            className="input"
                            placeholder="Koordinata: 41.355233, 69.386437"
                            value={coordEdit.coords}
                            onChange={(e) => setCoordEdit({ ...coordEdit, coords: e.target.value, address: '' })}
                          />
                          <input className="input" placeholder="Manzil (avto)" value={coordEdit.address} onChange={(e) => setCoordEdit({ ...coordEdit, address: e.target.value })} />
                        </div>
                      ) : (
                        <>
                          <div>{p.address || '—'}</div>
                          <div className="kpi-muted">
                            {p.lat.toFixed(4)}, {p.lng.toFixed(4)} {p.exactGps ? '(aniq GPS · admin)' : '(hudud bo‘yicha)'}
                          </div>
                        </>
                      )}
                    </td>
                    <td data-label="" onClick={(e) => e.stopPropagation()}>
                      <div className="kpi-row-actions">
                        {isEd ? (
                          <>
                            <button type="button" className="btn btn-primary" onClick={() => saveCoords.mutate(coordEdit)}>Saqlash</button>
                            <button type="button" className="btn" onClick={() => setCoordEdit(null)}>Bekor</button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn btn-primary"
                              onClick={() => {
                                setSelectedStopId(p.id);
                                setMapFullscreen(true);
                              }}
                            >
                              <MapPin size={14} /> Xaritada
                            </button>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => setCoordEdit({
                                id: p.id,
                                // Never prefill inferred/fake pins as if they were exact
                                coords: p.exactGps ? `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}` : '',
                                address: p.address || '',
                              })}
                            >
                              Tahrir
                            </button>
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
      ) : null}

      {sub === 'agents' ? (
        <div className="kpi-table-wrap">
          <table className="kpi-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Kuzatuv holati</th>
                <th>Oxirgi GPS</th>
                <th>Bugun ping</th>
                <th>Mijozlari</th>
                <th>Bugun bordi</th>
                <th>Marshrutni ko‘rish</th>
              </tr>
            </thead>
            <tbody>
              {(d?.agents || []).map((a) => {
                const status = agentWatch(a, workActive);
                return (
                  <tr key={a.id}>
                    <td data-label="Agent"><b>{a.fullName}</b></td>
                    <td data-label="Kuzatuv holati">
                      <span className={`kpi-chip ${watchChipClass(status)}`}>
                        {a.watchLabel || status}
                      </span>
                    </td>
                    <td data-label="Oxirgi GPS">
                      {a.lastSeenAt ? (
                        <span>
                          {fmtTime(a.lastSeenAt)}
                          {a.lat != null && a.lng != null ? (
                            <div className="kpi-muted">{a.lat.toFixed(4)}, {a.lng.toFixed(4)}</div>
                          ) : null}
                        </span>
                      ) : (
                        <span className="kpi-chip">GPS yo‘q</span>
                      )}
                    </td>
                    <td data-label="Bugun ping"><b>{a.pingCountToday || 0}</b></td>
                    <td data-label="Mijozlari">{a.customersCount} ta</td>
                    <td data-label="Bugun bordi"><b>✓ {a.visitedToday} ta</b></td>
                    <td data-label="">
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => {
                          setAgentId(a.id);
                          setSelectedStopId(null);
                          setSub('points');
                          setMapFullscreen(true);
                        }}
                      >
                        <RouteIcon size={14} /> Marshrutini ochish
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {sub === 'route' ? (
        <div className="kpi-table-wrap">
          <table className="kpi-table">
            <thead>
              <tr>
                <th>Vaqt</th>
                <th>Agent</th>
                <th>Borilgan nuqta</th>
                <th>GPS dalil</th>
                <th>Izoh</th>
              </tr>
            </thead>
            <tbody>
              {(d?.routeLog || []).map((r) => (
                <tr key={r.id}>
                  <td data-label="Vaqt"><b><Clock size={13} /> {fmtTime(r.at)}</b></td>
                  <td data-label="Agent"><b>{r.agentName}</b></td>
                  <td data-label="Borilgan nuqta">✓ {r.customerName}<div className="kpi-muted">{r.address}</div></td>
                  <td data-label="GPS dalil">
                    {r.lat != null && r.lng != null ? (
                      <span className="kpi-chip ok">{r.lat.toFixed(4)}, {r.lng.toFixed(4)}</span>
                    ) : (
                      <span className="kpi-muted">—</span>
                    )}
                  </td>
                  <td data-label="Izoh">{r.notes || '—'}</td>
                </tr>
              ))}
              {!d?.routeLog.length ? (
                <tr><td colSpan={5} className="kpi-muted">Bugun hali tashrif qayd etilmagan.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
