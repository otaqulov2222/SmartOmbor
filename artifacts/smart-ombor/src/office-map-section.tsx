import { useEffect, useRef, useState } from 'react';
import { LocateFixed, Navigation, Radar } from 'lucide-react';
import { useI18n } from '@/i18n';

type LeafletMap = {
  remove: () => void;
  setView: (center: [number, number], zoom?: number, opts?: { animate?: boolean }) => void;
  fitBounds: (bounds: unknown, opts?: { padding?: [number, number]; maxZoom?: number; animate?: boolean }) => void;
  invalidateSize: () => void;
  on: (event: string, fn: () => void) => void;
  off: (event: string, fn: () => void) => void;
};
type LeafletLayer = { remove: () => void; setLatLng?: (ll: [number, number]) => void; setStyle?: (s: object) => void; setRadius?: (r: number) => void; setIcon?: (icon: unknown) => void; setLatLngs?: (pts: Array<[number, number]>) => void };
type LeafletNS = {
  map: (el: HTMLElement, opts?: object) => LeafletMap & { addLayer: (l: unknown) => void };
  tileLayer: (url: string, opts?: object) => { addTo: (m: LeafletMap) => unknown };
  circle: (ll: [number, number], opts?: object) => LeafletLayer & { addTo: (m: LeafletMap) => LeafletLayer };
  marker: (ll: [number, number], opts?: object) => LeafletLayer & { addTo: (m: LeafletMap) => LeafletLayer };
  polyline: (pts: Array<[number, number]>, opts?: object) => LeafletLayer & { addTo: (m: LeafletMap) => LeafletLayer };
  divIcon: (opts: object) => unknown;
  latLngBounds: (pts: Array<[number, number]>) => unknown;
  control: { zoom: (opts?: object) => { addTo: (m: LeafletMap) => unknown } };
};

let leafletPromise: Promise<LeafletNS> | null = null;

function ensureLeaflet(): Promise<LeafletNS> {
  const w = window as unknown as { L?: LeafletNS };
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
    script.onload = () => {
      const L = (window as unknown as { L?: LeafletNS }).L;
      if (!L) reject(new Error('Leaflet missing'));
      else resolve(L);
    };
    script.onerror = () => reject(new Error('Leaflet load failed'));
    document.head.appendChild(script);
  });
  return leafletPromise;
}

