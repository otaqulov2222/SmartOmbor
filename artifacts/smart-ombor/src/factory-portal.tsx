import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, FilePlus2, History, LayoutDashboard, LogOut, Menu, Plus, Send, Trash2, UserRound, X } from 'lucide-react';
import { useI18n, type Lang } from '@/i18n';

type Account = { id: string; name: string; code: string; login: string };
type ColorLine = { name: string; quantity: number };
type Line = { id: string; sectionCode: string; productCode: string; productName?: string | null; model: string; size: string; pairs: number; boxes: number; quantity: number; price: number; colors: ColorLine[] };
type Shipment = { id: string; number: string; date: string; status: string; note?: string; pairs: number; boxes: number; amount: number; lines: Line[] };
type DraftColor = { name: string; quantity: string };
type Draft = { key: string; productId: string; productName: string; productCode: string; barcode: string; size: string; pairs: string; boxes: string; price: string; colors: DraftColor[] };
type CatalogHit = { id: string; name: string; code: string | null; article: string | null; barcode: string | null };

const TOKEN_KEY = 'smart-ombor-factory-token';

function blank(): Draft {
  return { key: Math.random().toString(36).slice(2), productId: '', productName: '', productCode: '', barcode: '', size: '', pairs: '', boxes: '', price: '', colors: [{ name: '', quantity: '' }] };
}

function sizeOf(name: string) {
  const match = name.match(/(\d{2}\s*[-–]\s*\d{2})\s*(?:\([^)]*\))?\s*$/);
  return match ? match[1].replace(/\s/g, '') : '';
}

