/** Bo‘lim ruxsatlari — MoySklad uslubida xodimga alohida ochiladi/yopiladi. */

export type AccessModuleId =
  | 'dashboard'
  | 'products'
  | 'stock'
  | 'scanner'
  | 'receipts'
  | 'transfers'
  | 'inventory'
  | 'partners'
  | 'employees'
  | 'my_cabinet'
  | 'office'
  | 'kpi'
  | 'gps'
  | 'analytics'
  | 'reports'
  | 'settings'
  | 'audit';

export type AccessModule = {
  id: AccessModuleId;
  label: string;
  paths: string[];
};

export const ACCESS_MODULES: AccessModule[] = [
  { id: 'dashboard', label: 'Dashboard', paths: ['/dashboard'] },
  { id: 'products', label: 'Mahsulotlar', paths: ['/products'] },
  { id: 'stock', label: 'Qoldiq', paths: ['/stock'] },
  { id: 'scanner', label: 'Skaner', paths: ['/scanner'] },
  { id: 'receipts', label: 'Kirim', paths: ['/receipts'] },
  { id: 'transfers', label: 'Ko‘chirish', paths: ['/transfers'] },
  { id: 'inventory', label: 'Inventarizatsiya', paths: ['/inventory'] },
  { id: 'partners', label: 'Hamkor zavodlar', paths: ['/partners'] },
  { id: 'employees', label: 'Xodimlar', paths: ['/employees'] },
  /** Shaxsiy: rol bo‘yicha agent UI yoki o‘z davomat belgilashi. */
  { id: 'my_cabinet', label: 'Mening kabinetim', paths: ['/office', '/my-kpi'] },
  /** Faqat rahbar: jamoa hisoboti, QR, Excel/PDF. */
  { id: 'office', label: 'Davomat hisoboti', paths: ['/office/report', '/office/payroll'] },
  { id: 'kpi', label: 'KPI', paths: ['/kpi', '/kpi/agents', '/kpi/customers', '/kpi/orders', '/kpi/payments', '/kpi/settings'] },
  { id: 'gps', label: 'GPS va marshrut', paths: ['/gps'] },
  { id: 'analytics', label: 'Tahlil', paths: ['/analytics', '/non-moving', '/factories', '/branches', '/recommendations'] },
  { id: 'reports', label: 'Hisobotlar', paths: ['/reports'] },
  { id: 'settings', label: 'Sozlamalar', paths: ['/settings'] },
  { id: 'audit', label: 'Audit', paths: ['/audit'] },
];

export const ALL_ACCESS_IDS: AccessModuleId[] = ACCESS_MODULES.map((m) => m.id);

const PATH_TO_MODULE = new Map<string, AccessModuleId>();
for (const mod of ACCESS_MODULES) {
  for (const p of mod.paths) PATH_TO_MODULE.set(p, mod.id);
}

const ROLE_DEFAULTS: Record<string, AccessModuleId[]> = {
  super_admin: [...ALL_ACCESS_IDS],
  manager: [...ALL_ACCESS_IDS],
  sales_admin: [
    'dashboard', 'products', 'partners', 'employees', 'my_cabinet', 'kpi', 'gps',
    'analytics', 'reports', 'settings',
  ],
  warehouse_manager: [
    'partners', 'products', 'stock', 'scanner', 'receipts', 'transfers', 'inventory',
    'my_cabinet', 'analytics',
  ],
  warehouse_staff: [
    'partners', 'products', 'stock', 'scanner', 'receipts', 'transfers', 'inventory',
    'my_cabinet',
  ],
  agent: ['my_cabinet'],
  accountant: ['my_cabinet', 'reports', 'analytics'],
  analyst: ['my_cabinet', 'analytics', 'reports', 'dashboard'],
  worker: ['my_cabinet'],
};

/**
 * ACCESS LOCK — ruxsatisiz buzmang:
 * - my_cabinet = shaxsiy (agent → /my-kpi, boshqalar → /office punch)
 * - office = faqat rahbar jamoa hisoboti/QR/Excel/PDF
 * - oddiy rolga «office» bersa ham scrub → my_cabinet, hisobot yopiq
 */
export function isOfficeAdmin(role?: string | null) {
  const key = String(role || '').trim();
  return key === 'super_admin' || key === 'manager';
}

export function isAgentRole(role?: string | null) {
  const key = String(role || '').trim();
  return key === 'agent' || /agent|агент/i.test(key);
}

export function cabinetHomeForRole(role?: string | null) {
  return isAgentRole(role) ? '/my-kpi' : '/office';
}

