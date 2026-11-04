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

export function GpsPage() {
  const cache = useQueryClient();
  const [agentId, setAgentId] = useState('');
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [sub, setSub] = useState<'points' | 'agents' | 'route'>('points');
  const [coordEdit, setCoordEdit] = useState<{ id: string; lat: string; lng: string; address: string } | null>(null);

  const q = useQuery({
    queryKey: ['kpi-gps', agentId],
    queryFn: () => kpiFetch<Overview>(`/kpi/gps/overview${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`),
    refetchInterval: 15_000,
  });

  const saveCoords = useMutation({
    mutationFn: (payload: { id: string; lat: string; lng: string; address: string }) =>
      kpiFetch(`/kpi/customers/${payload.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          lat: payload.lat ? Number(payload.lat) : null,
          lng: payload.lng ? Number(payload.lng) : null,
          address: payload.address,
        }),
      }),
    onSuccess: () => {
      setCoordEdit(null);
      void cache.invalidateQueries({ queryKey: ['kpi-gps'] });
    },
  });

  const d = q.data;
  const currentAgentId = agentId || d?.selectedAgentId || '';
  const liveAgents = (d?.agents || []).filter((a) => a.lat != null && a.lng != null);
  const visitedCount = (d?.points || []).filter((p) => p.visitedToday).length;
  const selectedAgent = (d?.agents || []).find((a) => a.id === currentAgentId);

  return (
    <div className="kpi-page" data-testid="page-gps">
      <header className="kpi-head">
        <div>
          <h1>GPS va marshrut {selectedAgent ? `— ${selectedAgent.fullName}` : ''}</h1>
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
          const isOnline = a.lat != null && a.lng != null;
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
              <small>
                ✓ {a.visitedToday} / {a.customersCount} nuqta
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

      {/* Interactive 1✓ -> 2 -> 3 -> 4 -> 5 Route Map for the selected agent */}
      <RouteMap
        stops={(d?.points || []) as RouteStop[]}
        agents={selectedAgent ? [selectedAgent] : []}
        agentName={selectedAgent?.fullName}
        track={d?.agentTrack || []}
        selectedStopId={selectedStopId}
        onSelectStop={(st) => setSelectedStopId(st.id)}
        onSelectAgent={(id) => setAgentId(id)}
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
                          <input className="input" placeholder="Manzil" value={coordEdit.address} onChange={(e) => setCoordEdit({ ...coordEdit, address: e.target.value })} />
                          <div className="kpi-row-actions">
                            <input className="input" style={{ width: 110 }} placeholder="Lat (41.29)" value={coordEdit.lat} onChange={(e) => setCoordEdit({ ...coordEdit, lat: e.target.value })} />
                            <input className="input" style={{ width: 110 }} placeholder="Lng (69.24)" value={coordEdit.lng} onChange={(e) => setCoordEdit({ ...coordEdit, lng: e.target.value })} />
                          </div>
                        </div>
                      ) : (
                        <>
                          <div>{p.address || '—'}</div>
                          <div className="kpi-muted">
                            {p.lat.toFixed(4)}, {p.lng.toFixed(4)} {p.exactGps ? '(aniq GPS)' : '(hudud bo‘yicha)'}
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
                            <button type="button" className="btn btn-primary" onClick={() => setSelectedStopId(p.id)}>
                              <MapPin size={14} /> Xaritada
                            </button>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => setCoordEdit({ id: p.id, lat: String(p.lat), lng: String(p.lng), address: p.address || '' })}
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
                    {a.lat != null && a.lng != null ? (
                      <span className="kpi-chip ok">Faol · {fmtTime(a.lastSeenAt)}</span>
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
                      onClick={() => { setAgentId(a.id); setSub('points'); }}
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
