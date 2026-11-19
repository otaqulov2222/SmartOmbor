/**
 * Smart location resolver for Tashkent stores & markets
 * when MoySklad counterparty doesn't yet have exact GPS coordinates,
 * plus Haversine distance and nearest-neighbor route ordering from agent position.
 */

const PLACES: Array<[RegExp, number, number]> = [
  [/sergeli|сергели/i, 41.2213, 69.2167],
  [/chorsu|чорсу|eskijuv/i, 41.3265, 69.2342],
  [/abu\s*saxiy|абу\s*сахий|abusaxiy/i, 41.2446, 69.1624],
  [/bek\s*baraka|бек\s*барака/i, 41.2335, 69.1538],
  [/o‘rikzor|orikzor|урикзар/i, 41.2858, 69.1462],
  [/chilonzor|чиланзар/i, 41.2725, 69.2041],
  [/yunusobod|юнусабад/i, 41.3662, 69.2869],
  [/qo‘yliq|qoyliq|куйлюк/i, 41.2392, 69.3278],
  [/farxod|farhod|фархад/i, 41.2842, 69.1856],
  [/askiya|аския/i, 41.2859, 69.2544],
  [/olomazor|olmazor|алмазар/i, 41.3485, 69.2225],
  [/mirzo\s*ulug|мирзо\s*улуг|qorasuv|ttz/i, 41.3452, 69.3385],
  [/yashnobod|яшнабад|kadisheva|aviasozlar/i, 41.2928, 69.3456],
  [/shayxontohur|шайхантахур/i, 41.3248, 69.2432],
  [/uchtepa|учтепа/i, 41.2889, 69.1714],
  [/yakkasaroy|яккасарай/i, 41.2775, 69.2554],
  [/mirobod|мирабад|gospital/i, 41.2921, 69.2775],
  [/eshonguzar|эшонгузар|zangiota/i, 41.2428, 69.1408],
  [/nks|nukus\s*k|next/i, 41.2986, 69.2492],
  [/giper|samarqand\s*darvoza|darvoza/i, 41.3164, 69.2311],
  [/chirchiq|чирчик/i, 41.3689, 69.3822],
  [/chinoz|чиназ/i, 41.2164, 69.1386],
  [/yangiyo‘l|yangiyol|янгиюль/i, 41.1967, 69.1472],
  [/buka|bo‘ka|бука/i, 41.2019, 69.2686],
  [/begobod|bekobod|бекабад/i, 41.2208, 69.3397],
  [/parkent|паркент/i, 41.2944, 69.3764],
];

function hashOffset(seed: string): [number, number] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = ((h & 0xffff) / 0xffff - 0.5) * 0.018;
  const b = (((h >>> 16) & 0xffff) / 0xffff - 0.5) * 0.024;
  return [a, b];
}

export function inferCoordinates(
  id: string,
  name: string,
  address = "",
  lat?: string | number | null,
  lng?: string | number | null,
): { lat: number; lng: number; exact: boolean } {
  const nLat = lat != null && lat !== "" ? Number(lat) : NaN;
  const nLng = lng != null && lng !== "" ? Number(lng) : NaN;
  if (Number.isFinite(nLat) && Number.isFinite(nLng) && Math.abs(nLat) > 1 && Math.abs(nLng) > 1) {
    return { lat: nLat, lng: nLng, exact: true };
  }
  const text = `${name} ${address}`;
  const [dLat, dLng] = hashOffset(id || name);
  for (const [rx, baseLat, baseLng] of PLACES) {
    if (rx.test(text)) {
      return {
        lat: Number((baseLat + dLat * 0.35).toFixed(6)),
        lng: Number((baseLng + dLng * 0.35).toFixed(6)),
        exact: false,
      };
    }
  }
  // Default spread around Tashkent trade rings — faqat taxminiy hudud
  return {
    lat: Number((41.295 + dLat * 2.2).toFixed(6)),
    lng: Number((69.235 + dLng * 2.5).toFixed(6)),
    exact: false,
  };
}

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (n: number) => (n * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371000 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function stopExact(s: { exact?: boolean; exactGps?: boolean }): boolean {
  return s.exactGps === true || s.exact === true;
}

/**
 * Nearest-neighbor: har qadamda joriy nuqtaga eng yaqin mijoz.
 * Tie-break: aniq GPS > qarz > ism (bir xil masofada).
 */
function greedyNearest<
  T extends {
    lat: number;
    lng: number;
    exact?: boolean;
    exactGps?: boolean;
    debt?: string | number;
    name?: string;
    id?: string;
  },
>(pool: T[], startLat: number, startLng: number): T[] {
  const rem = [...pool];
  const out: T[] = [];
  let curLat = startLat;
  let curLng = startLng;
  while (rem.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < rem.length; i += 1) {
      const d = distanceMeters(curLat, curLng, rem[i].lat, rem[i].lng);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
        continue;
      }
      if (d === bestDist) {
        const a = rem[i];
        const b = rem[bestIdx];
        const ea = stopExact(a) ? 1 : 0;
        const eb = stopExact(b) ? 1 : 0;
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
        if (String(a.name || a.id || "").localeCompare(String(b.name || b.id || ""), "uz") < 0) {
          bestIdx = i;
        }
      }
    }
    const [picked] = rem.splice(bestIdx, 1);
    curLat = picked.lat;
    curLng = picked.lng;
    out.push(picked);
  }
  return out;
}

