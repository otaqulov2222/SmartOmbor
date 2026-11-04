import { CheckCircle2, ExternalLink, MapPin, Navigation } from 'lucide-react';
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
  heading?: number | null;
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

/** Bearing in degrees (0 = North, 90 = East) from point A to point B */
function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

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
  agentName,
  selectedStopId,
  onSelectStop,
  onSelectAgent,
}: {
  stops: RouteStop[];
  agents?: AgentMarker[];
  track?: Array<{ lat: number; lng: number }>;
  agentPos?: { lat: number; lng: number; heading?: number | null } | null;
  agentName?: string;
  selectedStopId?: string | null;
  onSelectStop?: (stop: RouteStop) => void;
  onSelectAgent?: (agentId: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const [active, setActive] = useState(false);

  // Click inside map -> enable interaction; click anywhere outside map -> disable so page scroll works smoothly
  useEffect(() => {
    const onDocDown = (e: MouseEvent | TouchEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      const target = e.target as Node | null;
      if (target && el.contains(target)) {
        setActive(true);
      } else {
        setActive(false);
      }
    };
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('touchstart', onDocDown, true);
    return () => {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('touchstart', onDocDown, true);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (active) {
      map.dragging?.enable();
      map.scrollWheelZoom?.enable();
      map.touchZoom?.enable();
      map.doubleClickZoom?.enable();
    } else {
      map.dragging?.disable();
      map.scrollWheelZoom?.disable();
      map.touchZoom?.disable();
      map.doubleClickZoom?.disable();
    }
  }, [active]);

  useEffect(() => {
    let alive = true;
    void ensureLeaflet().then(async (L) => {
      if (!alive || !boxRef.current || !L) return;
      if (!mapRef.current) {
        mapRef.current = L.map(boxRef.current, {
          center: [41.2995, 69.2401],
          zoom: 12,
          zoomControl: true,
          attributionControl: false,
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
      const nextStop = validStops.find((s) => s.isNext) || validStops.find((s) => !s.visitedToday) || validStops[0];

      // Determine Agent's live position (or start anchor just before stop #1 so agent arrow is always visible)
      const primaryAgent = agents.find((a) => a.lat != null && a.lng != null);
      let navLat =
        agentPos?.lat ??
        primaryAgent?.lat ??
        (nextStop ? Number((nextStop.lat - 0.0065).toFixed(6)) : null);
      let navLng =
        agentPos?.lng ??
        primaryAgent?.lng ??
        (nextStop ? Number((nextStop.lng - 0.0085).toFixed(6)) : null);

      let navHeading = agentPos?.heading ?? primaryAgent?.heading ?? null;
      if ((navHeading == null || !Number.isFinite(navHeading)) && navLat != null && navLng != null && nextStop) {
        if (track.length >= 2) {
          const prev = track[track.length - 2];
          const curr = track[track.length - 1];
          navHeading = bearingDeg(prev.lat, prev.lng, curr.lat, curr.lng);
        } else {
          navHeading = bearingDeg(navLat, navLng, nextStop.lat, nextStop.lng);
        }
      }

      // Draw numbered customer stops: 1, 2, 3, 4, 5
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

      // Draw rotating Navigation Arrow for the Agent
      if (navLat != null && navLng != null) {
        bounds.push([navLat, navLng]);
        const deg = Math.round(navHeading || 0);
        const label = agentName || primaryAgent?.fullName || 'Agent';
        const arrowIcon = L.divIcon({
          className: 'rm-pin-wrap',
          html: `
            <div class="rm-nav-arrow-wrap">
              <div class="rm-nav-pulse"></div>
              <div class="rm-nav-cone" style="transform: rotate(${deg}deg)"></div>
              <div class="rm-nav-arrow" style="transform: rotate(${deg}deg)">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
                  <path d="M12 2L19.5 20.5L12 16.8L4.5 20.5L12 2Z" fill="#ffffff" stroke="#1d4ed8" stroke-width="1.6" stroke-linejoin="round"/>
                </svg>
              </div>
            </div>
            <div class="rm-pin-tag is-agent">${label}</div>
          `,
          iconSize: [48, 48],
          iconAnchor: [24, 24],
        });
        const m = L.marker([navLat, navLng], { icon: arrowIcon, zIndexOffset: 900 }).addTo(group);
        if (primaryAgent) m.on('click', () => onSelectAgent?.(primaryAgent.id));
      }

      const sel = validStops.find((s) => s.id === selectedStopId);
      if (sel) {
        mapRef.current.setView([sel.lat, sel.lng], 15, { animate: true });
      } else if (bounds.length === 1) {
        mapRef.current.setView(bounds[0], 14);
      } else if (bounds.length > 1) {
        mapRef.current.fitBounds(bounds, { padding: [46, 46], maxZoom: 14 });
      }

      // Road-following route: Agent Arrow -> 1 -> 2 -> 3 -> 4 -> 5
      if (validStops.length > 0) {
        const doneStops = validStops.filter((s) => s.visitedToday).map((s) => [s.lat, s.lng] as [number, number]);
        const pendingStops = validStops.filter((s) => !s.visitedToday).map((s) => [s.lat, s.lng] as [number, number]);

        if (navLat != null && navLng != null && pendingStops.length > 0) {
          pendingStops.unshift([navLat, navLng]);
        } else if (doneStops.length > 0 && pendingStops.length > 0) {
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
          L.polyline(roadPending, { color: '#1e40af', weight: 8, opacity: 0.22, lineCap: 'round' }).addTo(group);
          L.polyline(roadPending, { color: '#2563eb', weight: 5, opacity: 0.96, lineCap: 'round' }).addTo(group);
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
  }, [stops, agents, track, agentPos, agentName, selectedStopId]);

  const doneCount = stops.filter((s) => s.visitedToday).length;
  const nextStop = stops.find((s) => s.isNext) || stops.find((s) => !s.visitedToday);

  return (
    <div className="rm-card">
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

      <div ref={wrapRef} className={`rm-canvas-wrap ${active ? 'is-active' : ''}`}>
        <div ref={boxRef} className="rm-canvas" />
      </div>

      <div className="rm-legend">
        <span><i className="rm-dot is-agent" /> Agent (➤)</span>
        <span><i className="rm-dot is-done" /> Borildi (✓)</span>
        <span><i className="rm-dot is-next" /> Navbatdagi</span>
        <span><i className="rm-dot is-wait" /> Rejada</span>
      </div>
    </div>
  );
}
