import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2, Clock, Compass, ExternalLink, MapPin, Navigation, RefreshCw, Route as RouteIcon, Users,
} from 'lucide-react';
import { useState } from 'react';
import { kpiFetch, uzs } from '@/kpi/api';
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
  name: string;
  phone: string;
  address: string;
  agentId: string | null;
  agentName: string;
  lat: number | null;
  lng: number | null;
  debt: string;
  visitedToday: boolean;
  visitedAt: string | null;
  visitNotes: string;
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
  agents: AgentPin[];
  points: GpsPoint[];
  routeLog: RouteEntry[];
};

const TASHKENT_CENTER = { lat: 41.2995, lng: 69.2401, label: 'Toshkent' };

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
  const [sub, setSub] = useState<'agents' | 'points' | 'route'>('agents');
  const [focus, setFocus] = useState<{ lat: number; lng: number; label: string }>(TASHKENT_CENTER);
  const [coordEdit, setCoordEdit] = useState<{ id: string; lat: string; lng: string; address: string } | null>(null);

  const q = useQuery({
    queryKey: ['kpi-gps', agentId],
    queryFn: () => kpiFetch<Overview>(`/kpi/gps/overview${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`),
    refetchInterval: 20_000,
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
  const liveAgents = (d?.agents || []).filter((a) => a.lat != null && a.lng != null);
  const mappedPoints = (d?.points || []).filter((p) => p.lat != null && p.lng != null);
  const visitedCount = (d?.points || []).filter((p) => p.visitedToday).length;

  const delta = 0.035;
  const bbox = `${(focus.lng - delta).toFixed(5)}%2C${(focus.lat - delta).toFixed(5)}%2C${(focus.lng + delta).toFixed(5)}%2C${(focus.lat + delta).toFixed(5)}`;
  const mapUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${focus.lat.toFixed(5)}%2C${focus.lng.toFixed(5)}`;

  return (
    <div className="kpi-page" data-testid="page-gps">
      <header className="kpi-head">
        <div>
          <h1>GPS va marshrut</h1>
          <p>Agentlarning jonli joylashuvi, savdo nuqtalari xaritasi va bugungi yurgan yo‘nalishi</p>
        </div>
        <div className="kpi-actions">
          <select className="input" style={{ minWidth: 200 }} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Barcha agentlar</option>
            {(d?.agents || []).map((a) => (
              <option key={a.id} value={a.id}>{a.fullName}</option>
            ))}
          </select>
          <button type="button" className="btn" onClick={() => void q.refetch()}>
            <RefreshCw size={15} /> Yangilash
          </button>
        </div>
      </header>

      <div className="ag-stats">
        <article className="ag-stat is-blue">
          <div className="ag-stat-head">
            <span>GPS faol agentlar</span>
            <span className="ag-stat-ico"><Navigation size={18} /></span>
          </div>
          <strong>{liveAgents.length} / {d?.agents.length || 0}</strong>
          <small>Kabinetga kirganda avto-yangilanadi</small>
        </article>
        <article className="ag-stat is-green">
          <div className="ag-stat-head">
            <span>Bugun borilgan nuqtalar</span>
            <span className="ag-stat-ico"><CheckCircle2 size={18} /></span>
          </div>
          <strong>{d?.routeLog.length || visitedCount} ta</strong>
          <small>Sana: {d?.date || 'bugun'}</small>
        </article>
        <article className="ag-stat is-amber">
          <div className="ag-stat-head">
            <span>Nazoratdagi nuqtalar</span>
            <span className="ag-stat-ico"><Compass size={18} /></span>
          </div>
          <strong>{d?.points.length || 0} ta</strong>
          <small>Qarzdor yoki koordinatali mijozlar</small>
        </article>
        <article className="ag-stat">
          <div className="ag-stat-head">
            <span>GPS biriktirilgan do‘konlar</span>
            <span className="ag-stat-ico"><MapPin size={18} /></span>
          </div>
          <strong>{mappedPoints.length} ta</strong>
          <small>Tashrifda avtomatik saqlanadi</small>
        </article>
      </div>

      {/* Interactive Map + Active Pin Bar */}
      <section className="gps-map-card">
        <div className="gps-map-top">
          <div>
            <b><MapPin size={15} /> Ko‘rinayotgan nuqta: {focus.label}</b>
            <span className="kpi-muted"> ({focus.lat.toFixed(5)}, {focus.lng.toFixed(5)})</span>
          </div>
          <div className="kpi-actions">
            <a
              className="btn"
              href={`https://www.google.com/maps/search/?api=1&query=${focus.lat},${focus.lng}`}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={14} /> Google Mapsda ochish
            </a>
          </div>
        </div>
        <iframe title="Bordo GPS Map" className="gps-iframe" src={mapUrl} loading="lazy" />
        <div className="gps-pins-bar">
          {liveAgents.map((a) => (
            <button
              key={a.id}
              type="button"
              className="gps-pin-chip is-agent"
              onClick={() => setFocus({ lat: a.lat!, lng: a.lng!, label: `Agent: ${a.fullName}` })}
            >
              <Navigation size={13} /> {a.fullName} ({fmtTime(a.lastSeenAt)})
            </button>
          ))}
          {mappedPoints.slice(0, 10).map((p) => (
            <button
              key={p.id}
              type="button"
              className={`gps-pin-chip ${p.visitedToday ? 'is-visited' : ''}`}
              onClick={() => setFocus({ lat: p.lat!, lng: p.lng!, label: p.name })}
            >
              <MapPin size={13} /> {p.name}
            </button>
          ))}
        </div>
      </section>

      <div className="kpi-seg">
        <button type="button" className={sub === 'agents' ? 'active' : ''} onClick={() => setSub('agents')}>
          <Users size={14} /> Agentlar holati ({d?.agents.length || 0})
        </button>
        <button type="button" className={sub === 'points' ? 'active' : ''} onClick={() => setSub('points')}>
          <MapPin size={14} /> Savdo nuqtalari ({d?.points.length || 0})
        </button>
        <button type="button" className={sub === 'route' ? 'active' : ''} onClick={() => setSub('route')}>
          <RouteIcon size={14} /> Bugungi marshrut tarixi ({d?.routeLog.length || 0})
        </button>
      </div>

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
                <th>Xaritada</th>
              </tr>
            </thead>
            <tbody>
              {(d?.agents || []).map((a) => (
                <tr key={a.id}>
                  <td><b>{a.fullName}</b></td>
                  <td>
                    {a.lat != null && a.lng != null ? (
                      <span className="kpi-chip ok">Faol · {fmtTime(a.lastSeenAt)}</span>
                    ) : (
                      <span className="kpi-chip">GPS kutilmoqda</span>
                    )}
                  </td>
                  <td>{a.customersCount} ta</td>
                  <td>{a.debtorsCount} ta</td>
                  <td><b>{a.visitedToday} ta</b></td>
                  <td>
                    {a.lat != null && a.lng != null ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => setFocus({ lat: a.lat!, lng: a.lng!, label: `Agent: ${a.fullName}` })}
                      >
                        <MapPin size={14} /> Ko‘rsatish
                      </button>
                    ) : (
                      <span className="kpi-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {sub === 'points' ? (
        <div className="kpi-table-wrap">
          <table className="kpi-table">
            <thead>
              <tr>
                <th>Savdo nuqtasi (Mijoz)</th>
                <th>Agent</th>
                <th>Qarzdorlik</th>
                <th>Bugungi tashrif</th>
                <th>Manzil / GPS</th>
                <th>Amal</th>
              </tr>
            </thead>
            <tbody>
              {(d?.points || []).map((p) => {
                const isEd = coordEdit?.id === p.id;
                return (
                  <tr key={p.id}>
                    <td><b>{p.name}</b><div className="kpi-muted">{p.phone}</div></td>
                    <td>{p.agentName}</td>
                    <td><b className={Number(p.debt) > 0 ? 'is-warn' : 'is-ok'}>{uzs(p.debt)}</b></td>
                    <td>
                      {p.visitedToday ? (
                        <span className="kpi-chip ok">Borildi · {fmtTime(p.visitedAt)}</span>
                      ) : (
                        <span className="kpi-chip pending">Borilmagan</span>
                      )}
                    </td>
                    <td>
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
                          {p.lat != null && p.lng != null ? (
                            <div className="kpi-muted">{p.lat.toFixed(5)}, {p.lng.toFixed(5)}</div>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td>
                      <div className="kpi-row-actions">
                        {isEd ? (
                          <>
                            <button type="button" className="btn btn-primary" onClick={() => saveCoords.mutate(coordEdit)}>Saqlash</button>
                            <button type="button" className="btn" onClick={() => setCoordEdit(null)}>Bekor</button>
                          </>
                        ) : (
                          <>
                            {p.lat != null && p.lng != null ? (
                              <button type="button" className="btn btn-primary" onClick={() => setFocus({ lat: p.lat!, lng: p.lng!, label: p.name })}>
                                <MapPin size={14} /> Xarita
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="btn"
                              onClick={() => setCoordEdit({ id: p.id, lat: p.lat ? String(p.lat) : '', lng: p.lng ? String(p.lng) : '', address: p.address || '' })}
                            >
                              GPS kiritish
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
                  <td><b><Clock size={13} /> {fmtTime(r.at)}</b></td>
                  <td><b>{r.agentName}</b></td>
                  <td>{r.customerName}<div className="kpi-muted">{r.address}</div></td>
                  <td>
                    {r.lat != null && r.lng != null ? (
                      <button type="button" className="btn" onClick={() => setFocus({ lat: r.lat!, lng: r.lng!, label: `${r.agentName} → ${r.customerName}` })}>
                        <MapPin size={14} /> {r.lat.toFixed(4)}, {r.lng.toFixed(4)}
                      </button>
                    ) : (
                      <span className="kpi-muted">GPS yo‘q</span>
                    )}
                  </td>
                  <td>{r.notes || '—'}</td>
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
