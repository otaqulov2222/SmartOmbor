import { CheckCircle2, ExternalLink, Hand, Navigation } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

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

function fmtDistance(m: number | null | undefined) {
  if (m == null || !Number.isFinite(m)) return '';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

async function fetchRoadRoute(points: Array<[number, number]>): Promise<{
  path: Array<[number, number]>;
  distanceM: number | null;
  durationSec: number | null;
}> {
  if (points.length < 2) return { path: points, distanceM: null, durationSec: null };
  try {
    const coords = points.slice(0, 12).map(([lat, lng]) => `${lng.toFixed(5)},${lat.toFixed(5)}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) return { path: points, distanceM: null, durationSec: null };
    const data = (await res.json()) as {
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: Array<[number, number]> };
      }>;
    };
    const route = data.routes?.[0];
    const geom = route?.geometry?.coordinates;
    if (geom && geom.length > 1) {
      return {
        path: geom.map(([lng, lat]) => [lat, lng]),
        distanceM: route?.distance != null ? Math.round(route.distance) : null,
        durationSec: route?.duration != null ? Math.round(route.duration) : null,
      };
    }
  } catch {
    /* offline fallback */
  }
  return { path: points, distanceM: null, durationSec: null };
}

function fmtEta(sec: number | null) {
  if (sec == null || !Number.isFinite(sec)) return '';
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `~${m} daq`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `~${h} soat ${rest} daq` : `~${h} soat`;
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
  const [roadHint, setRoadHint] = useState<{ distanceM: number | null; durationSec: number | null }>({
    distanceM: null,
    durationSec: null,
  });

  const doneCount = stops.filter((s) => s.visitedToday).length;
  const nextStop = useMemo(
    () => stops.find((s) => s.isNext) || stops.find((s) => !s.visitedToday) || null,
    [stops],
  );
  const progressPct = stops.length ? Math.round((doneCount / stops.length) * 100) : 0;
  const hasLiveGps = Boolean(agentPos?.lat != null && agentPos?.lng != null);

  useEffect(() => {
    const onDocDown = (e: MouseEvent | TouchEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      const target = e.target as Node | null;
      if (target && el.contains(target)) setActive(true);
      else setActive(false);
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
        setTimeout(() => mapRef.current?.invalidateSize?.(), 80);
      }

      const group = layerRef.current;
      group.clearLayers();
      const focusBounds: Array<[number, number]> = [];
      const allBounds: Array<[number, number]> = [];

      const validStops = stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
      const next = validStops.find((s) => s.isNext) || validStops.find((s) => !s.visitedToday) || validStops[0] || null;

      const primaryAgent = agents.find((a) => a.lat != null && a.lng != null);
      const navLat = agentPos?.lat ?? primaryAgent?.lat ?? null;
      const navLng = agentPos?.lng ?? primaryAgent?.lng ?? null;

      let navHeading = agentPos?.heading ?? primaryAgent?.heading ?? null;
      if ((navHeading == null || !Number.isFinite(navHeading)) && navLat != null && navLng != null && next) {
        if (track.length >= 2) {
          const prev = track[track.length - 2];
          const curr = track[track.length - 1];
          navHeading = bearingDeg(prev.lat, prev.lng, curr.lat, curr.lng);
        } else {
          navHeading = bearingDeg(navLat, navLng, next.lat, next.lng);
        }
      }

      for (const s of validStops) {
        allBounds.push([s.lat, s.lng]);
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

      if (navLat != null && navLng != null) {
        allBounds.push([navLat, navLng]);
        focusBounds.push([navLat, navLng]);
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
      if (sel) focusBounds.push([sel.lat, sel.lng]);
      else if (next) focusBounds.push([next.lat, next.lng]);

      // Primary road route: agent → next stop only (clear day plan)
      if (navLat != null && navLng != null && next && !next.visitedToday) {
        const road = await fetchRoadRoute([
          [navLat, navLng],
          [next.lat, next.lng],
        ]);
        if (!alive) return;
        setRoadHint({ distanceM: road.distanceM ?? next.distanceM ?? null, durationSec: road.durationSec });
        L.polyline(road.path, { color: '#1e40af', weight: 8, opacity: 0.2, lineCap: 'round' }).addTo(group);
        L.polyline(road.path, { color: '#2563eb', weight: 5, opacity: 0.95, lineCap: 'round' }).addTo(group);
      } else {
        setRoadHint({ distanceM: next?.distanceM ?? null, durationSec: null });
      }

      // Remaining plan as thin dashed polyline (stop order, no fake GPS)
      const pending = validStops.filter((s) => !s.visitedToday);
      if (pending.length > 1) {
        const planPts = pending.map((s) => [s.lat, s.lng] as [number, number]);
        L.polyline(planPts, {
          color: '#f59e0b',
          weight: 3,
          opacity: 0.7,
          dashArray: '8 8',
          lineCap: 'round',
        }).addTo(group);
      }

      const doneStops = validStops.filter((s) => s.visitedToday);
      if (doneStops.length > 1) {
        const roadDone = await fetchRoadRoute(doneStops.map((s) => [s.lat, s.lng] as [number, number]));
        if (!alive) return;
        L.polyline(roadDone.path, { color: '#059669', weight: 5, opacity: 0.85, lineCap: 'round' }).addTo(group);
      }

      if (track.length > 1) {
        L.polyline(
          track.map((t) => [t.lat, t.lng]),
          { color: '#0ea5e9', weight: 3, opacity: 0.65, dashArray: '4 6' },
        ).addTo(group);
      }

      const viewBounds = focusBounds.length >= 1 ? focusBounds : allBounds;
      if (sel && focusBounds.length === 1) {
        mapRef.current.setView([sel.lat, sel.lng], 15, { animate: true });
      } else if (viewBounds.length === 1) {
        mapRef.current.setView(viewBounds[0], 14);
      } else if (viewBounds.length > 1) {
        mapRef.current.fitBounds(viewBounds, { padding: [48, 48], maxZoom: 15 });
      }
      setTimeout(() => mapRef.current?.invalidateSize?.(), 40);
    });
    return () => {
      alive = false;
    };
  }, [stops, agents, track, agentPos, agentName, selectedStopId]);

  return (
    <div className="rm-card">
      <div className="rm-chain-bar">
        <div className="rm-chain-meta">
          <div className="rm-progress-block">
            <b>Yo‘nalish: {doneCount} / {stops.length} bajarildi</b>
            <div className="rm-progress"><i style={{ width: `${progressPct}%` }} /></div>
          </div>
          {nextStop ? (
            <span className="rm-next-hint">
              Navbatdagi: <b>#{nextStop.step} {nextStop.name}</b>
              {roadHint.distanceM != null ? ` · ${fmtDistance(roadHint.distanceM)}` : nextStop.distanceM != null ? ` · ${fmtDistance(nextStop.distanceM)}` : ''}
              {roadHint.durationSec != null ? ` · ${fmtEta(roadHint.durationSec)}` : ''}
            </span>
          ) : stops.length ? (
            <span className="rm-next-hint is-ok">Barcha nuqtalar bajarildi ✓</span>
          ) : null}
        </div>
        {nextStop ? (
          <a
            className="btn btn-primary"
            href={`https://www.google.com/maps/dir/?api=1&destination=${nextStop.lat},${nextStop.lng}${
              hasLiveGps ? `&origin=${agentPos!.lat},${agentPos!.lng}` : ''
            }`}
            target="_blank"
            rel="noreferrer"
          >
            <Navigation size={14} /> #{nextStop.step} ga yo‘l <ExternalLink size={13} />
          </a>
        ) : null}
      </div>

      {stops.length > 0 ? (
        <div className="rm-steps" role="list">
          {stops.slice(0, 16).map((s, idx) => (
            <div className="rm-step-item" key={s.id} role="listitem">
              <button
                type="button"
                className={`rm-node ${s.visitedToday ? 'is-done' : s.isNext ? 'is-next' : ''} ${selectedStopId === s.id ? 'is-sel' : ''}`}
                onClick={() => onSelectStop?.(s)}
                title={s.name}
              >
                <span className="rm-node-num">
                  {s.visitedToday ? <CheckCircle2 size={15} /> : s.step}
                </span>
                <span className="rm-node-name">{s.name}</span>
              </button>
              {idx < Math.min(stops.length, 16) - 1 ? (
                <span className={`rm-connector ${s.visitedToday ? 'is-done' : ''}`} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div ref={wrapRef} className={`rm-canvas-wrap ${active ? 'is-active' : ''}`}>
        <div ref={boxRef} className="rm-canvas" />
        {!active ? (
          <div className="rm-map-hint" aria-hidden="true">
            <Hand size={14} /> Xaritani boshqarish uchun bosing
          </div>
        ) : null}
        {!hasLiveGps ? (
          <div className="rm-gps-banner">GPS yo‘q — masofa oxirgi joylashuv / taxminiy</div>
        ) : null}
      </div>

      <div className="rm-legend">
        <span><i className="rm-dot is-agent" /> Agent</span>
        <span><i className="rm-dot is-done" /> Borildi</span>
        <span><i className="rm-dot is-next" /> Navbatdagi</span>
        <span><i className="rm-dot is-wait" /> Rejada</span>
      </div>
    </div>
  );
}