function migrateAccessId(raw: string): AccessModuleId | null {
  const id = raw.trim();
  if (id === 'my_kpi') return 'my_cabinet';
  if ((ALL_ACCESS_IDS as string[]).includes(id)) return id as AccessModuleId;
  return null;
}

/** Oddiy xodimga jamoa hisoboti yopiladi; eski «office» → shaxsiy kabinet saqlanadi. */
function scrubAdminOnly(list: AccessModuleId[], role?: string | null): AccessModuleId[] {
  if (isOfficeAdmin(role) || String(role || '') === 'super_admin') {
    // Rahbar: hisobot ochiq bo‘lsa shaxsiy Davomat ham ochiq qoladi (dropdown ikkala band).
    if (list.includes('office') && !list.includes('my_cabinet')) return [...list, 'my_cabinet'];
    return list;
  }
  const hadOffice = list.includes('office');
  const next = list.filter((id) => id !== 'office');
  if (hadOffice && !next.includes('my_cabinet')) next.push('my_cabinet');
  return next;
}

export function defaultsForRole(role?: string | null): AccessModuleId[] {
  const key = String(role || '').trim();
  let list: AccessModuleId[];
  if (ROLE_DEFAULTS[key]) list = [...ROLE_DEFAULTS[key]];
  else if (isAgentRole(key)) list = [...ROLE_DEFAULTS.agent];
  else if (/ombor|sklad|склад/i.test(key)) list = [...ROLE_DEFAULTS.warehouse_staff];
  else if (/admin|rahbar|menejer|direktor/i.test(key)) list = [...ROLE_DEFAULTS.manager];
  else list = [...ROLE_DEFAULTS.worker];
  return scrubAdminOnly(list, role);
}

export function normalizeAccessList(raw: unknown, role?: string | null): AccessModuleId[] {
  if (String(role || '') === 'super_admin') return [...ALL_ACCESS_IDS];
  if (!Array.isArray(raw)) return defaultsForRole(role);
  const picked = raw
    .map((v) => migrateAccessId(String(v || '')))
    .filter((v): v is AccessModuleId => Boolean(v));
  const unique = scrubAdminOnly([...new Set(picked)], role);
  return unique.length ? unique : defaultsForRole(role);
}

export function effectiveAccess(role?: string | null, permissions?: string[] | null): AccessModuleId[] {
  if (String(role || '') === 'super_admin') return [...ALL_ACCESS_IDS];
  if (permissions && permissions.length) return normalizeAccessList(permissions, role);
  return defaultsForRole(role);
}

export function moduleForPath(path: string): AccessModuleId | null {
  if (PATH_TO_MODULE.has(path)) return PATH_TO_MODULE.get(path)!;
  if (path.startsWith('/kpi')) return 'kpi';
  if (path.startsWith('/my-kpi')) return 'my_cabinet';
  if (path.startsWith('/office')) {
    if (path.includes('/report') || path.includes('/payroll')) return 'office';
    return 'my_cabinet';
  }
  return null;
}

export function pathAllowedByAccess(path: string, role?: string | null, permissions?: string[] | null): boolean {
  if (String(role || '') === 'super_admin') return true;
  const mod = moduleForPath(path);
  if (!mod) return false;
  if (mod === 'office' && !isOfficeAdmin(role)) return false;
  return effectiveAccess(role, permissions).includes(mod);
}

export function homeForAccess(role?: string | null, permissions?: string[] | null): string {
  const access = new Set(effectiveAccess(role, permissions));
  if (access.has('my_cabinet') && (isAgentRole(role) || access.size <= 2)) {
    return cabinetHomeForRole(role);
  }
  const prefer: AccessModuleId[] = [
    'dashboard', 'partners', 'my_cabinet', 'office', 'products', 'stock', 'kpi', 'gps',
  ];
  for (const id of prefer) {
    if (!access.has(id)) continue;
    if (id === 'my_cabinet') return cabinetHomeForRole(role);
    if (id === 'office' && !isOfficeAdmin(role)) continue;
    const mod = ACCESS_MODULES.find((m) => m.id === id);
    if (mod?.paths[0]) return mod.paths[0];
  }
  const first = ACCESS_MODULES.find((m) => access.has(m.id));
  return first?.paths[0] || '/office';
}

export const NAV_PRIMARY_MODULES: AccessModuleId[] = [
  'dashboard', 'products', 'employees', 'gps', 'partners',
];
export const NAV_MORE_MODULES: AccessModuleId[] = [
  'stock', 'scanner', 'receipts', 'transfers', 'inventory',
  'analytics', 'reports', 'settings', 'audit',
];
