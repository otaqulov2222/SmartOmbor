import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ClerkProvider, Show, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity, ArrowDownLeft, ArrowLeftRight, ArrowRight, Banknote, BarChart3, Box, ChartColumn,
  CheckCheck, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleAlert, ClipboardCheck, ClipboardList,
  Clock3, Eye, EyeOff, Factory, FileBarChart, FileText, Filter, Handshake, LayoutDashboard, ListChecks, LogOut, Menu, MoreHorizontal, Repeat,
  Layers, Package, Plus, RefreshCw, Search, Settings2, ShieldCheck, ScanBarcode, SlidersHorizontal,
  UserRound, Users, Wallet, Warehouse, X,
} from 'lucide-react';
import { Link, Redirect, Route, Switch, Router as WouterRouter, useLocation, useSearch } from 'wouter';
import {
  getGetDashboardQueryKey, getGetMoyskladStatusQueryKey, getListTasksQueryKey, getListUsersQueryKey,
  useCreateTask, useGetCurrentUser, useGetDashboard,
  useGetMoyskladStatus, useGetNonMovingProducts, useGetPurchaseRecommendations, useGetSalesAnalytics,
  useListAuditEvents, useListDocuments, useListProducts, useListStock, useListTasks, useListUsers,
  useListWarehouses, useUpdateTask,
  useUpdateUserRole,
} from '@workspace/api-client-react';
import type {
  AppUserRole, Product, Task, TaskInputPriority,
} from '@workspace/api-client-react';
import { ErrorBoundary, type ErrorFallbackProps } from '@/components/error-boundary';
import { I18nProvider, useI18n, weekdayShort, formatShortDay, type Lang, type TKey } from '@/i18n';
import { AutoRefresh, AUTO_REFRESH_MS, useCatalogRefresh } from '@/auto-refresh';
import { ExportButton, ReportsHub } from '@/export-dialog';
import { FactoryPortal } from '@/factory-portal';
import { ScannerPage } from '@/scanner';
import { PartnersPage } from '@/partners';
import { BORDO_SIZES } from '@/bordo-sizes';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 20_000, retry: 2, retryDelay: attempt => Math.min(1000, 400 * (attempt + 1)), refetchOnWindowFocus: false } } });
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const hostName = window.location.hostname;
const isLocalHost = hostName === 'localhost' || hostName === '127.0.0.1';
const clerkFromEnv = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || undefined;
const clerkPubKey = isLocalHost || !clerkFromEnv
  ? clerkFromEnv
  : publishableKeyFromHost(hostName, clerkFromEnv);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
function stripBase(path: string) { return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path; }

const clerkAppearance = {
  theme: shadcn, cssLayerName: 'clerk',
  options: { logoPlacement: 'inside' as const, logoLinkUrl: basePath || '/', logoImageUrl: `${window.location.origin}${basePath}/logo.png` },
  variables: { colorPrimary: '#2f54eb', colorForeground: '#0f1b2d', colorMutedForeground: '#64748b', colorDanger: '#dc2626', colorBackground: '#ffffff', colorInput: '#ffffff', colorInputForeground: '#0f1b2d', colorNeutral: '#e2e8f0', fontFamily: 'Inter, sans-serif', borderRadius: '10px' },
  elements: {
    rootBox: 'w-full flex justify-center', cardBox: 'bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-none border border-[#e4e8ee]',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none', footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    formButtonPrimary: 'bg-[#2f54eb] hover:bg-[#1d39c4] text-white', footerActionLink: 'text-[#2f54eb] font-semibold',
  },
};

type NavItem = { key: TKey; href: string; icon: typeof Package; group: TKey };
const navigation: NavItem[] = [
  { key: 'nav.dashboard', href: '/dashboard', icon: LayoutDashboard, group: 'nav.group.workspace' },
  { key: 'nav.products', href: '/products', icon: Package, group: 'nav.group.workspace' },
  { key: 'nav.stock', href: '/stock', icon: Warehouse, group: 'nav.group.workspace' },
  { key: 'nav.scanner', href: '/scanner', icon: ScanBarcode, group: 'nav.group.workspace' },
  { key: 'nav.receipts', href: '/receipts', icon: ArrowDownLeft, group: 'nav.group.operations' },
  { key: 'nav.transfers', href: '/transfers', icon: ArrowLeftRight, group: 'nav.group.operations' },
  { key: 'nav.inventory', href: '/inventory', icon: ClipboardCheck, group: 'nav.group.operations' },
  { key: 'nav.tasks', href: '/tasks', icon: ClipboardList, group: 'nav.group.operations' },
  { key: 'nav.analytics', href: '/analytics', icon: BarChart3, group: 'nav.group.analytics' },
  { key: 'nav.nonMoving', href: '/non-moving', icon: Clock3, group: 'nav.group.analytics' },
  { key: 'nav.factories', href: '/factories', icon: Factory, group: 'nav.group.analytics' },
  { key: 'nav.branches', href: '/branches', icon: Repeat, group: 'nav.group.analytics' },
  { key: 'nav.partners', href: '/partners', icon: Handshake, group: 'nav.group.operations' },
  { key: 'nav.recommendations', href: '/recommendations', icon: ListChecks, group: 'nav.group.analytics' },
  { key: 'nav.reports', href: '/reports', icon: FileBarChart, group: 'nav.group.analytics' },
  { key: 'nav.audit', href: '/audit', icon: Activity, group: 'nav.group.system' },
  { key: 'nav.settings', href: '/settings', icon: Settings2, group: 'nav.group.system' },
];
const primaryHrefs = ['/dashboard', '/recommendations', '/products', '/scanner', '/partners'];
const moreGroups: { key: TKey; hrefs: string[] }[] = [
  { key: 'nav.more.warehouse', hrefs: ['/stock', '/receipts', '/transfers', '/inventory', '/tasks'] },
  { key: 'nav.more.accounts', hrefs: ['/analytics', '/non-moving', '/factories', '/branches', '/reports', '/audit', '/settings'] },
];
const moreHrefs = moreGroups.flatMap(group => group.hrefs);
const roleOptions: AppUserRole[] = ['super_admin', 'manager', 'warehouse_manager', 'warehouse_staff', 'branch_manager', 'analyst'];

/* ---------- small helpers ---------- */
function useRole() {
  const { t } = useI18n();
  return (role: AppUserRole | string) => t(`role.${role}` as TKey);
}
function useStatusLabel() {
  const { t } = useI18n();
  return (status: string) => {
    const key = status === 'low' ? 'status.low' : `status.${status}`;
    const value = t(key as TKey);
    return value === key ? status : value;
  };
}
function useDocKind() {
  const { t } = useI18n();
  return (kind: string) => t(`doc.${kind}` as TKey);
}
function useUnit() {
  const { t } = useI18n();
  return (unit?: string | null) => { if (!unit) return ''; const clean = unit.trim(); return /^(шт\.?|шт)$/i.test(clean) ? t('common.pcs') : clean; };
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const cache = useQueryClient();
  const prev = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const stop = addListener(({ user }) => {
      const id = user?.id ?? null;
      if (prev.current !== undefined && prev.current !== id) cache.clear();
      prev.current = id;
    });
    return stop;
  }, [addListener, cache]);
  return null;
}

/* ---------- brand & language ---------- */
function BrandMark({ light = false }: { light?: boolean }) {
  const { t } = useI18n();
  return <div className={`brand ${light ? 'brand-light' : ''}`} data-testid="brand-smart-ombor">
    <img className="brand-lockup" src={`${basePath}/${light ? 'logo-dark.png' : 'logo.png'}`} alt={t('brand.name')} width={925} height={254}/>
    <img className="brand-mark" src={`${basePath}/logo-mark.png`} alt="" width={243} height={250}/>
  </div>;
}
function LangSwitch({ compact = false }: { compact?: boolean }) {
  const { lang, setLang, t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const options: Array<{ code: Lang; name: TKey }> = [{ code: 'uz', name: 'lang.uz' }, { code: 'ru', name: 'lang.ru' }];
  return <div className={`lang-dd ${compact ? 'is-compact' : ''} ${open ? 'is-open' : ''}`} ref={box} data-testid="lang-switch">
    <button type="button" className="lang-dd-btn" aria-haspopup="listbox" aria-expanded={open} aria-label={t('common.language')} onClick={() => setOpen(v => !v)} data-testid="lang-toggle"><span>{lang.toUpperCase()}</span><ChevronDown size={14}/></button>
    {open && <div className="lang-dd-menu" role="listbox">{options.map(o => <button key={o.code} type="button" role="option" aria-selected={lang === o.code} className={lang === o.code ? 'is-active' : ''} onClick={() => { setLang(o.code); setOpen(false); }} data-testid={`lang-${o.code}`}><span>{t(o.name)}</span><b>{o.code.toUpperCase()}</b></button>)}</div>}
  </div>;
}
function ScanMark({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" aria-hidden="true"><path d="M6 8V6.5A1.5 1.5 0 0 1 7.5 5H9M6 16v1.5A1.5 1.5 0 0 0 7.5 19H9M18 8V6.5A1.5 1.5 0 0 0 16.5 5H15M18 16v1.5a1.5 1.5 0 0 1-1.5 1.5H15"/><path d="M8 9.2v5.6M10.4 8.4v7.2M13.2 9.5v5M15.6 8v8" strokeWidth="1.7"/><path d="M7.2 12h9.6" strokeWidth="1.9"/></svg>;
}

/* ---------- auth pages ---------- */
function AuthSplash({ title, body, children }: { title?: string; body?: string; children: ReactNode }) {
  return <div className="auth"><aside className="auth-side"><BrandMark light/>{(title || body) && <div>{title && <h1>{title}</h1>}{body && <p className="auth-body">{body}</p>}</div>}<LangSwitch/></aside><main className="auth-main">{children}</main></div>;
}
function SignInPage() {
  return <AuthSplash><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`}/></AuthSplash>;
}
function SignUpPage() {
  return <AuthSplash><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`}/></AuthSplash>;
}
function LocalSignInNotice() {
  const { t } = useI18n();
  return <AuthSplash title={t('auth.local.title')} body={t('auth.local.body')}><Link href="/" className="btn btn-primary">{t('auth.local.home')}</Link></AuthSplash>;
}

/* ---------- entry ---------- */
const LOCAL_SESSION = 'smart-ombor-session';
const RETURN_PATH = 'smart-ombor-return';
const accessRoles = ['super_admin', 'manager', 'warehouse_manager', 'warehouse_staff', 'branch_manager', 'analyst', 'accountant', 'worker'] as const;
type LocalSession = { token: string; name: string; login: string; role: string };

function readLocalSession(): LocalSession | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(LOCAL_SESSION) || '') as Partial<LocalSession>;
    if (!parsed.token || !parsed.login || !parsed.role) return null;
    return { token: parsed.token, name: parsed.name || parsed.login, login: parsed.login, role: parsed.role };
  } catch {
    return null;
  }
}
function PasswordField({ value, onChange, testId, autoComplete }: { value: string; onChange: (value: string) => void; testId: string; autoComplete?: string }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  return <span className="secret"><input className="input" type={shown ? 'text' : 'password'} value={value} onChange={event => onChange(event.target.value)} autoComplete={autoComplete} data-testid={testId}/><button type="button" className="secret-eye" aria-label={shown ? t('auth.hidePassword') : t('auth.showPassword')} onClick={() => setShown(open => !open)}>{shown ? <EyeOff size={18}/> : <Eye size={18}/>}</button></span>;
}

function EntryScreen({ children }: { children: ReactNode }) {
  return <main className="gate" data-testid="page-public-landing">
    <section className="gate-brand"><div className="gate-logo-navy"><BrandMark light/></div><div className="gate-logo-plain"><BrandMark/></div></section>
    <section className="gate-main">
      <div className="gate-lang"><LangSwitch compact/></div>
      {children}
    </section>
  </main>;
}
function LocalLoginForm() {
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(false);
    try {
      const response = await fetch('/api/local-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
      if (!response.ok) { setError(true); return; }
      const body = await response.json() as LocalSession;
      sessionStorage.setItem(LOCAL_SESSION, JSON.stringify({ token: body.token, name: body.name, login: body.login, role: body.role }));
      window.dispatchEvent(new Event('smart-ombor-auth'));
      const here = `${window.location.pathname}${window.location.search}`;
      const saved = sessionStorage.getItem(RETURN_PATH) || '';
      sessionStorage.removeItem(RETURN_PATH);
      const target = here.startsWith('/') && here !== '/' ? here : saved.startsWith('/') && !saved.startsWith('//') ? saved : '/dashboard';
      setLocation(target);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return <form className="gate-form" onSubmit={event => { void submit(event); }}>
    <label className="field"><span>{t('auth.login')}</span><input className="input" value={login} onChange={event => setLogin(event.target.value)} autoComplete="username" autoFocus data-testid="input-login"/></label>
    <label className="field"><span>{t('auth.password')}</span><PasswordField value={password} onChange={setPassword} testId="input-password" autoComplete="current-password"/></label>
    {error && <p className="gate-error">{t('auth.invalid')}</p>}
    <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !login.trim() || !password} data-testid="button-sign-in">{t('landing.nav.signIn')}</button>
  </form>;
}

/* ---------- workspace shell ---------- */
function WorkspaceGate({ children }: { children: ReactNode }) {
  return <><Show when="signed-in">{children}</Show><Show when="signed-out"><Redirect to="/"/></Show></>;
}
function AppShell({ children, title }: { children: ReactNode; title: string }) {
  const { user } = useUser(); const { signOut } = useClerk(); const { t } = useI18n();
  return <WorkspaceChrome title={title} userName={user?.fullName || user?.firstName || t('shell.localUser')} onSignOut={() => signOut({ redirectUrl: basePath || '/' })}>{children}</WorkspaceChrome>;
}
function LocalShell({ children, title }: { children: ReactNode; title: string }) {
  const [, setLocation] = useLocation(); const { t } = useI18n();
  const session = readLocalSession();
  return <WorkspaceChrome title={title} userName={session?.name || t('shell.localUser')} onSignOut={() => { sessionStorage.removeItem(LOCAL_SESSION); setLocation('/'); }}>{children}</WorkspaceChrome>;
}
function WorkspaceChrome({ children, title, userName, onSignOut }: { children: ReactNode; title: string; userName: string; onSignOut: () => void }) {
  const { t, fmt } = useI18n();
  const [path] = useLocation(); const [open, setOpen] = useState(false);
  const [rail, setRail] = useState(() => localStorage.getItem('smart-ombor-nav') === 'icons');
  const inMore = moreHrefs.includes(path);
  const [moreOpen, setMoreOpen] = useState(inMore);
  useEffect(() => { localStorage.setItem('smart-ombor-nav', rail ? 'icons' : 'full'); }, [rail]);
  useEffect(() => { setMoreOpen(inMore); }, [inMore]);
  const current = navigation.find(x => x.href === path);
  const alerts = useQuery<{ pending: number }>({
    queryKey: ['partner-alerts'],
    queryFn: async () => {
      const response = await fetch('/api/partner-alerts');
      if (!response.ok) throw new Error('alerts');
      return response.json();
    },
    staleTime: 15_000,
    refetchInterval: 45_000,
  });
  const initials = userName.split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase();
  const navItem = (href: string) => {
    const item = navigation.find(entry => entry.href === href);
    if (!item) return null;
    const Icon = item.icon;
    const active = path === item.href;
    const pending = item.href === '/partners' ? alerts.data?.pending ?? 0 : 0;
    return <Link key={item.href} href={item.href} className={`nav-item ${active ? 'is-active' : ''}`} title={t(item.key)} aria-current={active ? 'page' : undefined} data-testid={`nav-${item.href.slice(1)}`}><Icon size={18} strokeWidth={1.9}/><span>{t(item.key)}</span>{pending > 0 && <em className="nav-badge" title={t('partners.pending', { count: pending })}>{fmt(pending)}</em>}</Link>;
  };
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => { document.body.classList.toggle('nav-open', open); return () => document.body.classList.remove('nav-open'); }, [open]);
  return <div className={`app ${rail ? 'is-rail' : ''}`}>
    {open && <button className="scrim" aria-label={t('common.menuClose')} onClick={() => setOpen(false)} data-testid="button-close-navigation"/>}
    <aside className={`sidebar ${open ? 'is-open' : ''}`}>
      <div className="sidebar-top"><BrandMark light/><button type="button" className="icon-btn sidebar-collapse" onClick={() => setRail(value => !value)} aria-label={rail ? t('nav.expand') : t('nav.collapse')} title={rail ? t('nav.expand') : t('nav.collapse')} data-testid="button-navigation-collapse">{rail ? <ChevronRight size={18}/> : <ChevronLeft size={18}/>}</button><button className="icon-btn sidebar-close" onClick={() => setOpen(false)} aria-label={t('common.menuClose')} data-testid="button-navigation-close"><X size={18}/></button></div>
      <nav className="nav" aria-label={t('brand.name')}>
        <div className="nav-primary">
          {primaryHrefs.map(href => navItem(href))}
          <button type="button" className={`nav-item nav-more ${moreOpen ? 'is-open' : ''} ${inMore && !moreOpen ? 'is-active' : ''}`} aria-expanded={moreOpen} title={t('nav.more')} onClick={() => setMoreOpen(value => !value)} data-testid="button-navigation-more">{moreOpen ? <ChevronUp size={18} strokeWidth={1.9}/> : <MoreHorizontal size={18} strokeWidth={1.9}/>}<span>{t('nav.more')}</span>{!moreOpen && <ChevronDown size={16} className="nav-more-chevron"/>}</button>
        </div>
        {moreOpen && <div className="nav-more-panel">{moreGroups.map(group => <div key={group.key} className="nav-group"><p>{t(group.key)}</p>{group.hrefs.map(href => navItem(href))}</div>)}</div>}
      </nav>
      <div className="sidebar-bottom">
        <div className="user" title={userName}><span className="avatar">{initials}</span><span className="user-copy"><b>{userName}</b></span><button type="button" onClick={onSignOut} className="icon-btn user-out" aria-label={t('common.signOut')} title={t('common.signOut')} data-testid="button-sign-out"><LogOut size={16}/></button></div>
      </div>
    </aside>
    <div className="main">
      <header className="topbar"><button className="icon-btn menu-btn" onClick={() => setOpen(true)} aria-label={t('common.menuOpen')} data-testid="button-navigation-open"><Menu size={20}/></button><div className="crumbs"><span className="crumb-root">{t('brand.name')}</span><ChevronRight size={14}/><b>{current ? t(current.key) : title}</b></div><div className="topbar-right"><LangSwitch compact/><Link href="/scanner" className="scan-btn" data-testid="link-topbar-scanner" title={t('shell.scanner')} aria-label={t('shell.scanner')}><ScanMark size={17}/><span>{t('shell.scanner')}</span></Link></div></header>
      <main className="content"><div className="page-enter">{children}</div></main>
    </div>
  </div>;
}

