import { CheckCircle2, Crosshair, ExternalLink, Navigation } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { kpiFetch, readAgentToken } from './api';

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

type LatLng = { lat: number; lng: number; heading?: number | null };

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

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = (n: number) => (n * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function fmtDistance(m: number | null | undefined) {
  if (m == null || !Number.isFinite(m)) return '';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function fmtEta(sec: number | null) {
  if (sec == null || !Number.isFinite(sec)) return '';
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `~${m} daq`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `~${h} soat ${rest} daq` : `~${h} soat`;
}

async function fetchRoadRoute(points: Array<[number, number]>): Promise<{
  path: Array<[number, number]>;
  distanceM: number | null;
  durationSec: number | null;
  ok: boolean;
}> {
  if (points.length < 2) return { path: points, distanceM: null, durationSec: null, ok: false };
  const [[fromLat, fromLng], [toLat, toLng]] = points;
  const straight = {
    path: points,
    distanceM: Math.round(haversineM({ lat: fromLat, lng: fromLng }, { lat: toLat, lng: toLng })),
    durationSec: null as number | null,
    ok: false,
  };
  try {
    const mode = readAgentToken() ? 'agent' : 'admin';
    const q = new URLSearchParams({
      fromLat: String(fromLat),
      fromLng: String(fromLng),
      toLat: String(toLat),
      toLng: String(toLng),
    });
    const data = await kpiFetch<{
      ok?: boolean;
      path?: Array<[number, number]>;
      distanceM?: number | null;
      durationSec?: number | null;
    }>(`/kpi/route?${q.toString()}`, {}, mode);
    if (data.ok && data.path && data.path.length > 1) {
      return {
        path: data.path,
        distanceM: data.distanceM ?? straight.distanceM,
        durationSec: data.durationSec ?? null,
        ok: true,
      };
    }
  } catch {
    /* fall through to direct OSRM, then straight line */
  }
  try {
    const coords = `${fromLng.toFixed(6)},${fromLat.toFixed(6)};${toLng.toFixed(6)},${toLat.toFixed(6)}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false&alternatives=false`;
    const res = await fetch(url);
    if (!res.ok) return straight;
    const data = (await res.json()) as {
      code?: string;
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: Array<[number, number]> };
      }>;
    };
    const route = data.routes?.[0];
    const geom = route?.geometry?.coordinates;
    if (data.code === 'Ok' && geom && geom.length > 1) {
      return {
        path: geom.map(([lng, lat]) => [lat, lng]),
        distanceM: route?.distance != null ? Math.round(route.distance) : straight.distanceM,
        durationSec: route?.duration != null ? Math.round(route.duration) : null,
        ok: true,
      };
    }
  } catch {
    /* offline */
  }
  return straight;
}

function agentIconHtml(label: string, deg: number) {
  return `
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
  `;
}

