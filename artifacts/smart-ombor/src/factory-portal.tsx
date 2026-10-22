import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Eye, EyeOff, FilePlus2, History, LogOut, Menu, Pencil, Send, Trash2, UserRound, X } from 'lucide-react';
import { useI18n, type Lang } from '@/i18n';

type Account = { id: string; name: string; code: string; login: string };
type ColorLine = { name: string; quantity: number };
type Line = { id: string; factoryCode: string; sectionCode: string; productCode: string; productName?: string | null; model: string; size: string; pairs: number; boxes: number; quantity: number; price: number; priceType?: string; colors: ColorLine[] };
type Shipment = { id: string; number: string; date: string; status: string; note?: string; pairs: number; boxes: number; amount: number; lines: Line[] };
type Draft = { key: string; factoryCode: string; groupCode: string; productCode: string; model: string; size: string; pairs: string; boxes: string; price: string; priceType: string; colors: ColorLine[] };

const TOKEN_KEY = 'smart-ombor-factory-token';
const LINE_SIZES = ['20-23', '24-29', '30-35', '36-40', '40-44'] as const;

function blank(factoryCode: string): Draft {
  return { key: Math.random().toString(36).slice(2), factoryCode, groupCode: '', productCode: '', model: '', size: '', pairs: '', boxes: '', price: '', priceType: '', colors: [] };
}

function started(line: Draft) {
  return Boolean(line.pairs || line.boxes || line.price);
}

function withBlank(rows: Draft[]) {
  const last = rows[rows.length - 1];
  const sum = last ? unitsOf(last) * num(last.price) : 0;
  if (!last || sum > 0) return [...rows, blank(last?.factoryCode || '')];
  return rows;
}

function num(value: string) {
  const parsed = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function digits(value: string) {
  return value.replace(/\D/g, '');
}

function unitsOf(line: Draft) {
  const pack = num(line.pairs);
  const boxes = num(line.boxes);
  if (pack > 0 && boxes > 0) return pack * boxes;
  return pack || boxes;
}

function piecesOf(line: Line) {
  const pack = line.pairs > 0 ? line.pairs : 0;
  const colors = (line.colors ?? []).filter(color => color.name && color.quantity > 0);
  if (pack > 0 && colors.length) return colors.reduce((sum, color) => sum + color.quantity * pack, 0);
  if (pack > 0 && line.boxes > 0) return pack * line.boxes;
  if (line.quantity > 0) return line.quantity;
  return pack;
}

export function FactoryPortal() {
  const { t, lang, setLang, fmt, money, date } = useI18n();
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [account, setAccount] = useState<Account | null>(null);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (next = token) => {
    if (!next) return;
    const response = await fetch('/api/factory/me', { headers: { Authorization: `Bearer ${next}` } });
    if (!response.ok) {
      sessionStorage.removeItem(TOKEN_KEY);
      setToken('');
      setAccount(null);
      return;
    }
    const body = await response.json();
    setAccount(body.account);
    setShipments(body.shipments ?? []);
  };

  useEffect(() => { if (token) void load(token); }, [token]);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/factory/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password }) });
      const body = await response.json();
      if (!response.ok) { setError(t('zavod.invalid')); return; }
      sessionStorage.setItem(TOKEN_KEY, body.token);
      setToken(body.token);
      setAccount(body.account);
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken('');
    setAccount(null);
    setShipments([]);
  };

  if (!account) {
    return <main className="gate" data-testid="page-factory-login">
      <section className="gate-brand">
        <div className="gate-logo-navy"><div className="brand"><img className="brand-lockup" src={`${import.meta.env.BASE_URL}logo-dark.png`} alt={t('brand.name')} width={922} height={250}/></div></div>
        <div className="gate-logo-plain"><div className="brand"><img className="brand-lockup" src={`${import.meta.env.BASE_URL}logo.png`} alt={t('brand.name')} width={922} height={250}/></div></div>
      </section>
      <section className="gate-main">
        <div className="gate-lang"><LangMini lang={lang} setLang={setLang}/></div>
        <form className="gate-form" onSubmit={signIn}>
          <p className="eyebrow">{t('zavod.kicker')}</p>
          <label className="field"><span>{t('zavod.login')}</span><input className="input" value={login} onChange={e => setLogin(e.target.value)} autoComplete="username" autoFocus data-testid="input-factory-login"/></label>
          <label className="field"><span>{t('zavod.password')}</span><span className="secret"><input className="input" type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" data-testid="input-factory-password"/><button type="button" className="secret-eye" aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')} onClick={() => setShowPassword(open => !open)}>{showPassword ? <EyeOff size={18}/> : <Eye size={18}/>}</button></span></label>
          {error && <p className="gate-error">{error}</p>}
          <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !login.trim() || !password} data-testid="button-factory-login">{t('zavod.enter')}</button>
        </form>
      </section>
    </main>;
  }

  return <Workspace account={account} shipments={shipments} token={token} onSent={() => load(token)} dateLabel={date} money={money} fmt={fmt} lang={lang} setLang={setLang} onSignOut={signOut} />;
}