/* ---------- primitives ---------- */
function PageHead({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return <div className="page-head"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</div>;
}
function Card({ children, className = '', title, meta, action }: { children: ReactNode; className?: string; title?: string; meta?: string; action?: ReactNode }) {
  return <section className={`card ${className}`}>{(title || meta || action) && <div className="card-head">{title && <h2>{title}</h2>}{meta && <span className="card-meta">{meta}</span>}{action && <div className="card-action">{action}</div>}</div>}{children}</section>;
}
function Button({ children, onClick, variant = 'primary', disabled, testId, type = 'button', size }: { children: ReactNode; onClick?: () => void; variant?: 'primary'|'secondary'|'ghost'|'danger'; disabled?: boolean; testId: string; type?: 'button'|'submit'; size?: 'sm' }) {
  return <button type={type} className={`btn btn-${variant} ${size ? `btn-${size}` : ''}`} onClick={onClick} disabled={disabled} data-testid={testId}>{children}</button>;
}
function Field({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return <label className="field" data-testid={testId}><span>{label}</span>{children}</label>;
}
function TextInput(props: React.InputHTMLAttributes<HTMLInputElement> & { testId: string }) {
  const { testId, className, ...rest } = props;
  return <input className={`input ${className || ''}`} data-testid={testId} {...rest}/>;
}
function SelectInput({ value, onChange, children, testId, ariaLabel }: { value: string; onChange: (v: string) => void; children: ReactNode; testId: string; ariaLabel?: string }) {
  return <select className="input" value={value} onChange={e => onChange(e.target.value)} data-testid={testId} aria-label={ariaLabel}>{children}</select>;
}
function Notice({ kind = 'info', title, children, testId }: { kind?: 'info'|'error'|'success'|'warning'; title: string; children?: ReactNode; testId: string }) {
  const Icon = kind === 'error' ? CircleAlert : kind === 'success' ? CheckCheck : kind === 'warning' ? ShieldCheck : Activity;
  return <div className={`notice notice-${kind}`} data-testid={testId}><Icon size={18}/><div><b>{title}</b>{children && <p>{children}</p>}</div></div>;
}
function LoadingRows({ count = 4 }: { count?: number }) {
  return <div className="loading-rows" data-testid="loading-data">{Array.from({ length: count }, (_, i) => <div className="skeleton-row" key={i}><i className="skeleton"/><i className="skeleton"/><i className="skeleton"/></div>)}</div>;
}
function ErrorState({ message, retry, id }: { message: string; retry: () => void; id: string }) {
  const { t } = useI18n();
  return <div className="state state-error" data-testid={`error-${id}`}><CircleAlert size={20}/><div><b>{t('common.loadFailed')}</b><p>{message || t('common.loadFailedHint')}</p></div><button className="btn btn-secondary btn-sm" onClick={retry} data-testid={`retry-${id}`}><RefreshCw size={14}/> {t('common.retry')}</button></div>;
}
function EmptyState({ title, body, icon: Icon = Package }: { title: string; body: string; icon?: typeof Package }) {
  return <div className="state state-empty" data-testid="empty-state"><span className="state-icon"><Icon size={22}/></span><b>{title}</b><p>{body}</p></div>;
}
type Row = { key: string; testId?: string; cells: ReactNode[]; onClick?: () => void };
function Table({ columns, rows, testId, numeric = [] }: { columns: string[]; rows: Row[]; testId: string; numeric?: number[] }) {
  return <div className="table-wrap"><table className="table" data-testid={testId}><thead><tr>{columns.map((c, i) => <th key={c} className={numeric.includes(i) ? 'num' : ''}>{c}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={r.key} data-testid={r.testId} className={r.onClick ? 'is-clickable' : ''} onClick={r.onClick}>{r.cells.map((cell, i) => <td key={i} data-label={columns[i]} className={numeric.includes(i) ? 'num' : ''}>{cell}</td>)}</tr>)}</tbody></table></div>;
}
function Badge({ value }: { value: string }) {
  const label = useStatusLabel();
  return <span className={`badge badge-${value.replaceAll('_', '-')}`} data-testid={`status-badge-${value}`}>{label(value)}</span>;
}
function QueryError({ q, id }: { q: { error: unknown; isError: boolean; refetch: () => unknown }; id: string }) {
  const { t } = useI18n();
  if (!q.isError) return null;
  const raw = q.error instanceof Error ? q.error.message : '';
  const status = /HTTP (\d{3})/.exec(raw)?.[1];
  const opaque = !raw || raw === 'Failed to fetch' || /^(factories|alerts|warehouses|rebalance|load)$/i.test(raw);
  const message = opaque ? t('common.loadFailedHint') : status === '404' ? t('common.notAvailable') : /<html|<!doctype/i.test(raw) ? t('common.httpError', { status: status ?? '500' }) : raw;
  return <ErrorState message={message} retry={() => { void q.refetch(); }} id={id}/>;
}
function ImageLightbox({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = previous; };
  }, [onClose]);
  return createPortal(
    <div className="backdrop image-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <figure className="lightbox" onClick={e => e.stopPropagation()}><img src={src} alt={title}/><figcaption>{title}</figcaption><button type="button" className="icon-btn lightbox-close" onClick={onClose} aria-label={t('common.close')}><X size={18}/></button></figure>
    </div>, document.body);
}
function ProductTitle({ product, href }: { product: Product; href?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const meta = [product.code || product.article || t('common.noCode'), product.category].filter(Boolean).join(' · ');
  const copy = <span className="product-copy"><b>{product.name}</b><small>{meta}</small></span>;
  return <div className="product"><button type="button" className="thumb" disabled={!product.imageUrl} onClick={event => { event.stopPropagation(); if (product.imageUrl) setOpen(true); }} aria-label={product.imageUrl ? t('common.openImage', { name: product.name }) : product.name}>{product.imageUrl ? <img src={`${product.imageUrl}?size=mini`} alt="" loading="lazy"/> : <Package size={17}/>}</button>{href ? <Link href={href} onClick={event => event.stopPropagation()}>{copy}</Link> : copy}{open && product.imageUrl && <ImageLightbox src={product.imageUrl} title={product.name} onClose={() => setOpen(false)}/>}</div>;
}
function ProductTable({ products, onOpen, testId = 'table-products' }: { products: Product[]; onOpen?: (product: Product) => void; testId?: string }) {
  const { t, fmt, money } = useI18n(); const unit = useUnit();
  return <Table testId={testId} numeric={[1, 2, 3, 4, 5]} columns={[t('products.col.product'), t('products.col.stock'), t('products.col.available'), t('products.col.price'), t('products.col.sales'), t('products.col.cover'), t('products.col.status')]} rows={products.map(p => ({ key: p.id, testId: `row-product-${p.id}`, onClick: onOpen ? () => onOpen(p) : undefined, cells: [<ProductTitle product={p} href={`/products?search=${encodeURIComponent(p.code || p.name)}`}/>, `${fmt(p.stock)} ${unit(p.unit)}`, `${fmt(p.available)} ${unit(p.unit)}`, money(p.salePrice), fmt(p.sales30), p.daysCover == null ? '—' : `${fmt(p.daysCover)} ${t('common.days')}`, <Badge value={p.stockStatus}/>] }))}/>;
}
function Metric({ label, value, note, icon: Icon, tone = '' }: { label: string; value: string; note: string; icon: typeof Package; tone?: string }) {
  return <div className={`metric ${tone}`}><span className="metric-icon"><Icon size={18}/></span><span className="metric-label">{label}</span><strong>{value}</strong><small>{note}</small></div>;
}
function WarehousesSelect({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }) {
  const { t } = useI18n(); const q = useListWarehouses();
  return <SelectInput value={value} onChange={onChange} testId={testId}><option value="">{t('common.allWarehouses')}</option>{q.data?.map(w => <option value={w.id} key={w.id}>{w.name}</option>)}</SelectInput>;
}

/* ---------- dashboard ---------- */
type WarehouseTotal = { id: string; name: string; units: number; products: number; inTransit: number; value: number };
type DayView = { date: string; sales: number; incoming: number; trend: Array<{ date: string; amount: number }>; documents: Array<{ id: string; kind: string; number: string; date: string; status: string; sourceWarehouse: string | null; targetWarehouse: string | null }> };
function DashboardPage() {
  const { t, lang, fmt, money, date, dateTime } = useI18n(); const docKind = useDocKind();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [day, setDay] = useState(today);
  const q = useGetDashboard({ query: { refetchInterval: AUTO_REFRESH_MS } }); const status = useGetMoyskladStatus(); const sync = useCatalogRefresh();
  const warehouses = useQuery<WarehouseTotal[]>({ queryKey: ['dashboard-warehouses'], queryFn: async () => { const r = await fetch('/api/dashboard/warehouses'); if (!r.ok) throw new Error(t('dash.warehouses.failed')); return r.json(); }, refetchInterval: AUTO_REFRESH_MS });
  const chosen = useQuery<DayView>({ queryKey: ['dashboard-day', day], queryFn: async () => { const r = await fetch(`/api/dashboard/day?date=${day}`); if (!r.ok) throw new Error(t('common.loadFailedHint')); return r.json(); }, retry: 1, refetchInterval: AUTO_REFRESH_MS });
  const sales = useGetSalesAnalytics({ period: '7d' }, { query: { enabled: day === today } });
  const connected = !!status.data?.configured && !!status.data?.connected;
  const d = q.data;
  const shownDay = date(`${day}T12:00:00+05:00`);
  const isToday = day === today;
  const maxUnits = Math.max(1, ...(warehouses.data ?? []).map(w => w.units));
  const trend = chosen.data?.trend?.some(point => point.amount > 0) ? chosen.data.trend : (isToday ? (sales.data?.trend ?? []).map(point => ({ date: point.date, amount: point.amount })) : (chosen.data?.trend ?? []));
  const maxSale = Math.max(1, ...trend.map(x => x.amount));
  const recentDocs = chosen.data?.documents ?? [];
  const liveReady = chosen.data?.date === day;
  const refresh = sync.refresh;
  const attention = d ? [
    { href: '/products', icon: CircleAlert, tone: 'tone-amber', label: t('dash.attention.low'), note: t('dash.attention.low.note'), value: d.lowStockCount as number | null },
    { href: '/non-moving', icon: Clock3, tone: 'tone-slate', label: t('dash.attention.idle'), note: t('dash.attention.idle.note'), value: d.nonMovingCount as number | null },
    { href: '/transfers', icon: ArrowLeftRight, tone: 'tone-blue', label: t('dash.attention.transfers'), note: t('dash.attention.transfers.note'), value: d.pendingTransfers as number | null },
    { href: '/receipts', icon: ArrowDownLeft, tone: 'tone-green', label: isToday ? t('dash.attention.incoming') : t('dash.attention.incomingOn', { date: shownDay }), note: chosen.isError ? t('dash.live.missing') : isToday ? t('dash.attention.incoming.note') : t('dash.attention.incomingOn.note'), value: liveReady ? chosen.data!.incoming : null },
  ] : [];
  const syncKept = sync.isSuccess && sync.data?.error === 'kept-cache';
  const syncFresh = sync.isSuccess && sync.data?.error === 'already-fresh';
  return <div className="dash">
    <header className="page-head"><div><h1>{t('dash.title')}</h1>{d?.lastSync ? <p>{t('dash.catalog.asOf', { date: dateTime(d.lastSync) })}</p> : null}</div><div className="page-actions"><label className="dash-day"><input className="input" type="date" max={today} value={day} onChange={event => setDay(event.target.value && event.target.value <= today ? event.target.value : today)} data-testid="input-dashboard-date" aria-label={t('dash.day')}/></label><ExportButton kind="dashboard" defaultPeriod="today" testId="button-export-dashboard"/><button type="button" className="btn btn-secondary" disabled={sync.pending} onClick={refresh} data-testid="button-sync-dashboard"><RefreshCw size={15} className={sync.pending ? 'spin' : ''}/>{sync.pending ? t('common.refreshing') : t('common.refresh')}</button></div></header>
    <QueryError q={q} id="dashboard"/>
    {status.isError && <Notice kind="error" title={t('dash.notice.statusFailed')} testId="status-integration-error"/>}
    {!status.isLoading && !connected && !status.isError && <Notice kind={status.data?.configured ? 'error' : 'info'} title={status.data?.configured ? t('dash.notice.disconnected') : t('dash.notice.unconfigured')} testId="status-integration-unconfigured">{status.data?.error || t('dash.notice.unconfiguredBody')} <Link href="/settings" className="notice-link" data-testid="link-settings-integration">{t('nav.settings')} <ArrowRight size={14}/></Link></Notice>}
    {!sync.pending && syncFresh && <Notice kind="info" title={t('dash.sync.fresh')} testId="status-sync-fresh"/>}
    {!sync.pending && syncKept && <Notice kind="warning" title={t('dash.sync.kept')} testId="status-sync-kept"/>}
    {!sync.pending && sync.isError && <Notice kind="error" title={t('dash.sync.failed')} testId="status-sync-error">{(() => { const raw = sync.error instanceof Error ? sync.error.message : ''; return /503|502|504|band|unavailable|javob bermadi|kept-cache|HTTP 429/i.test(raw) ? t('dash.sync.busy') : (raw || t('common.tryAgain')); })()}</Notice>}
    {q.isLoading ? <LoadingRows count={3}/> : d ? <>
      <section className="kpis" aria-label={t('dash.title')}>
        <Link href="/products" className="kpi" data-testid="metric-products"><span className="kpi-icon"><Box size={20} strokeWidth={1.75}/></span><span className="kpi-label">{t('dash.kpi.products')}</span><strong>{fmt(d.productCount)}</strong><small>{t('dash.kpi.products.note')}</small></Link>
        <Link href="/stock" className="kpi" data-testid="metric-units"><span className="kpi-icon tone-green"><Layers size={20} strokeWidth={1.75}/></span><span className="kpi-label">{t('dash.kpi.units')}</span><strong>{fmt(d.stockUnits)}</strong><small>{t('dash.kpi.units.note', { count: warehouses.data?.length ?? '—' })}</small></Link>
        <div className="kpi" data-testid="metric-value"><span className="kpi-icon tone-amber"><Wallet size={20} strokeWidth={1.75}/></span><span className="kpi-label">{t('dash.kpi.value')}</span><strong>{money(d.stockValue)}</strong><small>{t('dash.kpi.value.note')}</small></div>
        <Link href="/analytics" className="kpi" data-testid="metric-sales"><span className="kpi-icon tone-blue"><ChartColumn size={20} strokeWidth={1.75}/></span><span className="kpi-label">{isToday ? t('dash.kpi.sales') : t('dash.kpi.salesOn', { date: shownDay })}</span><strong>{liveReady ? money(chosen.data!.sales) : chosen.isError ? '—' : '…'}</strong><small>{chosen.isError ? t('dash.live.missing') : isToday ? t('dash.kpi.sales.note') : t('dash.kpi.salesOn.note')}</small></Link>
      </section>
      <div className="dash-grid">
        <div className="dash-col">
          <Card title={t('dash.warehouses')} meta={warehouses.data ? t('dash.warehouses.meta', { count: warehouses.data.length }) : ''}>
            {warehouses.isLoading ? <LoadingRows count={4}/> : warehouses.isError ? <p className="muted">{t('dash.warehouses.failed')}</p> : <ul className="wh-list">{warehouses.data?.map(w => <li key={w.id}><Link href={`/stock?warehouseId=${w.id}`} className="wh-row" data-testid={`warehouse-${w.id}`}><span className="wh-name"><Warehouse size={15}/><b>{w.name}</b></span><span className="wh-bar"><i style={{ width: `${Math.max(2, (w.units / maxUnits) * 100)}%` }}/></span><span className="wh-num">{fmt(w.units)}<small>{t('dash.warehouses.types', { count: fmt(w.products) })}{w.inTransit > 0 ? ` · ${t('dash.warehouses.inTransit', { count: fmt(w.inTransit) })}` : ''}</small></span></Link></li>)}</ul>}
          </Card>
          <Card title={t('dash.docs')} action={<Link href="/receipts" className="link" data-testid="link-all-documents">{t('dash.docs.all')} <ArrowRight size={13}/></Link>}>
            {chosen.isLoading && !chosen.data ? <LoadingRows count={3}/> : chosen.isError ? <p className="muted">{t('common.loadFailedHint')}</p> : recentDocs.length ? <ul className="doc-list">{recentDocs.map(doc => <li key={doc.id} className="doc-row" data-testid={`doc-${doc.id}`}><span className={`doc-icon doc-${doc.kind}`}>{doc.kind === 'receipt' ? <ArrowDownLeft size={15}/> : doc.kind === 'transfer' ? <ArrowLeftRight size={15}/> : <Banknote size={15}/>}</span><span className="doc-copy"><b>{docKind(doc.kind)} № {doc.number}</b><small>{[doc.sourceWarehouse, doc.targetWarehouse].filter(Boolean).join(' → ') || '—'}</small></span><span className="doc-meta"><Badge value={doc.status}/><small>{date(doc.date)}</small></span></li>)}</ul> : <p className="muted">{t('dash.docs.empty')}</p>}
          </Card>
        </div>
        <div className="dash-col">
          <Card title={t('dash.attention')} meta={t('common.today')}>
            <ul className="attn-list">{attention.map(a => { const Icon = a.icon; return <li key={a.href}><Link href={a.href} className="attn-row" data-testid={`link-${a.href.slice(1)}`}><span className={`attn-icon ${a.tone}`}><Icon size={17}/></span><span className="attn-copy"><b>{a.label}</b><small>{a.note}</small></span><strong className={a.value != null && a.value <= 0 ? 'is-zero' : ''}>{a.value == null ? (chosen.isError && a.href === '/receipts' ? '—' : '…') : fmt(a.value)}</strong><ChevronRight size={16} className="attn-chev"/></Link></li>; })}</ul>
          </Card>
          <Card title={isToday ? t('dash.sales7') : t('dash.sales7.on', { date: shownDay })} meta={trend.length ? money(trend.reduce((sum, point) => sum + point.amount, 0)) : ''}>
            {(chosen.isLoading || sales.isLoading) && !trend.length ? <LoadingRows count={2}/> : trend.length ? <><div className="spark" role="img" aria-label={t('dash.sales7.chart')}>{trend.map(x => <div key={x.date} className="spark-col" title={`${date(x.date)} · ${money(x.amount)}`}><i style={{ height: `${Math.max(3, (x.amount / maxSale) * 100)}%` }}/><span>{weekdayShort(lang, x.date)}</span></div>)}</div><div className="spark-foot"><span>{t('dash.sales7.avg')}</span><b>{money(trend.reduce((sum, point) => sum + point.amount, 0) / trend.length)}</b></div></> : <p className="muted">{t('dash.sales7.empty')}</p>}
          </Card>
        </div>
      </div>
    </> : <EmptyState title={t('dash.empty.title')} body={t('dash.empty.body')} icon={LayoutDashboard}/>}
  </div>;
}

/* ---------- products ---------- */

function moneyDigits(value: string) {
  return value.replace(/[^\d]/g, '');
}

const PRODUCT_ADD_MEMORY = 'bordo.product-add';
const DEFAULT_MARKUP = { Premium: 5, Exclusive: 10, Standard: 13 };
const SALE_TYPES = ['Premium', 'Exclusive', 'Standard'] as const;
type SaleType = typeof SALE_TYPES[number];
type SaleMarkup = { Premium: number; Exclusive: number; Standard: number };
function asMarkup(data: Partial<SaleMarkup> | null | undefined): SaleMarkup {
  const one = (value: unknown, fallback: number) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 0 && n <= 99 ? n : fallback;
  };
  return {
    Premium: one(data?.Premium, DEFAULT_MARKUP.Premium),
    Exclusive: one(data?.Exclusive, DEFAULT_MARKUP.Exclusive),
    Standard: one(data?.Standard, DEFAULT_MARKUP.Standard),
  };
}
type ProductAddMemory = { factoryCode?: string; packSize?: string };
function readProductAddMemory(): ProductAddMemory {
  try { return JSON.parse(localStorage.getItem(PRODUCT_ADD_MEMORY) || '{}') as ProductAddMemory; } catch { return {}; }
}
type FamilyLock = { markups: Partial<SaleMarkup>; found: boolean; sales: Partial<Record<SaleType, number>> };
type PctMap = Record<SaleType, string>;
function markedSale(cost: number, pct: number) {
  if (!(cost > 0) || pct < 0) return 0;
  return Math.round(cost * (100 + pct) / 100);
}
function pctDigits(value: string) {
  return value.replace(/[^\d]/g, '').slice(0, 2);
}
function parsePctText(value: string) {
  if (value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 99 ? n : null;
}
function defaultPctMap(markup: SaleMarkup): PctMap {
  return { Premium: String(markup.Premium), Exclusive: String(markup.Exclusive), Standard: String(markup.Standard) };
}

function ProductAddDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (name: string) => void }) {
  const { t } = useI18n();
  const remembered = readProductAddMemory();
  const [draft, setDraft] = useState({ factoryCode: remembered.factoryCode || '', groupCode: '', productCode: '', size: '', packSize: remembered.packSize || '', cost: '', barcode: '' });
  const [markup, setMarkup] = useState<SaleMarkup>(DEFAULT_MARKUP);
  const [pctTexts, setPctTexts] = useState<PctMap>(() => defaultPctMap(DEFAULT_MARKUP));
  const [family, setFamily] = useState<FamilyLock | null>(null);
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState('');
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [folderId, setFolderId] = useState('');
  const [factory, setFactory] = useState({ found: false, ready: true, name: '', supplierId: '', supplierName: '' });
  useEffect(() => {
    void fetch('/api/settings/markup').then(response => response.ok ? response.json() : null).then((data: Partial<SaleMarkup> | null) => {
      if (!data) return;
      const next = asMarkup(data);
      setMarkup(next);
      setPctTexts(current => {
        const filled = { ...current };
        for (const type of SALE_TYPES) {
          if (filled[type] === '' || filled[type] === String(DEFAULT_MARKUP[type])) filled[type] = String(next[type]);
        }
        return filled;
      });
    }).catch(() => undefined);
    void fetch('/api/products/folders').then(response => response.json()).then(data => setFolders(Array.isArray(data.items) ? data.items : [])).catch(() => setFolders([]));
    void fetch('/api/products/next-barcode').then(response => response.json()).then((data: { barcode?: string }) => {
      if (data.barcode) setDraft(current => current.barcode ? current : { ...current, barcode: data.barcode || '' });
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    const code = draft.factoryCode.trim();
    if (code.length < 2) {
      setFactory({ found: false, ready: true, name: '', supplierId: '', supplierName: '' });
      return;
    }
    let cancelled = false;
    setFactory({ found: false, ready: false, name: '', supplierId: '', supplierName: '' });
    const timer = window.setTimeout(() => {
      void fetch(`/api/products/factory-setup?code=${encodeURIComponent(code)}`).then(response => response.json()).then((data: { found?: boolean; name?: string; supplierId?: string; supplierName?: string }) => {
        if (cancelled) return;
        setFactory({
          found: Boolean(data.found),
          ready: true,
          name: data.name || '',
          supplierId: data.supplierId || '',
          supplierName: data.supplierName || data.name || '',
        });
      }).catch(() => {
        if (!cancelled) setFactory({ found: false, ready: true, name: '', supplierId: '', supplierName: '' });
      });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [draft.factoryCode]);
  useEffect(() => {
    const code = draft.groupCode.trim() || draft.productCode.trim();
    if (code.length < 2) return;
    const timer = window.setTimeout(() => {
      void fetch(`/api/products/suggest?code=${encodeURIComponent(code)}`).then(response => response.json()).then((data: { folderId?: string; packSize?: number | null }) => {
        if (data.folderId) {
          const group = draft.groupCode.trim();
          setFolderId(current => (group && code === group ? data.folderId || current : current || data.folderId || ''));
        }
        if (data.packSize) setDraft(current => current.packSize ? current : { ...current, packSize: String(data.packSize) });
      }).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draft.groupCode, draft.productCode]);
  useEffect(() => {
    const factory = draft.factoryCode.trim();
    const group = draft.groupCode.trim();
    const code = draft.productCode.trim();
    const size = draft.size.trim();
    if (!factory || !code) {
      setFamily(null);
      return;
    }
    const qs = new URLSearchParams({ factory, code });
    if (group) qs.set('group', group);
    if (size) qs.set('size', size);
    const timer = window.setTimeout(() => {
      void fetch(`/api/products/passport?${qs}`).then(response => response.ok ? response.json() : null).then((data: { found?: boolean; markups?: Partial<SaleMarkup>; sales?: Partial<Record<SaleType, number>>; priceType?: string; markupPct?: number | null; packSize?: number | null; cost?: number | null } | null) => {
        const inherited: Partial<SaleMarkup> = { ...(data?.markups ?? {}) };
        if (!SALE_TYPES.some(type => inherited[type] != null) && data?.priceType && data.priceType in DEFAULT_MARKUP && data.markupPct != null) {
          inherited[data.priceType as SaleType] = data.markupPct;
        }
        const hasInherited = SALE_TYPES.some(type => inherited[type] != null);
        if (!hasInherited && !data?.found) {
          setFamily(null);
          return;
        }
        setFamily({ markups: inherited, found: Boolean(data?.found), sales: data?.sales ?? {} });
        setPctTexts(current => {
          const next = { ...current };
          for (const type of SALE_TYPES) {
            if (inherited[type] != null) next[type] = String(inherited[type]);
          }
          return next;
        });
        if (data?.found) {
          setDraft(current => ({
            ...current,
            ...(!current.packSize && data.packSize && data.packSize > 1 ? { packSize: String(data.packSize) } : {}),
            ...(!current.cost && data.cost && data.cost > 0 ? { cost: String(data.cost) } : {}),
          }));
        }
      }).catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [draft.factoryCode, draft.groupCode, draft.productCode, draft.size]);
  const factoryCode = draft.factoryCode.trim().replace(/\s+/g, ' ').toLocaleUpperCase('ru-RU');
  const groupCode = draft.groupCode.trim().replace(/\s+/g, ' ').toLocaleUpperCase('ru-RU');
  const productCode = draft.productCode.trim().replace(/\s+/g, ' ').toLocaleUpperCase('ru-RU');
  const nameRest = [factoryCode, groupCode, productCode, draft.size].filter(Boolean).join(' ');
  const name = ['Bordo', nameRest].filter(Boolean).join(' ');
  const cost = draft.cost.trim() ? Number(draft.cost) : null;
  const markups: SaleMarkup = {
    Premium: family?.markups.Premium ?? parsePctText(pctTexts.Premium) ?? markup.Premium,
    Exclusive: family?.markups.Exclusive ?? parsePctText(pctTexts.Exclusive) ?? markup.Exclusive,
    Standard: family?.markups.Standard ?? parsePctText(pctTexts.Standard) ?? markup.Standard,
  };
  const sales: Record<SaleType, number> = {
    Premium: family?.found && family.sales.Premium ? family.sales.Premium : (cost != null ? markedSale(cost, markups.Premium) : 0),
    Exclusive: family?.found && family.sales.Exclusive ? family.sales.Exclusive : (cost != null ? markedSale(cost, markups.Exclusive) : 0),
    Standard: family?.found && family.sales.Standard ? family.sales.Standard : (cost != null ? markedSale(cost, markups.Standard) : 0),
  };
  const pctReady = SALE_TYPES.every(type => parsePctText(family?.markups[type] != null ? String(family.markups[type]) : pctTexts[type]) != null);
  const canSave = factory.found && factoryCode.length >= 2 && Boolean(groupCode) && Boolean(draft.size) && cost != null && cost > 0 && pctReady && !saving;
  const saveProduct = async () => {
    if (!canSave || cost == null) return;
    if (!Number.isFinite(cost) || cost < 0) {
      setAddError(t('products.addFailed'));
      return;
    }
    setSaving(true);
    setAddError('');
    try {
      const response = await fetch('/api/products', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          factoryCode,
          groupCode,
          productCode,
          size: draft.size,
          packSize: draft.packSize.trim() ? Number(draft.packSize) : null,
          cost,
          markups,
          barcode: draft.barcode.trim(),
          folderId,
          supplierId: factory.supplierId,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: '' })) as { error?: string };
        throw new Error(body.error === 'factory_missing' ? `${t('products.factoryMissing')} ${t('products.factoryMissing.action')}` : t('products.addFailed'));
      }
      localStorage.setItem(PRODUCT_ADD_MEMORY, JSON.stringify({ factoryCode }));
      onSaved(name);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : t('products.addFailed'));
    } finally { setSaving(false); }
  };
  const setText = (key: 'factoryCode' | 'groupCode' | 'productCode' | 'barcode' | 'packSize') => (event: React.ChangeEvent<HTMLInputElement>) => setDraft(current => ({ ...current, [key]: key === 'packSize' ? moneyDigits(event.target.value) : key === 'barcode' ? event.target.value : event.target.value.replace(/[^\S\n]+/g, ' ').replace(/^\s+/g, '').toLocaleUpperCase('ru-RU') }));
  const factoryMissing = factory.ready && draft.factoryCode.trim().length >= 2 && !factory.found;
  return createPortal(<div className="backdrop" onClick={() => { if (!saving) onClose(); }}><form className="modal product-add" onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void saveProduct(); }} role="dialog" aria-labelledby="product-add-title">
    <div className="modal-top"><div><p className="eyebrow">{t('products.title')}</p><h2 id="product-add-title">{t('products.addTitle')}</h2></div><button className="icon-btn" type="button" onClick={onClose} aria-label={t('common.close')} data-testid="button-close-add-product"><X size={18}/></button></div>
    <div className="form-grid">
      <label className="field span-2">{t('products.field.name')}<span className="name-lock"><TextInput testId="input-product-brand" className="input-locked" value={t('zavod.brand')} readOnly tabIndex={-1}/><TextInput testId="input-product-name" className="input-locked" value={nameRest} readOnly tabIndex={-1}/></span></label>
      <label className="field">{t('zavod.factoryCode')}<TextInput testId="input-product-factory" value={draft.factoryCode} onChange={setText('factoryCode')} autoCapitalize="characters" autoFocus/></label>
      <label className="field">{t('products.field.supplier')}<TextInput testId="input-product-supplier" className="input-locked" value={factory.supplierName} readOnly tabIndex={-1}/></label>
      {factoryMissing ? <p className="field-note" data-testid="status-factory-missing">{t('products.factoryMissing')} <Link href="/partners" className="notice-link" onClick={onClose}>{t('products.factoryMissing.action')}</Link></p> : null}
      <label className="field">{t('zavod.groupCode')}<TextInput testId="input-product-group" value={draft.groupCode} onChange={setText('groupCode')} autoCapitalize="characters"/></label>
      <label className="field">{t('zavod.product')}<TextInput testId="input-product-code" value={draft.productCode} onChange={setText('productCode')} autoCapitalize="characters"/></label>
      <label className="field">{t('products.field.size')}<select className="input" value={draft.size} onChange={event => setDraft(current => ({ ...current, size: event.target.value }))} data-testid="select-product-size"><option value="">{t('products.sizeEmpty')}</option>{BORDO_SIZES.map(size => <option key={size} value={size}>{size}</option>)}</select></label>
      <label className="field">{t('products.field.pack')}<TextInput testId="input-product-pack" inputMode="numeric" value={draft.packSize} onChange={setText('packSize')}/></label>
      <label className="field">{t('products.field.cost')}<TextInput testId="input-product-cost" inputMode="numeric" value={draft.cost} onChange={event => setDraft(current => ({ ...current, cost: moneyDigits(event.target.value) }))}/></label>
      <label className="field">{t('products.field.barcode')}<TextInput testId="input-product-barcode" inputMode="numeric" value={draft.barcode} onChange={setText('barcode')} placeholder={t('products.barcodeAuto')}/></label>
      <div className="field span-2 sale-triple" data-testid="product-sale-triple">
        <span>{t('products.field.prices')}</span>
        {SALE_TYPES.map(type => {
          const locked = Boolean(family?.found) || family?.markups[type] != null;
          return <label className="sale-triple-row" key={type}>
            <b>{type}</b>
            <span className="pct-box">
              <input className={`input ${locked ? 'input-locked' : ''}`} inputMode="numeric" disabled={locked} value={family?.markups[type] != null ? String(family.markups[type]) : pctTexts[type]} onChange={event => setPctTexts(current => ({ ...current, [type]: pctDigits(event.target.value) }))} onFocus={event => event.target.select()} aria-label={`${type} ${t('products.field.markup')}`} data-testid={`input-product-markup-${type.toLowerCase()}`}/><span>%</span>
            </span>
            <TextInput testId={`input-product-sale-${type.toLowerCase()}`} className="input-locked" value={sales[type] > 0 ? String(sales[type]) : ''} readOnly tabIndex={-1} aria-label={`${type} ${t('products.field.sale')}`}/>
          </label>;
        })}
      </div>
      <label className="field">{t('products.field.folder')}<select className="input" value={folderId} onChange={event => setFolderId(event.target.value)} data-testid="select-product-folder"><option value="">{t('products.folderEmpty')}</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
    </div>
    {addError && <p className="error-text" data-testid="status-product-add-error">{addError}</p>}
    <div className="form-actions"><Button testId="button-save-product" type="submit" disabled={!canSave}>{saving ? t('products.saving') : t('products.saved')}</Button><Button variant="secondary" testId="button-cancel-product" disabled={saving} onClick={onClose}>{t('common.cancel')}</Button></div>
  </form></div>, document.body);
}

function ProductsPage() {
  const { t, fmt, money } = useI18n(); const unit = useUnit();
  const urlQuery = new URLSearchParams(useSearch() || window.location.search);
  const urlSearch = urlQuery.get('search') || '';
  const productId = urlQuery.get('product') || '';
  const [search, setSearch] = useState(urlSearch); const [stockStatus, setStatus] = useState('all'); const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Product | null>(null);
  useEffect(() => { setSearch(urlSearch); setPage(1); }, [urlSearch]);
  useEffect(() => {
    if (!productId) return;
    let stop = false;
    void fetch(`/api/products/${encodeURIComponent(productId)}`).then(response => response.ok ? response.json() : null).then((data: Product | null) => {
      if (stop || !data?.id) return;
      setSelected(data);
      setSearch(data.code || data.name);
      setPage(1);
    }).catch(() => undefined);
    return () => { stop = true; };
  }, [productId]);
  const params = useMemo(() => ({ search: search || undefined, stockStatus: stockStatus as 'all'|'low'|'available'|'out', page, pageSize: 25 }), [search, stockStatus, page]);
  const q = useListProducts(params); const cache = useQueryClient();
  const dash = useGetDashboard(); const sync = useCatalogRefresh();
  const [adding, setAdding] = useState(false);
  const refresh = sync.refresh;
  return <>
    <PageHead title={t('products.title')}/>
    {dash.data && <div className="product-kpis">
      <div><span>{t('dash.kpi.products')}</span><b>{fmt(dash.data.productCount)}</b></div>
      <div><span>{t('products.filter.low')}</span><b>{fmt(dash.data.lowStockCount)}</b></div>
      <div><span>{t('status.non_moving')}</span><b>{fmt(dash.data.nonMovingCount)}</b></div>
      <div><span>{t('dash.kpi.value')}</span><b>{money(dash.data.stockValue)}</b></div>
    </div>}
    <div className="toolbar"><label className="search"><Search size={17}/><TextInput testId="input-products-search" type="search" placeholder={t('products.searchPlaceholder')} value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}/></label><label className="select-wrap"><Filter size={15}/><SelectInput testId="select-products-status" value={stockStatus} onChange={v => { setStatus(v); setPage(1); }}><option value="all">{t('products.filter.all')}</option><option value="low">{t('products.filter.low')}</option><option value="available">{t('products.filter.available')}</option><option value="out">{t('products.filter.out')}</option></SelectInput></label><ExportButton kind="products"/><Button testId="button-add-product" onClick={() => setAdding(true)}><Plus size={15}/>{t('products.add')}</Button><Button variant="secondary" testId="button-products-refresh" disabled={sync.pending} onClick={refresh}><RefreshCw size={15} className={sync.pending ? 'spin' : ''}/>{sync.pending ? t('common.refreshing') : t('common.refresh')}</Button></div>
    <QueryError q={q} id="products"/>
    <Card className="table-card" title={t('products.catalog')} meta={q.data ? t('products.results', { count: fmt(q.data.total) }) : ''}>
      {q.isLoading ? <LoadingRows/> : q.data?.items.length ? <><ProductTable products={q.data.items} onOpen={setSelected}/><div className="pager"><span>{t('products.range', { total: fmt(q.data.total), from: fmt(Math.min((page - 1) * q.data.pageSize + 1, q.data.total)), to: fmt(Math.min(page * q.data.pageSize, q.data.total)) })}</span><div className="pager-nav"><button className="icon-btn" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={t('common.prevPage')} data-testid="button-products-prev"><ChevronLeft size={17}/></button><span>{page}</span><button className="icon-btn" disabled={page * q.data.pageSize >= q.data.total} onClick={() => setPage(page + 1)} aria-label={t('common.nextPage')} data-testid="button-products-next"><ChevronRight size={17}/></button></div></div></> : <EmptyState title={search ? t('products.empty.search') : t('products.empty.title')} body={search ? t('products.empty.searchBody') : t('products.empty.body')}/>}
    </Card>
    {adding && <ProductAddDialog onClose={() => setAdding(false)} onSaved={name => { setAdding(false); setSearch(name); setPage(1); void cache.invalidateQueries(); }}/>}
    {selected && createPortal(<div className="backdrop" onClick={() => setSelected(null)}><div className="modal product-modal" onClick={e => e.stopPropagation()} role="dialog" aria-labelledby="product-detail-title"><div className="modal-top"><div><p className="eyebrow">{t('products.detail')}</p><h2 id="product-detail-title">{selected.name}</h2></div><button className="icon-btn" onClick={() => setSelected(null)} aria-label={t('common.close')} data-testid="button-close-product"><X size={18}/></button></div>
      <div className="product-sheet">{selected.imageUrl ? <img src={selected.imageUrl} alt=""/> : <span className="product-sheet-empty"><Package size={28}/></span>}<div><Badge value={selected.stockStatus}/><p className="muted">{[selected.code, selected.article].filter(Boolean).join(' · ') || t('common.noCode')}</p></div></div>
      <div className="detail-grid">
        <div><small>{t('products.detail.category')}</small><b>{selected.category || '—'}</b></div>
        <div><small>{t('products.detail.factory')}</small><b>{selected.factory || '—'}</b></div>
        <div><small>{t('products.detail.stock')}</small><b>{fmt(selected.stock)} {unit(selected.unit)}</b></div>
        <div><small>{t('products.detail.available')}</small><b>{fmt(selected.available)} {unit(selected.unit)}</b></div>
        <div><small>{t('products.detail.price')}</small><b>{money(selected.salePrice)}</b></div>
        <div><small>{t('products.detail.cost')}</small><b>{money(selected.cost)}</b></div>
        <div><small>{t('products.detail.sales')}</small><b>{fmt(selected.sales30)} {unit(selected.unit)}</b></div>
        <div><small>{t('products.detail.daily')}</small><b>{fmt(selected.sales30 / 30, 2)} {unit(selected.unit)}</b></div>
        <div><small>{t('products.detail.cover')}</small><b>{selected.daysCover == null ? t('products.detail.noSales') : `${fmt(selected.daysCover)} ${t('common.days')}`}</b></div>
        <div><small>{t('products.detail.windows')}</small><b>{fmt(selected.sales7)} / {fmt(selected.sales30)} / {fmt(selected.sales90)}</b></div>
      </div>
      <div className="codes"><b>{t('products.barcodes')}</b>{selected.barcodes.length ? selected.barcodes.map(c => <code key={c}>{c}</code>) : <span>{t('products.noBarcode')}</span>}</div>
    </div></div>, document.body)}
  </>;
}

/* ---------- stock ---------- */
function stockRowStatus(quantity: number, productStatus: string) {
  if (quantity < 0) return 'negative';
  if (quantity === 0) return 'in-transit';
  if (quantity <= 3) return 'low';
  if (productStatus === 'non_moving') return 'non_moving';
  return 'healthy';
}

function StockPage() {
  const { t, fmt, money } = useI18n(); const unit = useUnit();
  const searchParams = useSearch();
  const [, setLocation] = useLocation();
  const warehouseId = new URLSearchParams(searchParams).get('warehouseId') || '';
  const urlSearch = new URLSearchParams(searchParams).get('search') || '';
  const [search, setSearch] = useState(urlSearch);
  const [page, setPage] = useState(1);
  useEffect(() => { setSearch(urlSearch); setPage(1); }, [urlSearch]);
  const params = useMemo(() => ({ warehouseId: warehouseId || undefined, search: search || undefined, page, pageSize: 50 }), [warehouseId, search, page]);
  const q = useListStock(params);
  const sync = useCatalogRefresh();
  const warehouses = useQuery<WarehouseTotal[]>({ queryKey: ['dashboard-warehouses'], queryFn: async () => { const response = await fetch('/api/dashboard/warehouses'); if (!response.ok) throw new Error('warehouses'); return response.json(); } });
  const chosen = warehouses.data?.find(item => item.id === warehouseId);
  const summary = chosen ?? (warehouses.data ? warehouses.data.reduce((sum, item) => ({ id: 'all', name: '', units: sum.units + item.units, products: sum.products + item.products, inTransit: sum.inTransit + item.inTransit, value: sum.value + item.value }), { id: 'all', name: '', units: 0, products: 0, inTransit: 0, value: 0 }) : null);
  const refresh = sync.refresh;
  const chooseWarehouse = (id: string) => { setPage(1); setLocation(id ? `/stock?warehouseId=${encodeURIComponent(id)}` : '/stock'); };
  return <>
    <PageHead title={t('stock.title')}/>
    {summary && <div className="product-kpis">
      <div><span>{t('dash.kpi.units')}</span><b>{fmt(summary.units)}</b></div>
      <div><span>{t('dash.kpi.products')}</span><b>{fmt(summary.products)}</b></div>
      <div><span>{t('stock.col.inTransit')}</span><b>{fmt(summary.inTransit)}</b></div>
      <div><span>{t('stock.col.value')}</span><b>{money(summary.value)}</b></div>
    </div>}
    <div className="toolbar"><label className="search"><Search size={17}/><TextInput testId="input-stock-search" placeholder={t('stock.searchPlaceholder')} value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}/></label><label className="select-wrap"><Warehouse size={16}/><WarehousesSelect value={warehouseId} onChange={chooseWarehouse} testId="select-stock-warehouse"/></label><ExportButton kind="stock"/><Button variant="secondary" testId="button-stock-refresh" disabled={sync.pending} onClick={refresh}><RefreshCw size={15} className={sync.pending ? 'spin' : ''}/>{sync.pending ? t('common.refreshing') : t('common.refresh')}</Button></div>
    <QueryError q={q} id="stock"/>
    <Card className="table-card" title={t('stock.panel')} meta={q.data ? t('stock.rows', { count: fmt(q.data.total) }) : ''}>
      {q.isLoading ? <LoadingRows/> : q.data?.items.length ? <><Table testId="table-stock" numeric={[2, 3, 4]} columns={[t('common.product'), t('stock.col.warehouse'), t('stock.col.quantity'), t('stock.col.inTransit'), t('stock.col.value'), t('common.status')]} rows={q.data.items.map(row => ({ key: `${row.product.id}-${row.warehouse.id}`, testId: `row-stock-${row.product.id}-${row.warehouse.id}`, cells: [<ProductTitle product={row.product} href={`/products?search=${encodeURIComponent(row.product.code || row.product.name)}`}/>, <span className="cell-two"><b>{row.warehouse.name}</b>{(row.warehouse.code || row.warehouse.address) && <small>{row.warehouse.code || row.warehouse.address}</small>}</span>, <span className={row.quantity < 0 ? 'qty-neg' : ''}>{fmt(row.quantity)} {unit(row.product.unit)}</span>, `${fmt(row.inTransit)} ${unit(row.product.unit)}`, money(row.value), <Badge value={stockRowStatus(row.quantity, row.product.stockStatus)}/>] }))}/><div className="pager"><span>{t('products.range', { total: fmt(q.data.total), from: fmt(Math.min((page - 1) * q.data.pageSize + 1, q.data.total)), to: fmt(Math.min(page * q.data.pageSize, q.data.total)) })}</span><div className="pager-nav"><button className="icon-btn" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={t('common.prevPage')} data-testid="button-stock-prev"><ChevronLeft size={17}/></button><span>{page}</span><button className="icon-btn" disabled={page * q.data.pageSize >= q.data.total} onClick={() => setPage(page + 1)} aria-label={t('common.nextPage')} data-testid="button-stock-next"><ChevronRight size={17}/></button></div></div></> : <EmptyState title={t('stock.empty.title')} body={t('stock.empty.body')} icon={Warehouse}/>}
    </Card>
  </>;
}

/* ---------- analytics ---------- */
function AnalyticsPage() {
  const { t, lang, fmt, money, date } = useI18n();
  const [period, setPeriod] = useState('30d'); const [warehouse, setWarehouse] = useState('');
  const params = useMemo(() => ({ period: period as '7d'|'30d'|'90d'|'365d', warehouseId: warehouse || undefined }), [period, warehouse]);
  const q = useGetSalesAnalytics(params);
  const max = Math.max(1, ...(q.data?.trend.map(p => p.amount) || []));
  const periodLabel = t(`analytics.period.${period}` as TKey);
  return <>
    <PageHead title={t('analytics.title')} subtitle={t('analytics.sub')}/>
    <div className="toolbar sales-toolbar"><label className="select-wrap"><SlidersHorizontal size={15}/><SelectInput value={period} onChange={setPeriod} testId="select-analytics-period">{(['7d', '30d', '90d', '365d'] as const).map(p => <option key={p} value={p}>{t(`analytics.period.${p}` as TKey)}</option>)}</SelectInput></label><label className="select-wrap"><Warehouse size={16}/><WarehousesSelect value={warehouse} onChange={setWarehouse} testId="select-analytics-warehouse"/></label><ExportButton kind="sales" defaultPeriod={period === '7d' ? 'days7' : period === '30d' ? 'thisMonth' : 'all'}/></div>
    <QueryError q={q} id="analytics"/>
    {q.isLoading ? <LoadingRows count={5}/> : q.data ? <>
      <div className="metrics metrics-3"><Metric label={t('analytics.total')} value={money(q.data.totalAmount)} note={periodLabel} icon={BarChart3} tone="tone-blue"/><Metric label={t('analytics.qty')} value={fmt(q.data.totalQuantity)} note={t('analytics.qty.note')} icon={Package}/><Metric label={t('analytics.avg')} value={money(q.data.averagePerDay)} note={t('analytics.avg.note')} icon={Activity} tone="tone-green"/></div>
      <Card title={t('analytics.trend')} meta={periodLabel}>
        <div className="sales-plot" data-testid="chart-sales-trend">
          <div className="sales-bars">{q.data.trend.map((p, i) => <div key={`${p.date}-${i}`} className="sales-bar" data-testid={`bar-sales-${p.date}`} title={`${date(p.date)} · ${money(p.amount)}`}><i style={{ height: `${Math.max(p.amount > 0 ? 3 : 0, (p.amount / max) * 100)}%` }}/></div>)}</div>
          <div className="sales-axis">{q.data.trend.map((p, i) => { const step = q.data!.trend.length <= 8 ? 1 : q.data!.trend.length <= 16 ? 2 : q.data!.trend.length <= 40 ? 5 : Math.ceil(q.data!.trend.length / 8); const show = i % step === 0; return <span key={`${p.date}-axis`}>{show ? (q.data!.trend.length <= 7 ? weekdayShort(lang, p.date) : formatShortDay(lang, p.date)) : ''}</span>; })}</div>
        </div>
      </Card>
      <Card title={t('analytics.top')} meta={t('analytics.top.meta', { count: q.data.topProducts.length })}>{q.data.topProducts.length ? <ul className="sales-leaders">{q.data.topProducts.map((p, i) => <li key={p.id} data-testid={`row-top-product-${p.id}`}><span className="rank">{String(i + 1).padStart(2, '0')}</span><ProductTitle product={p} href={`/products?search=${encodeURIComponent(p.code || p.name)}`}/><span className="rank-val">{fmt(p.sales30)}<small>{t('analytics.top.sales')}</small></span></li>)}</ul> : <EmptyState title={t('analytics.top.empty')} body={t('analytics.top.emptyBody')}/>}</Card>
    </> : <EmptyState title={t('analytics.empty.title')} body={t('analytics.empty.body')} icon={BarChart3}/>}
  </>;
}

/* ---------- non-moving ---------- */
function NonMovingPage() {
  const { t, fmt, money } = useI18n();
  const unit = useUnit();
  const [days, setDays] = useState('30');
  const [warehouse, setWarehouse] = useState('');
  const [search, setSearch] = useState('');
  const params = useMemo(() => ({ days: Number(days) as 7|30|90, warehouseId: warehouse || undefined }), [days, warehouse]);
  const q = useGetNonMovingProducts(params);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (q.data ?? [])
      .filter(product => !needle || `${product.name} ${product.code || ''} ${product.article || ''}`.toLowerCase().includes(needle))
      .slice()
      .sort((a, b) => (b.stock * (b.salePrice ?? 0)) - (a.stock * (a.salePrice ?? 0)) || b.stock - a.stock);
  }, [q.data, search]);
  const stock = rows.reduce((sum, product) => sum + product.stock, 0);
  const value = rows.reduce((sum, product) => sum + product.stock * (product.salePrice ?? 0), 0);
  const idleWindow = (product: { sales30: number; sales90: number }) => product.sales30 > 0 ? 7 : product.sales90 > 0 ? 30 : 90;
  return <>
    <PageHead title={t('idle.title')} subtitle={t('idle.sub')}/>
    <div className="toolbar idle-toolbar"><label className="search"><Search size={16}/><TextInput testId="input-idle-search" placeholder={t('idle.search')} value={search} onChange={event => setSearch(event.target.value)}/></label><label className="select-wrap"><Clock3 size={15}/><SelectInput value={days} onChange={setDays} testId="select-idle-days">{['7', '30', '90'].map(d => <option key={d} value={d}>{t('idle.since', { days: d })}</option>)}</SelectInput></label><label className="select-wrap"><Warehouse size={16}/><WarehousesSelect value={warehouse} onChange={setWarehouse} testId="select-idle-warehouse"/></label><ExportButton kind="nonMoving"/></div>
    <QueryError q={q} id="non-moving"/>
    {q.isLoading ? <LoadingRows/> : <>
      <div className="metrics metrics-3"><Metric label={t('idle.kpi.products')} value={fmt(rows.length)} note={t('idle.since', { days })} icon={Clock3} tone="tone-amber"/><Metric label={t('idle.kpi.stock')} value={fmt(stock)} note={t('idle.kpi.stockNote')} icon={Package}/><Metric label={t('idle.kpi.value')} value={money(value)} note={t('idle.kpi.valueNote')} icon={Banknote} tone="tone-blue"/></div>
      {rows.length ? <Card className="table-card" title={t('idle.panel')} meta={t('idle.count', { count: fmt(rows.length) })}><Table testId="table-non-moving" numeric={[1, 2, 3, 4, 5]} columns={[t('common.product'), t('idle.col.stock'), t('idle.col.value'), t('idle.col.d7'), t('idle.col.d30'), t('idle.col.d90'), t('idle.col.window')]} rows={rows.map(product => ({ key: product.id, testId: `row-idle-${product.id}`, cells: [<ProductTitle product={product} href={`/products?search=${encodeURIComponent(product.code || product.name)}`}/>, `${fmt(product.stock)} ${unit(product.unit)}`, money(product.stock * (product.salePrice ?? 0)), fmt(product.sales7), fmt(product.sales30), fmt(product.sales90), t('idle.window', { days: idleWindow(product) })] }))}/></Card> : <EmptyState title={search ? t('idle.empty.search') : t('idle.empty.title')} body={search ? t('idle.empty.searchBody') : t('idle.empty.body')} icon={Clock3}/>}
    </>}
  </>;
}

