import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, Copy, Factory, KeyRound, Pencil, Plus, Search, Trash2, Truck, X } from 'lucide-react';
import { Link, useLocation, useSearch } from 'wouter';
import { useListProducts } from '@workspace/api-client-react';
import { useI18n } from '@/i18n';

type Account = { id: string; name: string; code: string; catalogName: string; login: string; password?: string | null; active: boolean; createdAt: string };
type ColorLine = { name: string; quantity: number };
type Line = {
  id: string; factoryCode: string; sectionCode: string; productCode: string; model: string; size: string;
  pairs: number; boxes: number; quantity: number; price: number; colors: ColorLine[]; note: string;
};
type Shipment = {
  id: string; number: string; date: string; status: 'sent' | 'accepted'; note: string; createdAt: string;
  lines: Line[]; pairs: number; boxes: number; amount: number;
};
type Row = { name: string; productCount: number; stock: number; account: Account | null; shipmentCount: number; pendingCount?: number; lastShipment: string | null };

function portalUrl() {
  return `${window.location.origin}/zavod`;
}

export function PartnersPage() {
  const { t, fmt, date } = useI18n();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const selected = new URLSearchParams(search).get('factory') || '';
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const cache = useQueryClient();
  const list = useQuery<{ items: Row[] }>({
    queryKey: ['partner-factories'],
    queryFn: async () => {
      const response = await fetch('/api/partner-factories');
      if (!response.ok) throw new Error('load');
      return response.json();
    },
  });
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data?.items ?? []).filter(row => !needle || row.name.toLowerCase().includes(needle) || (row.account?.code || '').toLowerCase().includes(needle) || (row.account?.login || '').includes(needle));
  }, [list.data, q]);
  const current = list.data?.items.find(row => row.name === selected) ?? null;

  if (selected && current) {
    return <PartnerDetail row={current} onBack={() => setLocation('/partners')} />;
  }

  return <>
    <div className="page-head"><div><h1>{t('partners.title')}</h1><p>{t('partners.sub')}</p></div><div className="page-actions"><button type="button" className="btn btn-primary" onClick={() => setCreating(true)} data-testid="button-add-partner"><Plus size={16}/>{t('partners.add')}</button></div></div>
    <div className="toolbar"><label className="search"><Search size={17}/><input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder={t('partners.search')} data-testid="input-partners-search"/></label><span className="muted">{t('partners.localOnly')}</span></div>
    {list.isLoading ? <div className="loading-rows"><i className="skeleton-line"/><i className="skeleton-line"/></div> : items.length ? <div className="partner-grid">{items.map(row => <button key={row.name} type="button" className="partner-card" onClick={() => setLocation(`/partners?factory=${encodeURIComponent(row.name)}`)} data-testid={`partner-${row.name}`}>
      <span className="partner-mark"><Factory size={18}/></span>
      <span className="partner-copy"><b>{row.name}</b><small>{row.account?.code || t('partners.noAccount')}</small></span>
      <ChevronRight size={18} className="partner-go"/>
      {(row.pendingCount ?? 0) > 0 && <span className="partner-alert" title={t('partners.pending', { count: row.pendingCount ?? 0 })}>{fmt(row.pendingCount ?? 0)}</span>}
      <span className="partner-meta">{t('partners.shipments', { count: fmt(row.shipmentCount) })}{row.lastShipment ? ` · ${date(row.lastShipment)}` : ''}</span>
    </button>)}</div> : <div className="state state-empty"><b>{t('partners.empty')}</b></div>}
    {creating && <CreatePartner onClose={() => setCreating(false)} onCreated={async () => { setCreating(false); await cache.invalidateQueries({ queryKey: ['partner-factories'] }); }}/>}
  </>;
}

