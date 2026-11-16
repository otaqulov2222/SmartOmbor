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
  | 'office'
  | 'kpi'
  | 'gps'
  | 'my_kpi'
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
  { id: 'office', label: 'Davomat', paths: ['/office', '/office/report'] },
  { id: 'kpi', label: 'KPI', paths: ['/kpi', '/kpi/agents', '/kpi/customers', '/kpi/orders', '/kpi/payments', '/kpi/settings'] },
  { id: 'gps', label: 'GPS va marshrut', paths: ['/gps'] },
  { id: 'my_kpi', label: 'Agent kabineti', paths: ['/my-kpi'] },
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
    'dashboard', 'products', 'partners', 'employees', 'office', 'kpi', 'gps',
    'analytics', 'reports', 'settings',
  ],
  warehouse_manager: [
    'partners', 'products', 'stock', 'scanner', 'receipts', 'transfers', 'inventory', 'office', 'analytics',
  ],
  warehouse_staff: [
    'partners', 'products', 'stock', 'scanner', 'receipts', 'transfers', 'inventory', 'office',
  ],
  agent: ['my_kpi', 'office'],
  accountant: ['office', 'reports', 'analytics'],
  analyst: ['office', 'analytics', 'reports', 'dashboard'],
  worker: ['office'],
};

export function defaultsForRole(role?: string | null): AccessModuleId[] {
  const key = String(role || '').trim();
  if (ROLE_DEFAULTS[key]) return [...ROLE_DEFAULTS[key]];
  if (/agent|агент/i.test(key)) return [...ROLE_DEFAULTS.agent];
  if (/ombor|sklad|склад/i.test(key)) return [...ROLE_DEFAULTS.warehouse_staff];
  if (/admin|rahbar|menejer|direktor/i.test(key)) return [...ROLE_DEFAULTS.manager];
  return [...ROLE_DEFAULTS.worker];
}

export function normalizeAccessList(raw: unknown, role?: string | null): AccessModuleId[] {
  const allowed = new Set(ALL_ACCESS_IDS);
  if (String(role || '') === 'super_admin') return [...ALL_ACCESS_IDS];
  if (!Array.isArray(raw)) return defaultsForRole(role);
  const picked = raw
    .map((v) => String(v).trim())
    .filter((v): v is AccessModuleId => allowed.has(v as AccessModuleId));
  const unique = [...new Set(picked)];
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
  if (path.startsWith('/office')) return 'office';
  return null;
}

export function pathAllowedByAccess(path: string, role?: string | null, permissions?: string[] | null): boolean {
  if (String(role || '') === 'super_admin') return true;
  const mod = moduleForPath(path);
  if (!mod) return false;
  return effectiveAccess(role, permissions).includes(mod);
}

export function homeForAccess(role?: string | null, permissions?: string[] | null): string {
  const access = new Set(effectiveAccess(role, permissions));
  const prefer: AccessModuleId[] = [
    'dashboard', 'partners', 'my_kpi', 'office', 'products', 'stock', 'kpi', 'gps',
  ];
  for (const id of prefer) {
    if (!access.has(id)) continue;
    const mod = ACCESS_MODULES.find((m) => m.id === id);
    if (mod?.paths[0]) return mod.paths[0];
  }
  const first = ACCESS_MODULES.find((m) => access.has(m.id));
  return first?.paths[0] || '/office';
}

/** Asosiy menyu tartibi (Davomat/KPI alohida chiziladi). */
export const NAV_PRIMARY_MODULES: AccessModuleId[] = [
  'dashboard', 'products', 'employees', 'gps', 'partners',
];
/** «Boshqalar» ichida. */
export const NAV_MORE_MODULES: AccessModuleId[] = [
  'stock', 'scanner', 'my_kpi', 'receipts', 'transfers', 'inventory',
  'analytics', 'reports', 'settings', 'audit',
];