/* ---------- factories ---------- */
type FactoryGroup = { name: string; count: number; stock: number; value: number; products: Array<{ id: string; name: string; code: string | null; stock: number; value: number }> };
type FactorySort = 'stock' | 'value' | 'count';
function FactoriesPage() {
  const { t, fmt, money } = useI18n();
  const [search, setSearch] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [sort, setSort] = useState<FactorySort>('stock');
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const gridRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(3);
  const q = useQuery<{ items: FactoryGroup[]; ready?: boolean }>({
    queryKey: ['catalog-factories', 'ready'],
    queryFn: async () => {
      const response = await fetch('/api/catalog/factories');
      if (!response.ok) throw new Error(t('common.loadFailedHint'));
      return response.json();
    },
    refetchInterval: query => query.state.data?.ready === false ? 2000 : false,
  });
  const unknown = t('factories.unknown');
  const needle = search.trim().toLowerCase();
  const catalog = useMemo(() => (q.data?.items ?? []).map(item => ({ ...item, name: item.name || unknown })), [q.data, unknown]);
  const stock = catalog.reduce((sum, item) => sum + item.stock, 0);
  const value = catalog.reduce((sum, item) => sum + item.value, 0);
  const shareOf = (part: number) => stock > 0 ? Math.round((part / stock) * 1000) / 10 : 0;
  const shareLabel = (part: number) => {
    const share = shareOf(part);
    return t('factories.share', { share: fmt(share, share > 0 && share < 10 ? 1 : 0) });
  };
  const makers = useMemo(() => catalog.flatMap(item => {
    const nameHit = !needle || item.name.toLowerCase().includes(needle);
    const products = nameHit ? item.products : item.products.filter(product => `${product.name} ${product.code || ''}`.toLowerCase().includes(needle));
    if (!nameHit && products.length === 0) return [];
    const next = nameHit ? item : { ...item, products, stock: products.reduce((sum, product) => sum + product.stock, 0), value: products.reduce((sum, product) => sum + product.value, 0), count: products.length };
    return [next];
  }).sort((a, b) => {
    if ((a.name === unknown) !== (b.name === unknown)) return a.name === unknown ? 1 : -1;
    return b[sort] - a[sort];
  }), [catalog, needle, sort, unknown]);
  const active = selected ? catalog.find(item => item.name === selected) ?? null : null;
  const activeIndex = active ? makers.findIndex(item => item.name === active.name) : -1;
  const productNeedle = productSearch.trim().toLowerCase();
  const activeProducts = active ? active.products.filter(product => !productNeedle || `${product.name} ${product.code || ''}`.toLowerCase().includes(productNeedle)) : [];
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(activeProducts.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const visibleProducts = activeProducts.slice((safePage - 1) * pageSize, safePage * pageSize);
  useEffect(() => {
    const node = gridRef.current;
    if (!node) return;
    const read = () => setCols(window.matchMedia('(max-width: 900px)').matches ? 1 : window.matchMedia('(max-width: 1180px)').matches ? 2 : 3);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [makers.length]);
  useEffect(() => {
    if (selected && !makers.some(item => item.name === selected)) setSelected(null);
  }, [makers, selected]);
  const openMaker = (name: string) => {
    const item = catalog.find(entry => entry.name === name);
    const nameHit = !needle || !!item?.name.toLowerCase().includes(needle);
    setProductSearch(nameHit ? '' : search.trim());
    setPage(1);
    setSelected(current => current === name ? null : name);
  };
  const stepMaker = (name: string) => { setProductSearch(''); setPage(1); setSelected(name); };
  const rows: FactoryGroup[][] = [];
  for (let index = 0; index < makers.length; index += cols) rows.push(makers.slice(index, index + cols));
  return <>
    <PageHead title={t('factories.title')}/>
    <div className="toolbar">
      <label className="search"><Search size={17}/><TextInput testId="input-factory-search" placeholder={t('factories.searchPlaceholder')} value={search} onChange={e => setSearch(e.target.value)}/></label>
      <div className="maker-sort" role="group">{(['stock', 'value', 'count'] as const).map(key => <button type="button" key={key} className={sort === key ? 'is-on' : ''} onClick={() => setSort(key)}>{t(`factories.sort.${key}`)}</button>)}</div>
      <ExportButton kind="factories"/>
    </div>
    {q.isPending ? <LoadingRows/> : q.isError ? <QueryError q={q} id="factories"/> : catalog.length ? <>
      <section className="maker-summary" data-testid="factories-summary">
        <article><span>{t('factories.kpi.makers')}</span><strong>{fmt(catalog.length)}</strong><small>{t('factories.kpi.makersNote')}</small></article>
        <article><span>{t('idle.kpi.stock')}</span><strong>{fmt(stock)}</strong><small>{t('idle.kpi.stockNote')}</small></article>
        <article><span>{t('idle.kpi.value')}</span><strong>{money(value)}</strong><small>{t('idle.kpi.valueNote')}</small></article>
      </section>
      {makers.length ? <div className="maker-rows" ref={gridRef} data-testid="list-factories">{rows.map(row => <div className="maker-row" key={row[0].name}>{row.map(data => {
        const index = makers.indexOf(data);
        return <button type="button" key={data.name} className={`maker-card ${data.name === unknown ? 'is-unknown' : ''} ${active?.name === data.name ? 'is-open' : ''}`} data-testid={`factory-card-${index}`} onClick={() => openMaker(data.name)} aria-expanded={active?.name === data.name}>
          <span className="maker-card-top"><span className={`rank ${index < 3 && data.name !== unknown ? 'is-lead' : ''}`}>{String(index + 1).padStart(2, '0')}</span><b>{data.name}</b><ChevronRight size={16} className="maker-go"/></span>
          <span className="maker-stats"><span><small>{t('factories.stat.products')}</small><strong>{fmt(data.count)}</strong></span><span><small>{t('factories.stat.stock')}</small><strong>{fmt(data.stock)}</strong></span></span>
          <span className="maker-worth">{money(data.value)}</span>
          <span className="maker-foot"><span className="maker-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, shareOf(data.stock))}%` }}/></span><small>{shareLabel(data.stock)}</small></span>
        </button>;
      })}{active && row.some(item => item.name === active.name) && <section className="maker-open" data-testid="panel-factory">
        <div className="maker-open-head">
          <div><h2>{active.name}</h2><p>{t('factories.summary', { count: fmt(active.count), stock: fmt(active.stock) })} · {money(active.value)}</p></div>
          <div className="maker-open-tools">
            <span className="maker-share">{shareLabel(active.stock)}</span>
            {activeIndex > 0 && <button type="button" className="maker-nav" onClick={() => stepMaker(makers[activeIndex - 1].name)}><ChevronLeft size={15}/><span>{makers[activeIndex - 1].name}</span></button>}
            {activeIndex >= 0 && activeIndex < makers.length - 1 && <button type="button" className="maker-nav" onClick={() => stepMaker(makers[activeIndex + 1].name)}><span>{makers[activeIndex + 1].name}</span><ChevronRight size={15}/></button>}
            <button type="button" className="icon-btn" onClick={() => setSelected(null)} aria-label={t('common.close')}><X size={16}/></button>
          </div>
        </div>
        <div className="maker-meter maker-meter-open" aria-hidden="true"><i style={{ width: `${Math.min(100, shareOf(active.stock))}%` }}/></div>
        <label className="search maker-open-search"><Search size={16}/><TextInput testId="input-factory-product-search" placeholder={t('factories.productSearch')} value={productSearch} onChange={event => { setProductSearch(event.target.value); setPage(1); }}/></label>
        {visibleProducts.length ? <>
          <Table testId="table-factory-products" numeric={[2, 3]} columns={[t('common.product'), t('col.code'), t('idle.col.stock'), t('idle.col.value')]} rows={visibleProducts.map(product => ({ key: product.id, testId: `factory-product-${product.id}`, cells: [<Link href={`/products?search=${encodeURIComponent(product.code || product.name)}`}><b>{product.name}</b></Link>, product.code || t('common.noCode'), fmt(product.stock), money(product.value)] }))}/>
          {activeProducts.length > pageSize && <div className="pager"><span>{t('products.range', { total: fmt(activeProducts.length), from: fmt((safePage - 1) * pageSize + 1), to: fmt(Math.min(safePage * pageSize, activeProducts.length)) })}</span><div className="pager-nav"><button className="icon-btn" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} aria-label={t('common.prevPage')}><ChevronLeft size={17}/></button><span>{safePage}</span><button className="icon-btn" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)} aria-label={t('common.nextPage')}><ChevronRight size={17}/></button></div></div>}
        </> : <EmptyState title={t('products.empty.search')} body={t('products.empty.searchBody')} icon={Search}/>}
      </section>}</div>)}</div> : <EmptyState title={t('factories.empty.title')} body={t('factories.empty.body')} icon={Factory}/>}
    </> : <EmptyState title={t('factories.empty.title')} body={t('factories.empty.body')} icon={Factory}/>}
  </>;
}

