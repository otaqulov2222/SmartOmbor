/**
 * Smart location resolver for Uzbekistan / Tashkent stores & markets
 * when MoySklad counterparty doesn't yet have exact GPS coordinates,
 * plus Haversine distance and nearest-neighbor 1 -> 2 -> 3 -> 4 -> 5 route ordering.
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
  [/chirchiq|чирчик/i, 41.4689, 69.5822],
  [/chinoz|чиназ/i, 40.9364, 68.7586],
  [/yangiyo‘l|yangiyol|янгиюль/i, 41.1167, 69.0472],
  [/buka|bo‘ka|бука/i, 40.8119, 69.1986],
  [/begobod|bekobod|бекабад/i, 40.2208, 69.2697],
  [/olmaliq|алмалык/i, 40.8447, 69.5983],
  [/angren|ангрен/i, 41.0167, 70.1436],
  [/parkent|паркент/i, 41.2944, 69.6764],
  [/g‘azalkent|gazalkent/i, 41.5581, 69.7708],
  [/jizzax|джизак/i, 40.1158, 67.8422],
  [/sirdaryo|guliston|гулистан/i, 40.4897, 68.7842],
  [/samarqand|самарканд/i, 39.6542, 66.9597],
  [/buxoro|бухара/i, 39.7747, 64.4286],
  [/navoiy|навои/i, 40.0844, 65.3792],
  [/qarshi|карши|qashqadaryo/i, 38.8606, 65.7891],
  [/g‘uzor|guzor|гузар/i, 38.6208, 66.2481],
  [/muborak|мубарек/i, 39.2553, 65.1528],
  [/termiz|термез|surxondaryo/i, 37.2242, 67.2783],
  [/andijon|андижан/i, 40.7821, 72.3442],
  [/farg‘ona|fargona|фергана/i, 40.3842, 71.7843],
  [/marg‘ilon|margilon|маргилан/i, 40.4711, 71.7247],
  [/qo‘qon|qoqon|коканд/i, 40.5286, 70.9425],
  [/namangan|наманган/i, 40.9983, 71.6726],
  [/xorazm|urganch|хорезм|ургенч/i, 41.55, 60.6333],
  [/nukus|нукус|qoraqalpoq/i, 42.4619, 59.6166],
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
  // Default spread around Tashkent trade rings
  return {
    lat: Number((41.295 + dLat * 2.4).toFixed(6)),
    lng: Number((69.24 + dLng * 2.8).toFixed(6)),
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

/**
 * Orders stops into a smooth 1 -> 2 -> 3 -> 4 -> 5 sequence:
 * - Already visited stops today keep their chronological order first (1 ✓, 2 ✓...)
 * - Remaining unvisited stops are ordered by nearest-neighbor starting from agent's current position (or last visited stop), prioritizing debtors.
 */
export function orderRouteStops<
  T extends {
    id: string;
    lat: number;
    lng: number;
    visitedToday: boolean;
    visitedAt?: string | null;
    debt?: string | number;
  },
>(stops: T[], startLat?: number | null, startLng?: number | null): Array<T & { step: number; isNext: boolean; distanceM: number | null }> {
  const visited = stops
    .filter((s) => s.visitedToday)
    .sort((a, b) => String(a.visitedAt || "").localeCompare(String(b.visitedAt || "")));

  const unvisitedDebtors = stops.filter((s) => !s.visitedToday && Number(s.debt || 0) > 0);
  const unvisitedOthers = stops.filter((s) => !s.visitedToday && Number(s.debt || 0) <= 0);

  let curLat =
    startLat != null && Number.isFinite(startLat)
      ? startLat
      : visited.length
        ? visited[visited.length - 1].lat
        : 41.2995;
  let curLng =
    startLng != null && Number.isFinite(startLng)
      ? startLng
      : visited.length
        ? visited[visited.length - 1].lng
        : 69.2401;

  const greedySort = (pool: T[]) => {
    const rem = [...pool];
    const out: T[] = [];
    while (rem.length) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < rem.length; i += 1) {
        const d = distanceMeters(curLat, curLng, rem[i].lat, rem[i].lng);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      const [picked] = rem.splice(bestIdx, 1);
      curLat = picked.lat;
      curLng = picked.lng;
      out.push(picked);
    }
    return out;
  };

  const ordered = [...visited, ...greedySort(unvisitedDebtors), ...greedySort(unvisitedOthers)];
  let nextAssigned = false;

  return ordered.map((item, idx) => {
    const isNext = !item.visitedToday && !nextAssigned;
    if (isNext) nextAssigned = true;
    const distanceM =
      startLat != null && startLng != null && Number.isFinite(startLat) && Number.isFinite(startLng)
        ? distanceMeters(startLat, startLng, item.lat, item.lng)
        : null;
    return {
      ...item,
      step: idx + 1,
      isNext,
      distanceM,
    };
  });
}
