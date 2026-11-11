/** Reverse geocode via OpenStreetMap Nominatim (no API key). */

export type ReverseGeocodeResult = {
  address: string;
  displayName: string;
  district: string;
  city: string;
  street: string;
  house: string;
};

type NominatimAddress = {
  house_number?: string;
  road?: string;
  pedestrian?: string;
  suburb?: string;
  neighbourhood?: string;
  city_district?: string;
  district?: string;
  county?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  state?: string;
  country?: string;
};

type NominatimResponse = {
  display_name?: string;
  address?: NominatimAddress;
};

function pick(...values: Array<string | undefined>): string {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

export function formatGeocodedAddress(parts: {
  house?: string;
  street?: string;
  district?: string;
  city?: string;
}): string {
  const streetLine = [parts.street, parts.house].filter(Boolean).join(" ");
  return [streetLine, parts.district, parts.city].filter(Boolean).join(", ");
}

export async function reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) < 1 || Math.abs(lng) < 1) {
    return null;
  }
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat.toFixed(6))}` +
    `&lon=${encodeURIComponent(lng.toFixed(6))}&accept-language=uz,ru&addressdetails=1`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "SmartOmbor/1.0 (bordoombor.uz; kpi-customer-geocode)",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as NominatimResponse;
    const a = data.address || {};
    const house = pick(a.house_number);
    const street = pick(a.road, a.pedestrian);
    const district = pick(a.city_district, a.suburb, a.neighbourhood, a.district, a.county);
    const city = pick(a.city, a.town, a.village, a.municipality, a.state);
    const address = formatGeocodedAddress({ house, street, district, city }) || String(data.display_name || "").trim();
    if (!address) return null;
    return {
      address,
      displayName: String(data.display_name || address).trim(),
      district,
      city,
      street,
      house,
    };
  } catch {
    return null;
  }
}

export function parseAdminCoords(latRaw: unknown, lngRaw: unknown): { lat: number; lng: number } | null {
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) < 1 || Math.abs(lng) < 1) {
    return null;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** Bordim must be within this radius of admin-set store GPS. */
export const BORDIM_GEOFENCE_M = 250;

export function hasAdminGps(row: {
  lat?: string | number | null;
  lng?: string | number | null;
  gpsSource?: string | null;
}): { ok: true; lat: number; lng: number } | { ok: false } {
  if (String(row.gpsSource || "") !== "admin") return { ok: false };
  const lat = row.lat != null && row.lat !== "" ? Number(row.lat) : NaN;
  const lng = row.lng != null && row.lng !== "" ? Number(row.lng) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) < 1 || Math.abs(lng) < 1) {
    return { ok: false };
  }
  return { ok: true, lat, lng };
}