function CreatePartner({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/partner-factories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, code, login, password: password || undefined, catalogName: name }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error === 'login_taken' ? t('partners.loginTaken') : body.error === 'code_taken' ? t('partners.codeTaken') : t('partners.required'));
        return;
      }
      await onCreated();
    } finally {
      setBusy(false);
    }
  };
  return createPortal(<div className="backdrop" onClick={onClose}><div className="modal" onClick={event => event.stopPropagation()} role="dialog" aria-labelledby="partner-create-title">
    <div className="modal-top"><div><p className="eyebrow">{t('partners.title')}</p><h2 id="partner-create-title">{t('partners.add')}</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label={t('common.close')}><X size={18}/></button></div>
    <p className="muted">{t('partners.accessHint')}</p>
    <div className="form-grid">
      <label className="field"><span>{t('partners.name')}</span><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Sando" data-testid="input-new-factory-name"/></label>
      <label className="field"><span>{t('partners.code')}</span><input className="input" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="BOP80" data-testid="input-new-factory-code"/></label>
      <label className="field"><span>{t('partners.login')}</span><input className="input" value={login} onChange={e => setLogin(e.target.value.toLowerCase())} placeholder="sando" data-testid="input-new-factory-login"/></label>
      <label className="field"><span>{t('partners.password')}</span><input className="input" value={password} onChange={e => setPassword(e.target.value)} placeholder={t('partners.generate')} data-testid="input-new-factory-password"/></label>
    </div>
    {error && <p className="error-text">{error}</p>}
    <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button type="button" className="btn btn-primary" disabled={busy || !name.trim() || !code.trim() || !login.trim()} onClick={() => void save()} data-testid="button-create-factory"><KeyRound size={15}/>{busy ? t('common.saving') : t('partners.saveAccess')}</button></div>
  </div></div>, document.body);
}