/* ---------- recommendations ---------- */
type RebalanceRow = {
  productId: string; name: string; code: string | null; barcode: string | null;
  fromWarehouse: string; toWarehouse: string; fromQuantity: number; toQuantity: number;
  dailyAverage: number; suggestedQuantity: number; reason: string;
};
function BranchesPage() {
  const { t, fmt } = useI18n();
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useQuery<{ items: RebalanceRow[]; proposal: boolean }>({ queryKey: ['rebalance'], queryFn: async () => { const response = await fetch('/api/analytics/rebalance'); if (!response.ok) throw new Error(t('common.loadFailedHint')); return response.json(); } });
  const items = q.data?.items ?? [];
  const sources = [...new Set(items.map(row => row.fromWarehouse))].sort((a, b) => a.localeCompare(b));
  const targets = [...new Set(items.map(row => row.toWarehouse))].sort((a, b) => a.localeCompare(b));
  const needle = search.trim().toLowerCase();
  const rows = items.filter(row => (!from || row.fromWarehouse === from) && (!to || row.toWarehouse === to) && (!needle || `${row.name} ${row.code || ''} ${row.barcode || ''} ${row.fromWarehouse} ${row.toWarehouse}`.toLowerCase().includes(needle)));
  const move = rows.reduce((sum, row) => sum + row.suggestedQuantity, 0);
  const places = new Set(rows.flatMap(row => [row.fromWarehouse, row.toWarehouse])).size;
  return <>
    <PageHead title={t('branch.title')}/>
    <div className="toolbar">
      <label className="search"><Search size={17}/><TextInput testId="input-branch-search" placeholder={t('branch.search')} value={search} onChange={event => setSearch(event.target.value)}/></label>
      <label className="select-wrap"><Warehouse size={16}/><SelectInput value={from} onChange={setFrom} testId="select-branch-from" ariaLabel={t('branch.col.from')}><option value="">{t('branch.col.from')}</option>{sources.map(name => <option key={name} value={name}>{name}</option>)}</SelectInput></label>
      <label className="select-wrap"><Warehouse size={16}/><SelectInput value={to} onChange={setTo} testId="select-branch-to" ariaLabel={t('branch.col.to')}><option value="">{t('branch.col.to')}</option>{targets.map(name => <option key={name} value={name}>{name}</option>)}</SelectInput></label>
      <ExportButton kind="branches"/>
    </div>
    {q.isPending ? <LoadingRows/> : q.isError ? <QueryError q={q} id="branches"/> : items.length ? <>
      <section className="maker-summary">
        <article><span>{t('branch.kpi.offers')}</span><strong>{fmt(rows.length)}</strong><small>{t('branch.kpi.offersNote')}</small></article>
        <article><span>{t('branch.kpi.move')}</span><strong>{fmt(move)}</strong><small>{t('branch.kpi.moveNote')}</small></article>
        <article><span>{t('branch.kpi.places')}</span><strong>{fmt(places)}</strong><small>{t('branch.kpi.placesNote')}</small></article>
      </section>
      {rows.length ? <Card className="table-card" title={t('branch.panel')} meta={t('branch.count', { count: fmt(rows.length) })}><Table testId="table-rebalance" numeric={[3, 4, 5, 6]} columns={[t('common.product'), t('branch.col.from'), t('branch.col.to'), t('branch.col.fromQty'), t('branch.col.toQty'), t('branch.col.move'), t('reco.col.perDay')]} rows={rows.map(row => ({ key: `${row.productId}-${row.fromWarehouse}-${row.toWarehouse}`, testId: `row-rebalance-${row.productId}`, cells: [<span className="cell-two"><b>{row.name}</b><Link href={`/products?search=${encodeURIComponent(row.code || row.name)}`}><small>{row.code || row.barcode || t('common.noCode')}</small></Link></span>, row.fromWarehouse, <span className="branch-to">{row.toWarehouse}</span>, fmt(row.fromQuantity), <b className="qty-low">{fmt(row.toQuantity)}</b>, <b className="move-qty">{fmt(row.suggestedQuantity)}</b>, fmt(row.dailyAverage, 2)] }))}/></Card> : <EmptyState title={t('products.empty.search')} body={t('products.empty.searchBody')} icon={Search}/>}
    </> : <EmptyState title={t('branch.empty.title')} body={t('branch.empty.body')} icon={Repeat}/>}
  </>;
}

