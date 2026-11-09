import { Crosshair, Hand, MapPin, Minus, Plus, Radar } from 'lucide-react';
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

export function OfficeMap({
  officeLat, officeLng, zoom, name, radiusM, radiusLabel, here, user, status, gpsDenied, meters,
  onZoom, onLocate, onNudge, onEnableGps,
}: {
  officeLat: number; officeLng: number; zoom: number; name: string; radiusM: number; radiusLabel: string;
  here: boolean; user: { lat: number; lng: number } | null; status: string; gpsDenied: boolean; meters: number | null;
  onZoom: (next: number) => void; onLocate: () => void; onNudge: () => void; onEnableGps: () => void;
}) {
  const { t } = useI18n();
  const far = Boolean(user && meters != null && meters > radiusM * 1.5);
  const autoZ = user && far ? zoomToFit(officeLat, officeLng, user.lat, user.lng) : Math.min(18, Math.max(14, zoom));
  const z = far ? autoZ : Math.min(18, Math.max(14, zoom));
  const centerLat = user && far ? (officeLat + user.lat) / 2 : officeLat;
  const centerLng = user && far ? (officeLng + user.lng) / 2 : officeLng;

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
    return { x: (tx - xf) * 256, y: (ty - yf) * 256 };
  };
  const officePx = toPx(officeLat, officeLng);
  const userPx = user ? toPx(user.lat, user.lng) : null;

  const clampMarker = (x: number, y: number) => {
    const maxX = 150; const maxY = 78;
    const ax = Math.abs(x); const ay = Math.abs(y);
    if (ax <= maxX && ay <= maxY) return { x, y, clipped: false };
    const scale = Math.min(maxX / Math.max(ax, 1), maxY / Math.max(ay, 1));
    return { x: x * scale, y: y * scale, clipped: true };
  };
  const officePos = clampMarker(officePx.x, officePx.y);
  const userPos = userPx ? clampMarker(userPx.x, userPx.y) : null;

  return <div className={`office-map ${here ? 'is-here' : user ? 'is-away' : 'is-wait'}`}>
    <div className="office-map-tiles" style={{ left, top }}>
      {tiles.map(tile => (
        <img key={`${z}-${tile.x}-${tile.y}`} alt="" draggable={false} style={{ left: tile.left, top: tile.top }} src={`https://tile.openstreetmap.org/${z}/${tile.x}/${tile.y}.png`}/>
      ))}
    </div>
    <div className="office-map-shade"/>
    <div
      className={`office-pin ${here ? 'is-here' : ''}`}
      style={{
        width: radiusPx * 2,
        height: radiusPx * 2,
        left: `calc(50% + ${officePos.x}px)`,
        top: `calc(46% + ${officePos.y}px)`,
      }}
    >
      <i/><i/><span><MapPin size={18}/></span>
    </div>
    {userPos && <div
      className={`office-me ${here ? 'is-here' : ''}${userPos.clipped ? ' is-edge' : ''}`}
      style={{ left: `calc(50% + ${userPos.x}px)`, top: `calc(46% + ${userPos.y}px)` }}
      title={t('office.you')}
    >
      <em/><b>{t('office.you')}</b>
    </div>}
    <div className={`office-geo-badge ${here ? 'is-here' : user ? 'is-away' : 'is-wait'}`}>{status}</div>
    {gpsDenied && <div className="office-map-gate">
      <Radar size={22}/>
      <b>{t('office.gpsGateTitle')}</b>
      <p>{t('office.gpsGateBody')}</p>
      <button type="button" className="office-map-enable" onClick={onEnableGps}>{t('office.gpsEnable')}</button>
    </div>}
    {!gpsDenied && <button type="button" className="office-tap" onClick={onNudge} onDoubleClick={onNudge}>
      <Hand size={14}/> {t('office.dbl')}
    </button>}
    <div className="office-map-tools">
      <button type="button" onClick={() => onZoom(z + 1)} aria-label="+"><Plus size={16}/></button>
      <button type="button" onClick={() => onZoom(z - 1)} aria-label="-"><Minus size={16}/></button>
      <button type="button" className="is-round" onClick={onLocate} aria-label={t('office.map')}><Crosshair size={16}/></button>
    </div>
    <div className="office-map-meta">
      <b><MapPin size={12}/> {name}</b>
      <em>{radiusLabel}</em>
    </div>
  </div>;
}