function PartnerDetail({ row, onBack }: { row: Row; onBack: () => void }) {
  const { t, fmt, money, date } = useI18n();
  const cache = useQueryClient();
  const [, setLocation] = useLocation();
  const [name, setName] = useState(row.name);
  const [code, setCode] = useState(row.account?.code || '');
  const [login, setLogin] = useState(row.account?.login || row.name.toLowerCase().replace(/[^a-z0-9]+/gi, '').slice(0, 16));
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setName(row.name);
    setCode(row.account?.code || '');
    setLogin(row.account?.login || row.name.toLowerCase().replace(/[^a-z0-9]+/gi, '').slice(0, 16));
  }, [row.name, row.account?.code, row.account?.login]);
  const detail = useQuery<{ account: Account; shipments: Shipment[] }>({
    queryKey: ['partner-detail', row.account?.id],
    enabled: !!row.account,
    queryFn: async () => {
      const response = await fetch(`/api/partner-factories/${row.account!.id}`);
      if (!response.ok) throw new Error('load');
      return response.json();
    },
  });
  const products = useListProducts({ factory: row.name, page: 1, pageSize: 12 });
  const shipments = detail.data?.shipments ?? [];

  const saveAccess = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch(row.account ? `/api/partner-factories/${row.account.id}` : '/api/partner-factories', {
        method: row.account ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, catalogName: name, code, login, password: password || undefined }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error === 'login_taken' ? t('partners.loginTaken') : body.error === 'code_taken' ? t('partners.codeTaken') : body.error === 'password_short' ? t('partners.passwordShort') : t('partners.required'));
        return;
      }
      setRevealed(password ? body.password : '');
      setPassword('');
      await cache.invalidateQueries({ queryKey: ['partner-factories'] });
      if (body.account?.id) await cache.invalidateQueries({ queryKey: ['partner-detail', body.account.id] });
      if (row.account && name.trim() !== row.name) setLocation(`/partners?factory=${encodeURIComponent(name.trim())}`);
      else setSettings(false);
    } finally {
      setBusy(false);
    }
  };

  const removeFactory = async () => {
    if (!row.account) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/partner-factories/${row.account.id}`, { method: 'DELETE' });
      if (!response.ok) { setError(t('partners.required')); return; }
      await cache.invalidateQueries({ queryKey: ['partner-factories'] });
      await cache.invalidateQueries({ queryKey: ['partner-alerts'] });
      onBack();
    } finally {
      setBusy(false);
    }
  };

  const accept = async (id: string) => {
    await fetch(`/api/partner-factories/shipments/${id}/accept`, { method: 'POST' });
    await cache.invalidateQueries({ queryKey: ['partner-detail', row.account?.id] });
    await cache.invalidateQueries({ queryKey: ['partner-factories'] });
    await cache.invalidateQueries({ queryKey: ['partner-alerts'] });
  };

  const copy = async () => {
    await navigator.clipboard.writeText(portalUrl());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const pairs = shipments.reduce((sum, shipment) => sum + shipment.pairs, 0);
  const amount = shipments.reduce((sum, shipment) => sum + shipment.amount, 0);
  const passwordShown = detail.data?.account.password || row.account?.password || '';

  return <div className="partner-detail">
    <header className="page-head">
      <div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}><ArrowLeft size={15}/>{t('partners.back')}</button>
        <p className="eyebrow">{row.account?.code || t('partners.noAccount')}</p>
        <h1>{row.name}</h1>
        <p>{t('partners.products', { count: fmt(row.productCount) })} · {t('partners.stock', { count: fmt(row.stock) })}</p>
      </div>
      <div className="page-actions">{row.account && <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)} data-testid="button-delete-partner"><Trash2 size={16}/>{t('partners.delete')}</button>}<button type="button" className="btn btn-secondary" onClick={() => setSettings(true)} data-testid="button-edit-partner"><Pencil size={16}/>{t('partners.edit')}</button></div>
    </header>
    <div className="partner-kpis">
      <div><span>{t('partners.incoming')}</span><b>{fmt(shipments.length)}</b></div>
      <div><span>{t('zavod.pairs')}</span><b>{fmt(pairs)}</b></div>
      <div><span>{t('zavod.sum')}</span><b>{money(amount)}</b></div>
    </div>
    <section className="card">
      <div className="card-head"><h2>{t('partners.incoming')}</h2><span className="card-meta">{t('partners.shipments', { count: fmt(shipments.length) })}</span></div>
      {shipments.length ? <div className="shipment-list">{shipments.map(shipment => <article key={shipment.id} className="shipment" data-testid={`shipment-${shipment.id}`}>
        <header><span className="doc-icon"><Truck size={15}/></span><div><b>{shipment.number}</b><small>{date(shipment.date)} · {shipment.lines.length}</small></div><span className={`badge ${shipment.status === 'accepted' ? 'badge-healthy' : 'badge-in-transit'}`}>{shipment.status === 'accepted' ? t('partners.accepted') : t('partners.sent')}</span><strong>{money(shipment.amount)}</strong>{shipment.status === 'sent' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void accept(shipment.id)}>{t('partners.accept')}</button>}</header>
        <div className="mini-wrap"><table className="mini-table"><thead><tr><th>{t('zavod.section')}</th><th>{t('zavod.product')}</th><th>{t('zavod.model')}</th><th>{t('zavod.size')}</th><th>{t('zavod.pairs')}</th><th>{t('zavod.boxes')}</th><th>{t('zavod.quantity')}</th><th>{t('zavod.price')}</th><th>{t('zavod.colors')}</th><th>{t('zavod.sum')}</th></tr></thead><tbody>{shipment.lines.map(line => { const units = line.pairs > 0 ? line.pairs : line.quantity; const colors = line.colors.filter(color => color.name && color.quantity > 0); return <tr key={line.id}><td>{line.sectionCode || '—'}</td><td><b>{line.productCode || '—'}</b></td><td>{line.model || '—'}</td><td>{line.size || '—'}</td><td className="num">{fmt(line.pairs)}</td><td className="num">{fmt(line.boxes)}</td><td className="num">{fmt(line.quantity)}</td><td className="num">{line.price ? money(line.price) : '—'}</td><td>{colors.length ? <span className="color-pills">{colors.map(color => <i key={color.name}>{color.name} {fmt(color.quantity)}</i>)}</span> : '—'}</td><td className="num">{money(units * line.price)}</td></tr>; })}</tbody></table></div>
        {shipment.note && <p className="muted">{shipment.note}</p>}
      </article>)}</div> : <p className="muted">{t('partners.noShipments')}</p>}
    </section>
    {!!products.data?.items.length && <section className="card">
      <div className="card-head"><h2>{t('partners.catalog')}</h2><span className="card-meta">{fmt(products.data.total)}</span></div>
      <ul className="partner-products">{products.data.items.map(product => <li key={product.id}><b>{product.name}</b><small>{product.code || product.article || '—'}</small><span>{fmt(product.stock)}</span></li>)}</ul>
      <Link href="/factories" className="link">{t('nav.factories')}</Link>
    </section>}
    {settings && createPortal(<div className="backdrop" onClick={() => setSettings(false)}><div className="modal" onClick={event => event.stopPropagation()} role="dialog" aria-labelledby="partner-settings-title">
      <div className="modal-top"><div><p className="eyebrow">{row.name}</p><h2 id="partner-settings-title">{t('partners.edit')}</h2></div><button type="button" className="icon-btn" onClick={() => setSettings(false)} aria-label={t('common.close')}><X size={18}/></button></div>
      <div className="form-grid">
        <label className="field"><span>{t('partners.name')}</span><input className="input" value={name} onChange={e => setName(e.target.value)} data-testid="input-partner-name"/></label>
        <label className="field"><span>{t('partners.code')}</span><input className="input" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="BOP80" data-testid="input-partner-code"/></label>
        <label className="field"><span>{t('partners.login')}</span><input className="input" value={login} onChange={e => setLogin(e.target.value.toLowerCase())} data-testid="input-partner-login"/></label>
        <label className="field"><span>{t('partners.password')}</span><input className="input" value={password} onChange={e => setPassword(e.target.value)} placeholder={row.account ? t('partners.passwordKeep') : t('partners.generate')} data-testid="input-partner-password"/></label>
      </div>
      {row.account && <div className="facts"><div><span>{t('partners.password')}</span><b className="secret">{passwordShown || t('partners.passwordMissing')}</b></div></div>}
      {error && <p className="error-text">{error}</p>}
      {revealed && <div className="notice notice-success"><KeyRound size={18}/><div><b>{t('partners.once')}</b><p className="secret">{revealed}</p></div></div>}
      <div className="portal-link"><span>{t('partners.portal')}</span><code>{portalUrl()}</code><button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy()}><Copy size={14}/>{copied ? t('partners.copied') : t('partners.copy')}</button></div>
      <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={() => setSettings(false)}>{t('common.cancel')}</button><button type="button" className="btn btn-primary" disabled={busy || !name.trim() || !code.trim() || !login.trim()} onClick={() => void saveAccess()} data-testid="button-partner-access"><Pencil size={15}/>{busy ? t('common.saving') : t('partners.edit')}</button></div>
    </div></div>, document.body)}
    {confirmDelete && createPortal(<div className="backdrop" onClick={() => setConfirmDelete(false)}><div className="modal" onClick={event => event.stopPropagation()} role="dialog" aria-labelledby="partner-delete-title">
      <div className="modal-top"><div><p className="eyebrow">{row.name}</p><h2 id="partner-delete-title">{t('partners.deleteTitle')}</h2></div><button type="button" className="icon-btn" onClick={() => setConfirmDelete(false)} aria-label={t('common.close')}><X size={18}/></button></div>
      <p>{t('partners.deleteBody', { name: row.name })}</p>
      {error && <p className="error-text">{error}</p>}
      <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</button><button type="button" className="btn btn-danger" disabled={busy} onClick={() => void removeFactory()} data-testid="button-confirm-delete-partner"><Trash2 size={15}/>{busy ? t('common.saving') : t('partners.delete')}</button></div>
    </div></div>, document.body)}
  </div>;
}
