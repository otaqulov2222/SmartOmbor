import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ClerkProvider, Show, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity, ArrowDownLeft, ArrowLeftRight, ArrowRight, BarChart3, Boxes,
  CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, ClipboardCheck, ClipboardList,
  Clock3, Factory, FileBarChart, FileText, Filter, Handshake, Languages, LayoutDashboard, LogOut, Menu,
  Package, Plus, RefreshCw, Search, Settings2, ShieldCheck, ScanBarcode, SlidersHorizontal,
  Sparkles, Tags, UserRound, Users, Warehouse, X,
} from 'lucide-react';
import { Link, Redirect, Route, Switch, Router as WouterRouter, useLocation, useSearch } from 'wouter';
import {
  getGetDashboardQueryKey, getGetMoyskladStatusQueryKey, getListTasksQueryKey, getListUsersQueryKey,
  useCreateTask, useGetCurrentUser, useGetDashboard,
  useGetMoyskladStatus, useGetNonMovingProducts, useGetPurchaseRecommendations, useGetSalesAnalytics,
  useListAuditEvents, useListDocuments, useListProducts, useListStock, useListTasks, useListUsers,
  useListWarehouses, useSyncMoysklad, useUpdateTask,
  useUpdateUserRole,
} from '@workspace/api-client-react';
import type {
  AppUserRole, Product, Task, TaskInputPriority,
} from '@workspace/api-client-react';
import { ErrorBoundary, type ErrorFallbackProps } from '@/components/error-boundary';
import { I18nProvider, useI18n, weekdayShort, longToday, formatShortDay, type Lang, type TKey } from '@/i18n';
import { AutoRefresh, AUTO_REFRESH_KEY, type AutoRefreshState } from '@/auto-refresh';
import { ExportButton, ReportsHub } from '@/export-dialog';
import { FactoryPortal } from '@/factory-portal';
import { ScannerPage } from '@/scanner';
import { PartnersPage } from '@/partners';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 20_000, retry: 1, refetchOnWindowFocus: false } } });
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const hostName = window.location.hostname;
const isLocalHost = hostName === 'localhost' || hostName === '127.0.0.1';
const clerkPubKey = isLocalHost
  ? import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || undefined
  : publishableKeyFromHost(hostName, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
function stripBase(path: string) { return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path; }

const clerkAppearance = {
  theme: shadcn, cssLayerName: 'clerk',
  options: { logoPlacement: 'inside' as const, logoLinkUrl: basePath || '/', logoImageUrl: `${window.location.origin}${basePath}/logo.svg` },
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
  { key: 'nav.partners', href: '/partners', icon: Handshake, group: 'nav.group.operations' },
  { key: 'nav.recommendations', href: '/recommendations', icon: Sparkles, group: 'nav.group.analytics' },
  { key: 'nav.reports', href: '/reports', icon: FileBarChart, group: 'nav.group.analytics' },
  { key: 'nav.audit', href: '/audit', icon: Activity, group: 'nav.group.system' },
  { key: 'nav.settings', href: '/settings', icon: Settings2, group: 'nav.group.system' },
];
const navGroups: TKey[] = ['nav.group.workspace', 'nav.group.operations', 'nav.group.analytics', 'nav.group.system'];
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
  return <div className={`brand ${light ? 'brand-light' : ''}`} data-testid="brand-smart-ombor"><span className="brand-symbol"><Boxes size={18} strokeWidth={2}/></span><span className="brand-name">{t('brand.first')} <b>{t('brand.second')}</b></span></div>;
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
function AuthSplash({ kicker, title, body, children }: { kicker: string; title: string; body: string; children: ReactNode }) {
  return <div className="auth"><aside className="auth-side"><BrandMark light/><div><p className="eyebrow eyebrow-light">{kicker}</p><h1>{title}</h1><p className="auth-body">{body}</p></div><LangSwitch/></aside><main className="auth-main">{children}</main></div>;
}
function SignInPage() {
  const { t } = useI18n();
  return <AuthSplash kicker={t('auth.signIn.kicker')} title={t('auth.signIn.title')} body={t('auth.signIn.body')}><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`}/></AuthSplash>;
}
function SignUpPage() {
  const { t } = useI18n();
  return <AuthSplash kicker={t('auth.signUp.kicker')} title={t('auth.signUp.title')} body={t('auth.signUp.body')}><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`}/></AuthSplash>;
}
function LocalSignInNotice() {
  const { t } = useI18n();
  return <AuthSplash kicker={t('auth.signIn.kicker')} title={t('auth.local.title')} body={t('auth.local.body')}><Link href="/" className="btn btn-primary">{t('auth.local.home')}</Link></AuthSplash>;
}