const RECO_COLORS: Array<[RegExp, TKey]> = [
  [/\bqora\b|\bчерн/i, 'reco.color.qora'],
  [/\boq\b|\bбел(ый|ая|ое)?\b/i, 'reco.color.oq'],
  [/\bjigarrang\b|\bкоричнев/i, 'reco.color.jigarrang'],
  [/\bsariq\b|\bж[её]лт/i, 'reco.color.sariq'],
  [/\bqizil\b|\bкрасн/i, 'reco.color.qizil'],
  [/\bko['’‘]?k\b|\bсин(ий|яя|ее)?\b/i, 'reco.color.kok'],
  [/\byashil\b|\bзел[её]н/i, 'reco.color.yashil'],
  [/\bkulrang\b|\bсер(ый|ая|ое)?\b/i, 'reco.color.kulrang'],
  [/\bbej\b|\bбеж/i, 'reco.color.bej'],
  [/\bpushti\b|\bрозов/i, 'reco.color.pushti'],
];
function RecommendationsPage() {
  const { t, fmt } = useI18n(); const unit = useUnit();
  const [warehouse, setWarehouse] = useState('');
  const [search, setSearch] = useState('');
  const params = useMemo(() => ({ warehouseId: warehouse || undefined }), [warehouse]);
  const q = useGetPurchaseRecommendations(params);
  const basis = (row: { product: { sales30: number; sales7: number }; onHand: number }) => {
    const windowDays = row.product.sales30 > 0 ? 30 : 7;
    const sold = windowDays === 30 ? row.product.sales30 : row.product.sales7;
    const daily = sold / windowDays;
    const cover = daily > 0 ? Math.round((row.onHand / daily) * 10) / 10 : 0;
    return { windowDays, sold, cover };
  };
  const traits = (name: string) => {
    const size = [...name.matchAll(/(\d{2})\s*[-–]\s*(\d{2})/g)].pop();
    const color = RECO_COLORS.find(([pattern]) => pattern.test(name));
    return { size: size ? `${size[1]}-${size[2]}` : '—', color: color ? t(color[1]) : '—' };
  };
  const needle = search.trim().toLowerCase();
  const rows = (q.data ?? []).filter(row => !needle || `${row.product.name} ${row.product.code || ''} ${row.product.article || ''} ${traits(row.product.name).size} ${traits(row.product.name).color}`.toLowerCase().includes(needle));
  const units = rows.reduce((sum, row) => sum + row.suggestedQuantity, 0);
  const fast = rows.filter(row => row.reason === 'fast' || row.reason === 'out_of_stock').length;
  return <>
    <PageHead title={t('reco.title')}/>
    <div className="toolbar">
      <label className="search"><Search size={17}/><TextInput testId="input-recommendation-search" placeholder={t('reco.search')} value={search} onChange={event => setSearch(event.target.value)}/></label>
      <label className="select-wrap"><Warehouse size={16}/><WarehousesSelect value={warehouse} onChange={setWarehouse} testId="select-recommendation-warehouse"/></label>
      <ExportButton kind="recommendations"/>
    </div>
    {q.isPending ? <LoadingRows/> : q.isError ? <QueryError q={q} id="recommendations"/> : (q.data?.length ?? 0) > 0 ? <>
      <section className="maker-summary">
        <article><span>{t('reco.kpi.count')}</span><strong>{fmt(rows.length)}</strong><small>{t('reco.kpi.countNote')}</small></article>
        <article><span>{t('reco.kpi.units')}</span><strong>{fmt(units)}</strong><small>{t('reco.kpi.unitsNote')}</small></article>
        <article><span>{t('reco.kpi.fast')}</span><strong>{fmt(fast)}</strong><small>{t('reco.kpi.fastNote')}</small></article>
      </section>
      {rows.length ? <Card className="table-card" title={t('reco.panel')} meta={t('reco.count', { count: fmt(rows.length) })}><Table testId="table-recommendations" numeric={[5]} columns={[t('common.product'), t('reco.col.size'), t('reco.col.color'), t('reco.col.current'), t('reco.col.reason'), t('reco.col.suggested')]} rows={rows.map(r => { const look = traits(r.product.name); const fact = basis(r); return { key: `${r.product.id}-${r.warehouseId}`, testId: `row-recommendation-${r.product.id}`, cells: [<ProductTitle product={r.product} href={`/products?search=${encodeURIComponent(r.product.code || r.product.name)}`}/>, look.size, look.color, <span className="cell-two"><b>{t('reco.onHand', { count: fmt(r.onHand) })}</b><small>{t('reco.inTransit', { count: fmt(r.inTransit) })}</small></span>, <span className="cell-two reco-fact"><b>{t('reco.fact.sold', { days: fact.windowDays, sold: fmt(fact.sold) })}</b><small>{t('reco.fact.need', { stock: fmt(r.onHand), transit: fmt(r.inTransit), cover: fmt(fact.cover, 1), days: r.leadTimeDays, need: fmt(r.safetyStock), order: fmt(r.suggestedQuantity) })}</small></span>, <b className="move-qty">{fmt(r.suggestedQuantity)} {unit(r.product.unit)}</b>] }; })}/></Card> : <EmptyState title={t('products.empty.search')} body={t('products.empty.searchBody')} icon={Search}/>}
    </> : <EmptyState title={t('reco.empty.title')} body={t('reco.empty.body')} icon={ListChecks}/>}
  </>;
}

/* ---------- documents ---------- */
type DocLine = { id: string; name: string; code: string | null; article: string | null; quantity: number; price: number | null; sum: number | null };
type DocDetail = { description: string | null; quantity: number; lines: DocLine[] };
function DocumentsPage({ kind }: { kind: 'receipt'|'transfer' }) {
  const { t, fmt, date, money } = useI18n(); const docKind = useDocKind();
  const q = useListDocuments({ kind });
  const sync = useCatalogRefresh();
  const isReceipt = kind === 'receipt';
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [place, setPlace] = useState('all');
  const [destination, setDestination] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (q.data ?? []).filter(doc => {
      if (status !== 'all' && doc.status !== status) return false;
      if (isReceipt) {
        if (place !== 'all' && doc.targetWarehouse !== place) return false;
      } else {
        if (place !== 'all' && doc.sourceWarehouse !== place) return false;
        if (destination !== 'all' && doc.targetWarehouse !== destination) return false;
      }
      if (!needle) return true;
      return [doc.number, doc.sourceWarehouse, doc.targetWarehouse].join(' ').toLowerCase().includes(needle);
    });
  }, [q.data, search, status, place, destination, isReceipt]);
  const places = useMemo(() => [...new Set((q.data ?? []).map(doc => (isReceipt ? doc.targetWarehouse : doc.sourceWarehouse) || '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uz')), [q.data, isReceipt]);
  const destinations = useMemo(() => [...new Set((q.data ?? []).map(doc => doc.targetWarehouse || '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uz')), [q.data]);
  const posted = rows.filter(doc => doc.status === 'posted').length;
  const total = rows.reduce((sum, doc) => sum + (doc.total || 0), 0);
  const detail = useQuery<DocDetail>({
    queryKey: ['document', selected],
    enabled: Boolean(selected),
    queryFn: async () => {
      const response = await fetch(`/api/documents/${selected}`);
      if (!response.ok) throw new Error(t('docs.detail.failed'));
      return response.json();
    },
  });
  const open = q.data?.find(doc => doc.id === selected);
  const statusText = (value: string) => value === 'posted' ? t(isReceipt ? 'docs.status.accepted' : 'docs.status.moved') : t('status.draft');
  const refresh = sync.refresh;
  return <>
    <PageHead title={isReceipt ? t('docs.receipts.title') : t('docs.transfers.title')} subtitle={isReceipt ? t('docs.receipts.sub') : t('docs.transfers.sub')} actions={<><ExportButton kind={isReceipt ? 'receipts' : 'transfers'} defaultPeriod="today"/><Button variant="secondary" testId={`button-${kind}-refresh`} disabled={sync.pending} onClick={refresh}><RefreshCw size={15} className={sync.pending ? 'spin' : ''}/>{sync.pending ? t('common.refreshing') : t('common.refresh')}</Button></>}/>
    {q.data && <div className="product-kpis">
      <div><span>{t('docs.kpi.count')}</span><b>{fmt(rows.length)}</b></div>
      <div><span>{statusText('posted')}</span><b>{fmt(posted)}</b></div>
      <div><span>{t('status.draft')}</span><b>{fmt(rows.length - posted)}</b></div>
      <div><span>{t('docs.col.sum')}</span><b>{money(total)}</b></div>
    </div>}
    <div className="toolbar">
      <label className="search"><Search size={17}/><TextInput testId={`input-${kind}-search`} type="search" placeholder={t(isReceipt ? 'docs.search.receipt' : 'docs.search.transfer')} value={search} onChange={e => setSearch(e.target.value)}/></label>
      <label className="select-wrap"><Filter size={15}/><SelectInput value={status} onChange={setStatus} testId={`select-${kind}-status`}><option value="all">{t('docs.filter.all')}</option><option value="posted">{statusText('posted')}</option><option value="draft">{t('status.draft')}</option></SelectInput></label>
      <label className="select-wrap"><Warehouse size={16}/><SelectInput value={place} onChange={setPlace} testId={`select-${kind}-warehouse`}><option value="all">{t(isReceipt ? 'docs.filter.warehouse' : 'docs.filter.from')}</option>{places.map(name => <option key={name} value={name}>{name}</option>)}</SelectInput></label>
      {!isReceipt && <label className="select-wrap"><ArrowLeftRight size={16}/><SelectInput value={destination} onChange={setDestination} testId="select-transfer-destination"><option value="all">{t('docs.filter.to')}</option>{destinations.map(name => <option key={name} value={name}>{name}</option>)}</SelectInput></label>}
    </div>
    <QueryError q={q} id={kind}/>
    <Card className="table-card" title={t('docs.panel')} meta={q.data ? t('docs.count', { count: fmt(rows.length) }) : ''}>
      {q.isLoading ? <LoadingRows/> : rows.length ? <Table testId={`table-${kind}-documents`} numeric={[4, 5]} columns={[t('common.number'), t('common.date'), t('common.status'), isReceipt ? t('docs.col.supplier') : t('docs.col.from'), isReceipt ? t('docs.col.warehouse') : t('docs.col.to'), t('docs.col.items'), t('docs.col.sum'), '']} rows={rows.map(d => ({ key: d.id, testId: `row-document-${d.id}`, onClick: () => setSelected(d.id), cells: [<span className="cell-two"><b>{d.number}</b><small>{docKind(d.kind)}</small></span>, date(d.date), <span className={`badge badge-${d.status}`}>{statusText(d.status)}</span>, d.sourceWarehouse || '—', d.targetWarehouse || '—', t('docs.items', { count: fmt(d.itemCount) }), money(d.total), <ChevronRight size={16} aria-hidden/>] }))}/> : <EmptyState title={search || status !== 'all' || place !== 'all' || destination !== 'all' ? t('docs.empty.search') : t('docs.empty.title')} body={search || status !== 'all' || place !== 'all' || destination !== 'all' ? t('docs.empty.searchBody') : t('docs.empty.body')} icon={isReceipt ? ArrowDownLeft : ArrowLeftRight}/>}
    </Card>
    {open && createPortal(<div className="backdrop" onClick={() => setSelected(null)}><div className="modal product-modal" onClick={e => e.stopPropagation()} role="dialog" aria-labelledby="doc-detail-title"><div className="modal-top"><div><p className="eyebrow">{docKind(open.kind)} · {statusText(open.status)}</p><h2 id="doc-detail-title">{t('docs.detail.number', { number: open.number })}</h2></div><button className="icon-btn" onClick={() => setSelected(null)} aria-label={t('common.close')} data-testid="button-close-document"><X size={18}/></button></div>
      <div className="detail-grid">
        <div><small>{t('common.date')}</small><b>{date(open.date)}</b></div>
        <div><small>{isReceipt ? t('docs.col.supplier') : t('docs.col.from')}</small><b>{open.sourceWarehouse || '—'}</b></div>
        <div><small>{isReceipt ? t('docs.col.warehouse') : t('docs.col.to')}</small><b>{open.targetWarehouse || '—'}</b></div>
        <div><small>{t('docs.col.sum')}</small><b>{money(open.total)}</b></div>
        <div><small>{t('docs.detail.quantity')}</small><b>{detail.data ? fmt(detail.data.quantity) : '—'}</b></div>
        <div><small>{t('docs.col.items')}</small><b>{fmt(open.itemCount)}</b></div>
      </div>
      {!isReceipt && <p className="muted doc-note">{open.status === 'draft' ? t('docs.transfer.draft') : t('docs.transfer.posted')}</p>}
      {detail.data?.description && <p className="muted doc-note">{detail.data.description}</p>}
      {detail.isLoading ? <LoadingRows count={3}/> : detail.isError ? <Notice kind="error" title={t('docs.detail.failed')} testId="status-document-lines"/> : detail.data?.lines.length ? <div className="table-wrap"><table className="table mini-table" data-testid="table-document-lines"><thead><tr><th>{t('common.product')}</th><th>{t('col.code')}</th><th className="num">{t('docs.line.qty')}</th><th className="num">{t('docs.line.price')}</th><th className="num">{t('docs.line.sum')}</th></tr></thead><tbody>{detail.data.lines.map(line => <tr key={line.id}><td data-label={t('common.product')}><span className="cell-two"><b>{line.name}</b>{line.article && <small>{line.article}</small>}</span></td><td data-label={t('col.code')}>{line.code || '—'}</td><td className="num" data-label={t('docs.line.qty')}>{fmt(line.quantity)}</td><td className="num" data-label={t('docs.line.price')}>{money(line.price)}</td><td className="num" data-label={t('docs.line.sum')}>{money(line.sum)}</td></tr>)}</tbody></table></div> : <EmptyState title={t('docs.detail.empty')} body={t('docs.detail.emptyBody')} icon={Package}/>}
    </div></div>, document.body)}
  </>;
}

/* ---------- inventory ---------- */
type InventoryLine = { id: string; name: string; code: string | null; article: string | null; quantity: number; calculatedQuantity: number | null; correctionAmount: number | null; correctionValue: number | null };
type InventoryDetail = { description: string | null; lineTotal: number; diffCount: number; shortageQty: number; surplusQty: number; truncated: boolean; lines: InventoryLine[] };
function InventoryPage() {
  const { t, fmt, date, money } = useI18n();
  const q = useListDocuments({ kind: 'inventory' });
  const sync = useCatalogRefresh();
  const [search, setSearch] = useState('');
  const [place, setPlace] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (q.data ?? []).filter(doc => {
      if (place !== 'all' && doc.sourceWarehouse !== place) return false;
      if (!needle) return true;
      return [doc.number, doc.sourceWarehouse].join(' ').toLowerCase().includes(needle);
    });
  }, [q.data, search, place]);
  const places = useMemo(() => [...new Set((q.data ?? []).map(doc => doc.sourceWarehouse || '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uz')), [q.data]);
  const posted = rows.filter(doc => doc.status === 'posted').length;
  const detail = useQuery<InventoryDetail>({
    queryKey: ['document', selected],
    enabled: Boolean(selected),
    queryFn: async () => {
      const response = await fetch(`/api/documents/${selected}`);
      if (!response.ok) throw new Error(t('docs.detail.failed'));
      return response.json();
    },
  });
  const open = q.data?.find(doc => doc.id === selected);
  const refresh = sync.refresh;
  return <>
    <PageHead title={t('inv.title')} subtitle={t('inv.sub')} actions={<><ExportButton kind="inventory" defaultPeriod="thisMonth"/><Button variant="secondary" testId="button-inventory-refresh" disabled={sync.pending} onClick={refresh}><RefreshCw size={15} className={sync.pending ? 'spin' : ''}/>{sync.pending ? t('common.refreshing') : t('common.refresh')}</Button></>}/>
    {q.data && <div className="product-kpis">
      <div><span>{t('docs.kpi.count')}</span><b>{fmt(rows.length)}</b></div>
      <div><span>{t('status.posted')}</span><b>{fmt(posted)}</b></div>
      <div><span>{t('status.draft')}</span><b>{fmt(rows.length - posted)}</b></div>
      <div><span>{t('inv.col.rows')}</span><b>{fmt(rows.reduce((sum, doc) => sum + doc.itemCount, 0))}</b></div>
    </div>}
    <div className="toolbar">
      <label className="search"><Search size={17}/><TextInput testId="input-inventory-search" type="search" placeholder={t('inv.search')} value={search} onChange={e => setSearch(e.target.value)}/></label>
      <label className="select-wrap"><Warehouse size={16}/><SelectInput value={place} onChange={setPlace} testId="select-inventory-warehouse"><option value="all">{t('docs.filter.warehouse')}</option>{places.map(name => <option key={name} value={name}>{name}</option>)}</SelectInput></label>
    </div>
    <QueryError q={q} id="inventory"/>
    <Card className="table-card" title={t('inv.sessions')} meta={q.data ? t('inv.sessions.count', { count: fmt(rows.length) }) : ''}>
      {q.isLoading ? <LoadingRows/> : rows.length ? <Table testId="table-inventory-sessions" numeric={[3]} columns={[t('common.number'), t('common.date'), t('common.warehouse'), t('inv.col.rows'), t('common.status'), '']} rows={rows.map(d => ({ key: d.id, testId: `row-inventory-${d.id}`, onClick: () => setSelected(d.id), cells: [<b>{d.number}</b>, date(d.date), d.sourceWarehouse || '—', fmt(d.itemCount), <span className={`badge badge-${d.status}`}>{d.status === 'posted' ? t('status.posted') : t('status.draft')}</span>, <ChevronRight size={16} aria-hidden/>] }))}/> : <EmptyState title={search || place !== 'all' ? t('docs.empty.search') : t('inv.empty.title')} body={search || place !== 'all' ? t('docs.empty.searchBody') : t('inv.empty.body')} icon={ClipboardCheck}/>}
    </Card>
    {open && createPortal(<div className="backdrop" onClick={() => setSelected(null)}><div className="modal product-modal" onClick={e => e.stopPropagation()} role="dialog" aria-labelledby="inv-detail-title"><div className="modal-top"><div><p className="eyebrow">{open.sourceWarehouse || t('common.warehouse')} · {open.status === 'posted' ? t('status.posted') : t('status.draft')}</p><h2 id="inv-detail-title">{t('docs.detail.number', { number: open.number })}</h2></div><button className="icon-btn" onClick={() => setSelected(null)} aria-label={t('common.close')} data-testid="button-close-inventory"><X size={18}/></button></div>
      <div className="detail-grid">
        <div><small>{t('common.date')}</small><b>{date(open.date)}</b></div>
        <div><small>{t('common.warehouse')}</small><b>{open.sourceWarehouse || '—'}</b></div>
        <div><small>{t('inv.col.rows')}</small><b>{detail.data ? fmt(detail.data.lineTotal) : fmt(open.itemCount)}</b></div>
        <div><small>{t('inv.detail.diffs')}</small><b>{detail.data ? fmt(detail.data.diffCount) : '—'}</b></div>
        <div><small>{t('inv.detail.shortage')}</small><b className="qty-neg">{detail.data ? fmt(detail.data.shortageQty) : '—'}</b></div>
        <div><small>{t('inv.detail.surplus')}</small><b>{detail.data ? fmt(detail.data.surplusQty) : '—'}</b></div>
      </div>
      <p className="muted doc-note">{open.status === 'draft' ? t('inv.note.draft') : t('inv.note.posted')}</p>
      {detail.data?.description && <p className="muted doc-note">{detail.data.description}</p>}
      {detail.isLoading ? <LoadingRows count={4}/> : detail.isError ? <Notice kind="error" title={t('docs.detail.failed')} testId="status-inventory-lines"/> : detail.data?.lines.length ? <>{detail.data.truncated && <p className="muted doc-note">{t('inv.detail.truncated')}</p>}<div className="table-wrap"><table className="table mini-table" data-testid="table-inventory-lines"><thead><tr><th>{t('common.product')}</th><th>{t('col.code')}</th><th className="num">{t('inv.col.book')}</th><th className="num">{t('inv.col.counted')}</th><th className="num">{t('inv.col.diff')}</th><th className="num">{t('docs.col.sum')}</th></tr></thead><tbody>{detail.data.lines.map(line => <tr key={line.id}><td data-label={t('common.product')}><span className="cell-two"><b>{line.name}</b>{line.article && <small>{line.article}</small>}</span></td><td data-label={t('col.code')}>{line.code || '—'}</td><td className="num" data-label={t('inv.col.book')}>{fmt(line.calculatedQuantity)}</td><td className="num" data-label={t('inv.col.counted')}>{fmt(line.quantity)}</td><td className={`num ${(line.correctionAmount ?? 0) < 0 ? 'qty-neg' : ''}`} data-label={t('inv.col.diff')}>{fmt(line.correctionAmount)}</td><td className="num" data-label={t('docs.col.sum')}>{money(line.correctionValue)}</td></tr>)}</tbody></table></div></> : <EmptyState title={t('inv.detail.none')} body={t('inv.detail.noneBody')} icon={ClipboardCheck}/>}
    </div></div>, document.body)}
  </>;
}

/* ---------- tasks ---------- */
function TasksPage() {
  const { t, date } = useI18n(); const roleLabel = useRole(); const statusLabel = useStatusLabel();
  const [filter, setFilter] = useState('all'); const params = useMemo(() => ({ status: filter as 'all'|'open'|'in_progress'|'done' }), [filter]); const q = useListTasks(params); const users = useListUsers(); const create = useCreateTask(); const update = useUpdateTask(); const cache = useQueryClient();
  const [form, setForm] = useState(false); const [title, setTitle] = useState(''); const [description, setDescription] = useState(''); const [assignedTo, setAssigned] = useState(''); const [priority, setPriority] = useState<TaskInputPriority>('normal');
  const invalidate = () => { void cache.invalidateQueries({ queryKey: getListTasksQueryKey() }); };
  const submit = () => create.mutate({ data: { title: title.trim(), description: description || null, assignedTo: assignedTo || null, dueDate: null, priority } }, { onSuccess: () => { invalidate(); setTitle(''); setDescription(''); setForm(false); } });
  const lanes: Task['status'][] = ['open', 'in_progress', 'done'];
  const priorityLabel = (p: string) => p === 'low' ? t('status.low_priority') : statusLabel(p);
  return <>
    <PageHead title={t('tasks.title')} subtitle={t('tasks.sub')} actions={<><ExportButton kind="tasks"/><Button testId="button-new-task" onClick={() => setForm(!form)}><Plus size={16}/>{t('tasks.add')}</Button></>}/>
    <div className="tabs">{['all', 'open', 'in_progress', 'done'].map(s => <button key={s} className={filter === s ? 'is-active' : ''} onClick={() => setFilter(s)} data-testid={`filter-task-${s}`}>{s === 'all' ? t('common.all') : statusLabel(s)}</button>)}</div>
    {form && <Card title={t('tasks.form')} meta={t('tasks.form.meta')}><div className="form-grid"><Field label={t('tasks.name')} testId="field-task-title"><TextInput testId="input-task-title" value={title} onChange={e => setTitle(e.target.value)} placeholder={t('tasks.namePlaceholder')}/></Field><Field label={t('tasks.assignee')} testId="field-task-assigned"><SelectInput value={assignedTo} onChange={setAssigned} testId="select-task-assignee"><option value="">{t('tasks.noAssignee')}</option>{users.data?.map(u => <option key={u.id} value={u.id}>{u.name} · {roleLabel(u.role)}</option>)}</SelectInput></Field><Field label={t('tasks.priority')} testId="field-task-priority"><SelectInput value={priority} onChange={v => setPriority(v as TaskInputPriority)} testId="select-task-priority"><option value="low">{t('status.low_priority')}</option><option value="normal">{t('status.normal')}</option><option value="high">{t('status.high')}</option><option value="urgent">{t('status.urgent')}</option></SelectInput></Field><Field label={t('common.comment')} testId="field-task-description"><TextInput testId="input-task-description" value={description} onChange={e => setDescription(e.target.value)} placeholder={t('tasks.descriptionPlaceholder')}/></Field></div><div className="form-actions"><Button variant="ghost" testId="button-cancel-task" onClick={() => setForm(false)}>{t('common.cancel')}</Button><Button testId="button-submit-task" disabled={!title.trim() || create.isPending} onClick={submit}>{create.isPending ? t('common.saving') : t('tasks.create')}</Button></div>{create.error && <Notice kind="error" title={t('tasks.createFailed')} testId="status-create-task-error">{create.error instanceof Error ? create.error.message : t('common.tryAgain')}</Notice>}</Card>}
    <QueryError q={q} id="tasks"/>
    {q.isLoading ? <LoadingRows count={5}/> : q.data?.length ? <div className="board">{(filter === 'all' ? lanes : [filter as Task['status']]).map(lane => { const tasks = q.data!.filter(x => x.status === lane); return <div className="lane" key={lane} data-testid={`task-lane-${lane}`}><div className="lane-head"><span><i className={`dot lane-${lane}`}/>{statusLabel(lane)}</span><b>{tasks.length}</b></div>{tasks.map(task => <article className="card task" key={task.id} data-testid={`card-task-${task.id}`}><div className="task-top"><span className={`badge badge-${task.priority}`}>{priorityLabel(task.priority)}</span><span className="muted">{date(task.dueDate)}</span></div><b>{task.title}</b><p className="muted">{task.description || t('tasks.noDescription')}</p><div className="task-bottom"><span className="muted"><UserRound size={14}/>{users.data?.find(u => u.id === task.assignedTo)?.name || t('tasks.unassigned')}</span><SelectInput value={task.status} onChange={v => update.mutate({ id: task.id, data: { status: v as Task['status'] } }, { onSuccess: invalidate })} testId={`select-task-status-${task.id}`}>{lanes.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}</SelectInput></div></article>)}</div>; })}</div> : <EmptyState title={t('tasks.empty.title')} body={t('tasks.empty.body')} icon={ClipboardList}/>}
  </>;
}

/* ---------- reports ---------- */
function ReportsPage() {
  const { t } = useI18n();
  return <><PageHead title={t('reports.title')}/><ReportsHub/></>;
}

/* ---------- settings ---------- */
type AccessAccount = { id: string; name: string; login: string; password: string; role: string };
function AccessPanel() {
  const { t, fmt } = useI18n(); const roleLabel = useRole();
  const [, setLocation] = useLocation();
  const session = readLocalSession();
  const [rows, setRows] = useState<AccessAccount[]>([]);
  const [name, setName] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('worker');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const headers = { authorization: `Bearer ${session?.token || ''}`, 'content-type': 'application/json' };
  const load = async () => {
    const response = await fetch('/api/local-accounts', { headers });
    if (response.ok) setRows(await response.json());
  };
  useEffect(() => { void load(); }, []);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!login.trim() || password.length < 4) { setNote(t('auth.accessShort')); return; }
    setBusy(true); setNote('');
    const response = await fetch('/api/local-accounts', { method: 'POST', headers, body: JSON.stringify({ name, login, password, role }) });
    setBusy(false);
    if (response.status === 401) {
      sessionStorage.removeItem(LOCAL_SESSION);
      setNote(t('auth.sessionExpired'));
      window.setTimeout(() => setLocation('/'), 900);
      return;
    }
    if (response.status === 403) { setNote(t('auth.invalid')); return; }
    if (response.status === 409) { setNote(t('auth.accessExists')); return; }
    if (!response.ok) { setNote(t('auth.accessShort')); return; }
    setRows(await response.json());
    setName(''); setLogin(''); setPassword('');
  };
  const remove = async (id: string) => {
    const response = await fetch(`/api/local-accounts/${id}`, { method: 'DELETE', headers });
    if (response.ok) setRows(await response.json());
  };
  return <Card title={t('auth.access')} meta={t('auth.accessMeta', { count: fmt(rows.length) })}>
    <form onSubmit={event => { void create(event); }}>
      <div className="form-grid">
        <Field label={t('auth.accessName')} testId="field-access-name"><TextInput testId="input-access-name" value={name} onChange={event => setName(event.target.value)}/></Field>
        <Field label={t('auth.login')} testId="field-access-login"><TextInput testId="input-access-login" value={login} onChange={event => setLogin(event.target.value)} autoComplete="off"/></Field>
        <Field label={t('auth.password')} testId="field-access-password"><PasswordField value={password} onChange={setPassword} testId="input-access-password" autoComplete="new-password"/></Field>
        <Field label={t('auth.accessRole')} testId="field-access-role"><SelectInput value={role} onChange={setRole} testId="select-access-role">{accessRoles.map(item => <option key={item} value={item}>{roleLabel(item)}</option>)}</SelectInput></Field>
        <div className="form-actions span-2 access-create"><Button testId="button-access-create" type="submit" disabled={busy}>{busy ? t('common.saving') : t('auth.accessCreate')}</Button></div>
      </div>
    </form>
    {note && <Notice kind="error" title={note} testId="status-access-error"/>}
    <ul className="user-list">{rows.map(account => {
      const open = openId === account.id;
      return <li className={`access-item ${open ? 'is-open' : ''}`} key={account.id} data-testid={`row-access-${account.id}`}>
        <div className="user-row">
          <button type="button" className="access-main" aria-expanded={open} onClick={() => { setOpenId(open ? null : account.id); setReveal(true); }} data-testid={`button-access-open-${account.id}`}>
            <span className="avatar">{account.name.slice(0, 2).toUpperCase()}</span>
            <span className="user-copy"><b>{account.name}</b><small>{account.login}</small></span>
            <ChevronRight size={16} className="chev"/>
          </button>
          <span className="chip">{roleLabel(account.role)}</span>
          {account.login !== 'bordouzadmin' && account.login !== session?.login && <Button variant="danger" size="sm" testId={`button-access-delete-${account.id}`} onClick={() => { void remove(account.id); }}>{t('auth.accessDelete')}</Button>}
        </div>
        {open && <dl className="access-detail">
          <div><dt>{t('auth.accessName')}</dt><dd>{account.name}</dd></div>
          <div><dt>{t('auth.login')}</dt><dd>{account.login}</dd></div>
          <div><dt>{t('auth.password')}</dt><dd className="access-pass-line"><span className="access-pass">{reveal ? account.password : '•'.repeat(Math.max(account.password.length, 4))}</span><button type="button" className="icon-btn" aria-label={reveal ? t('auth.hidePassword') : t('auth.showPassword')} onClick={() => setReveal(value => !value)} data-testid={`button-access-reveal-${account.id}`}>{reveal ? <EyeOff size={16}/> : <Eye size={16}/>}</button></dd></div>
          <div><dt>{t('auth.accessRole')}</dt><dd>{roleLabel(account.role)}</dd></div>
        </dl>}
      </li>;
    })}</ul>
  </Card>;
}
type ConnectionView = { source: 'saved' | 'environment' | 'none'; companyName: string | null; masked: string | null; savedAt: string | null };
function MoySkladPanel() {
  const { t, dateTime } = useI18n();
  const session = readLocalSession();
  const cache = useQueryClient();
  const status = useGetMoyskladStatus();
  const connection = useQuery<ConnectionView>({
    queryKey: ['settings-connection'],
    enabled: !!session?.token,
    queryFn: async () => {
      const response = await fetch('/api/settings/connection', { headers: { authorization: `Bearer ${session!.token}` } });
      if (response.status === 401) throw new Error('auth');
      if (!response.ok) throw new Error('load');
      return response.json();
    },
  });
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const connected = !!status.data?.configured && !!status.data?.connected;
  const company = status.data?.companyName || connection.data?.companyName;
  const headers = { authorization: `Bearer ${session?.token || ''}`, 'content-type': 'application/json' };
  const refresh = async () => {
    await Promise.all([
      connection.refetch(),
      cache.invalidateQueries({ queryKey: getGetMoyskladStatusQueryKey() }),
      cache.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
    ]);
  };
  const connect = async () => {
    const value = token.trim();
    if (value.length < 20) { setNote({ kind: 'error', text: t('settings.connectFailed') }); return; }
    setBusy(true); setNote(null);
    const response = await fetch('/api/settings/connection', { method: 'POST', headers, body: JSON.stringify({ token: value }) });
    setBusy(false);
    if (response.status === 401) { sessionStorage.removeItem(LOCAL_SESSION); setNote({ kind: 'error', text: t('auth.sessionExpired') }); return; }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      const key = body.error === 'api-denied' ? 'settings.connectApiDenied' : body.error === 'forbidden' ? 'settings.connectForbidden' : 'settings.connectFailed';
      setNote({ kind: 'error', text: t(key) });
      return;
    }
    setToken('');
    setNote({ kind: 'success', text: t('settings.accountReady') });
    await refresh();
  };
  const disconnect = async () => {
    setBusy(true); setNote(null);
    const response = await fetch('/api/settings/connection', { method: 'DELETE', headers });
    setBusy(false);
    if (!response.ok) { setNote({ kind: 'error', text: t('settings.connectFailed') }); return; }
    setNote(null);
    await refresh();
  };
  const stateLabel = !status.data?.configured && connection.data?.source === 'none'
    ? t('settings.state.unconfigured')
    : connected ? t('settings.state.connected') : t('settings.state.disconnected');
  return <Card title={t('settings.integration')} meta={t('settings.integration.meta')} className="settings-account" action={status.isFetching ? <span className="muted">{t('settings.integration.checking')}</span> : undefined}>
    <div className="integration">
      <span className={`seal ${connected ? 'seal-on' : ''}`}>{connected ? <ShieldCheck size={22}/> : <CircleAlert size={22}/>}</span>
      <div className="integration-copy">
        <h3>{company || t('settings.integration.unconfigured')}</h3>
        <p>{connected ? t('settings.integration.ok') : (status.data?.error || t('settings.integration.hint'))}</p>
      </div>
    </div>
    <div className="facts">
      <div><span>{t('settings.state')}</span><b data-testid="settings-ms-state">{stateLabel}</b></div>
      <div><span>{t('settings.masked')}</span><b>{connection.data?.masked || '—'}</b></div>
      <div><span>{t('settings.lastSync')}</span><b>{status.data?.lastSync ? dateTime(status.data.lastSync) : '—'}</b></div>
    </div>
    <div className="form-grid">
      <Field label={t('settings.token')} testId="field-ms-token">
        <span className="secret">
          <input className="input" type={showToken ? 'text' : 'password'} value={token} onChange={event => setToken(event.target.value)} placeholder={t('settings.tokenPlaceholder')} autoComplete="off" data-testid="input-ms-token"/>
          <button type="button" className="secret-eye" aria-label={showToken ? t('auth.hidePassword') : t('auth.showPassword')} onClick={() => setShowToken(open => !open)}>{showToken ? <EyeOff size={18}/> : <Eye size={18}/>}</button>
        </span>
      </Field>
      <div className="form-actions span-2">
        <Button testId="button-ms-connect" disabled={busy || token.trim().length < 20} onClick={() => void connect()}>{busy ? t('settings.connecting') : t('settings.connect')}</Button>
        {connection.data?.source === 'saved' && <Button testId="button-ms-disconnect" variant="secondary" disabled={busy} onClick={() => void disconnect()}>{t('settings.disconnect')}</Button>}
      </div>
    </div>
    {note && <Notice kind={note.kind === 'success' ? 'success' : 'error'} title={note.text} testId="status-ms-connection"/>}
  </Card>;
}
function MarkupPanel() {
  const { t } = useI18n();
  const session = readLocalSession();
  const [draft, setDraft] = useState<SaleMarkup>(DEFAULT_MARKUP);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  useEffect(() => {
    void fetch('/api/settings/markup').then(response => response.ok ? response.json() : null).then((data: Partial<SaleMarkup> | null) => {
      if (!data) return;
      setDraft(asMarkup(data));
    }).catch(() => undefined);
  }, []);
  const setPct = (key: SaleType) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const digits = pctDigits(event.target.value);
    const value = digits === '' ? 0 : Math.max(0, Math.min(99, Number(digits)));
    setDraft(current => ({ ...current, [key]: value }));
  };
  const save = async () => {
    setBusy(true); setNote(null);
    const response = await fetch('/api/settings/markup', {
      method: 'PUT',
      headers: { authorization: `Bearer ${session?.token || ''}`, 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    });
    setBusy(false);
    if (!response.ok) { setNote({ kind: 'error', text: t('common.tryAgain') }); return; }
    const saved = await response.json() as SaleMarkup;
    setDraft(saved);
    setNote({ kind: 'success', text: t('settings.markup.saved') });
  };
  return <Card title={t('settings.markup')} meta={t('settings.markup.meta')}>
    <p className="muted markup-hint">{t('settings.markup.hint')}</p>
    <div className="markup-row">
      {SALE_TYPES.map(type => <label className="field" key={type} data-testid={`field-markup-${type}`}><span>{type}</span><span className="pct-box"><TextInput testId={`input-markup-${type}`} inputMode="numeric" value={String(draft[type])} onChange={setPct(type)} onFocus={event => event.currentTarget.select()}/><span>%</span></span></label>)}
      <div className="form-actions"><Button testId="button-save-markup" disabled={busy} onClick={() => void save()}>{busy ? t('common.saving') : t('products.saved')}</Button></div>
    </div>
    {note && <Notice kind={note.kind === 'success' ? 'success' : 'error'} title={note.text} testId="status-markup"/>}
  </Card>;
}
function SettingsPage() {
  const { t, fmt } = useI18n(); const roleLabel = useRole();
  const users = useListUsers(); const me = useGetCurrentUser(); const updateRole = useUpdateUserRole(); const cache = useQueryClient();
  const admin = me.data?.role === 'super_admin' || me.data?.role === 'manager';
  const localAdmin = !clerkPubKey && readLocalSession()?.role === 'super_admin';
  return <>
    <PageHead title={t('settings.title')}/>
    {localAdmin && <MoySkladPanel/>}
    {localAdmin && <MarkupPanel/>}
    {localAdmin ? <AccessPanel/> : <Card title={t('settings.team')} meta={users.data ? t('settings.team.meta', { count: fmt(users.data.length) }) : ''}><QueryError q={users} id="users"/>{users.isLoading ? <LoadingRows count={3}/> : users.data?.length ? <ul className="user-list">{users.data.map(u => <li className="user-row" key={u.id} data-testid={`row-user-${u.id}`}><span className="avatar">{u.name.split(' ').map(x => x[0]).join('').slice(0, 2)}</span><span className="user-copy"><b>{u.id === 'local' ? t('shell.localUser') : u.name}</b><small>{u.email}</small></span>{admin ? <SelectInput value={u.role} onChange={role => updateRole.mutate({ id: u.id, data: { role: role as AppUserRole } }, { onSuccess: () => void cache.invalidateQueries({ queryKey: getListUsersQueryKey() }) })} testId={`select-role-${u.id}`}>{roleOptions.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}</SelectInput> : <span className="chip">{roleLabel(u.role)}</span>}</li>)}</ul> : <EmptyState title={t('settings.team.empty')} body={t('settings.team.emptyBody')} icon={Users}/>}</Card>}
  </>;
}