export function RouteMap({
  stops,
  agents = [],
  track = [],
  agentPos,
  agentName,
  selectedStopId,
  follow = true,
  onSelectStop,
  onSelectAgent,
}: {
  stops: RouteStop[];
  agents?: AgentMarker[];
  track?: Array<{ lat: number; lng: number }>;
  agentPos?: LatLng | null;
  agentName?: string;
  selectedStopId?: string | null;
  follow?: boolean;
  onSelectStop?: (stop: RouteStop) => void;
  onSelectAgent?: (agentId: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const LRef = useRef<any>(null);
  const stopsLayerRef = useRef<any>(null);
  const routeLayerRef = useRef<any>(null);
  const trackLayerRef = useRef<any>(null);
  const agentMarkerRef = useRef<any>(null);
  const routeOriginRef = useRef<{ lat: number; lng: number; destId: string } | null>(null);
  const followRef = useRef(follow);
  const userPanRef = useRef(false);
  const onSelectStopRef = useRef(onSelectStop);
  const onSelectAgentRef = useRef(onSelectAgent);

  const [mapReady, setMapReady] = useState(false);
  const [active, setActive] = useState(false);
  const [followOn, setFollowOn] = useState(follow);
  const [roadHint, setRoadHint] = useState<{ distanceM: number | null; durationSec: number | null; roadOk: boolean }>({
    distanceM: null,
    durationSec: null,
    roadOk: false,
  });
  const [compassHeading, setCompassHeading] = useState<number | null>(null);

  onSelectStopRef.current = onSelectStop;
  onSelectAgentRef.current = onSelectAgent;
  followRef.current = followOn;

  // Keep follow in sync when parent toggles (admin agent select)
  useEffect(() => {
    if (follow) {
      userPanRef.current = false;
      setFollowOn(true);
    }
  }, [follow]);

  const doneCount = stops.filter((s) => s.visitedToday).length;
  const nextStop = useMemo(
    () => stops.find((s) => s.isNext) || stops.find((s) => !s.visitedToday) || null,
    [stops],
  );
  const progressPct = stops.length ? Math.round((doneCount / stops.length) * 100) : 0;
  const approxNext = Boolean(nextStop && nextStop.exactGps === false);

  const primaryAgent = agents.find((a) => a.lat != null && a.lng != null);
  const livePos: LatLng | null = useMemo(() => {
    if (agentPos?.lat != null && agentPos?.lng != null) {
      return { lat: agentPos.lat, lng: agentPos.lng, heading: agentPos.heading };
    }
    if (primaryAgent?.lat != null && primaryAgent?.lng != null) {
      return { lat: primaryAgent.lat, lng: primaryAgent.lng, heading: primaryAgent.heading };
    }
    return null;
  }, [agentPos?.lat, agentPos?.lng, agentPos?.heading, primaryAgent?.lat, primaryAgent?.lng, primaryAgent?.heading]);

  const hasLiveGps = Boolean(livePos);

  useEffect(() => {
    const onOrient = (e: DeviceOrientationEvent) => {
      const webkit = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
      let h: number | null = null;
      if (typeof webkit === 'number' && Number.isFinite(webkit)) h = webkit;
      else if (e.absolute && e.alpha != null && Number.isFinite(e.alpha)) h = (360 - e.alpha) % 360;
      if (h != null) setCompassHeading(h);
    };
    window.addEventListener('deviceorientation', onOrient, true);
    return () => window.removeEventListener('deviceorientation', onOrient, true);
  }, []);

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
  }, [active, mapReady]);

  // Init once + cleanup
  useEffect(() => {
    let alive = true;
    void ensureLeaflet().then((L) => {
      if (!alive || !boxRef.current || !L || mapRef.current) return;
      LRef.current = L;
      const map = L.map(boxRef.current, {
        center: [41.2995, 69.2401],
        zoom: 13,
        zoomControl: true,
        attributionControl: false,
        scrollWheelZoom: false,
        dragging: false,
        touchZoom: false,
        doubleClickZoom: false,
      });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
      stopsLayerRef.current = L.layerGroup().addTo(map);
      routeLayerRef.current = L.layerGroup().addTo(map);
      trackLayerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      map.on('dragstart', () => {
        userPanRef.current = true;
        setFollowOn(false);
      });
      setMapReady(true);
      setTimeout(() => map.invalidateSize?.(), 80);
    });
    return () => {
      alive = false;
      try {
        mapRef.current?.remove?.();
      } catch {
        /* ignore */
      }
      mapRef.current = null;
      agentMarkerRef.current = null;
      stopsLayerRef.current = null;
      routeLayerRef.current = null;
      trackLayerRef.current = null;
      setMapReady(false);
    };
  }, []);

  // Stops layer
  useEffect(() => {
    if (!mapReady) return;
    const L = LRef.current;
    const layer = stopsLayerRef.current;
    if (!L || !layer) return;
    layer.clearLayers();
    for (const s of stops) {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
      const cls = s.visitedToday ? 'is-done' : s.isNext ? 'is-next' : 'is-wait';
      const label = s.visitedToday ? `${s.step}✓` : String(s.step);
      const approx = s.exactGps === false ? ' <em class="rm-approx">~</em>' : '';
      const icon = L.divIcon({
        className: 'rm-pin-wrap',
        html: `<div class="rm-pin ${cls} ${selectedStopId === s.id ? 'is-sel' : ''}"><span>${label}</span></div><div class="rm-pin-tag">${s.name.slice(0, 18)}${approx}</div>`,
        iconSize: [42, 42],
        iconAnchor: [21, 21],
      });
      const marker = L.marker([s.lat, s.lng], { icon }).addTo(layer);
      marker.on('click', () => onSelectStopRef.current?.(s));
    }
  }, [mapReady, stops, selectedStopId]);

  // Track
  useEffect(() => {
    if (!mapReady) return;
    const L = LRef.current;
    const layer = trackLayerRef.current;
    if (!L || !layer) return;
    layer.clearLayers();
    if (track.length > 1) {
      L.polyline(
        track.map((t) => [t.lat, t.lng]),
        { color: '#38bdf8', weight: 3, opacity: 0.55, lineCap: 'round' },
      ).addTo(layer);
    }
  }, [mapReady, track]);

  // Live agent marker + follow
  useEffect(() => {
    if (!mapReady) return;
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map) return;

    if (!livePos) {
      if (agentMarkerRef.current) {
        map.removeLayer(agentMarkerRef.current);
        agentMarkerRef.current = null;
      }
      return;
    }

    const dest = nextStop && !nextStop.visitedToday ? nextStop : null;
    let heading = livePos.heading ?? compassHeading ?? null;
    if ((heading == null || !Number.isFinite(heading)) && dest) {
      heading = bearingDeg(livePos.lat, livePos.lng, dest.lat, dest.lng);
    }
    const deg = Math.round(heading || 0);
    const label = agentName || primaryAgent?.fullName || 'Agent';
    const icon = L.divIcon({
      className: 'rm-pin-wrap',
      html: agentIconHtml(label, deg),
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    });

    if (!agentMarkerRef.current) {
      agentMarkerRef.current = L.marker([livePos.lat, livePos.lng], {
        icon,
        zIndexOffset: 1200,
      }).addTo(map);
      agentMarkerRef.current.on('click', () => {
        if (primaryAgent) onSelectAgentRef.current?.(primaryAgent.id);
      });
    } else {
      agentMarkerRef.current.setLatLng([livePos.lat, livePos.lng]);
      agentMarkerRef.current.setIcon(icon);
    }

    if (followRef.current && !userPanRef.current) {
      const z = Math.max(map.getZoom?.() || 14, 15);
      map.panTo([livePos.lat, livePos.lng], { animate: true });
      if ((map.getZoom?.() || 0) < 15) map.setZoom(z, { animate: true });
    }
  }, [mapReady, livePos, nextStop, compassHeading, agentName, primaryAgent]);

  // Road route agent → next
  useEffect(() => {
    if (!mapReady) return;
    let alive = true;
    const L = LRef.current;
    const layer = routeLayerRef.current;
    if (!L || !layer) return;

    const run = async () => {
      if (!livePos || !nextStop || nextStop.visitedToday) {
        layer.clearLayers();
        setRoadHint({ distanceM: nextStop?.distanceM ?? null, durationSec: null, roadOk: false });
        routeOriginRef.current = null;
        return;
      }

      const prev = routeOriginRef.current;
      const movedFar =
        !prev ||
        prev.destId !== nextStop.id ||
        haversineM(prev, livePos) > 90;

      if (!movedFar && prev) {
        setRoadHint((h) => ({
          distanceM: Math.round(haversineM(livePos, nextStop)),
          durationSec: h.durationSec,
          roadOk: h.roadOk,
        }));
        return;
      }

      const road = await fetchRoadRoute([
        [livePos.lat, livePos.lng],
        [nextStop.lat, nextStop.lng],
      ]);
      if (!alive) return;
      routeOriginRef.current = { lat: livePos.lat, lng: livePos.lng, destId: nextStop.id };
      setRoadHint({
        distanceM: road.distanceM ?? Math.round(haversineM(livePos, nextStop)),
        durationSec: road.durationSec,
        roadOk: road.ok,
      });
      layer.clearLayers();
      const style = road.ok
        ? { color: '#2563eb', weight: 5, opacity: 0.95 }
        : { color: '#64748b', weight: 4, opacity: 0.75, dashArray: '6 8' };
      L.polyline(road.path, { color: '#1e3a8a', weight: 10, opacity: 0.16, lineCap: 'round', lineJoin: 'round' }).addTo(layer);
      L.polyline(road.path, { ...style, lineCap: 'round', lineJoin: 'round' }).addTo(layer);
    };

    void run();
    return () => {
      alive = false;
    };
  }, [mapReady, livePos?.lat, livePos?.lng, nextStop?.id, nextStop?.lat, nextStop?.lng, nextStop?.visitedToday, nextStop?.distanceM]);

  // Initial fit when not following
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map || followOn) return;
    const bounds: Array<[number, number]> = [];
    if (livePos) bounds.push([livePos.lat, livePos.lng]);
    if (nextStop) bounds.push([nextStop.lat, nextStop.lng]);
    else {
      for (const s of stops) {
        if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) bounds.push([s.lat, s.lng]);
      }
    }
    if (bounds.length === 1) map.setView(bounds[0], 14);
    else if (bounds.length > 1) map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
  }, [mapReady, stops.length, nextStop?.id, followOn]); // eslint-disable-line react-hooks/exhaustive-deps

  const recenter = () => {
    userPanRef.current = false;
    setFollowOn(true);
    const map = mapRef.current;
    if (map && livePos) {
      map.setView([livePos.lat, livePos.lng], Math.max(map.getZoom?.() || 15, 15), { animate: true });
    }
  };

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
              {roadHint.distanceM != null ? ` · ${fmtDistance(roadHint.distanceM)}` : ''}
              {roadHint.durationSec != null ? ` · ${fmtEta(roadHint.durationSec)}` : ''}
              {approxNext ? ' · taxminiy joy' : ''}
              {!roadHint.roadOk && hasLiveGps ? ' · to‘g‘ri chiziq (OSRM yo‘q)' : ''}
            </span>
          ) : stops.length ? (
            <span className="rm-next-hint is-ok">Barcha nuqtalar bajarildi ✓</span>
          ) : null}
        </div>
        <div className="rm-chain-actions">
          <button type="button" className={`btn ${followOn ? 'btn-primary' : ''}`} onClick={recenter} disabled={!hasLiveGps}>
            <Crosshair size={14} /> {followOn ? 'Kuzatuv yoqilgan' : 'Menga qarat'}
          </button>
          {nextStop ? (
            <a
              className="btn btn-primary"
              href={`https://www.google.com/maps/dir/?api=1&destination=${nextStop.lat},${nextStop.lng}${
                livePos ? `&origin=${livePos.lat},${livePos.lng}&travelmode=driving` : ''
              }`}
              target="_blank"
              rel="noreferrer"
            >
              <Navigation size={14} /> Navigator <ExternalLink size={13} />
            </a>
          ) : null}
        </div>
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

      <div ref={wrapRef} className={`rm-canvas-wrap ${active ? 'is-active' : ''} ${followOn ? 'is-follow' : ''}`}>
        <div ref={boxRef} className="rm-canvas" />
        {!hasLiveGps ? (
          <div className="rm-gps-banner">GPS yo‘q — joylashuv kutilmoqda. Telefon GPS ni yoqing.</div>
        ) : null}
        {approxNext ? (
          <div className="rm-gps-banner is-warn">Navbatdagi nuqta taxminiy joyda — aniq GPS saqlang (Bordim yoki admin).</div>
        ) : null}
        {followOn && hasLiveGps ? (
          <div className="rm-follow-badge"><Navigation size={12} /> Jonli kuzatuv</div>
        ) : null}
      </div>

      <div className="rm-legend">
        <span><i className="rm-dot is-agent" /> Agent (jonli)</span>
        <span><i className="rm-dot is-done" /> Borildi</span>
        <span><i className="rm-dot is-next" /> Navbatdagi</span>
        <span><i className="rm-dot is-wait" /> Rejada</span>
      </div>
    </div>
  );
}
