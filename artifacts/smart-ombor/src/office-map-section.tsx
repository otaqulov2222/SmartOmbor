import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Crosshair, Hand, MapPin, Minus, Navigation, Plus, Radar } from 'lucide-react';
import { useI18n } from '@/i18n';

function lon2tile(lon: number, zoom: number) {
  return (lon + 180) / 360 * (2 ** zoom);
}
function lat2tile(lat: number, zoom: number) {
  const rad = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * (2 ** zoom);
}
function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = (n: number) => n * Math.PI / 180;
  const dLat = r(lat2 - lat1); const dLng = r(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function zoomToFit(lat1: number, lng1: number, lat2: number, lng2: number) {
  const dist = haversine(lat1, lng1, lat2, lng2);
  if (dist < 60) return 17;
  const midLat = (lat1 + lat2) / 2;
  const mppNeeded = dist / 140;
  const z = Math.log2((156543.03392 * Math.cos(midLat * Math.PI / 180)) / Math.max(mppNeeded, 0.5));
  return Math.min(17, Math.max(11, Math.floor(z)));
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

type Focus = 'fit' | 'me' | 'office';
type RoutePoint = { lat: number; lng: number };

export function OfficeMap({
  officeLat, officeLng, zoom, name, radiusM, radiusLabel, here, user, status, gpsDenied, meters,
  onZoom, onLocate, onNudge, onEnableGps,
}: {
  officeLat: number; officeLng: number; zoom: number; name: string; radiusM: number; radiusLabel: string;
  here: boolean; user: { lat: number; lng: number; heading?: number | null } | null; status: string;
  gpsDenied: boolean; meters: number | null;
  onZoom: (next: number) => void; onLocate: () => void; onNudge: () => void; onEnableGps: () => void;
}) {
  const { t } = useI18n();
  const mapRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<Focus>('fit');
  const [heading, setHeading] = useState<number | null>(null);
  const [route, setRoute] = useState<RoutePoint[]>([]);
  const [routeMeta, setRouteMeta] = useState<{ meters: number; minutes: number } | null>(null);
  const [size, setSize] = useState({ w: 360, h: 220 });
  const lastTap = useRef(0);
  const orientReady = useRef(false);

  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const sync = () => setSize({ w: el.clientWidth || 360, h: el.clientHeight || 220 });
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (user?.heading != null && Number.isFinite(user.heading) && user.heading >= 0) {
      setHeading(normDeg(user.heading));
    }
  }, [user?.heading]);

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
    if (!user || gpsDenied) {
      setRoute([]);
      setRouteMeta(null);
      return;
    }
    const ctrl = new AbortController();
    const url = `https://router.project-osrm.org/route/v1/foot/${user.lng},${user.lat};${officeLng},${officeLat}?overview=full&geometries=geojson&steps=false`;
    const timer = window.setTimeout(() => {
      void fetch(url, { signal: ctrl.signal })
        .then(res => res.ok ? res.json() : null)
        .then((data: { routes?: Array<{ distance: number; duration: number; geometry?: { coordinates: number[][] } }> } | null) => {
          const leg = data?.routes?.[0];
          const coords = leg?.geometry?.coordinates;
          if (!leg || !coords?.length) {
            setRoute([{ lat: user.lat, lng: user.lng }, { lat: officeLat, lng: officeLng }]);
            setRouteMeta(meters != null ? { meters: Math.round(meters), minutes: Math.max(1, Math.round(meters / 80)) } : null);
            return;
          }
          const step = Math.max(1, Math.floor(coords.length / 80));
          const points: RoutePoint[] = [];
          for (let i = 0; i < coords.length; i += step) {
            points.push({ lng: coords[i][0], lat: coords[i][1] });
          }
          const last = coords[coords.length - 1];
          if (points[points.length - 1]?.lat !== last[1] || points[points.length - 1]?.lng !== last[0]) {
            points.push({ lng: last[0], lat: last[1] });
          }
          setRoute(points);
          setRouteMeta({
            meters: Math.round(leg.distance),
            minutes: Math.max(1, Math.round(leg.duration / 60)),
          });
        })
        .catch(() => {
          setRoute([{ lat: user.lat, lng: user.lng }, { lat: officeLat, lng: officeLng }]);
          setRouteMeta(meters != null ? { meters: Math.round(meters), minutes: Math.max(1, Math.round(meters / 80)) } : null);
        });
    }, 250);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [user?.lat, user?.lng, officeLat, officeLng, gpsDenied, meters]);

  const far = Boolean(user && meters != null && meters > radiusM * 1.5);
  let z: number;
  let centerLat: number;
  let centerLng: number;
  if (focus === 'me' && user) {
    z = Math.min(18, Math.max(16, zoom));
    centerLat = user.lat;
    centerLng = user.lng;
  } else if (focus === 'office') {
    z = Math.min(18, Math.max(15, zoom));
    centerLat = officeLat;
    centerLng = officeLng;
  } else if (user && far) {
    z = zoomToFit(officeLat, officeLng, user.lat, user.lng);
    centerLat = (officeLat + user.lat) / 2;
    centerLng = (officeLng + user.lng) / 2;
  } else {
    z = Math.min(18, Math.max(14, zoom));
    centerLat = officeLat;
    centerLng = officeLng;
  }

  const xf = lon2tile(centerLng, z);
  const yf = lat2tile(centerLat, z);
  const cx = Math.floor(xf);
  const cy = Math.floor(yf);
  const n = 2 ** z;
  const wrap = (value: number) => ((value % n) + n) % n;
  const tiles: Array<{ x: number; y: number; left: number; top: number }> = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      tiles.push({ x: wrap(cx + dx), y: cy + dy, left: (dx + 1) * 256, top: (dy + 1) * 256 });
    }
  }
  const left = `calc(50% - ${(xf - (cx - 1)) * 256}px)`;
  const top = `calc(46% - ${(yf - (cy - 1)) * 256}px)`;
  const mpp = 156543.03392 * Math.cos((centerLat * Math.PI) / 180) / (2 ** z);
  const radiusPx = Math.max(22, Math.min(160, radiusM / Math.max(mpp, 0.01)));

  const toPx = (lat: number, lng: number) => {
    const tx = lon2tile(lng, z);
    const ty = lat2tile(lat, z);
    return {
      x: size.w * 0.5 + (tx - xf) * 256,
      y: size.h * 0.46 + (ty - yf) * 256,
    };
  };
  const officeScreen = toPx(officeLat, officeLng);
  const userScreen = user ? toPx(user.lat, user.lng) : null;
  const face = Math.round(heading ?? (user ? bearingDeg(user.lat, user.lng, officeLat, officeLng) : 0));
  const routePoints = route.map(point => {
    const p = toPx(point.lat, point.lng);
    return `${p.x},${p.y}`;
  }).join(' ');

  const goToMe = () => {
    setFocus('me');
    void ensureOrientation();
    onNudge();
  };
  const goToOffice = () => {
    setFocus('office');
    onLocate();
  };
  const goFit = () => setFocus('fit');

  const onMapTap = (event: ReactPointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    const now = Date.now();
    if (now - lastTap.current < 350) {
      event.preventDefault();
      goToMe();
      lastTap.current = 0;
      return;
    }
    lastTap.current = now;
  };

  return <div
    ref={mapRef}
    className={`office-map ${here ? 'is-here' : user ? 'is-away' : 'is-wait'}`}
    onPointerUp={onMapTap}
    onDoubleClick={(event) => { event.preventDefault(); goToMe(); }}
  >
    <div className="office-map-tiles" style={{ left, top }}>
      {tiles.map(tile => (
        <img key={`${z}-${tile.x}-${tile.y}`} alt="" draggable={false} style={{ left: tile.left, top: tile.top }} src={`https://tile.openstreetmap.org/${z}/${tile.x}/${tile.y}.png`}/>
      ))}
    </div>
    <div className="office-map-shade"/>
    {routePoints && <svg className="office-route" width={size.w} height={size.h} aria-hidden>
      <polyline points={routePoints} className="office-route-glow"/>
      <polyline points={routePoints} className={`office-route-line ${here ? 'is-here' : ''}`}/>
    </svg>}
    <div
      className={`office-pin ${here ? 'is-here' : ''}`}
      style={{
        width: radiusPx * 2,
        height: radiusPx * 2,
        left: officeScreen.x,
        top: officeScreen.y,
      }}
    >
      <i/><i/><span><MapPin size={18}/></span>
    </div>
    {userScreen && <div
      className={`office-me ${here ? 'is-here' : ''}`}
      style={{ left: userScreen.x, top: userScreen.y }}
      title={t('office.you')}
    >
      <div className="office-me-nav" aria-hidden>
        <i className="office-me-pulse"/>
        <i className="office-me-cone" style={{ transform: `rotate(${face}deg)` }}/>
        <span className="office-me-arrow" style={{ transform: `rotate(${face}deg)` }}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
            <path d="M12 2L19.5 20.5L12 16.8L4.5 20.5L12 2Z" fill="#fff" stroke="#1d4ed8" strokeWidth="1.6" strokeLinejoin="round"/>
          </svg>
        </span>
      </div>
      <b>{t('office.you')}</b>
    </div>}
    <div className={`office-geo-badge ${here ? 'is-here' : user ? 'is-away' : 'is-wait'}`}>{status}</div>
    {routeMeta && user && !here && <div className="office-route-chip">
      <Navigation size={12}/>
      {t('office.routeChip', { m: routeMeta.meters, min: routeMeta.minutes })}
    </div>}
    {gpsDenied && <div className="office-map-gate">
      <Radar size={22}/>
      <b>{t('office.gpsGateTitle')}</b>
      <p>{t('office.gpsGateBody')}</p>
      <button type="button" className="office-map-enable" onClick={(e) => { e.stopPropagation(); onEnableGps(); }}>{t('office.gpsEnable')}</button>
    </div>}
    {!gpsDenied && <div className="office-map-actions">
      <button type="button" className={focus === 'me' ? 'is-on' : ''} onClick={(e) => { e.stopPropagation(); goToMe(); }}>
        <Hand size={14}/> {t('office.toMe')}
      </button>
      <button type="button" className={focus === 'fit' ? 'is-on' : ''} onClick={(e) => { e.stopPropagation(); goFit(); }}>
        <Navigation size={14}/> {t('office.toRoute')}
      </button>
    </div>}
    <div className="office-map-tools">
      <button type="button" onClick={(e) => { e.stopPropagation(); onZoom(Math.min(18, z + 1)); setFocus(prev => prev === 'fit' ? 'office' : prev); }} aria-label="+"><Plus size={16}/></button>
      <button type="button" onClick={(e) => { e.stopPropagation(); onZoom(Math.max(11, z - 1)); setFocus(prev => prev === 'fit' ? 'office' : prev); }} aria-label="-"><Minus size={16}/></button>
      <button type="button" className="is-round" onClick={(e) => { e.stopPropagation(); goToOffice(); }} aria-label={t('office.map')}><Crosshair size={16}/></button>
    </div>
    <div className="office-map-meta">
      <b><MapPin size={12}/> {name}</b>
      <em>{radiusLabel}</em>
    </div>
  </div>;
}