/* ---------- audit ---------- */
function AuditPage() {
  const { t, fmt, dateTime } = useI18n();
  const [search, setSearch] = useState('');
  const q = useListAuditEvents();
  const actionLabel = (action: string) => { const key = `audit.action.${action}` as TKey; const value = t(key); return value === key ? action : value; };
  const needle = search.trim().toLowerCase();
  const rows = (q.data ?? []).filter(event => !needle || `${actionLabel(event.action)} ${event.actor} ${event.entityType} ${event.details || ''}`.toLowerCase().includes(needle));
  return <>
    <PageHead title={t('audit.title')} actions={<><label className="search audit-search"><Search size={17}/><TextInput testId="input-audit-search" placeholder={t('audit.search')} value={search} onChange={event => setSearch(event.target.value)}/></label><ExportButton kind="audit" defaultPeriod="days7"/></>}/>
    {q.isPending ? <LoadingRows/> : q.isError ? <QueryError q={q} id="audit"/> : rows.length ? <Card className="table-card" title={t('audit.panel')} meta={t('audit.count', { count: fmt(rows.length) })}><Table testId="table-audit-events" columns={[t('audit.col.time'), t('common.action'), t('audit.col.object'), t('audit.col.actor'), t('audit.col.details')]} rows={rows.map(e => ({ key: e.id, testId: `row-audit-${e.id}`, cells: [dateTime(e.createdAt), actionLabel(e.action), <span className="cell-two"><b>{e.entityType}</b><small>{e.entityId || t('audit.noId')}</small></span>, e.actor, e.details || '—'] }))}/></Card> : <EmptyState title={search ? t('products.empty.search') : t('audit.empty.title')} body={search ? t('products.empty.searchBody') : t('audit.empty.body')} icon={search ? Search : Activity}/>}
  </>;
}

