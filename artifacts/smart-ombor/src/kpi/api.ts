const LOCAL_SESSION = 'smart-ombor-session';
const AGENT_TOKEN = 'smart-ombor-kpi-agent';

export function readStaffToken(): string {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(LOCAL_SESSION) || '') as { token?: string };
    return parsed.token || '';
  } catch {
    return '';
  }
}

export function readAgentToken(): string {
  try {
    return localStorage.getItem(AGENT_TOKEN) || '';
  } catch {
    return '';
  }
}

export function saveAgentToken(token: string) {
  localStorage.setItem(AGENT_TOKEN, token);
}

export function clearAgentToken() {
  localStorage.removeItem(AGENT_TOKEN);
}

export async function kpiFetch<T = unknown>(path: string, init: RequestInit = {}, mode: 'admin' | 'agent' = 'admin'): Promise<T> {
  const token = mode === 'agent' ? readAgentToken() : readStaffToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path.startsWith('/api/') ? path : `/api${path}`, { ...init, headers });
  if (!response.ok) {
    let message = `Xato ${response.status}`;
    try {
      const body = await response.json() as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep */
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  const type = response.headers.get('content-type') || '';
  if (type.includes('text/csv')) return (await response.text()) as T;
  return await response.json() as T;
}

export function uzs(value: unknown) {
  const n = Number(String(value ?? 0).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return '0 so‘m';
  return `${new Intl.NumberFormat('uz-UZ').format(Math.round(n))} so‘m`;
}

/** Holat / status kodlarini o'zbekcha yozuvga */
export function kpiStatusLabel(raw: unknown): string {
  const s = String(raw ?? '').toLowerCase().trim();
  if (!s) return '—';
  if (s === 'confirmed') return 'Tasdiqlangan';
  if (s === 'paid') return "To'liq to'langan";
  if (s === 'partially_paid' || s === 'partial') return "Qisman to'langan";
  if (s === 'pending' || s === 'pending_approval') return 'Kutilmoqda';
  if (s === 'expired' || s === 'overdue') return "Muddati o'tgan";
  if (s === 'cancelled' || s === 'canceled') return 'Bekor qilingan';
  if (s === 'active') return 'Faol';
  if (s === 'inactive') return 'Nofaol';
  if (s === 'draft') return 'Qoralama';
  return String(raw);
}