function LangMini({ lang, setLang }: { lang: Lang; setLang: (lang: Lang) => void }) {
  const { t } = useI18n();
  return <div className="lang-dd" data-testid="factory-lang"><button type="button" className="lang-dd-btn" onClick={() => setLang(lang === 'uz' ? 'ru' : 'uz')} aria-label={t('common.language')}>{lang.toUpperCase()}</button></div>;
}

function Workspace({ account, shipments, token, onSent, dateLabel, money, fmt, lang, setLang, onSignOut }: { account: Account; shipments: Shipment[]; token: string; onSent: () => void; dateLabel: (value: string) => string; money: (value: number) => string; fmt: (value: number) => string; lang: Lang; setLang: (lang: Lang) => void; onSignOut: () => void }) {
  const { t } = useI18n();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Draft[]>(() => [blank(account.code)]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<'waybill' | 'history' | 'profile'>('waybill');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingStatus, setEditingStatus] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [rail, setRail] = useState(() => localStorage.getItem('smart-ombor-factory-nav') === 'icons');
  useEffect(() => { localStorage.setItem('smart-ombor-factory-nav', rail ? 'icons' : 'full'); }, [rail]);
  const [historyStatus, setHistoryStatus] = useState<'all' | 'sent' | 'accepted' | 'declined'>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const totals = useMemo(() => lines.reduce((sum, line) => {
    sum.pairs += unitsOf(line);
    sum.boxes += num(line.boxes);
    sum.amount += unitsOf(line) * num(line.price);
    return sum;
  }, { pairs: 0, boxes: 0, amount: 0 }), [lines]);

  const patch = (key: string, next: Partial<Draft>) => setLines(rows => withBlank(rows.map(row => row.key === key ? { ...row, ...next } : row)));

  const resetForm = () => {
    setEditingId(null);
    setEditingStatus(null);
    setDate(new Date().toISOString().slice(0, 10));
    setNote('');
    setLines([blank(account.code)]);
  };

  const beginRevise = (item: Shipment) => {
    setEditingId(item.id);
    setEditingStatus(item.status);
    setDate(item.date.slice(0, 10));
    setNote(item.note || '');
    setLines(withBlank(item.lines.map(line => ({
      key: line.id,
      factoryCode: line.factoryCode || account.code,
      groupCode: line.sectionCode || '',
      productCode: line.productCode,
      model: line.model || '',
      size: line.size,
      priceType: line.priceType || '',
      colors: line.colors ?? [],
      pairs: line.pairs ? String(line.pairs) : '',
      boxes: line.boxes ? String(line.boxes) : '',
      price: line.price ? String(line.price) : '',
    }))));
    setError('');
    setSection('waybill');
    setNavOpen(false);
  };

  const submit = async () => {
    const filled = lines.filter(started);
    if (!filled.length) { setError(t('zavod.emptyLine')); return; }
    if (filled.some(line => !line.productCode.trim())) { setError(t('zavod.needCode')); return; }
    if (filled.some(line => !line.size.trim())) { setError(t('zavod.needSize')); return; }
    if (filled.some(line => num(line.pairs) <= 0 || num(line.boxes) <= 0 || num(line.price) <= 0)) { setError(t('zavod.needQty')); return; }
    if (filled.some(line => unitsOf(line) <= 0)) { setError(t('zavod.needQty')); return; }
    const payload = filled.map(line => ({
      id: editingId ? line.key : undefined,
      factoryCode: account.code,
      sectionCode: line.groupCode.trim(),
      productId: null,
      productName: null,
      productCode: line.productCode.trim(),
      model: line.model,
      size: line.size.trim(),
      pairs: num(line.pairs),
      boxes: num(line.boxes),
      quantity: 0,
      price: num(line.price),
      priceType: line.priceType,
      colors: line.colors,
    }));
    setBusy(true); setError(''); setFlash('');
    try {
      const response = await fetch(editingId ? `/api/factory/shipments/${editingId}` : '/api/factory/shipments', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ date, note, lines: payload }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: '' })) as { error?: string };
        setError(body.error === 'need_size' ? t('zavod.needSize') : t('zavod.needQty'));
        return;
      }
      const body = await response.json();
      setFlash(`${editingStatus === 'declined' ? t('zavod.resend') : t('zavod.sent')} · ${body.number}`);
      resetForm();
      setHistoryStatus('all');
      setQuery('');
      setOpenId(null);
      setSection('history');
      onSent();
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = (status: string) => status === 'accepted' ? t('zavod.accepted') : status === 'declined' ? t('zavod.declined') : t('zavod.waiting');
  const statusClass = (status: string) => status === 'accepted' ? 'badge-healthy' : status === 'declined' ? 'badge-rejected' : 'badge-in-transit';
  const waiting = shipments.filter(item => item.status === 'sent').length;
  const needle = query.trim().toLowerCase();
  const shown = shipments.filter(item => {
    if (historyStatus !== 'all' && item.status !== historyStatus) return false;
    if (!needle) return true;
    return item.number.toLowerCase().includes(needle) || item.lines.some(line => `${line.productCode} ${line.model} ${line.size}`.toLowerCase().includes(needle));
  });

  const choose = (next: 'waybill' | 'history' | 'profile') => { setSection(next); setNavOpen(false); };
  const sectionTitle = section === 'history' ? t('zavod.nav.history') : section === 'profile' ? t('zavod.nav.profile') : t('zavod.nav.waybill');
  return <div className={`app factory-shell ${navOpen ? 'nav-open' : ''} ${rail ? 'is-rail' : ''}`}>
    {navOpen && <button type="button" className="factory-scrim" aria-label={t('common.close')} onClick={() => setNavOpen(false)}/>}
    <aside className={`sidebar ${navOpen ? 'is-open' : ''}`}>
      <div className="sidebar-top">
        <div className="brand">
          <img className="brand-lockup" src={`${import.meta.env.BASE_URL}logo-dark.png`} alt={t('brand.name')} width={922} height={250}/>
          <img className="brand-mark" src={`${import.meta.env.BASE_URL}logo-mark.png`} alt="" width={243} height={250}/>
        </div>
        <button type="button" className="icon-btn sidebar-collapse" onClick={() => setRail(value => !value)} aria-label={rail ? t('nav.expand') : t('nav.collapse')} title={rail ? t('nav.expand') : t('nav.collapse')}>{rail ? <ChevronRight size={18}/> : <ChevronLeft size={18}/>}</button>
        <button type="button" className="icon-btn sidebar-close" onClick={() => setNavOpen(false)} aria-label={t('common.close')}><X size={18}/></button>
      </div>
      <nav className="nav" aria-label={t('zavod.kicker')}>
        <div className="nav-group"><p>{t('zavod.kicker')}</p></div>
        <button type="button" className={`nav-item ${section === 'waybill' ? 'is-active' : ''}`} title={t('zavod.nav.waybill')} onClick={() => choose('waybill')}><FilePlus2 size={17}/><span>{t('zavod.nav.waybill')}</span></button>
        <button type="button" className={`nav-item ${section === 'history' ? 'is-active' : ''}`} title={t('zavod.nav.history')} onClick={() => choose('history')}><History size={17}/><span>{t('zavod.nav.history')}</span>{waiting > 0 && <i className="nav-badge">{fmt(waiting)}</i>}</button>
        <button type="button" className={`nav-item ${section === 'profile' ? 'is-active' : ''}`} title={t('zavod.nav.profile')} onClick={() => choose('profile')}><UserRound size={17}/><span>{t('zavod.nav.profile')}</span></button>
      </nav>
      <div className="sidebar-bottom">
        <div className="user">
          <span className="avatar">{account.name.trim().slice(0, 1).toUpperCase() || account.code.slice(0, 1)}</span>
          <span className="user-copy"><b>{account.name}</b><small>{account.code}</small></span>
          <button type="button" className="icon-btn user-out" onClick={onSignOut} aria-label={t('zavod.signOut')}><LogOut size={16}/></button>
        </div>
      </div>
    </aside>
    <div className="main">
    <header className="topbar">
      <button type="button" className="icon-btn menu-btn" onClick={() => setNavOpen(true)} aria-label={t('zavod.kicker')}><Menu size={18}/></button>
      <div className="crumbs"><b>{sectionTitle}</b></div>
      <div className="topbar-right"><LangMini lang={lang} setLang={setLang}/></div>
    </header>
    <div className="content cabinet">
    <section className="yx" hidden={section !== 'waybill'}>
    <div className="yx-head">
      <div><p className="eyebrow">{t('zavod.newDoc')}</p><h2>{t('zavod.title')}</h2></div>
      <label className="field yx-date"><span>{t('zavod.date')}</span><input className="input" type="date" value={date} onChange={e => setDate(e.target.value)}/></label>
    </div>
    <div className="yx-sheet factory-sheet">
      <div className="yx-sheet-head"><span/><span>{t('zavod.brand')}</span><span>{t('zavod.factoryCode')}</span><span>{t('zavod.product')}</span><span>{t('zavod.size')}</span><span>{t('zavod.pairs')}</span><span>{t('zavod.boxes')}</span><span>{t('zavod.price')}</span><span>{t('zavod.sum')}</span><span/></div>
      {lines.map((line, index) => {
        const sum = unitsOf(line) * num(line.price);
        return <div className="yx-sheet-row factory-row" key={line.key}>
          <b>{String(index + 1).padStart(2, '0')}</b>
          <strong className="yx-brand">{t('zavod.brand')}</strong>
          <strong className="yx-brand">{account.code}</strong>
          <label className="yx-cell"><span>{t('zavod.product')}</span><input className="input" aria-label={t('zavod.product')} inputMode="numeric" value={line.productCode} onChange={e => patch(line.key, { productCode: digits(e.target.value) })} data-testid={`input-factory-product-${index}`}/></label>
          <label className="yx-cell"><span>{t('zavod.size')}</span><select className="input" aria-label={t('zavod.size')} value={line.size} onChange={e => patch(line.key, { size: e.target.value })} data-testid={`select-factory-size-${index}`}><option value="">{t('products.sizeEmpty')}</option>{!LINE_SIZES.includes(line.size as typeof LINE_SIZES[number]) && line.size ? <option value={line.size}>{line.size}</option> : null}{LINE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}</select></label>
          <label className="yx-cell"><span>{t('zavod.pairs')}</span><input className="input" aria-label={t('zavod.pairs')} inputMode="numeric" value={line.pairs} onChange={e => patch(line.key, { pairs: digits(e.target.value) })}/></label>
          <label className="yx-cell"><span>{t('zavod.boxes')}</span><input className="input" aria-label={t('zavod.boxes')} inputMode="numeric" value={line.boxes} onChange={e => patch(line.key, { boxes: digits(e.target.value) })}/></label>
          <label className="yx-cell"><span>{t('zavod.price')}</span><input className="input" aria-label={t('zavod.price')} inputMode="numeric" value={line.price} onChange={e => patch(line.key, { price: digits(e.target.value) })}/></label>
          <label className="yx-cell yx-sum-cell"><span>{t('zavod.sum')}</span><input className="input yx-sum" aria-label={t('zavod.sum')} value={sum ? money(sum) : ''} readOnly/></label>
          <button type="button" className="icon-btn" disabled={lines.length < 2} onClick={() => setLines(rows => { const next = rows.filter(row => row.key !== line.key); return next.length ? next : [blank(account.code)]; })} aria-label={t('zavod.remove')}><Trash2 size={15}/></button>
        </div>;
      })}
    </div>
    <label className="field"><span>{t('zavod.note')}</span><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder={t('zavod.notePlaceholder')}/></label>
    <div className="yx-foot">
      <div className="yx-totals">
        <div><span>{t('zavod.totalPairs')}</span><b>{fmt(totals.pairs)}</b></div>
        <div><span>{t('zavod.totalBoxes')}</span><b>{fmt(totals.boxes)}</b></div>
        <div><span>{t('zavod.totalAmount')}</span><b>{money(totals.amount)}</b></div>
      </div>
      <div className="yx-send">
        {error && <p className="error-text">{error}</p>}
        {editingId && <button type="button" className="btn btn-ghost" onClick={resetForm}>{t('common.cancel')}</button>}
        <button type="button" className="btn btn-primary btn-lg yx-submit" disabled={busy} onClick={() => void submit()} data-testid="button-factory-submit"><Send size={16}/>{busy ? t('zavod.sending') : editingStatus === 'declined' ? t('zavod.resend') : editingId ? t('partners.edit') : t('zavod.submit')}</button>
      </div>
    </div>
    </section>
    {section === 'history' && <section className="card factory-history">
      <div className="card-head"><h2>{t('zavod.history')}</h2><span className="card-meta">{fmt(shown.length)}</span></div>
      {flash && <p className="notice notice-success">{flash}</p>}
      <div className="cabinet-tools">
        <label className="search"><input className="input" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('zavod.search')}/></label>
        <div className="cabinet-filters">
          {(['all', 'sent', 'accepted', 'declined'] as const).map(status => <button type="button" key={status} className={historyStatus === status ? 'is-active' : ''} onClick={() => setHistoryStatus(status)}>{status === 'all' ? t('zavod.filter.all') : statusLabel(status)}</button>)}
        </div>
      </div>
      {shown.length ? <div className="shipment-list">{shown.map(item => <article key={item.id} className="shipment"><header><button type="button" className="shipment-open" onClick={() => setOpenId(openId === item.id ? null : item.id)}><div><b>{item.number}</b><small>{dateLabel(item.date)} · {fmt(item.pairs)} {t('zavod.totalPairs').toLowerCase()} · {fmt(item.boxes)} {t('zavod.boxes').toLowerCase()}</small></div><span className={`badge ${statusClass(item.status)}`}>{statusLabel(item.status)}</span><strong>{money(item.amount)}</strong></button>{item.status !== 'accepted' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => beginRevise(item)}><Pencil size={14}/>{item.status === 'declined' ? t('zavod.resend') : t('partners.edit')}</button>}</header>{openId === item.id && <ul className="yx-history-lines">{item.lines.map(line => <li key={line.id}><b>{['Bordo', line.factoryCode, line.sectionCode, line.productCode, line.size].filter(Boolean).join(' ')}</b><span data-label={t('zavod.size')}>{line.size || '—'}</span><span data-label={`${t('zavod.pairs')} / ${t('zavod.boxes')}`}>{fmt(line.pairs)} / {fmt(line.boxes)}</span><span data-label={t('zavod.price')}>{line.price ? money(line.price) : '—'}</span><span data-label={t('zavod.sum')}>{money(piecesOf(line) * line.price)}</span></li>)}</ul>}{openId === item.id && item.note && <p className="muted">{item.note}</p>}</article>)}</div> : <p className="muted">{shipments.length ? t('zavod.emptyFilter') : t('zavod.emptyHistory')}</p>}
    </section>}
    {section === 'profile' && <section className="cabinet-profile">
      <article><span>{t('zavod.profile.name')}</span><b>{account.name}</b></article>
      <article><span>{t('zavod.profile.code')}</span><b>{account.code}</b></article>
      <article><span>{t('zavod.profile.login')}</span><b>{account.login}</b></article>
    </section>}
    </div>
    </div>
  </div>;
}

function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return <div className={`field ${className}`}><span>{label}</span>{children}</div>;
}

