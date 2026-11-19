/** Agent joyidan eng yaqin → keyingi yaqin (1→2→3). Yo‘nalish/OSRM shu tartibga bog‘lanadi. */

export type OrderableStop = {
  id: string;
  lat: number;
  lng: number;
  visitedToday: boolean;
  visitedAt?: string | null;
  debt?: string | number;
  name?: string;
  exactGps?: boolean;
  step?: number;
  isNext?: boolean;
  distanceM?: number | null;
  fromAgentM?: number | null;
};

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = (n: number) => (n * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371000 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
}

function greedyNearest<T extends OrderableStop>(pool: T[], startLat: number, startLng: number): T[] {
  const rem = [...pool];
  const out: T[] = [];
  let curLat = startLat;
  let curLng = startLng;
  while (rem.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < rem.length; i += 1) {
      const d = haversineM({ lat: curLat, lng: curLng }, rem[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
        continue;
      }
      if (d === bestDist) {
        const a = rem[i];
        const b = rem[bestIdx];
        const ea = a.exactGps ? 1 : 0;
        const eb = b.exactGps ? 1 : 0;
        if (ea !== eb) {
          if (ea > eb) bestIdx = i;
          continue;
        }
        const da = Number(a.debt || 0);
        const db = Number(b.debt || 0);
        if (da !== db) {
          if (da > db) bestIdx = i;
          continue;
        }
        if (String(a.name || a.id).localeCompare(String(b.name || b.id), 'uz') < 0) bestIdx = i;
      }
    }
    const [picked] = rem.splice(bestIdx, 1);
    curLat = picked.lat;
    curLng = picked.lng;
    out.push(picked);
  }
  return out;
}

/**
 * Tashrif qilinganlar saqlanadi; qolganlari origin (agent) dan NN.
 * Har nuqtaga step / isNext / distanceM / fromAgentM yoziladi.
 */
export function orderStopsByNearest<T extends OrderableStop>(
  stops: T[],
  origin?: { lat: number; lng: number } | null,
): Array<T & { step: number; isNext: boolean; distanceM: number | null; fromAgentM: number | null }> {
  const visited = stops
    .filter((s) => s.visitedToday)
    .sort((a, b) => String(a.visitedAt || '').localeCompare(String(b.visitedAt || '')));
  const unvisited = stops.filter((s) => !s.visitedToday);

  const hasOrigin =
    origin != null && Number.isFinite(origin.lat) && Number.isFinite(origin.lng);

  let seedLat: number | null = hasOrigin ? origin!.lat : null;
  let seedLng: number | null = hasOrigin ? origin!.lng : null;
  if (seedLat == null && visited.length) {
    seedLat = visited[visited.length - 1].lat;
    seedLng = visited[visited.length - 1].lng;
  }
  if (seedLat == null && unvisited.length) {
    const lat = unvisited.reduce((s, x) => s + x.lat, 0) / unvisited.length;
    const lng = unvisited.reduce((s, x) => s + x.lng, 0) / unvisited.length;
    let best = unvisited[0];
    let bestD = Infinity;
    for (const s of unvisited) {
      const d = haversineM({ lat, lng }, s);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    seedLat = best.lat;
    seedLng = best.lng;
  }

  const greedy =
    seedLat != null && seedLng != null
      ? greedyNearest(unvisited, seedLat, seedLng)
      : [...unvisited];

  const ordered = [...visited, ...greedy];
  let nextAssigned = false;
  return ordered.map((item, idx) => {
    const isNext = !item.visitedToday && !nextAssigned;
    if (isNext) nextAssigned = true;
    const fromAgentM = hasOrigin ? haversineM(origin!, item) : null;
    let distanceM: number | null = null;
    if (isNext && hasOrigin) distanceM = fromAgentM;
    else if (idx > 0) distanceM = haversineM(ordered[idx - 1], item);
    else if (hasOrigin) distanceM = fromAgentM;
    return { ...item, step: idx + 1, isNext, distanceM, fromAgentM };
  });
}