/* ---------- landing ---------- */
function PublicLanding() {
  const { isSignedIn } = useUser();
  return <LandingPage isSignedIn={Boolean(isSignedIn)}/>;
}
function LandingPage({ isSignedIn, startHref }: { isSignedIn: boolean; startHref?: string }) {
  const { t } = useI18n();
  const start = startHref || (isSignedIn ? '/dashboard' : '/sign-up');
  const features = [
    { icon: Warehouse, title: t('landing.f1.title'), body: t('landing.f1.body') },
    { icon: ScanBarcode, title: t('landing.f2.title'), body: t('landing.f2.body') },
    { icon: BarChart3, title: t('landing.f3.title'), body: t('landing.f3.body') },
    { icon: FileText, title: t('landing.f4.title'), body: t('landing.f4.body') },
  ];
  return <main className="landing" data-testid="page-public-landing">
    <header className="landing-nav"><BrandMark/><nav className="landing-links"><a href="#about">{t('landing.nav.about')}</a><a href="#features">{t('landing.nav.ops')}</a></nav><div className="landing-actions"><LangSwitch compact/>{startHref || isSignedIn ? <Link href={startHref || '/dashboard'} className="btn btn-primary" data-testid="link-open-workspace">{t('landing.nav.workspace')} <ArrowRight size={16}/></Link> : <><Link href="/sign-in" className="btn btn-ghost" data-testid="link-sign-in">{t('landing.nav.signIn')}</Link><Link href="/sign-up" className="btn btn-primary" data-testid="link-sign-up">{t('landing.nav.start')} <ArrowRight size={16}/></Link></>}</div></header>
    <section className="hero"><div className="hero-copy"><span className="pill"><span className="live-dot"/>{t('landing.badge')}</span><h1>{t('landing.title1')}<br/><span className="accent">{t('landing.title2')}</span></h1><p className="lead">{t('landing.lead')}</p><div className="hero-actions"><Link href={start} className="btn btn-primary btn-lg" data-testid="button-start-work">{t('landing.cta')} <ArrowRight size={17}/></Link><a href="#features" className="btn btn-ghost btn-lg" data-testid="link-explore">{t('landing.more')} <ChevronDown size={16}/></a></div></div>
      <div className="hero-visual" aria-hidden="true"><div className="mock"><div className="mock-bar"><i/><i/><i/></div><div className="mock-kpis"><div><small>{t('dash.kpi.products')}</small><b>6 357</b></div><div><small>{t('dash.kpi.units')}</small><b>248 186</b></div><div><small>{t('dash.kpi.sales')}</small><b>56 956 800</b></div></div><div className="mock-rows">{[82, 54, 38, 26, 14].map((w, i) => <div key={i}><span/><i style={{ width: `${w}%` }}/></div>)}</div></div></div>
    </section>
    <section className="features" id="features">{features.map(f => { const Icon = f.icon; return <article key={f.title} className="feature"><span className="feature-icon"><Icon size={20}/></span><h3>{f.title}</h3><p>{f.body}</p></article>; })}</section>
    <section className="about" id="about"><p className="eyebrow">{t('landing.about.kicker')}</p><h2>{t('landing.about.title')}</h2><p>{t('landing.about.body')}</p></section>
    <section className="closing"><h2>{t('landing.close.title')}</h2><Link href={startHref || (isSignedIn ? '/dashboard' : '/sign-in')} className="btn btn-light btn-lg" data-testid="button-enter-system">{t('landing.close.cta')} <ArrowRight size={16}/></Link><footer><span>{t('landing.footer.rights')}</span><span>{t('landing.footer.made')}</span><span>{t('landing.footer.integration')}</span></footer></section>
  </main>;
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
  return <WorkspaceChrome title={title} userName={t('shell.localUser')} onSignOut={() => setLocation('/')}>{children}</WorkspaceChrome>;
}
function WorkspaceChrome({ children, title, userName, onSignOut }: { children: ReactNode; title: string; userName: string; onSignOut: () => void }) {
  const { t, time, fmt } = useI18n(); const roleLabel = useRole();
  const [path] = useLocation(); const [open, setOpen] = useState(false);
  const current = navigation.find(x => x.href === path);
  const currentUser = useGetCurrentUser();
  const connection = useGetMoyskladStatus();
  const auto = useQuery<AutoRefreshState>({ queryKey: [...AUTO_REFRESH_KEY], queryFn: async () => ({ pending: false, last: null, nextAt: Date.now() }), enabled: false, initialData: { pending: false, last: null, nextAt: Date.now() } });
  const alerts = useQuery<{ pending: number }>({
    queryKey: ['partner-alerts'],
    queryFn: async () => {
      const response = await fetch('/api/partner-alerts');
      if (!response.ok) throw new Error('alerts');
      return response.json();
    },
    refetchInterval: 20_000,
  });
  const connected = !!connection.data?.configured && !!connection.data?.connected;
  const initials = userName.split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase();
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => { document.body.classList.toggle('nav-open', open); return () => document.body.classList.remove('nav-open'); }, [open]);
  return <div className="app">
    {open && <button className="scrim" aria-label={t('common.menuClose')} onClick={() => setOpen(false)} data-testid="button-close-navigation"/>}
    <aside className={`sidebar ${open ? 'is-open' : ''}`}>
      <div className="sidebar-top"><BrandMark light/><button className="icon-btn sidebar-close" onClick={() => setOpen(false)} aria-label={t('common.menuClose')} data-testid="button-navigation-close"><X size={18}/></button></div>
      <nav className="nav" aria-label={t('nav.group.workspace')}>{navGroups.map(group => <div key={group} className="nav-group"><p>{t(group)}</p>{navigation.filter(n => n.group === group).map(item => { const Icon = item.icon; const active = path === item.href; const pending = item.href === '/partners' ? alerts.data?.pending ?? 0 : 0; return <Link key={item.href} href={item.href} className={`nav-item ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined} data-testid={`nav-${item.href.slice(1)}`}><Icon size={18} strokeWidth={1.9}/><span>{t(item.key)}</span>{pending > 0 && <em className="nav-badge" title={t('partners.pending', { count: pending })}>{fmt(pending)}</em>}</Link>; })}</div>)}</nav>
      <div className="sidebar-bottom">
        <Link href="/settings" className="conn" title={connection.data?.lastSync ? t('shell.lastSync', { time: time(connection.data.lastSync) }) : undefined} data-testid="link-sidebar-connection"><span className={`dot ${connected ? 'dot-on' : ''}`}/><span className="conn-name">{connection.isLoading ? t('shell.checking') : connected ? (connection.data?.companyName || 'MoySklad') : t('shell.disconnected')}</span>{connection.data?.lastSync && <small>{time(connection.data.lastSync)}</small>}</Link>
        <div className="user"><span className="avatar">{initials}</span><span className="user-copy"><b>{userName}</b><small>{currentUser.data ? roleLabel(currentUser.data.role) : ''}</small></span><button type="button" onClick={onSignOut} className="icon-btn user-out" aria-label={t('common.signOut')} data-testid="button-sign-out"><LogOut size={16}/></button></div>
      </div>
    </aside>
    <div className="main">
      <header className="topbar"><button className="icon-btn menu-btn" onClick={() => setOpen(true)} aria-label={t('common.menuOpen')} data-testid="button-navigation-open"><Menu size={20}/></button><div className="crumbs"><span className="crumb-root">{t('brand.name')}</span><ChevronRight size={14}/><b>{current ? t(current.key) : title}</b></div><div className="topbar-right"><span className={`chip ${connected ? 'chip-on' : ''}`} data-testid="status-moysklad" title={connection.isLoading ? t('shell.checking') : connected ? t('shell.connected') : t('shell.disconnected')}><i/><span>{connection.isLoading ? t('shell.checking') : connected ? t('shell.connected') : t('shell.disconnected')}</span></span>{auto.data?.pending && <span className="chip chip-sync" title={t('refresh.every')}><RefreshCw size={13} className="spin"/><span>{t('refresh.updating')}</span></span>}<LangSwitch compact/><Link href="/scanner" className="scan-btn" data-testid="link-topbar-scanner" title={t('shell.scanner')} aria-label={t('shell.scanner')}><ScanMark size={17}/><span>{t('shell.scanner')}</span></Link></div></header>
      <main className="content"><div className="page-enter">{children}</div><footer className="foot"><span>{t('brand.name')}</span><span>{t('shell.footer.source')}</span></footer></main>
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
  const message = !raw ? t('common.serverLost') : status === '404' ? t('common.notAvailable') : /<html|<!doctype/i.test(raw) ? t('common.httpError', { status: status ?? '500' }) : raw;
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
function DashboardPage() {
  const { t, lang, fmt, money, time, date } = useI18n(); const docKind = useDocKind();
  const q = useGetDashboard(); const status = useGetMoyskladStatus(); const sync = useSyncMoysklad(); const cache = useQueryClient();
  const warehouses = useQuery<WarehouseTotal[]>({ queryKey: ['dashboard-warehouses'], queryFn: async () => { const r = await fetch('/api/dashboard/warehouses'); if (!r.ok) throw new Error(t('dash.warehouses.failed')); return r.json(); } });
  const docs = useListDocuments({});
  const sales = useGetSalesAnalytics({ period: '7d' });
  const connected = !!status.data?.configured && !!status.data?.connected;
  const d = q.data;
  const maxUnits = Math.max(1, ...(warehouses.data ?? []).map(w => w.units));
  const maxSale = Math.max(1, ...(sales.data?.trend ?? []).map(x => x.amount));
  const recentDocs = [...(docs.data ?? [])].sort((a, b) => +new Date(b.date) - +new Date(a.date)).slice(0, 6);
  const refresh = () => sync.mutate(undefined, { onSuccess: () => { void cache.invalidateQueries(); } });
  const attention = d ? [
    { href: '/products', icon: CircleAlert, tone: 'tone-amber', label: t('dash.attention.low'), note: t('dash.attention.low.note'), value: d.lowStockCount },
    { href: '/non-moving', icon: Clock3, tone: 'tone-slate', label: t('dash.attention.idle'), note: t('dash.attention.idle.note'), value: d.nonMovingCount },
    { href: '/transfers', icon: ArrowLeftRight, tone: 'tone-blue', label: t('dash.attention.transfers'), note: t('dash.attention.transfers.note'), value: d.pendingTransfers },
    { href: '/receipts', icon: ArrowDownLeft, tone: 'tone-green', label: t('dash.attention.incoming'), note: t('dash.attention.incoming.note'), value: d.incomingToday },
  ] : [];
  return <div className="dash">
    <header className="page-head"><div><p className="eyebrow">{longToday(lang)}</p><h1>{t('dash.title')}</h1><p className="with-dot">{connected ? <><span className="live-dot"/>{t('dash.sub.connected', { company: status.data?.companyName || 'MoySklad', time: time(d?.lastSync || status.data?.lastSync) })}</> : status.isLoading ? t('dash.sub.checking') : t('dash.sub.offline')}</p></div><div className="page-actions"><ExportButton kind="dashboard" defaultPeriod="today" testId="button-export-dashboard"/><button type="button" className="btn btn-secondary" disabled={!connected || sync.isPending} onClick={refresh} data-testid="button-sync-dashboard"><RefreshCw size={15} className={sync.isPending ? 'spin' : ''}/>{sync.isPending ? t('common.refreshing') : t('common.refresh')}</button></div></header>
    <QueryError q={q} id="dashboard"/>
    {status.isError && <Notice kind="error" title={t('dash.notice.statusFailed')} testId="status-integration-error"/>}
    {!status.isLoading && !connected && !status.isError && <Notice kind={status.data?.configured ? 'error' : 'info'} title={status.data?.configured ? t('dash.notice.disconnected') : t('dash.notice.unconfigured')} testId="status-integration-unconfigured">{status.data?.error || t('dash.notice.unconfiguredBody')} <Link href="/settings" className="notice-link" data-testid="link-settings-integration">{t('nav.settings')} <ArrowRight size={14}/></Link></Notice>}
    {sync.isError && <Notice kind="error" title={t('dash.sync.failed')} testId="status-sync-error">{sync.error instanceof Error ? sync.error.message : t('common.tryAgain')}</Notice>}
    {q.isLoading ? <LoadingRows count={3}/> : d ? <>
      <section className="kpis" aria-label={t('dash.title')}>
        <Link href="/products" className="kpi" data-testid="metric-products"><span className="kpi-icon"><Package size={18}/></span><span className="kpi-label">{t('dash.kpi.products')}</span><strong>{fmt(d.productCount)}</strong><small>{t('dash.kpi.products.note')}</small></Link>
        <Link href="/stock" className="kpi" data-testid="metric-units"><span className="kpi-icon tone-green"><Boxes size={18}/></span><span className="kpi-label">{t('dash.kpi.units')}</span><strong>{fmt(d.stockUnits)}</strong><small>{t('dash.kpi.units.note', { count: warehouses.data?.length ?? '—' })}</small></Link>
        <div className="kpi" data-testid="metric-value"><span className="kpi-icon tone-amber"><Tags size={18}/></span><span className="kpi-label">{t('dash.kpi.value')}</span><strong>{money(d.stockValue)}</strong><small>{t('dash.kpi.value.note')}</small></div>
        <Link href="/analytics" className="kpi" data-testid="metric-sales"><span className="kpi-icon tone-blue"><BarChart3 size={18}/></span><span className="kpi-label">{t('dash.kpi.sales')}</span><strong>{money(d.salesToday)}</strong><small>{t('dash.kpi.sales.note')}</small></Link>
      </section>
      <div className="dash-grid">
        <div className="dash-col">
          <Card title={t('dash.warehouses')} meta={warehouses.data ? t('dash.warehouses.meta', { count: warehouses.data.length }) : ''}>
            {warehouses.isLoading ? <LoadingRows count={4}/> : warehouses.isError ? <p className="muted">{t('dash.warehouses.failed')}</p> : <ul className="wh-list">{warehouses.data?.map(w => <li key={w.id}><Link href={`/stock?warehouseId=${w.id}`} className="wh-row" data-testid={`warehouse-${w.id}`}><span className="wh-name"><Warehouse size={15}/><b>{w.name}</b></span><span className="wh-bar"><i style={{ width: `${Math.max(2, (w.units / maxUnits) * 100)}%` }}/></span><span className="wh-num">{fmt(w.units)}<small>{t('dash.warehouses.types', { count: fmt(w.products) })}{w.inTransit > 0 ? ` · ${t('dash.warehouses.inTransit', { count: fmt(w.inTransit) })}` : ''}</small></span></Link></li>)}</ul>}
          </Card>
          <Card title={t('dash.docs')} meta="MoySklad" action={<Link href="/receipts" className="link" data-testid="link-all-documents">{t('dash.docs.all')} <ArrowRight size={13}/></Link>}>
            {docs.isLoading ? <LoadingRows count={3}/> : recentDocs.length ? <ul className="doc-list">{recentDocs.map(doc => <li key={doc.id} className="doc-row" data-testid={`doc-${doc.id}`}><span className={`doc-icon doc-${doc.kind}`}>{doc.kind === 'receipt' ? <ArrowDownLeft size={15}/> : doc.kind === 'transfer' ? <ArrowLeftRight size={15}/> : <ClipboardCheck size={15}/>}</span><span className="doc-copy"><b>{docKind(doc.kind)} № {doc.number}</b><small>{[doc.sourceWarehouse, doc.targetWarehouse].filter(Boolean).join(' → ') || '—'}</small></span><span className="doc-meta"><Badge value={doc.status}/><small>{date(doc.date)}</small></span></li>)}</ul> : <p className="muted">{t('dash.docs.empty')}</p>}
          </Card>
        </div>
        <div className="dash-col">
          <Card title={t('dash.attention')} meta={t('common.today')}>
            <ul className="attn-list">{attention.map(a => { const Icon = a.icon; return <li key={a.href}><Link href={a.href} className="attn-row" data-testid={`link-${a.href.slice(1)}`}><span className={`attn-icon ${a.tone}`}><Icon size={17}/></span><span className="attn-copy"><b>{a.label}</b><small>{a.note}</small></span><strong className={a.value > 0 ? '' : 'is-zero'}>{fmt(a.value)}</strong><ChevronRight size={16} className="attn-chev"/></Link></li>; })}</ul>
          </Card>
          <Card title={t('dash.sales7')} meta={sales.data ? money(sales.data.totalAmount) : ''}>
            {sales.isLoading ? <LoadingRows count={2}/> : sales.data && sales.data.trend.length ? <><div className="spark" role="img" aria-label={t('dash.sales7.chart')}>{sales.data.trend.map(x => <div key={x.date} className="spark-col" title={`${date(x.date)} · ${money(x.amount)}`}><i style={{ height: `${Math.max(3, (x.amount / maxSale) * 100)}%` }}/><span>{weekdayShort(lang, x.date)}</span></div>)}</div><div className="spark-foot"><span>{t('dash.sales7.avg')}</span><b>{money(sales.data.averagePerDay)}</b></div></> : <p className="muted">{t('dash.sales7.empty')}</p>}
          </Card>
        </div>
      </div>
    </> : <EmptyState title={t('dash.empty.title')} body={t('dash.empty.body')} icon={LayoutDashboard}/>}
  </div>;
}

/* ---------- products ---------- */
function ProductsPage() {
  const { t, fmt, money, time } = useI18n(); const unit = useUnit();
  const urlSearch = new URLSearchParams(useSearch()).get('search') || '';
  const [search, setSearch] = useState(urlSearch); const [stockStatus, setStatus] = useState('all'); const [page, setPage] = useState(1);
  useEffect(() => { setSearch(urlSearch); setPage(1); }, [urlSearch]);
  const params = useMemo(() => ({ search: search || undefined, stockStatus: stockStatus as 'all'|'low'|'available'|'out', page, pageSize: 25 }), [search, stockStatus, page]);
  const q = useListProducts(params); const cache = useQueryClient();
  const dash = useGetDashboard(); const status = useGetMoyskladStatus(); const sync = useSyncMoysklad();
  const [selected, setSelected] = useState<Product | null>(null);
  const refresh = () => sync.mutate(undefined, { onSuccess: () => { void cache.invalidateQueries(); } });
  return <>
    <PageHead title={t('products.title')} subtitle={status.data?.lastSync ? t('products.synced', { time: time(status.data.lastSync) }) : t('products.sub')}/>
    {dash.data && <div className="product-kpis">
      <div><span>{t('dash.kpi.products')}</span><b>{fmt(dash.data.productCount)}</b></div>
      <div><span>{t('products.filter.low')}</span><b>{fmt(dash.data.lowStockCount)}</b></div>
      <div><span>{t('status.non_moving')}</span><b>{fmt(dash.data.nonMovingCount)}</b></div>
      <div><span>{t('dash.kpi.value')}</span><b>{money(dash.data.stockValue)}</b></div>
    </div>}
    <div className="toolbar"><label className="search"><Search size={17}/><TextInput testId="input-products-search" type="search" placeholder={t('products.searchPlaceholder')} value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}/></label><label className="select-wrap"><Filter size={15}/><SelectInput testId="select-products-status" value={stockStatus} onChange={v => { setStatus(v); setPage(1); }}><option value="all">{t('products.filter.all')}</option><option value="low">{t('products.filter.low')}</option><option value="available">{t('products.filter.available')}</option><option value="out">{t('products.filter.out')}</option></SelectInput></label><ExportButton kind="products"/><Button variant="secondary" testId="button-products-refresh" disabled={sync.isPending} onClick={refresh}><RefreshCw size={15} className={sync.isPending ? 'spin' : ''}/>{sync.isPending ? t('common.refreshing') : t('common.refresh')}</Button></div>
    <QueryError q={q} id="products"/>
    <Card className="table-card" title={t('products.catalog')} meta={q.data ? t('products.results', { count: fmt(q.data.total) }) : ''}>
      {q.isLoading ? <LoadingRows/> : q.data?.items.length ? <><ProductTable products={q.data.items} onOpen={setSelected}/><div className="pager"><span>{t('products.range', { total: fmt(q.data.total), from: fmt(Math.min((page - 1) * q.data.pageSize + 1, q.data.total)), to: fmt(Math.min(page * q.data.pageSize, q.data.total)) })}</span><div className="pager-nav"><button className="icon-btn" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={t('common.prevPage')} data-testid="button-products-prev"><ChevronLeft size={17}/></button><span>{page}</span><button className="icon-btn" disabled={page * q.data.pageSize >= q.data.total} onClick={() => setPage(page + 1)} aria-label={t('common.nextPage')} data-testid="button-products-next"><ChevronRight size={17}/></button></div></div></> : <EmptyState title={search ? t('products.empty.search') : t('products.empty.title')} body={search ? t('products.empty.searchBody') : t('products.empty.body')}/>}
    </Card>
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
        <div><small>{t('products.detail.cover')}</small><b>{selected.daysCover == null ? '—' : `${fmt(selected.daysCover)} ${t('common.days')}`}</b></div>
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
  const { t, fmt, money, time } = useI18n(); const unit = useUnit();
  const searchParams = useSearch();
  const [, setLocation] = useLocation();
  const warehouseId = new URLSearchParams(searchParams).get('warehouseId') || '';
  const urlSearch = new URLSearchParams(searchParams).get('search') || '';
  const [search, setSearch] = useState(urlSearch);
  const [page, setPage] = useState(1);
  useEffect(() => { setSearch(urlSearch); setPage(1); }, [urlSearch]);
  const params = useMemo(() => ({ warehouseId: warehouseId || undefined, search: search || undefined, page, pageSize: 50 }), [warehouseId, search, page]);
  const q = useListStock(params);
  const cache = useQueryClient();
  const status = useGetMoyskladStatus();
  const sync = useSyncMoysklad();
  const warehouses = useQuery<WarehouseTotal[]>({ queryKey: ['dashboard-warehouses'], queryFn: async () => { const response = await fetch('/api/dashboard/warehouses'); if (!response.ok) throw new Error('warehouses'); return response.json(); } });
  const chosen = warehouses.data?.find(item => item.id === warehouseId);
  const summary = chosen ?? (warehouses.data ? warehouses.data.reduce((sum, item) => ({ id: 'all', name: '', units: sum.units + item.units, products: sum.products + item.products, inTransit: sum.inTransit + item.inTransit, value: sum.value + item.value }), { id: 'all', name: '', units: 0, products: 0, inTransit: 0, value: 0 }) : null);
  const refresh = () => sync.mutate(undefined, { onSuccess: () => { void cache.invalidateQueries(); } });
  const chooseWarehouse = (id: string) => { setPage(1); setLocation(id ? `/stock?warehouseId=${encodeURIComponent(id)}` : '/stock'); };
  return <>
    <PageHead title={t('stock.title')} subtitle={status.data?.lastSync ? t('stock.synced', { time: time(status.data.lastSync) }) : t('stock.sub')}/>
    {summary && <div className="product-kpis">
      <div><span>{t('dash.kpi.units')}</span><b>{fmt(summary.units)}</b></div>
      <div><span>{t('dash.kpi.products')}</span><b>{fmt(summary.products)}</b></div>
      <div><span>{t('stock.col.inTransit')}</span><b>{fmt(summary.inTransit)}</b></div>
      <div><span>{t('stock.col.value')}</span><b>{money(summary.value)}</b></div>
    </div>}
    <div className="toolbar"><label className="search"><Search size={17}/><TextInput testId="input-stock-search" placeholder={t('stock.searchPlaceholder')} value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}/></label><label className="select-wrap"><Warehouse size={16}/><WarehousesSelect value={warehouseId} onChange={chooseWarehouse} testId="select-stock-warehouse"/></label><ExportButton kind="stock"/><Button variant="secondary" testId="button-stock-refresh" disabled={sync.isPending} onClick={refresh}><RefreshCw size={15} className={sync.isPending ? 'spin' : ''}/>{sync.isPending ? t('common.refreshing') : t('common.refresh')}</Button></div>
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
    <div className="toolbar"><label className="select-wrap"><SlidersHorizontal size={15}/><SelectInput value={period} onChange={setPeriod} testId="select-analytics-period">{(['7d', '30d', '90d', '365d'] as const).map(p => <option key={p} value={p}>{t(`analytics.period.${p}` as TKey)}</option>)}</SelectInput></label><label className="select-wrap"><Warehouse size={16}/><WarehousesSelect value={warehouse} onChange={setWarehouse} testId="select-analytics-warehouse"/></label><ExportButton kind="sales" defaultPeriod={period === '7d' ? 'days7' : period === '30d' ? 'thisMonth' : 'all'}/></div>
    <QueryError q={q} id="analytics"/>
    {q.isLoading ? <LoadingRows count={5}/> : q.data ? <>
      <div className="metrics metrics-3"><Metric label={t('analytics.total')} value={money(q.data.totalAmount)} note={periodLabel} icon={BarChart3} tone="tone-blue"/><Metric label={t('analytics.qty')} value={fmt(q.data.totalQuantity)} note={t('analytics.qty.note')} icon={Package}/><Metric label={t('analytics.avg')} value={money(q.data.averagePerDay)} note={t('analytics.avg.note')} icon={Activity} tone="tone-green"/></div>
      <div className="two-col">
        <Card title={t('analytics.trend')} meta={periodLabel}><div className="chart" data-testid="chart-sales-trend"><div className="chart-bars">{q.data.trend.map((p, i) => <div key={`${p.date}-${i}`} className="chart-col" data-testid={`bar-sales-${p.date}`} title={`${date(p.date)} · ${money(p.amount)}`}><i style={{ height: `${Math.max(2, (p.amount / max) * 100)}%` }}/>{(q.data!.trend.length <= 14 || i % Math.ceil(q.data!.trend.length / 12) === 0) && <small>{q.data!.trend.length <= 7 ? weekdayShort(lang, p.date) : formatShortDay(lang, p.date)}</small>}</div>)}</div></div></Card>
        <Card title={t('analytics.top')} meta={t('analytics.top.meta', { count: q.data.topProducts.length })}>{q.data.topProducts.length ? <ul className="rank-list">{q.data.topProducts.map((p, i) => <li key={p.id} data-testid={`row-top-product-${p.id}`}><span className="rank">{String(i + 1).padStart(2, '0')}</span><ProductTitle product={p} href={`/products?search=${encodeURIComponent(p.code || p.name)}`}/><span className="rank-val">{fmt(p.sales30)}<small>{t('analytics.top.sales')}</small></span></li>)}</ul> : <EmptyState title={t('analytics.top.empty')} body={t('analytics.top.emptyBody')}/>}</Card>
      </div>
    </> : <EmptyState title={t('analytics.empty.title')} body={t('analytics.empty.body')} icon={BarChart3}/>}
  </>;
}

/* ---------- non-moving ---------- */
function NonMovingPage() {
  const { t, fmt } = useI18n();
  const [days, setDays] = useState('30'); const [warehouse, setWarehouse] = useState('');
  const params = useMemo(() => ({ days: Number(days) as 7|15|25|30|60|90, warehouseId: warehouse || undefined }), [days, warehouse]);
  const q = useGetNonMovingProducts(params);
  return <>
    <PageHead title={t('idle.title')} subtitle={t('idle.sub')}/>
    <div className="toolbar"><label className="select-wrap"><Clock3 size={15}/><SelectInput value={days} onChange={setDays} testId="select-idle-days">{['7', '15', '25', '30', '60', '90'].map(d => <option key={d} value={d}>{t('idle.since', { days: d })}</option>)}</SelectInput></label><label className="select-wrap"><Warehouse size={16}/><WarehousesSelect value={warehouse} onChange={setWarehouse} testId="select-idle-warehouse"/></label><ExportButton kind="nonMoving"/></div>
    <QueryError q={q} id="non-moving"/>
    <Card className="table-card" title={t('idle.panel')} meta={q.data ? t('idle.count', { count: fmt(q.data.length) }) : ''}>{q.isLoading ? <LoadingRows/> : q.data?.length ? <ProductTable products={q.data} testId="table-non-moving"/> : <EmptyState title={t('idle.empty.title')} body={t('idle.empty.body')} icon={Clock3}/>}</Card>
  </>;
}

/* ---------- factories ---------- */
type FactoryGroup = { name: string; count: number; stock: number; products: Array<{ id: string; name: string; code: string | null; stock: number; imageUrl: string | null }> };
function FactoriesPage() {
  const { t, fmt } = useI18n();
  const [search, setSearch] = useState('');
  const q = useQuery<{ items: FactoryGroup[] }>({ queryKey: ['catalog-factories'], queryFn: async () => { const response = await fetch('/api/catalog/factories'); if (!response.ok) throw new Error('factories'); return response.json(); } });
  const makers = (q.data?.items ?? []).filter(item => { const name = item.name || t('factories.unknown'); const hay = `${name} ${item.products.map(p => `${p.name} ${p.code || ''}`).join(' ')}`.toLowerCase(); return !search.trim() || hay.includes(search.trim().toLowerCase()); });
  return <>
    <PageHead title={t('factories.title')} subtitle={t('factories.sub')}/>
    <div className="toolbar"><label className="search"><Search size={17}/><TextInput testId="input-factory-search" placeholder={t('factories.searchPlaceholder')} value={search} onChange={e => setSearch(e.target.value)}/></label><ExportButton kind="factories"/></div>
    {q.isError ? <ErrorState message={q.error instanceof Error ? q.error.message : t('common.tryAgain')} retry={() => { void q.refetch(); }} id="factories"/> : null}
    {q.isLoading ? <LoadingRows/> : makers.length ? <div className="factory-grid">{makers.map((data, i) => { const name = data.name || t('factories.unknown'); return <details className="card factory" key={name || 'unknown'} data-testid={`factory-card-${i}`}><summary><span className="rank">{String(i + 1).padStart(2, '0')}</span><span className="factory-main"><b>{name}</b><small>{t('factories.summary', { count: fmt(data.count), stock: fmt(data.stock) })}</small></span><ChevronDown size={17}/></summary><div className="factory-products">{data.products.map(p => <div key={p.id} data-testid={`factory-product-${p.id}`}><Link href={`/products?search=${encodeURIComponent(p.code || p.name)}`}><b>{p.name}</b><small>{p.code || t('common.noCode')}</small></Link><span>{fmt(p.stock)}</span></div>)}{data.count > data.products.length && <p className="muted">{t('factories.partial', { shown: fmt(data.products.length), total: fmt(data.count) })}</p>}</div></details>; })}</div> : <EmptyState title={t('factories.empty.title')} body={t('factories.empty.body')} icon={Factory}/>}
  </>;
}

/* ---------- recommendations ---------- */
function RecommendationsPage() {
  const { t, fmt } = useI18n(); const unit = useUnit();
  const [warehouse, setWarehouse] = useState('');
  const params = useMemo(() => ({ warehouseId: warehouse || undefined }), [warehouse]);
  const q = useGetPurchaseRecommendations(params);
  const reason = (code: string) => { const key = `reco.reason.${code}` as TKey; const v = t(key); return v === key ? code : v; };
  return <>
    <PageHead title={t('reco.title')} subtitle={t('reco.sub')}/>
    <div className="toolbar"><label className="select-wrap"><Warehouse size={16}/><WarehousesSelect value={warehouse} onChange={setWarehouse} testId="select-recommendation-warehouse"/></label><ExportButton kind="recommendations"/></div>
    <QueryError q={q} id="recommendations"/>
    {q.isLoading ? <LoadingRows/> : q.data?.length ? <Card className="table-card" title={t('reco.panel')} meta={t('reco.count', { count: fmt(q.data.length) })}><Table testId="table-recommendations" numeric={[2, 3, 4]} columns={[t('common.product'), t('reco.col.current'), t('reco.col.perDay'), t('reco.col.lead'), t('reco.col.suggested'), t('reco.col.reason')]} rows={q.data.map(r => ({ key: `${r.product.id}-${r.warehouseId}`, testId: `row-recommendation-${r.product.id}`, cells: [<ProductTitle product={r.product} href={`/products?search=${encodeURIComponent(r.product.code || r.product.name)}`}/>, <span className="cell-two"><b>{t('reco.onHand', { count: fmt(r.onHand) })}</b><small>{t('reco.inTransit', { count: fmt(r.inTransit) })}</small></span>, fmt(r.dailyAverage, 2), `${fmt(r.leadTimeDays)} ${t('common.days')}`, <b className="accent-text">{fmt(r.suggestedQuantity)} {unit(r.product.unit)}</b>, reason(r.reason)] }))}/></Card> : <EmptyState title={t('reco.empty.title')} body={t('reco.empty.body')} icon={Sparkles}/>}
  </>;
}

/* ---------- documents ---------- */
function DocumentsPage({ kind }: { kind: 'receipt'|'transfer' }) {
  const { t, fmt, date } = useI18n(); const docKind = useDocKind();
  const q = useListDocuments({ kind });
  const isReceipt = kind === 'receipt';
  return <>
    <PageHead title={isReceipt ? t('docs.receipts.title') : t('docs.transfers.title')} subtitle={isReceipt ? t('docs.receipts.sub') : t('docs.transfers.sub')} actions={<ExportButton kind={isReceipt ? 'receipts' : 'transfers'} defaultPeriod="today"/>}/>
    <QueryError q={q} id={kind}/>
    <Card className="table-card" title={t('docs.panel')} meta={q.data ? t('docs.count', { count: fmt(q.data.length) }) : ''}>
      {q.isLoading ? <LoadingRows/> : q.data?.length ? <Table testId={`table-${kind}-documents`} numeric={[5]} columns={[t('common.number'), t('common.date'), t('common.status'), t('docs.col.source'), t('docs.col.target'), t('docs.col.items')]} rows={q.data.map(d => ({ key: d.id, testId: `row-document-${d.id}`, cells: [<span className="cell-two"><b>{d.number}</b><small>{docKind(d.kind)}</small></span>, date(d.date), <Badge value={d.status}/>, d.sourceWarehouse || '—', d.targetWarehouse || '—', t('docs.items', { count: fmt(d.itemCount) })] }))}/> : <EmptyState title={t('docs.empty.title')} body={t('docs.empty.body')} icon={isReceipt ? ArrowDownLeft : ArrowLeftRight}/>}
    </Card>
  </>;
}

/* ---------- inventory ---------- */
function InventoryPage() {
  const { t, fmt, date } = useI18n();
  const q = useListDocuments({ kind: 'inventory' });
  return <>
    <PageHead title={t('inv.title')} subtitle={t('inv.sub')} actions={<ExportButton kind="inventory" defaultPeriod="thisMonth"/>}/>
    <QueryError q={q} id="inventory"/>
    <Card className="table-card" title={t('inv.sessions')} meta={q.data ? t('inv.sessions.count', { count: fmt(q.data.length) }) : ''}>{q.isLoading ? <LoadingRows/> : q.data?.length ? <Table testId="table-inventory-sessions" numeric={[3]} columns={[t('common.number'), t('common.date'), t('common.warehouse'), t('inv.col.rows'), t('common.status')]} rows={q.data.map(d => ({ key: d.id, testId: `row-inventory-${d.id}`, cells: [<b>{d.number}</b>, date(d.date), d.sourceWarehouse || '—', fmt(d.itemCount), <Badge value={d.status}/>] }))}/> : <EmptyState title={t('inv.empty.title')} body={t('inv.empty.body')} icon={ClipboardCheck}/>}</Card>
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
  return <><PageHead title={t('reports.title')} subtitle={t('reports.sub')}/><ReportsHub/></>;
}

/* ---------- settings ---------- */
function SettingsPage() {
  const { t, fmt, dateTime, lang, setLang } = useI18n(); const roleLabel = useRole(); const statusLabel = useStatusLabel();
  const status = useGetMoyskladStatus(); const users = useListUsers(); const me = useGetCurrentUser(); const sync = useSyncMoysklad(); const updateRole = useUpdateUserRole(); const cache = useQueryClient();
  const admin = me.data?.role === 'super_admin' || me.data?.role === 'manager';
  const connected = !!status.data?.configured && !!status.data?.connected;
  return <>
    <PageHead title={t('settings.title')} subtitle={t('settings.sub')}/>
    <QueryError q={status} id="integration-settings"/>
    <div className="two-col">
      <Card title={t('settings.integration')} meta={t('settings.integration.meta')}>
        <div className="integration"><span className={`seal ${connected ? 'seal-on' : ''}`}><Boxes size={24}/></span><div><Badge value={status.isLoading ? 'loading' : status.data?.configured ? (connected ? 'healthy' : 'sync_error') : 'out'}/><h3>{status.isLoading ? t('settings.integration.checking') : status.data?.configured ? (status.data.companyName || t('settings.integration.account')) : t('settings.integration.unconfigured')}</h3><p className="muted">{status.data?.error || (connected ? t('settings.integration.ok') : t('settings.integration.hint'))}</p></div></div>
        <div className="facts"><div><span>{t('settings.lastSync')}</span><b>{dateTime(status.data?.lastSync)}</b></div><div><span>{t('settings.state')}</span><b>{status.data?.configured ? (connected ? t('settings.state.connected') : t('settings.state.disconnected')) : t('settings.state.unconfigured')}</b></div><div><span>{t('settings.autoRefresh')}</span><b>{t('settings.autoRefresh.value')}</b></div></div>
        <div className="form-actions"><Button testId="button-sync-settings" disabled={!connected || sync.isPending || !admin} onClick={() => sync.mutate(undefined, { onSuccess: () => { void cache.invalidateQueries(); } })}><RefreshCw size={15} className={sync.isPending ? 'spin' : ''}/>{sync.isPending ? t('settings.syncing') : t('settings.sync')}</Button><small className="muted">{!admin ? t('settings.sync.needRole') : t('settings.sync.hint')}</small></div>
        {sync.error && <Notice kind="error" title={t('settings.sync.failed')} testId="status-settings-sync-error">{sync.error instanceof Error ? sync.error.message : t('common.tryAgain')}</Notice>}
        {sync.data && <Notice kind={sync.data.status === 'failed' ? 'error' : 'success'} title={statusLabel(sync.data.status)} testId="status-settings-sync-result">{sync.data.error || t('settings.sync.result', { products: fmt(sync.data.productCount), warehouses: fmt(sync.data.warehouseCount) })}</Notice>}
      </Card>
      <div className="stack">
        <Card title={t('settings.language')}><p className="muted">{t('settings.language.body')}</p><div className="lang-cards">{(['uz', 'ru'] as Lang[]).map(code => <button key={code} type="button" className={`option ${lang === code ? 'is-active' : ''}`} onClick={() => setLang(code)} data-testid={`settings-lang-${code}`}><span className="option-icon"><Languages size={18}/></span><span className="option-copy"><b>{code === 'uz' ? 'O‘zbek tili' : 'Русский язык'}</b><small>{code.toUpperCase()}</small></span><span className="radio"/></button>)}</div></Card>
        <Card title={t('settings.team')} meta={users.data ? t('settings.team.meta', { count: fmt(users.data.length) }) : ''}><p className="muted">{t('settings.team.helper')}</p><QueryError q={users} id="users"/>{users.isLoading ? <LoadingRows count={3}/> : users.data?.length ? <ul className="user-list">{users.data.map(u => <li className="user-row" key={u.id} data-testid={`row-user-${u.id}`}><span className="avatar">{u.name.split(' ').map(x => x[0]).join('').slice(0, 2)}</span><span className="user-copy"><b>{u.id === 'local' ? t('shell.localUser') : u.name}</b><small>{u.email}</small></span>{admin ? <SelectInput value={u.role} onChange={role => updateRole.mutate({ id: u.id, data: { role: role as AppUserRole } }, { onSuccess: () => void cache.invalidateQueries({ queryKey: getListUsersQueryKey() }) })} testId={`select-role-${u.id}`}>{roleOptions.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}</SelectInput> : <span className="chip">{roleLabel(u.role)}</span>}</li>)}</ul> : <EmptyState title={t('settings.team.empty')} body={t('settings.team.emptyBody')} icon={Users}/>}</Card>
        <div className="notice notice-info"><ShieldCheck size={18}/><div><b>{t('settings.perm.title')}</b><p>{t('settings.perm.body')}</p></div></div>
      </div>
    </div>
  </>;
}

/* ---------- audit ---------- */
function AuditPage() {
  const { t, fmt, dateTime } = useI18n();
  const q = useListAuditEvents();
  return <>
    <PageHead title={t('audit.title')} subtitle={t('audit.sub')} actions={<ExportButton kind="audit" defaultPeriod="days7"/>}/>
    <QueryError q={q} id="audit"/>
    <Card className="table-card" title={t('audit.panel')} meta={q.data ? t('audit.count', { count: fmt(q.data.length) }) : ''}>{q.isLoading ? <LoadingRows/> : q.data?.length ? <Table testId="table-audit-events" columns={[t('audit.col.time'), t('common.action'), t('audit.col.object'), t('audit.col.actor'), t('audit.col.details')]} rows={q.data.map(e => ({ key: e.id, testId: `row-audit-${e.id}`, cells: [dateTime(e.createdAt), <code className="code">{e.action}</code>, <span className="cell-two"><b>{e.entityType}</b><small>{e.entityId || t('audit.noId')}</small></span>, e.actor, e.details || '—'] }))}/> : <EmptyState title={t('audit.empty.title')} body={t('audit.empty.body')} icon={Activity}/>}</Card>
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
  const body = <ErrorBoundary resetKey={location} FallbackComponent={ErrorFallback}>{children}</ErrorBoundary>;
  if (!clerkPubKey) return <LocalShell title={title}>{body}</LocalShell>;
  return <WorkspaceGate><AppShell title={title}>{body}</AppShell></WorkspaceGate>;
}
function ProtectedRoute({ titleKey, children }: { titleKey: TKey; children: ReactNode }) {
  const [location] = useLocation(); const { t } = useI18n();
  return <RouteFrame key={location} title={t(titleKey)}>{children}</RouteFrame>;
}
function HomeRoute() {
  return <><Show when="signed-in"><Redirect to="/dashboard"/></Show><Show when="signed-out"><PublicLanding/></Show></>;
}
function LocalHome() { return <LandingPage isSignedIn={false} startHref="/dashboard"/>; }
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
