import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Boxes, LogOut, Plus, Send, Trash2, X } from 'lucide-react';
import { useI18n, type Lang } from '@/i18n';

type Account = { id: string; name: string; code: string; login: string };
type ColorLine = { name: string; quantity: number };
type Line = { id: string; sectionCode: string; productCode: string; model: string; size: string; pairs: number; boxes: number; quantity: number; price: number; colors: ColorLine[] };
type Shipment = { id: string; number: string; date: string; status: string; note?: string; pairs: number; boxes: number; amount: number; lines: Line[] };
type DraftColor = { name: string; quantity: string };
type Draft = {
  key: string; sectionCode: string; productCode: string; model: string; size: string;
  pairs: string; boxes: string; quantity: string; price: string; colors: DraftColor[];
};

const TOKEN_KEY = 'smart-ombor-factory-token';

function blank(): Draft {
  return { key: Math.random().toString(36).slice(2), sectionCode: '', productCode: '', model: '', size: '', pairs: '', boxes: '', quantity: '', price: '', colors: [{ name: '', quantity: '' }] };
}

function num(value: string) {
  const parsed = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function unitsOf(line: Draft) {
  const pairs = num(line.pairs);
  if (pairs > 0) return pairs;
  const quantity = num(line.quantity);
  if (quantity > 0) return quantity;
  return line.colors.reduce((sum, color) => sum + num(color.quantity), 0);
}

export function FactoryPortal() {
  const { t, lang, setLang, fmt, money, date } = useI18n();
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [account, setAccount] = useState<Account | null>(null);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
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

  return <main className="factory-app">
    <header className="factory-top">
      <div className="brand"><span className="brand-symbol"><Boxes size={18}/></span><span className="brand-name">{t('brand.first')} <b>{t('brand.second')}</b></span></div>
      <div className="factory-top-actions">
        <LangMini lang={lang} setLang={setLang}/>
        {account && <button type="button" className="btn btn-ghost btn-sm" onClick={signOut}><LogOut size={15}/>{t('zavod.signOut')}</button>}
      </div>
    </header>
    {account ? <Workspace account={account} shipments={shipments} token={token} onSent={() => load(token)} dateLabel={date} money={money} fmt={fmt} /> : <form className="factory-login card" onSubmit={signIn}>
      <p className="eyebrow">{t('zavod.kicker')}</p>
      <h1>{t('zavod.title')}</h1>
      <p className="muted">{t('zavod.lead')}</p>
      <label className="field"><span>{t('zavod.login')}</span><input className="input" value={login} onChange={e => setLogin(e.target.value)} autoComplete="username" data-testid="input-factory-login"/></label>
      <label className="field"><span>{t('zavod.password')}</span><input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" data-testid="input-factory-password"/></label>
      {error && <p className="error-text">{error}</p>}
      <button className="btn btn-primary" type="submit" disabled={busy || !login.trim() || !password} data-testid="button-factory-login">{t('zavod.enter')}</button>
    </form>}
  </main>;
}

function LangMini({ lang, setLang }: { lang: Lang; setLang: (lang: Lang) => void }) {
  const { t } = useI18n();
  return <div className="lang-dd" data-testid="factory-lang"><button type="button" className="lang-dd-btn" onClick={() => setLang(lang === 'uz' ? 'ru' : 'uz')} aria-label={t('common.language')}>{lang.toUpperCase()}</button></div>;
}

function Workspace({ account, shipments, token, onSent, dateLabel, money, fmt }: { account: Account; shipments: Shipment[]; token: string; onSent: () => void; dateLabel: (value: string) => string; money: (value: number) => string; fmt: (value: number) => string }) {
  const { t } = useI18n();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Draft[]>(() => [blank()]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  const totals = useMemo(() => lines.reduce((sum, line) => {
    sum.pairs += num(line.pairs);
    sum.boxes += num(line.boxes);
    sum.amount += unitsOf(line) * num(line.price);
    return sum;
  }, { pairs: 0, boxes: 0, amount: 0 }), [lines]);

  const patch = (key: string, next: Partial<Draft>) => setLines(rows => rows.map(row => row.key === key ? { ...row, ...next } : row));

  const submit = async () => {
    const filled = lines.filter(line => line.sectionCode || line.productCode || line.model || line.size || line.pairs || line.boxes || line.quantity || line.price || line.colors.some(color => color.name || color.quantity));
    if (!filled.length) { setError(t('zavod.emptyLine')); return; }
    if (filled.some(line => !line.productCode.trim())) { setError(t('zavod.needProduct')); return; }
    if (filled.some(line => unitsOf(line) <= 0 && num(line.boxes) <= 0)) { setError(t('zavod.needQty')); return; }
    const payload = filled.map(line => ({
      factoryCode: account.code,
      sectionCode: line.sectionCode,
      productCode: line.productCode.trim(),
      model: line.model,
      size: line.size,
      pairs: num(line.pairs),
      boxes: num(line.boxes),
      quantity: num(line.quantity),
      price: num(line.price),
      colors: line.colors.filter(color => color.name.trim() && num(color.quantity) > 0).map(color => ({ name: color.name.trim(), quantity: num(color.quantity) })),
    }));
    setBusy(true); setError(''); setOk('');
    try {
      const response = await fetch('/api/factory/shipments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ date, note, lines: payload }),
      });
      if (!response.ok) { setError(t('zavod.needQty')); return; }
      const body = await response.json();
      setOk(`${t('zavod.sent')} · ${body.number}`);
      setLines([blank()]);
      setNote('');
      onSent();
    } finally {
      setBusy(false);
    }
  };

  const sentPairs = shipments.reduce((sum, item) => sum + item.pairs, 0);
  const sentAmount = shipments.reduce((sum, item) => sum + item.amount, 0);
  const waiting = shipments.filter(item => item.status !== 'accepted').length;
  const accepted = shipments.length - waiting;

  return <div className="cabinet">
    <section className="cabinet-hero">
      <div>
        <p className="eyebrow">{t('zavod.kicker')}</p>
        <h1>{account.name}</h1>
        <p className="cabinet-id"><span className="yx-code">{account.code}</span><span>{account.login}</span></p>
      </div>
      <div className="cabinet-kpis">
        <div><span>{t('zavod.docs')}</span><b>{fmt(shipments.length)}</b></div>
        <div><span>{t('zavod.waiting')}</span><b>{fmt(waiting)}</b></div>
        <div><span>{t('zavod.accepted')}</span><b>{fmt(accepted)}</b></div>
        <div><span>{t('zavod.totalAmount')}</span><b>{money(sentAmount)}</b></div>
      </div>
    </section>
    <section className="yx">
    <div className="yx-head">
      <div><p className="eyebrow">{t('zavod.newDoc')}</p><h1>{t('zavod.title')}</h1><p className="muted">{t('zavod.guide')}</p></div>
      <label className="field yx-date"><span>{t('zavod.date')}</span><input className="input" type="date" value={date} onChange={e => setDate(e.target.value)}/></label>
    </div>
    <div className="yx-lines">
      {lines.map((line, index) => {
        const sum = unitsOf(line) * num(line.price);
        return <article className="yx-line" key={line.key}>
          <header><b>{String(index + 1).padStart(2, '0')}</b><span className="yx-code">{account.code}</span>{line.productCode && <small>{line.productCode}</small>}{lines.length > 1 && <button type="button" className="icon-btn" onClick={() => setLines(rows => rows.filter(row => row.key !== line.key))} aria-label={t('zavod.remove')}><Trash2 size={15}/></button>}</header>
          <div className="yx-grid">
            <Field label={t('zavod.section')} className="span-3"><input className="input" value={line.sectionCode} onChange={e => patch(line.key, { sectionCode: e.target.value })}/></Field>
            <Field label={t('zavod.product')} className="span-3"><input className="input" value={line.productCode} onChange={e => patch(line.key, { productCode: e.target.value })}/></Field>
            <Field label={t('zavod.model')} className="span-3"><input className="input" value={line.model} onChange={e => patch(line.key, { model: e.target.value })}/></Field>
            <Field label={t('zavod.size')} className="span-3"><input className="input" value={line.size} onChange={e => patch(line.key, { size: e.target.value })}/></Field>
            <Field label={t('zavod.pairs')} className="span-2"><input className="input" inputMode="decimal" value={line.pairs} onChange={e => patch(line.key, { pairs: e.target.value })}/></Field>
            <Field label={t('zavod.boxes')} className="span-2"><input className="input" inputMode="decimal" value={line.boxes} onChange={e => patch(line.key, { boxes: e.target.value })}/></Field>
            <Field label={t('zavod.quantity')} className="span-2"><input className="input" inputMode="decimal" value={line.quantity} onChange={e => patch(line.key, { quantity: e.target.value })}/></Field>
            <Field label={t('zavod.price')} className="span-3"><input className="input" inputMode="decimal" value={line.price} onChange={e => patch(line.key, { price: e.target.value })}/></Field>
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
    <div className="yx-actions"><button type="button" className="btn btn-secondary" onClick={() => setLines(rows => [...rows, blank()])}><Plus size={15}/>{t('zavod.addRow')}</button><span className="muted">{t('zavod.sumHint')}</span></div>
    <label className="field"><span>{t('zavod.note')}</span><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder={t('zavod.notePlaceholder')}/></label>
    <div className="yx-foot">
      <div className="yx-totals">
        <div><span>{t('zavod.totalPairs')}</span><b>{fmt(totals.pairs)}</b></div>
        <div><span>{t('zavod.totalBoxes')}</span><b>{fmt(totals.boxes)}</b></div>
        <div><span>{t('zavod.totalAmount')}</span><b>{money(totals.amount)}</b></div>
      </div>
      <div className="yx-send">
        {error && <p className="error-text">{error}</p>}
        {ok && <p className="notice notice-success">{ok}</p>}
        <button type="button" className="btn btn-primary btn-lg yx-submit" disabled={busy} onClick={() => void submit()} data-testid="button-factory-submit"><Send size={16}/>{busy ? t('zavod.sending') : t('zavod.submit')}</button>
      </div>
    </div>
    </section>
    <section className="card factory-history">
      <div className="card-head"><h2>{t('zavod.history')}</h2><span className="card-meta">{fmt(shipments.length)} · {fmt(sentPairs)} {t('zavod.pairs').toLowerCase()}</span></div>
      {shipments.length ? <div className="shipment-list">{shipments.map(item => <article key={item.id} className="shipment"><header><div><b>{item.number}</b><small>{dateLabel(item.date)} · {fmt(item.lines.length)}</small></div><span className={`badge ${item.status === 'accepted' ? 'badge-healthy' : 'badge-in-transit'}`}>{item.status === 'accepted' ? t('zavod.accepted') : t('zavod.waiting')}</span><strong>{money(item.amount)}</strong></header><ul className="yx-history-lines">{item.lines.map(line => <li key={line.id}><b>{line.productCode || '—'}</b><span>{line.model || '—'}</span><span>{line.size || '—'}</span><span>{fmt(line.pairs)} / {fmt(line.boxes)}</span><span>{line.colors.filter(color => color.quantity > 0).map(color => `${color.name} ${fmt(color.quantity)}`).join(', ') || '—'}</span></li>)}</ul>{item.note && <p className="muted">{item.note}</p>}</article>)}</div> : <p className="muted">{t('zavod.emptyHistory')}</p>}
    </section>
  </div>;
}

function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return <label className={`field ${className}`}><span>{label}</span>{children}</label>;
}