/** Agent GPS yo‘q: klaster markaziga eng yaqin nuqtadan NN boshlash. */
function seedFromStops<T extends { lat: number; lng: number }>(stops: T[]): { lat: number; lng: number } | null {
  if (!stops.length) return null;
  const lat = stops.reduce((s, x) => s + x.lat, 0) / stops.length;
  const lng = stops.reduce((s, x) => s + x.lng, 0) / stops.length;
  let best = stops[0];
  let bestD = Infinity;
  for (const s of stops) {
    const d = distanceMeters(lat, lng, s.lat, s.lng);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return { lat: best.lat, lng: best.lng };
}

/**
 * Marshrut: agent turgan joydan → eng yaqin → keyingi eng yaqin (1→2→3…).
 * Qarz bo‘yicha tartib YO‘Q (faqat teng masofada tie-break).
 */
export function orderRouteStops<
  T extends {
    id: string;
    lat: number;
    lng: number;
    visitedToday: boolean;
    visitedAt?: string | null;
    debt?: string | number;
    name?: string;
    exact?: boolean;
    exactGps?: boolean;
  },
>(
  stops: T[],
  startLat?: number | null,
  startLng?: number | null,
): Array<T & { step: number; isNext: boolean; distanceM: number | null; fromAgentM: number | null }> {
  const visited = stops
    .filter((s) => s.visitedToday)
    .sort((a, b) => String(a.visitedAt || "").localeCompare(String(b.visitedAt || "")));

  const unvisited = stops.filter((s) => !s.visitedToday);

  const hasStart =
    startLat != null && startLng != null && Number.isFinite(startLat) && Number.isFinite(startLng);

  let seedLat: number | null = null;
  let seedLng: number | null = null;

  if (hasStart) {
    seedLat = startLat as number;
    seedLng = startLng as number;
  } else if (visited.length) {
    seedLat = visited[visited.length - 1].lat;
    seedLng = visited[visited.length - 1].lng;
  } else {
    const seed = seedFromStops(unvisited);
    if (seed) {
      seedLat = seed.lat;
      seedLng = seed.lng;
    }
  }

  // Barcha ochiq nuqtalar — bir NN zanjir (aniq/taxminiy ajratilmaydi)
  const greedy =
    seedLat != null && seedLng != null
      ? greedyNearest(unvisited, seedLat, seedLng)
      : [...unvisited].sort((a, b) =>
          String(a.name || a.id).localeCompare(String(b.name || b.id), "uz"),
        );

  const ordered = [...visited, ...greedy];
  let nextAssigned = false;

  return ordered.map((item, idx) => {
    const isNext = !item.visitedToday && !nextAssigned;
    if (isNext) nextAssigned = true;

    const fromAgentM =
      hasStart ? distanceMeters(startLat as number, startLng as number, item.lat, item.lng) : null;

    let distanceM: number | null = null;
    if (isNext && hasStart) {
      distanceM = fromAgentM;
    } else if (idx > 0) {
      const prev = ordered[idx - 1];
      distanceM = distanceMeters(prev.lat, prev.lng, item.lat, item.lng);
    } else if (hasStart) {
      distanceM = fromAgentM;
    }

    return {
      ...item,
      step: idx + 1,
      isNext,
      distanceM,
      fromAgentM,
    };
  });
}