function num(value: string) {
  const parsed = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function unitsOf(line: Draft) {
  return num(line.pairs);
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
  const [lines, setLines] = useState<Draft[]>(() => [blank()]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<'home' | 'waybill' | 'history' | 'profile'>('home');
  const [navOpen, setNavOpen] = useState(false);
  const [rail, setRail] = useState(() => localStorage.getItem('smart-ombor-factory-nav') === 'icons');
  useEffect(() => { localStorage.setItem('smart-ombor-factory-nav', rail ? 'icons' : 'full'); }, [rail]);
  const [historyStatus, setHistoryStatus] = useState<'all' | 'sent' | 'accepted' | 'declined'>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const totals = useMemo(() => lines.reduce((sum, line) => {
    sum.pairs += num(line.pairs);
    sum.boxes += num(line.boxes);
    sum.amount += unitsOf(line) * num(line.price);
    return sum;
  }, { pairs: 0, boxes: 0, amount: 0 }), [lines]);

  const patch = (key: string, next: Partial<Draft>) => setLines(rows => rows.map(row => row.key === key ? { ...row, ...next } : row));

  const submit = async () => {
    const filled = lines.filter(line => line.productCode || line.size || line.pairs || line.boxes || line.price || line.colors.some(color => color.name || color.quantity));
    if (!filled.length) { setError(t('zavod.emptyLine')); return; }
    if (filled.some(line => !line.productCode.trim())) { setError(t('zavod.needProduct')); return; }
    if (filled.some(line => unitsOf(line) <= 0)) { setError(t('zavod.needQty')); return; }
    if (filled.some(line => { const colors = line.colors.reduce((sum, color) => sum + (color.name.trim() ? num(color.quantity) : 0), 0); return colors > 0 && num(line.boxes) > 0 && colors !== num(line.boxes); })) { setError(t('zavod.colorMismatch')); return; }
    const payload = filled.map(line => ({
      factoryCode: account.code,
      sectionCode: '',
      productId: line.productId || null,
      productName: line.productName || null,
      productCode: line.productCode.trim(),
      model: '',
      size: line.size.trim(),
      pairs: num(line.pairs),
      boxes: num(line.boxes) || line.colors.reduce((sum, color) => sum + (color.name.trim() ? num(color.quantity) : 0), 0),
      quantity: 0,
      price: num(line.price),
      colors: line.colors.filter(color => color.name.trim() && num(color.quantity) > 0).map(color => ({ name: color.name.trim(), quantity: num(color.quantity) })),
    }));
    setBusy(true); setError(''); setFlash('');
    try {
      const response = await fetch('/api/factory/shipments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ date, note, lines: payload }),
      });
      if (!response.ok) { setError(t('zavod.needQty')); return; }
      const body = await response.json();
      setFlash(`${t('zavod.sent')} · ${body.number}`);
      setLines([blank()]);
      setNote('');
      setHistoryStatus('all');
      setQuery('');
      setOpenId(body.id ?? null);
      setSection('history');
      onSent();
    } finally {
      setBusy(false);
    }
  };

  const openHistory = (status: 'all' | 'sent' | 'accepted' | 'declined') => {
    setHistoryStatus(status);
    setSection('history');
  };
  const statusLabel = (status: string) => status === 'accepted' ? t('zavod.accepted') : status === 'declined' ? t('zavod.declined') : t('zavod.waiting');
  const statusClass = (status: string) => status === 'accepted' ? 'badge-healthy' : status === 'declined' ? 'badge-rejected' : 'badge-in-transit';
  const waiting = shipments.filter(item => item.status === 'sent').length;
  const accepted = shipments.filter(item => item.status === 'accepted').length;
  const declined = shipments.filter(item => item.status === 'declined').length;
  const sentAmount = shipments.reduce((sum, item) => sum + item.amount, 0);
  const sentPairs = shipments.reduce((sum, item) => sum + item.pairs, 0);
  const needle = query.trim().toLowerCase();
  const shown = shipments.filter(item => {
    if (historyStatus !== 'all' && item.status !== historyStatus) return false;
    if (!needle) return true;
    return item.number.toLowerCase().includes(needle) || item.lines.some(line => `${line.productCode} ${line.model} ${line.size}`.toLowerCase().includes(needle));
  });

  const choose = (next: 'home' | 'waybill' | 'history' | 'profile') => { setSection(next); setNavOpen(false); };
  const sectionTitle = section === 'waybill' ? t('zavod.nav.waybill') : section === 'history' ? t('zavod.nav.history') : section === 'profile' ? t('zavod.nav.profile') : t('zavod.nav.home');
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
        <button type="button" className={`nav-item ${section === 'home' ? 'is-active' : ''}`} title={t('zavod.nav.home')} onClick={() => choose('home')}><LayoutDashboard size={17}/><span>{t('zavod.nav.home')}</span></button>
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
    {section === 'home' && <section className="cabinet-hero">
      <div className="cabinet-identity">
        <span className="cabinet-mark" aria-hidden="true">{account.name.trim().slice(0, 1).toUpperCase() || account.code.slice(0, 1)}</span>
        <div>
          <p className="eyebrow">{t('zavod.kicker')}</p>
          <h1>{account.name}</h1>
          <p className="cabinet-id"><span className="yx-code">{account.code}</span><span>{account.login}</span></p>
        </div>
      </div>
      <div className="cabinet-kpis">
        <button type="button" onClick={() => openHistory('all')}><span>{t('zavod.docs')}</span><b>{fmt(shipments.length)}</b></button>
        <button type="button" onClick={() => openHistory('sent')}><span>{t('zavod.waiting')}</span><b>{fmt(waiting)}</b></button>
        <button type="button" onClick={() => openHistory('accepted')}><span>{t('zavod.accepted')}</span><b>{fmt(accepted)}</b></button>
        <button type="button" onClick={() => openHistory('declined')}><span>{t('zavod.declined')}</span><b>{fmt(declined)}</b></button>
      </div>
    </section>}
    {section === 'home' && <section className="card factory-history">
      <div className="card-head"><h2>{t('zavod.recent')}</h2><button type="button" className="btn btn-secondary btn-sm" onClick={() => openHistory('all')}>{t('zavod.nav.history')}</button></div>
      {shipments.length ? <div className="shipment-list">{shipments.slice(0, 5).map(item => <article key={item.id} className="shipment"><header><div><b>{item.number}</b><small>{dateLabel(item.date)} · {fmt(item.lines.length)} {t('zavod.lines').toLowerCase()}</small></div><span className={`badge ${statusClass(item.status)}`}>{statusLabel(item.status)}</span><strong>{money(item.amount)}</strong></header></article>)}</div> : <p className="muted">{t('zavod.emptyHistory')}</p>}
      <p className="muted">{money(sentAmount)} · {fmt(sentPairs)} {t('zavod.pairs').toLowerCase()}</p>
    </section>}
    <section className="yx" hidden={section !== 'waybill'}>
    <div className="yx-head">
      <div><p className="eyebrow">{t('zavod.newDoc')}</p><h2>{t('zavod.title')}</h2></div>
      <label className="field yx-date"><span>{t('zavod.date')}</span><input className="input" type="date" value={date} onChange={e => setDate(e.target.value)}/></label>
    </div>
    <div className="yx-lines">
      {lines.map((line, index) => {
        const sum = unitsOf(line) * num(line.price);
        return <article className="yx-line" key={line.key}>
          <header><b>{String(index + 1).padStart(2, '0')}</b><span className="yx-code">{account.code}</span>{lines.length > 1 && <button type="button" className="icon-btn" onClick={() => setLines(rows => rows.filter(row => row.key !== line.key))} aria-label={t('zavod.remove')}><Trash2 size={15}/></button>}</header>
          <div className="yx-grid">
            <Field label={t('zavod.product')} className="span-12"><ProductPick token={token} line={line} onChange={next => patch(line.key, next)}/></Field>
            <Field label={t('zavod.size')} className="span-3"><input className="input" value={line.size} onChange={e => patch(line.key, { size: e.target.value })}/></Field>
            <Field label={t('zavod.pairs')} className="span-2"><input className="input" inputMode="decimal" value={line.pairs} onChange={e => patch(line.key, { pairs: e.target.value })}/></Field>
            <Field label={t('zavod.boxes')} className="span-2"><input className="input" inputMode="decimal" value={line.boxes} onChange={e => patch(line.key, { boxes: e.target.value })}/></Field>
            <Field label={t('zavod.price')} className="span-2"><input className="input" inputMode="decimal" value={line.price} onChange={e => patch(line.key, { price: e.target.value })}/></Field>
            <Field label={t('zavod.sum')} className="span-3"><input className="input yx-sum" value={sum ? money(sum) : '—'} readOnly/></Field>
          </div>
          <div className="yx-colors">
            <span>{t('zavod.colors')}</span>
            {line.colors.map((color, colorIndex) => <div className="yx-color" key={colorIndex}>
              <input className="input" value={color.name} placeholder={`${t('zavod.colorName')} ${colorIndex + 1}`} onChange={e => patch(line.key, { colors: line.colors.map((item, i) => i === colorIndex ? { ...item, name: e.target.value } : item) })}/>
              <input className="input" inputMode="decimal" value={color.quantity} placeholder={t('zavod.colorQty')} onChange={e => patch(line.key, { colors: line.colors.map((item, i) => i === colorIndex ? { ...item, quantity: e.target.value } : item) })}/>
              {line.colors.length > 1 && <button type="button" className="icon-btn" aria-label={t('zavod.remove')} onClick={() => patch(line.key, { colors: line.colors.filter((_, i) => i !== colorIndex) })}><X size={14}/></button>}
            </div>)}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => patch(line.key, { colors: [...line.colors, { name: '', quantity: '' }] })}><Plus size={14}/>{t('zavod.addColor')}</button>
          </div>
        </article>;
      })}
    </div>
    <div className="yx-actions"><button type="button" className="btn btn-secondary" onClick={() => setLines(rows => [...rows, blank()])}><Plus size={15}/>{t('zavod.addRow')}</button></div>
    <label className="field"><span>{t('zavod.note')}</span><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder={t('zavod.notePlaceholder')}/></label>
    <div className="yx-foot">
      <div className="yx-totals">
        <div><span>{t('zavod.totalPairs')}</span><b>{fmt(totals.pairs)}</b></div>
        <div><span>{t('zavod.totalBoxes')}</span><b>{fmt(totals.boxes)}</b></div>
        <div><span>{t('zavod.totalAmount')}</span><b>{money(totals.amount)}</b></div>
      </div>
      <div className="yx-send">
        {error && <p className="error-text">{error}</p>}
        <button type="button" className="btn btn-primary btn-lg yx-submit" disabled={busy} onClick={() => void submit()} data-testid="button-factory-submit"><Send size={16}/>{busy ? t('zavod.sending') : t('zavod.submit')}</button>
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
      {shown.length ? <div className="shipment-list">{shown.map(item => <article key={item.id} className="shipment"><header><div><b>{item.number}</b><small>{dateLabel(item.date)} · {fmt(item.pairs)} {t('zavod.pairs').toLowerCase()} · {fmt(item.boxes)} {t('zavod.boxes').toLowerCase()}</small></div><span className={`badge ${statusClass(item.status)}`}>{statusLabel(item.status)}</span><strong>{money(item.amount)}</strong><button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpenId(openId === item.id ? null : item.id)}>{t('zavod.lines')}</button></header>{openId === item.id && <ul className="yx-history-lines">{item.lines.map(line => <li key={line.id}><b>{line.productCode || '—'}</b><span>{line.productName || line.model || '—'}</span><span>{line.size || '—'}</span><span>{fmt(line.pairs)} / {fmt(line.boxes)}</span><span>{line.colors.filter(color => color.quantity > 0).map(color => `${color.name} ${fmt(color.quantity)}`).join(', ') || '—'}</span></li>)}</ul>}{openId === item.id && item.note && <p className="muted">{item.note}</p>}</article>)}</div> : <p className="muted">{shipments.length ? t('zavod.emptyFilter') : t('zavod.emptyHistory')}</p>}
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