function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = (n: number) => n * Math.PI / 180;
  const y = Math.sin(r(lng2 - lng1)) * Math.cos(r(lat2));
  const x = Math.cos(r(lat1)) * Math.sin(r(lat2)) - Math.sin(r(lat1)) * Math.cos(r(lat2)) * Math.cos(r(lng2 - lng1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function normDeg(value: number) {
  return ((value % 360) + 360) % 360;
}

function meIconHtml(deg: number, here: boolean) {
  const tone = here ? 'is-here' : '';
  return `<div class="office-leaflet-me ${tone}">
    <i class="office-leaflet-pulse"></i>
    <i class="office-leaflet-cone" style="transform:rotate(${deg}deg)"></i>
    <span class="office-leaflet-arrow" style="transform:rotate(${deg}deg)">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M12 2L19.5 20.5L12 16.8L4.5 20.5L12 2Z" fill="#fff" stroke="${here ? '#047857' : '#1d4ed8'}" stroke-width="1.6" stroke-linejoin="round"/></svg>
    </span>
  </div>`;
}

export function OfficeMap({
  officeLat, officeLng, radiusM, here, user, status, gpsBlocked, meters,
  onNudge, onEnableGps,
}: {
  officeLat: number; officeLng: number; radiusM: number;
  here: boolean; user: { lat: number; lng: number; heading?: number | null } | null; status: string;
  gpsBlocked: boolean; meters: number | null;
  onNudge: () => void; onEnableGps: () => void;
}) {
  const { t } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const LRef = useRef<LeafletNS | null>(null);
  const officeCircleRef = useRef<LeafletLayer | null>(null);
  const officeDotRef = useRef<LeafletLayer | null>(null);
  const meMarkerRef = useRef<LeafletLayer | null>(null);
  const routeRef = useRef<LeafletLayer | null>(null);
  const routeGlowRef = useRef<LeafletLayer | null>(null);
  const followMe = useRef(false);
  const fittedOnce = useRef(false);
  const [heading, setHeading] = useState<number | null>(null);
  const [etaMin, setEtaMin] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const orientReady = useRef(false);

  const ensureOrientation = async () => {
    if (orientReady.current) return;
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<PermissionState> };
    try {
      if (typeof DOE.requestPermission === 'function') {
        const state = await DOE.requestPermission();
        if (state !== 'granted') return;
      }
    } catch { /* ignore */ }
    orientReady.current = true;
  };

  useEffect(() => {
    if (user?.heading != null && Number.isFinite(user.heading) && user.heading >= 0) {
      setHeading(normDeg(user.heading));
    }
  }, [user?.heading]);

  useEffect(() => {
    const apply = (event: DeviceOrientationEvent) => {
      const ios = event as DeviceOrientationEvent & { webkitCompassHeading?: number };
      if (typeof ios.webkitCompassHeading === 'number' && Number.isFinite(ios.webkitCompassHeading)) {
        setHeading(normDeg(ios.webkitCompassHeading));
        return;
      }
      if (event.alpha == null || !Number.isFinite(event.alpha)) return;
      setHeading(normDeg(360 - event.alpha));
    };
    void ensureOrientation().then(() => {
      window.addEventListener('deviceorientationabsolute', apply as EventListener, true);
      window.addEventListener('deviceorientation', apply as EventListener, true);
    });
    return () => {
      window.removeEventListener('deviceorientationabsolute', apply as EventListener, true);
      window.removeEventListener('deviceorientation', apply as EventListener, true);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void ensureLeaflet().then((L) => {
      if (!alive || !boxRef.current || mapRef.current) return;
      LRef.current = L;
      const map = L.map(boxRef.current, {
        center: [officeLat, officeLng],
        zoom: 15,
        zoomControl: false,
        attributionControl: false,
        doubleClickZoom: true,
        scrollWheelZoom: true,
        dragging: true,
        touchZoom: true,
        boxZoom: true,
        keyboard: true,
      });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        className: 'office-leaflet-tiles',
      }).addTo(map);
      L.control.zoom({ position: 'topright' }).addTo(map);
      mapRef.current = map;
      const stopFollow = () => { followMe.current = false; };
      map.on('dragstart', stopFollow);
      map.on('zoomstart', stopFollow);
      setReady(true);
      window.setTimeout(() => map.invalidateSize(), 80);
    });
    return () => {
      alive = false;
      mapRef.current?.remove();
      mapRef.current = null;
      officeCircleRef.current = null;
      officeDotRef.current = null;
      meMarkerRef.current = null;
      routeRef.current = null;
      routeGlowRef.current = null;
      fittedOnce.current = false;
      setReady(false);
    };
  }, [officeLat, officeLng]);

  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map || !ready) return;

    if (!officeCircleRef.current) {
      officeCircleRef.current = L.circle([officeLat, officeLng], {
        radius: radiusM,
        color: '#34d399',
        weight: 2,
        dashArray: '6 6',
        fillColor: '#10b981',
        fillOpacity: 0.12,
      }).addTo(map);
      officeDotRef.current = L.marker([officeLat, officeLng], {
        interactive: false,
        icon: L.divIcon({
          className: 'office-leaflet-pin-wrap',
          html: '<span class="office-leaflet-pin"></span>',
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
      }).addTo(map);
    } else {
      officeCircleRef.current.setLatLng?.([officeLat, officeLng]);
      officeCircleRef.current.setRadius?.(radiusM);
      officeDotRef.current?.setLatLng?.([officeLat, officeLng]);
    }
  }, [officeLat, officeLng, radiusM, ready]);

  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map || !ready) return;

    if (!user) {
      meMarkerRef.current?.remove();
      meMarkerRef.current = null;
      return;
    }

    const face = Math.round(heading ?? bearingDeg(user.lat, user.lng, officeLat, officeLng));
    const icon = L.divIcon({
      className: 'office-leaflet-me-wrap',
      html: meIconHtml(face, here),
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    });

    if (!meMarkerRef.current) {
      meMarkerRef.current = L.marker([user.lat, user.lng], { icon, zIndexOffset: 900 }).addTo(map);
    } else {
      meMarkerRef.current.setLatLng?.([user.lat, user.lng]);
      meMarkerRef.current.setIcon?.(icon);
    }

    if (followMe.current) {
      map.setView([user.lat, user.lng], Math.max(16, 16), { animate: true });
    } else if (!fittedOnce.current) {
      fittedOnce.current = true;
      const bounds = L.latLngBounds([[officeLat, officeLng], [user.lat, user.lng]]);
      map.fitBounds(bounds, { padding: [48, 48], maxZoom: 16, animate: true });
    }
  }, [user?.lat, user?.lng, heading, here, officeLat, officeLng, ready]);

  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map || !ready) return;
    if (!user || gpsBlocked) {
      routeRef.current?.remove();
      routeGlowRef.current?.remove();
      routeRef.current = null;
      routeGlowRef.current = null;
      setEtaMin(null);
      return;
    }

    const ctrl = new AbortController();
    const url = `https://router.project-osrm.org/route/v1/foot/${user.lng},${user.lat};${officeLng},${officeLat}?overview=full&geometries=geojson&steps=false`;
    const timer = window.setTimeout(() => {
      void fetch(url, { signal: ctrl.signal })
        .then(res => res.ok ? res.json() : null)
        .then((data: { routes?: Array<{ duration: number; geometry?: { coordinates: number[][] } }> } | null) => {
          const leg = data?.routes?.[0];
          const coords = leg?.geometry?.coordinates;
          let points: Array<[number, number]> = [[user.lat, user.lng], [officeLat, officeLng]];
          if (leg && coords?.length) {
            points = coords.map(([lng, lat]) => [lat, lng] as [number, number]);
            setEtaMin(Math.max(1, Math.round(leg.duration / 60)));
          } else {
            setEtaMin(meters != null ? Math.max(1, Math.round(meters / 80)) : null);
          }
          if (!routeGlowRef.current) {
            routeGlowRef.current = L.polyline(points, {
              color: '#1d4ed8', weight: 8, opacity: 0.22, lineCap: 'round', interactive: false,
            }).addTo(map);
            routeRef.current = L.polyline(points, {
              color: here ? '#34d399' : '#3b82f6', weight: 4, opacity: 0.95, lineCap: 'round', interactive: false,
            }).addTo(map);
          } else {
            routeGlowRef.current.setLatLngs?.(points);
            routeRef.current?.setLatLngs?.(points);
            routeRef.current?.setStyle?.({ color: here ? '#34d399' : '#3b82f6' });
          }
        })
        .catch(() => {
          const points: Array<[number, number]> = [[user.lat, user.lng], [officeLat, officeLng]];
          setEtaMin(meters != null ? Math.max(1, Math.round(meters / 80)) : null);
          if (!routeGlowRef.current) {
            routeGlowRef.current = L.polyline(points, {
              color: '#1d4ed8', weight: 8, opacity: 0.22, lineCap: 'round', interactive: false,
            }).addTo(map);
            routeRef.current = L.polyline(points, {
              color: '#3b82f6', weight: 4, opacity: 0.95, lineCap: 'round', interactive: false,
            }).addTo(map);
          } else {
            routeGlowRef.current.setLatLngs?.(points);
            routeRef.current?.setLatLngs?.(points);
          }
        });
    }, 200);

    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [user?.lat, user?.lng, officeLat, officeLng, gpsBlocked, meters, here, ready]);

  const goToMe = () => {
    void ensureOrientation();
    onNudge();
    followMe.current = true;
    if (user && mapRef.current) {
      mapRef.current.setView([user.lat, user.lng], 17, { animate: true });
    }
  };

  return <div className={`office-map ${here ? 'is-here' : user ? 'is-away' : 'is-wait'}`}>
    <div ref={boxRef} className="office-leaflet"/>
    {!gpsBlocked && status && <div className={`office-geo-badge ${here ? 'is-here' : user ? 'is-away' : 'is-wait'}`}>{status}</div>}
    {etaMin != null && user && !here && !gpsBlocked && <div className="office-route-chip">
      <Navigation size={12}/>
      {t('office.etaChip', { min: etaMin })}
    </div>}
    {!gpsBlocked && <button
      type="button"
      className="office-map-locate"
      onClick={goToMe}
      aria-label={t('office.toMe')}
      title={t('office.toMe')}
    >
      <LocateFixed size={18}/>
    </button>}
    {gpsBlocked && <div className="office-map-gate">
      <Radar size={22}/>
      <b>{t('office.gpsGateTitle')}</b>
      <p>{t('office.gpsGateBody')}</p>
      <button type="button" className="office-map-enable" onClick={onEnableGps}>{t('office.gpsEnable')}</button>
    </div>}
  </div>;
}
