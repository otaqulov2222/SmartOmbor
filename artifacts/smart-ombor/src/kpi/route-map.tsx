import { CheckCircle2, ExternalLink, Lock, MapPin, Navigation, Unlock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export type RouteStop = {
  id: string;
  step: number;
  name: string;
  address?: string;
  phone?: string;
  lat: number;
  lng: number;
  exactGps?: boolean;
  debt?: string | number;
  visitedToday: boolean;
  visitedAt?: string | null;
  isNext?: boolean;
  distanceM?: number | null;
  agentName?: string;
};

export type AgentMarker = {
  id: string;
  fullName: string;
  lat: number | null;
  lng: number | null;
  visitedToday?: number;
  debtorsCount?: number;
};

let leafletPromise: Promise<any> | null = null;

function ensureLeaflet(): Promise<any> {
  const w = window as unknown as { L?: any };
  if (w.L) return Promise.resolve(w.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    if (!document.getElementById('leaflet-css')) {
      const link = document.createElement('link');
      link.id = 'leaflet-css';
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.async = true;
    script.onload = () => resolve((window as unknown as { L?: any }).L);
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return leafletPromise;
}

/**
 * Fetches real street-following driving geometry from OSRM public router
 * so lines follow actual roads instead of straight air lines.
 */
async function fetchRoadGeometry(points: Array<[number, number]>): Promise<Array<[number, number]>> {
  if (points.length < 2) return points;
  try {
    const coords = points.slice(0, 15).map(([lat, lng]) => `${lng.toFixed(5)},${lat.toFixed(5)}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) return points;
    const data = (await res.json()) as {
      routes?: Array<{ geometry?: { coordinates?: Array<[number, number]> } }>;
    };
    const geom = data.routes?.[0]?.geometry?.coordinates;
    if (geom && geom.length > 1) {
      return geom.map(([lng, lat]) => [lat, lng]);
    }
  } catch {
    /* fallback to direct points if offline */
  }
  return points;
}

export function RouteMap({
  stops,
  agents = [],
  track = [],
  agentPos,
  selectedStopId,
  onSelectStop,
  onSelectAgent,
}: {
  stops: RouteStop[];
  agents?: AgentMarker[];
  track?: Array<{ lat: number; lng: number }>;
  agentPos?: { lat: number; lng: number } | null;
  selectedStopId?: string | null;
  onSelectStop?: (stop: RouteStop) => void;
  onSelectAgent?: (agentId: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const [interactive, setInteractive] = useState(false);

  // Toggle map pan/scroll lock so page scrolling never gets hijacked until user double-clicks
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (interactive) {
      map.dragging?.enable();
      map.scrollWheelZoom?.enable();
      map.touchZoom?.enable();
    } else {
      map.dragging?.disable();
      map.scrollWheelZoom?.disable();
      map.touchZoom?.disable();
    }
  }, [interactive]);

  useEffect(() => {
    let alive = true;
    void ensureLeaflet().then(async (L) => {
      if (!alive || !boxRef.current || !L) return;
      if (!mapRef.current) {
        mapRef.current = L.map(boxRef.current, {
          center: [41.2995, 69.2401],
          zoom: 12,
          zoomControl: true,
          attributionControl: false, // Removes bottom-right "Leaflet | OpenStreetMap" text & flag
          scrollWheelZoom: false,
          dragging: false,
          touchZoom: false,
          doubleClickZoom: false,
        });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
        }).addTo(mapRef.current);
        layerRef.current = L.layerGroup().addTo(mapRef.current);
      }

      const group = layerRef.current;
      group.clearLayers();
      const bounds: Array<[number, number]> = [];

      const validStops = stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));

      // Draw pins first so map is responsive immediately
      for (const s of validStops) {
        bounds.push([s.lat, s.lng]);
        const cls = s.visitedToday ? 'is-done' : s.isNext ? 'is-next' : 'is-wait';
        const label = s.visitedToday ? `${s.step}✓` : String(s.step);
        const icon = L.divIcon({
          className: 'rm-pin-wrap',
          html: `<div class="rm-pin ${cls} ${selectedStopId === s.id ? 'is-sel' : ''}"><span>${label}</span></div><div class="rm-pin-tag">${s.name.slice(0, 18)}</div>`,
          iconSize: [42, 42],
          iconAnchor: [21, 21],
        });
        const marker = L.marker([s.lat, s.lng], { icon }).addTo(group);
        marker.on('click', () => onSelectStop?.(s));
      }

      // Live agent markers
      const liveList = [...agents.filter((a) => a.lat != null && a.lng != null)];
      if (agentPos && Number.isFinite(agentPos.lat) && Number.isFinite(agentPos.lng)) {
        liveList.push({ id: 'me', fullName: 'Men (Agent)', lat: agentPos.lat, lng: agentPos.lng });
      }
      for (const a of liveList) {
        if (a.lat == null || a.lng == null) continue;
        bounds.push([a.lat, a.lng]);
        const icon = L.divIcon({
          className: 'rm-pin-wrap',
          html: `<div class="rm-agent-pin"><span>●</span></div><div class="rm-pin-tag is-agent">${a.fullName}</div>`,
          iconSize: [38, 38],
          iconAnchor: [19, 19],
        });
        const m = L.marker([a.lat, a.lng], { icon }).addTo(group);
        if (a.id !== 'me') m.on('click', () => onSelectAgent?.(a.id));
      }

      const sel = validStops.find((s) => s.id === selectedStopId);
      if (sel) {
        mapRef.current.setView([sel.lat, sel.lng], 15, { animate: true });
      } else if (bounds.length === 1) {
        mapRef.current.setView(bounds[0], 14);
      } else if (bounds.length > 1) {
        mapRef.current.fitBounds(bounds, { padding: [46, 46], maxZoom: 14 });
      }

      // Road-following route lines (1 -> 2 -> 3 -> 4 -> 5 along real streets)
      if (validStops.length > 1) {
        const doneStops = validStops.filter((s) => s.visitedToday).map((s) => [s.lat, s.lng] as [number, number]);
        const pendingStops = validStops.filter((s) => !s.visitedToday).map((s) => [s.lat, s.lng] as [number, number]);
        if (doneStops.length > 0 && pendingStops.length > 0) {
          pendingStops.unshift(doneStops[doneStops.length - 1]);
        }

        if (doneStops.length > 1) {
          const roadDone = await fetchRoadGeometry(doneStops);
          if (!alive) return;
          L.polyline(roadDone, { color: '#059669', weight: 6, opacity: 0.92, lineCap: 'round' }).addTo(group);
        }
        if (pendingStops.length > 1) {
          const roadPending = await fetchRoadGeometry(pendingStops);
          if (!alive) return;
          // Outer glow + inner road line
          L.polyline(roadPending, { color: '#1e40af', weight: 7, opacity: 0.25, lineCap: 'round' }).addTo(group);
          L.polyline(roadPending, { color: '#2563eb', weight: 4.5, opacity: 0.95, lineCap: 'round' }).addTo(group);
        }
      }

      if (track.length > 1) {
        L.polyline(
          track.map((t) => [t.lat, t.lng]),
          { color: '#0ea5e9', weight: 3.5, opacity: 0.75 },
        ).addTo(group);
      }
    });
    return () => {
      alive = false;
    };
  }, [stops, agents, track, agentPos, selectedStopId]);

  const doneCount = stops.filter((s) => s.visitedToday).length;
  const nextStop = stops.find((s) => s.isNext) || stops.find((s) => !s.visitedToday);

  return (
    <div className="rm-card">
      {/* Top 1✓ -> 2 -> 3 -> 4 -> 5 visual chain */}
      <div className="rm-chain-bar">
        <div className="rm-chain-meta">
          <b>Yo‘nalish: {doneCount} / {stops.length} bajarildi</b>
          {nextStop ? (
            <span className="rm-next-hint">
              Navbatdagi nuqta: <b>#{nextStop.step} {nextStop.name}</b>
              {nextStop.distanceM != null ? ` (${nextStop.distanceM >= 1000 ? `${(nextStop.distanceM / 1000).toFixed(1)} km` : `${nextStop.distanceM} m`})` : ''}
            </span>
          ) : stops.length ? (
            <span className="rm-next-hint is-ok">Barcha nuqtalar bajarildi ✓</span>
          ) : null}
        </div>
        <div className="kpi-actions">
          <button
            type="button"
            className={`btn ${interactive ? 'btn-primary' : ''}`}
            onClick={() => setInteractive((v) => !v)}
          >
            {interactive ? <><Unlock size={14} /> Xarita faol (qulflash)</> : <><Lock size={14} /> Xaritani surish</>}
          </button>
          {nextStop ? (
            <a
              className="btn btn-primary"
              href={`https://www.google.com/maps/dir/?api=1&destination=${nextStop.lat},${nextStop.lng}`}
              target="_blank"
              rel="noreferrer"
            >
              <Navigation size={14} /> #{nextStop.step} ga yo‘l <ExternalLink size={13} />
            </a>
          ) : null}
        </div>
      </div>

      {stops.length > 0 ? (
        <div className="rm-steps" role="list">
          {stops.slice(0, 12).map((s, idx) => (
            <div className="rm-step-item" key={s.id} role="listitem">
              <button
                type="button"
                className={`rm-node ${s.visitedToday ? 'is-done' : s.isNext ? 'is-next' : ''}`}
                onClick={() => onSelectStop?.(s)}
                title={s.name}
              >
                <span className="rm-node-num">
                  {s.visitedToday ? <CheckCircle2 size={15} /> : s.step}
                </span>
                <span className="rm-node-name">{s.name}</span>
              </button>
              {idx < Math.min(stops.length, 12) - 1 ? (
                <span className={`rm-connector ${s.visitedToday ? 'is-done' : ''}`} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div
        className="rm-canvas-wrap"
        onDoubleClick={() => setInteractive((v) => !v)}
      >
        <div ref={boxRef} className="rm-canvas" />
        {!interactive ? (
          <button
            type="button"
            className="rm-lock-badge"
            onClick={() => setInteractive(true)}
          >
            <Lock size={13} /> Xaritani surish/yaqinlashtirish uchun 2 marta bosing
          </button>
        ) : null}
      </div>

      <div className="rm-legend">
        <span><i className="rm-dot is-done" /> Borildi (1 ✓)</span>
        <span><i className="rm-dot is-next" /> Navbatdagi nuqta (2)</span>
        <span><i className="rm-dot is-wait" /> Rejadagi nuqtalar (3, 4, 5)</span>
        <span><i className="rm-dot is-agent" /> Agent GPS joylashuvi</span>
        <span className="kpi-muted"><MapPin size={12} /> Avtomobil yo‘llari bo‘yicha eng yaqin marshrut</span>
      </div>
    </div>
  );
}