/* ---------- not found / error ---------- */
function NotFoundPage() {
  const { t } = useI18n();
  return <div className="state state-empty page-state"><span className="state-icon"><CircleAlert size={24}/></span><b>{t('notFound.title')}</b><p>{t('notFound.body')}</p><Link href="/dashboard" className="btn btn-primary">{t('notFound.home')}</Link></div>;
}
function ErrorFallback({ error, resetError }: ErrorFallbackProps) {
  const { t } = useI18n();
  return <div className="state state-error page-state"><CircleAlert size={22}/><div><b>{t('error.title')}</b><p>{t('error.body')}</p>{import.meta.env.DEV && <pre className="code-block">{error.message}</pre>}</div><button type="button" className="btn btn-secondary" onClick={resetError}>{t('error.retry')}</button></div>;
}

/* ---------- routing ---------- */
function RouteFrame({ title, children }: { title: string; children: ReactNode }) {
  const [location] = useLocation();
  const [sessionTick, setSessionTick] = useState(0);
  useEffect(() => {
    const refresh = () => setSessionTick(value => value + 1);
    window.addEventListener('smart-ombor-auth', refresh);
    return () => window.removeEventListener('smart-ombor-auth', refresh);
  }, []);
  const body = <ErrorBoundary resetKey={location} FallbackComponent={ErrorFallback}>{children}</ErrorBoundary>;
  const signedIn = Boolean(readLocalSession()) || sessionTick < 0;
  if (!clerkPubKey) {
    if (!signedIn) {
      const next = `${window.location.pathname}${window.location.search}`;
      if (next.startsWith('/') && next !== '/') sessionStorage.setItem(RETURN_PATH, next);
      return <EntryScreen><LocalLoginForm/></EntryScreen>;
    }
    return <LocalShell title={title}>{body}</LocalShell>;
  }
  return <WorkspaceGate><AppShell title={title}>{body}</AppShell></WorkspaceGate>;
}
function ProtectedRoute({ titleKey, children }: { titleKey: TKey; children: ReactNode }) {
  const [location] = useLocation(); const { t } = useI18n();
  return <RouteFrame key={location} title={t(titleKey)}>{children}</RouteFrame>;
}
function SignedInHome() {
  const back = sessionStorage.getItem(RETURN_PATH) || '';
  sessionStorage.removeItem(RETURN_PATH);
  const next = back.startsWith('/') && !back.startsWith('//') ? back : '/dashboard';
  return <Redirect to={next}/>;
}
function HomeRoute() {
  return <><Show when="signed-in"><SignedInHome/></Show><Show when="signed-out"><EntryScreen><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`}/></EntryScreen></Show></>;
}
function LocalHome() { return <EntryScreen><LocalLoginForm/></EntryScreen>; }
const pageRoutes: Array<{ path?: string; titleKey: TKey; element: ReactNode }> = [
  { path: '/dashboard', titleKey: 'nav.dashboard', element: <DashboardPage/> },
  { path: '/products', titleKey: 'nav.products', element: <ProductsPage/> },
  { path: '/stock', titleKey: 'nav.stock', element: <StockPage/> },
  { path: '/receipts', titleKey: 'nav.receipts', element: <DocumentsPage kind="receipt"/> },
  { path: '/transfers', titleKey: 'nav.transfers', element: <DocumentsPage kind="transfer"/> },
  { path: '/scanner', titleKey: 'nav.scanner', element: <ScannerPage/> },
  { path: '/analytics', titleKey: 'nav.analytics', element: <AnalyticsPage/> },
  { path: '/non-moving', titleKey: 'nav.nonMoving', element: <NonMovingPage/> },
  { path: '/factories', titleKey: 'nav.factories', element: <FactoriesPage/> },
  { path: '/branches', titleKey: 'nav.branches', element: <BranchesPage/> },
  { path: '/partners', titleKey: 'nav.partners', element: <PartnersPage/> },
  { path: '/inventory', titleKey: 'nav.inventory', element: <InventoryPage/> },
  { path: '/recommendations', titleKey: 'nav.recommendations', element: <RecommendationsPage/> },
  { path: '/tasks', titleKey: 'nav.tasks', element: <TasksPage/> },
  { path: '/reports', titleKey: 'nav.reports', element: <ReportsPage/> },
  { path: '/settings', titleKey: 'nav.settings', element: <SettingsPage/> },
  { path: '/audit', titleKey: 'nav.audit', element: <AuditPage/> },
  { titleKey: 'notFound.title', element: <NotFoundPage/> },
];
const appRoutes = pageRoutes.map(r => <Route key={r.path ?? '*'} path={r.path}><ProtectedRoute titleKey={r.titleKey}>{r.element}</ProtectedRoute></Route>);
function LocalRoutes() {
  return <Switch>
    <Route path="/" component={LocalHome}/>
    <Route path="/sign-in/*?" component={LocalSignInNotice}/>
    <Route path="/sign-up/*?" component={LocalSignInNotice}/>
    <Route path="/zavod" component={FactoryPortal}/>
    {appRoutes}
  </Switch>;
}
function ClerkRoutes() {
  const [, setLocation] = useLocation(); const { t } = useI18n();
  if (!clerkPubKey) return null;
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: t('auth.clerk.signInTitle'), subtitle: t('auth.clerk.signInSub') } }, signUp: { start: { title: t('auth.clerk.signUpTitle'), subtitle: t('auth.clerk.signUpSub') } } }} routerPush={to => setLocation(stripBase(to))} routerReplace={to => setLocation(stripBase(to), { replace: true })}>
    <ClerkQueryClientCacheInvalidator/>
    <Switch>
      <Route path="/" component={HomeRoute}/>
      <Route path="/sign-in/*?" component={SignInPage}/>
      <Route path="/sign-up/*?" component={SignUpPage}/>
      <Route path="/zavod" component={FactoryPortal}/>
      {appRoutes}
    </Switch>
  </ClerkProvider>;
}
function App() {
  return <I18nProvider><QueryClientProvider client={queryClient}><AutoRefresh/><WouterRouter base={basePath}>{clerkPubKey ? <ClerkRoutes/> : <LocalRoutes/>}</WouterRouter></QueryClientProvider></I18nProvider>;
}
export default App;