function ProductPick({ token, line, onChange }: { token: string; line: Draft; onChange: (next: Partial<Draft>) => void }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pickQuery, setPickQuery] = useState('');
  const [hits, setHits] = useState<CatalogHit[]>([]);
  const [looking, setLooking] = useState(false);
  const query = pickQuery.trim();

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (!open || query.length < 2) { setHits([]); setLooking(false); return; }
    const control = new AbortController();
    const timer = window.setTimeout(() => {
      setLooking(true);
      fetch(`/api/factory/products?q=${encodeURIComponent(query)}`, { headers: { Authorization: `Bearer ${token}` }, signal: control.signal })
        .then(response => response.ok ? response.json() : { items: [] })
        .then(body => setHits(Array.isArray(body.items) ? body.items : []))
        .catch(error => { if (error?.name !== 'AbortError') setHits([]); })
        .finally(() => { if (!control.signal.aborted) setLooking(false); });
    }, 180);
    return () => { window.clearTimeout(timer); control.abort(); };
  }, [open, query, token]);

  const choose = (item: CatalogHit) => {
    onChange({ productId: item.id, productName: item.name, productCode: item.code || item.article || item.name, barcode: item.barcode || '', size: sizeOf(item.name) });
    setOpen(false);
  };

  return <div className="yx-pick" ref={box}>
    <div className="yx-pick-row">
      <input className="input" value={line.productCode} onChange={event => onChange({ productCode: event.target.value, productId: '', productName: '', barcode: '' })}/>
      <button type="button" className="icon-btn yx-pick-btn" aria-label={t('zavod.pick')} aria-expanded={open} onClick={() => setOpen(value => !value)}><ChevronDown size={16}/></button>
    </div>
    {line.productName && <p className="yx-picked">{line.productName}{line.barcode ? ` · ${line.barcode}` : ''}</p>}
    {open && <div className="yx-pick-list" role="listbox">
      <input className="input" value={pickQuery} onChange={event => setPickQuery(event.target.value)} placeholder={t('zavod.search')} autoFocus/>
      {query.length < 2 ? <p>{t('zavod.pickHint')}</p> : looking ? <p>{t('common.loading')}</p> : hits.length ? hits.map(item => <button type="button" key={item.id} onClick={() => choose(item)}><b>{item.code || item.article || '—'}</b><span>{item.name}{item.barcode ? ` · ${item.barcode}` : ''}</span></button>) : <p>{t('zavod.noMatch')}</p>}
    </div>}
  </div>;
}
