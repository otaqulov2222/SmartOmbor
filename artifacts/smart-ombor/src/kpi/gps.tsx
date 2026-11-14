import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2, Clock, Compass, MapPin, Navigation, RefreshCw, Route as RouteIcon, Users,
} from 'lucide-react';
import { useState } from 'react';
import { kpiFetch, uzs } from '@/kpi/api';
import { RouteMap, type RouteStop } from './route-map';
import './kpi.css';

type AgentPin = {
  id: string;
  fullName: string;
  login: string;
  phone: string;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  lastSeenAt: string | null;
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

/** Agent counts as "live" only if last ping is fresh (5 min). */
function isAgentLive(lastSeenAt: string | null | undefined, lat: number | null | undefined, lng: number | null | undefined) {
  if (lat == null || lng == null || !lastSeenAt) return false;
  const age = Date.now() - new Date(lastSeenAt).getTime();
  return Number.isFinite(age) && age >= 0 && age <= 5 * 60_000;
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
  const currentAgentId = agentId || d?.selectedAgentId || '';
  const liveAgents = (d?.agents || []).filter((a) => isAgentLive(a.lastSeenAt, a.lat, a.lng));
  const visitedCount = (d?.points || []).filter((p) => p.visitedToday).length;
  const selectedAgent = (d?.agents || []).find((a) => a.id === currentAgentId);
  const selectedLive = selectedAgent
    ? isAgentLive(selectedAgent.lastSeenAt, selectedAgent.lat, selectedAgent.lng)
    : false;

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
            Nuqtalar = agentga biriktirilgan mijozlar (telefon Marshrut bilan bir xil). KPI dagi 5 = faqat MS aylanmasi.
          </p>
        </div>
        <div className="kpi-actions">
          <button type="button" className="btn" onClick={() => void q.refetch()}>
            <RefreshCw size={15} /> Yangilash
          </button>
        </div>
      </header>

      {/* Clickable Agent Selector Pills (one agent at a time) */}
      <div className="gps-agent-strip">
        {(d?.agents || []).map((a) => {
          const isOnline = isAgentLive(a.lastSeenAt, a.lat, a.lng);
          const isActive = currentAgentId === a.id;
          return (
            <button
              key={a.id}
              type="button"
              className={`gps-agent-pill ${isActive ? 'is-active' : ''}`}
              onClick={() => { setAgentId(a.id); setSelectedStopId(null); }}
            >
              <span className="gps-agent-pill-top">
                <i className={`gps-dot ${isOnline ? 'is-on' : ''}`} />
                <b>{a.fullName}</b>
              </span>
              <small className="gps-agent-pill-meta">✓ {a.visitedToday} / {a.customersCount} nuqta</small>
              <small className="gps-agent-pill-status">
                {isOnline ? 'Jonli GPS' : a.lastSeenAt ? `Oxirgi ${fmtTime(a.lastSeenAt)}` : 'GPS yo‘q'}
              </small>
            </button>
          );
        })}
      </div>

      <div className="ag-stats">
        <article className="ag-stat is-blue">
          <div className="ag-stat-head">
            <span>GPS faol agentlar</span>
            <span className="ag-stat-ico"><Navigation size={18} /></span>
          </div>
          <strong>{liveAgents.length} / {d?.agents.length || 0}</strong>
          <small>Telefon GPS yoqilganda ko‘rinadi</small>
        </article>
        <article className="ag-stat is-green">
          <div className="ag-stat-head">
            <span>Bajarilgan nuqtalar (✓)</span>
            <span className="ag-stat-ico"><CheckCircle2 size={18} /></span>
          </div>
          <strong>{visitedCount} / {d?.points.length || 0}</strong>
          <small>Sana: {d?.date || 'bugun'}</small>
        </article>
        <article className="ag-stat is-amber">
          <div className="ag-stat-head">
            <span>Qolgan nuqtalar</span>
            <span className="ag-stat-ico"><Compass size={18} /></span>
          </div>
          <strong>{Math.max(0, (d?.points.length || 0) - visitedCount)} ta</strong>
          <small>Navbat bo‘yicha 1 → 2 → 3 → 4 → 5</small>
        </article>
        <article className="ag-stat">
          <div className="ag-stat-head">
            <span>Bugungi tashriflar jurnali</span>
            <span className="ag-stat-ico"><MapPin size={18} /></span>
          </div>
          <strong>{d?.routeLog.length || 0} ta</strong>
          <small>Soat va GPS dalil bilan</small>
        </article>
      </div>

      {/* Live navigator-style map for selected agent (admin sees same trail) */}
      <RouteMap
        stops={(d?.points || []) as RouteStop[]}
        agents={selectedAgent && selectedLive ? [selectedAgent] : []}
        agentName={selectedAgent?.fullName}
        viewer="admin"
        agentPos={
          selectedLive && selectedAgent?.lat != null && selectedAgent?.lng != null
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
                <th>Oxirgi GPS</th>
                <th>Mijozlari</th>
                <th>Qarzdor nuqtalar</th>
                <th>Bugun bordi</th>
                <th>Marshrutni ko‘rish</th>
              </tr>
            </thead>
            <tbody>
              {(d?.agents || []).map((a) => (
                <tr key={a.id}>
                  <td data-label="Agent"><b>{a.fullName}</b></td>
                  <td data-label="Oxirgi GPS">
                    {isAgentLive(a.lastSeenAt, a.lat, a.lng) ? (
                      <span className="kpi-chip ok">Faol · {fmtTime(a.lastSeenAt)}</span>
                    ) : a.lat != null && a.lng != null ? (
                      <span className="kpi-chip">Eski · {fmtTime(a.lastSeenAt)}</span>
                    ) : (
                      <span className="kpi-chip">Telefon GPS kutilmoqda</span>
                    )}
                  </td>
                  <td data-label="Mijozlari">{a.customersCount} ta</td>
                  <td data-label="Qarzdor nuqtalar">{a.debtorsCount} ta</td>
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
              ))}
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
