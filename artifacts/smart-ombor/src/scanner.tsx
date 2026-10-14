import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import { CircleAlert, Flashlight, Package, Pencil, ScanBarcode, Search, Trash2, X } from 'lucide-react';
import { Link, useSearch } from 'wouter';
import { type BarcodeLocation, type BarcodeLookup, type Product } from '@workspace/api-client-react';
import { useI18n, type TKey } from '@/i18n';

type Detected = { rawValue?: string };
type DetectorCtor = new (options?: { formats?: string[] }) => { detect: (source: CanvasImageSource) => Promise<Detected[]> };

const FORMATS = ['aztec', 'codabar', 'code_39', 'code_93', 'code_128', 'data_matrix', 'ean_8', 'ean_13', 'itf', 'pdf417', 'qr_code', 'upc_a', 'upc_e', 'databar', 'databar_expanded'];
const FAST_HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.ITF, BarcodeFormat.CODABAR, BarcodeFormat.QR_CODE]],
  [DecodeHintType.TRY_HARDER, true],
]);

function beep(ok: boolean) {
  try {
    const ctx = new AudioContext();
    const tone = ctx.createOscillator();
    const gain = ctx.createGain();
    tone.frequency.value = ok ? 1760 : 220;
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (ok ? 0.04 : 0.08));
    tone.connect(gain);
    gain.connect(ctx.destination);
    tone.start();
    tone.stop(ctx.currentTime + 0.09);
    window.setTimeout(() => void ctx.close(), 200);
  } catch { /* sound is optional */ }
  navigator.vibrate?.(ok ? 18 : [16, 24, 16]);
}

function PageHead({ title, subtitle }: { title: string; subtitle: string }) {
  return <div className="page-head"><div><h1>{title}</h1><p>{subtitle}</p></div></div>;
}

function statusKey(value: string): TKey {
  const key = `status.${value}` as TKey;
  return key;
}

function readCode(raw: string) {
  const clean = raw.trim();
  const embedded = clean.match(/\d{8,14}/g);
  if (embedded && clean.length > embedded[0].length) return embedded.sort((a, b) => b.length - a.length)[0];
  return clean;
}

function eanOk(code: string) {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop() ?? -1;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) sum += digits[digits.length - 1 - i] * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === check;
}

function cameraCode(raw: string) {
  const clean = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (clean.length < 3 || clean.length > 120) return '';
  const runs = clean.match(/\d{8,14}/g) ?? [];
  const gtin = runs.find(eanOk);
  if (gtin && (clean === gtin || /[()]/.test(clean) || clean.replace(/\D/g, '') === gtin)) return gtin;
  const compact = clean.replace(/\s+/g, '');
  if (compact.length < 3 || compact.length > 80) return '';
  if (/^[\w./:+\-*=#?&=%@]+$/i.test(compact)) return compact;
  const digits = compact.replace(/\D/g, '');
  if (digits.length >= 6 && digits.length <= 18) return digits;
  return '';
}

function guideCrop(source: HTMLVideoElement) {
  const vw = source.videoWidth;
  const vh = source.videoHeight;
  const boxW = source.clientWidth || vw;
  const boxH = source.clientHeight || vh;
  const fit = Math.min(boxW / vw, boxH / vh) || 1;
  const offX = (boxW - vw * fit) / 2;
  const offY = (boxH - vh * fit) / 2;
  const guideW = Math.min(boxW * 0.96, 680);
  const guideH = guideW / 1.7;
  const x = Math.max(0, ((boxW - guideW) / 2 - offX) / fit);
  const y = Math.max(0, ((boxH - guideH) / 2 - offY) / fit);
  const w = Math.min(vw - x, guideW / fit);
  const h = Math.min(vh - y, guideH / fit);
  if (w < 40 || h < 40) return { x: Math.floor(vw * 0.1), y: Math.floor(vh * 0.26), w: Math.floor(vw * 0.8), h: Math.floor(vh * 0.48) };
  return { x: Math.floor(x), y: Math.floor(y), w: Math.floor(w), h: Math.floor(h) };
}

function paintRegion(source: HTMLVideoElement, ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, region: { x: number; y: number; w: number; h: number }, scale: number, smooth = false) {
  canvas.width = Math.max(1, Math.floor(region.w * scale));
  canvas.height = Math.max(8, Math.floor(region.h * scale));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = smooth;
  ctx.filter = 'none';
  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
}

function thresholdBars(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 16) { sum += data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11; count += 1; }
  const mid = sum / Math.max(1, count);
  for (let i = 0; i < data.length; i += 4) {
    const tone = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
    const value = tone < mid ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = value;
  }
  ctx.putImageData(image, 0, 0);
}

function labelWorthReading(text: string) {
  const tokens = [...text.matchAll(/\d{4,6}/g)].map(match => match[0]);
  return tokens.some(token => token.length >= 5) || tokens.filter(token => token.length === 4).length >= 2;
}

function labelPieces(text: string) {
  const lines = text.split(/[\n|]+/).map(part => part.trim()).filter(labelWorthReading);
  const split = text.replace(/\s+/g, ' ').split(/\s+(?=bordo\b)/i).map(part => part.trim()).filter(labelWorthReading);
  const chunks = lines.length >= split.length ? lines : split;
  return [...new Set(chunks)].slice(0, 3);
}

async function resolveScanRequest(code: string, text: string): Promise<BarcodeLookup> {
  const params = new URLSearchParams();
  if (code) params.set('code', code);
  if (text) params.set('text', text);
  const response = await fetch(`/api/products/resolve?${params}`);
  if (!response.ok) throw new Error(response.statusText);
  return response.json() as Promise<BarcodeLookup>;
}

type ProductDraft = { name: string; code: string; article: string; priceExclusive: string; pricePremium: string; priceStandard: string; barcode: string };
const emptyDraft = (barcode = ''): ProductDraft => ({ name: '', code: '', article: '', priceExclusive: '', pricePremium: '', priceStandard: '', barcode });

function moneyAmount(value: string) {
  if (!value.trim()) return null;
  return Number(value.replace(/\s/g, '').replace(',', '.'));
}

function ProductSheet({ mode, productId, presetBarcode, onClose, onSaved }: { mode: 'create' | 'edit'; productId?: string; presetBarcode?: string; onClose: () => void; onSaved: (patch: { name: string; code: string | null; article: string | null; barcode: string; salePrice: number | null }) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ProductDraft>(() => emptyDraft(presetBarcode || ''));
  const [loading, setLoading] = useState(mode === 'edit');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (mode !== 'edit' || !productId) return;
    let active = true;
    void fetch(`/api/products/${productId}/editor`).then(async response => {
      if (!response.ok) throw new Error(t('scan.editFailed'));
      return response.json() as Promise<{ name: string; code: string; article: string; barcode: string; prices: { Exclusive: number | null; Premium: number | null; Standard: number | null } }>;
    }).then(card => {
      if (!active) return;
      const text = (value: number | null) => value == null ? '' : String(value);
      setDraft({ name: card.name, code: card.code, article: card.article, barcode: card.barcode, priceExclusive: text(card.prices.Exclusive), pricePremium: text(card.prices.Premium), priceStandard: text(card.prices.Standard) });
      setLoading(false);
    }).catch(() => { if (active) { setError(t('scan.editFailed')); setLoading(false); } });
    return () => { active = false; };
  }, [mode, productId, t]);
  const save = async () => {
    const name = draft.name.trim();
    const priceExclusive = moneyAmount(draft.priceExclusive);
    const pricePremium = moneyAmount(draft.pricePremium);
    const priceStandard = moneyAmount(draft.priceStandard);
    if (name.length < 2 || [priceExclusive, pricePremium, priceStandard].some(price => price != null && (!Number.isFinite(price) || price < 0))) {
      setError(t(mode === 'edit' ? 'scan.editFailed' : 'products.addFailed'));
      return;
    }
    setSaving(true);
    setError('');
    const body = { name, code: draft.code.trim(), article: draft.article.trim(), barcode: draft.barcode.trim(), priceExclusive, pricePremium, priceStandard };
    try {
      const response = await fetch(mode === 'edit' && productId ? `/api/products/${productId}` : '/api/products', { method: mode === 'edit' ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(t(mode === 'edit' ? 'scan.editFailed' : 'products.addFailed'));
      onSaved({ name, code: draft.code.trim() || null, article: draft.article.trim() || null, barcode: draft.barcode.trim(), salePrice: priceExclusive ?? pricePremium ?? priceStandard });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('scan.editFailed'));
    } finally { setSaving(false); }
  };
  const set = (key: keyof ProductDraft) => (event: { target: { value: string } }) => setDraft(current => ({ ...current, [key]: event.target.value }));
  return createPortal(<div className="backdrop" onClick={() => { if (!saving) onClose(); }}><form className="modal" onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void save(); }} role="dialog" aria-labelledby="scan-product-title"><div className="modal-top"><div><p className="eyebrow">{t('scan.title')}</p><h2 id="scan-product-title">{mode === 'edit' ? t('scan.editTitle') : t('products.addTitle')}</h2></div><button className="icon-btn" type="button" onClick={onClose} aria-label={t('common.close')}><X size={18}/></button></div>{loading ? <p>{t('scan.checking')}</p> : <><label className="field">{t('products.field.name')}<input className="input" value={draft.name} onChange={set('name')} autoFocus required/></label><label className="field">{t('products.field.code')}<input className="input" value={draft.code} onChange={set('code')}/></label><label className="field">{t('products.field.article')}<input className="input" value={draft.article} onChange={set('article')}/></label><label className="field">{t('products.field.priceExclusive')}<input className="input" inputMode="decimal" value={draft.priceExclusive} onChange={set('priceExclusive')}/></label><label className="field">{t('products.field.pricePremium')}<input className="input" inputMode="decimal" value={draft.pricePremium} onChange={set('pricePremium')}/></label><label className="field">{t('products.field.priceStandard')}<input className="input" inputMode="decimal" value={draft.priceStandard} onChange={set('priceStandard')}/></label>{mode === 'edit' && <p className="muted">{t('scan.keepPrices')}</p>}<label className="field">{t('products.field.barcode')}<input className="input" value={draft.barcode} onChange={set('barcode')}/></label>{error && <p className="error-text">{error}</p>}<div className="form-actions"><button className="btn btn-primary" type="submit" disabled={saving || draft.name.trim().length < 2}>{saving ? t('products.saving') : t('products.saved')}</button><button className="btn btn-secondary" type="button" disabled={saving} onClick={onClose}>{t('common.cancel')}</button></div></>}</form></div>, document.body);
}

function Hit({ product, locations, code, onEdit, onRemove }: { product: Product; locations: BarcodeLocation[]; code: string; onEdit: (product: Product) => void; onRemove: (id: string) => void }) {
  const { t, fmt, money } = useI18n();
  const places = locations.filter(row => row.productId === product.id).slice(0, 3);
  const search = encodeURIComponent(product.code || product.name);
  return <article className="card scan-row" data-testid={`barcode-result-${product.id}`}>
    {product.imageUrl ? <img src={product.imageUrl} alt=""/> : <span className="scan-photo"><Package size={20}/></span>}
    <div>
      <span className={`badge badge-${product.stockStatus.replaceAll('_', '-')}`}>{t(statusKey(product.stockStatus))}</span>
      <h2>{product.name}</h2>
      <p>{[code, product.code, product.article].filter(Boolean).join(' · ')}</p>
      {places.length > 0 && <div className="scan-where">{places.map(row => <i key={row.warehouseName}>{row.warehouseName} · {fmt(row.quantity)}</i>)}</div>}
      <div className="scan-links">
        <Link href={`/products?search=${search}`} data-testid={`link-scan-product-${product.id}`}>{t('scan.openProduct')}</Link>
        <Link href={`/stock?search=${search}`} data-testid={`link-scan-stock-${product.id}`}>{t('scan.openStock')}</Link>
      </div>
      <div className="scan-row-actions">
        <button className="btn btn-secondary" type="button" onClick={() => onEdit(product)} data-testid={`button-edit-scan-${product.id}`}><Pencil size={14}/>{t('scan.edit')}</button>
        <button className="btn btn-secondary" type="button" onClick={() => onRemove(product.id)} data-testid={`button-remove-scan-${product.id}`}><Trash2 size={14}/>{t('scan.remove')}</button>
      </div>
    </div>
    <div className="scan-row-side"><b>{fmt(product.stock)}</b><span>{money(product.salePrice)}</span></div>
  </article>;
}

function Miss({ code, onDone, onSave }: { code: string; onDone: () => void; onSave: () => void }) {
  const { t } = useI18n();
  return <div className="notice notice-error scan-miss" data-testid="status-barcode-not-found"><CircleAlert size={18}/><div><b>{t('scan.notFound')}</b><p>{t('scan.notFoundBody', { code })}</p><div className="scan-miss-actions"><button className="btn btn-primary" type="button" onClick={onSave} data-testid="button-save-scan-product">{t('scan.saveProduct')}</button><button className="btn btn-secondary" type="button" onClick={onDone}>{t('scan.remove')}</button></div></div></div>;
}

function LookupView({ lookup, onEdit, onRemove }: { lookup: BarcodeLookup; onEdit: (product: Product) => void; onRemove: (id: string) => void }) {
  const { t } = useI18n();
  const locations = lookup.locations ?? [];
  const code = lookup.barcode;
  if (lookup.ambiguous) return <div className="scan-stack">
    <p className="muted">{t('scan.ambiguousBody')}</p>
    {lookup.products.map(product => <Hit key={product.id} product={product} locations={locations} code={code} onEdit={onEdit} onRemove={onRemove}/>)}
  </div>;
  return <Hit product={lookup.products[0]} locations={locations} code={code} onEdit={onEdit} onRemove={onRemove}/>;
}

export function ScannerPage() {
  const { t, fmt } = useI18n();
  const initial = new URLSearchParams(useSearch()).get('code')?.trim() || '';
  const [code, setCode] = useState(initial);
  const [hits, setHits] = useState<BarcodeLookup[]>([]);
  const [checking, setChecking] = useState(initial);
  const [miss, setMiss] = useState('');
  const [camera, setCamera] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [torchOn, setTorchOn] = useState(false);
  const [torchable, setTorchable] = useState(false);
  const [live, setLive] = useState('');
  const [sheet, setSheet] = useState<null | { mode: 'create' | 'edit'; productId?: string; barcode?: string }>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const ocrReady = useRef<Promise<Worker | null> | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const result = useRef<HTMLDivElement | null>(null);
  const acceptRef = useRef<(value: string) => void>(() => {});
  const labelRef = useRef('');
  const labelSeen = useRef(new Map<string, number>());
  const labelFlight = useRef(new Set<string>());
  const generation = useRef(0);
  const holdTimer = useRef(0);
  const lastBeep = useRef({ key: '', at: 0 });
  const burst = useRef<string[]>([]);
  const learned = useRef(new Map<string, BarcodeLookup>());
  const recentCode = useRef({ value: '', at: 0 });
  const showHitRef = useRef<(lookup: BarcodeLookup) => void>(() => {});
  const nudgeOcr = useRef<(() => void) | null>(null);

  const showHit = (lookup: BarcodeLookup) => {
    if (!lookup.products.length) return;
    window.clearTimeout(holdTimer.current);
    const key = lookup.products.map(product => product.id).join('-');
    const now = Date.now();
    const repeat = lastBeep.current.key === key && now - lastBeep.current.at < 420;
    lastBeep.current = { key, at: now };
    setChecking('');
    setMiss('');
    const names = [lookup.products[0].name, ...burst.current.filter(item => item !== lookup.products[0].name)].slice(0, 3);
    burst.current = names;
    setLive(names.join(' · '));
    setCode(lookup.barcode || lookup.products[0].code || '');
    if (!repeat) beep(true);
    setHits(list => [lookup, ...list.filter(item => item.products.map(product => product.id).join('-') !== key)].slice(0, 200));
  };
  showHitRef.current = showHit;

  const remember = (barcode: string, lookup: BarcodeLookup) => {
    if (!/^\d{8,18}$/.test(barcode) || !lookup.products.length) return;
    learned.current.set(barcode, lookup);
    if (learned.current.size > 40) learned.current.delete(learned.current.keys().next().value || barcode);
  };

  const scheduleMiss = (value: string, gen: number) => {
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      if (generation.current !== gen) return;
      setChecking('');
      setMiss(value);
      beep(false);
    }, 1800);
  };

  const accept = (value: string, quiet = false) => {
    const clean = readCode(value);
    if (clean.length < 3) return;
    const known = learned.current.get(clean);
    if (known) {
      recentCode.current = { value: clean, at: Date.now() };
      showHit(known);
      return;
    }
    const gen = ++generation.current;
    window.clearTimeout(holdTimer.current);
    setCode(clean);
    setMiss('');
    if (!quiet) setChecking(clean);
    void resolveScanRequest(clean, labelRef.current).then(lookup => {
      if (lookup.products.length) {
        remember(clean, lookup);
        showHit(lookup);
      } else if (generation.current === gen && Date.now() - lastBeep.current.at > 2000) {
        nudgeOcr.current?.();
        scheduleMiss(clean, gen);
      }
    }).catch(() => {
      if (generation.current !== gen) return;
      setChecking('');
      setMiss(clean);
    });
  };
  acceptRef.current = (value: string) => accept(value, true);

  const acceptLabel = (value: string) => {
    const signature = [...value.matchAll(/\d{2}-\d{2}|\d{4,6}/g)].map(match => match[0]).sort().join('|');
    if (!signature) return;
    const now = Date.now();
    if ((labelSeen.current.get(signature) ?? 0) > now - 280) {
      labelSeen.current.set(signature, now);
      return;
    }
    if (labelFlight.current.has(signature)) return;
    labelFlight.current.add(signature);
    labelRef.current = value;
    void resolveScanRequest('', value).then(lookup => {
      labelFlight.current.delete(signature);
      if (!lookup.products.length) return;
      labelSeen.current.set(signature, Date.now());
      const recent = recentCode.current;
      if (recent.value && Date.now() - recent.at < 1500) remember(recent.value, lookup);
      showHit(lookup);
    }).catch(() => {
      labelFlight.current.delete(signature);
    });
  };

  useEffect(() => {
    ocrReady.current = createWorker('eng').then(async worker => {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      return worker;
    }).catch(() => null);
    return () => {
      const pending = ocrReady.current;
      ocrReady.current = null;
      void pending?.then(worker => worker?.terminate());
    };
  }, []);

  useEffect(() => {
    if (initial) accept(initial);
    return () => window.clearTimeout(holdTimer.current);
  }, [initial]);

  useEffect(() => {
    if (!camera) return;
    let active = true;
    let nativeTimer = 0;
    let ocrTimer = 0;
    let worker: Worker | null = null;
    const streamBox: { current: MediaStream | null } = { current: null };
    const seenCodes = new Map<string, number>();
    const hit = (value: string) => {
      const now = Date.now();
      if ((seenCodes.get(value) ?? 0) > now - 240) {
        seenCodes.set(value, now);
        return;
      }
      seenCodes.set(value, now);
      recentCode.current = { value, at: now };
      acceptRef.current(value);
    };
    const consider = (raw: string) => {
      const clean = cameraCode(raw);
      if (clean) hit(clean);
    };
    const start = async () => {
      const videoConstraints: MediaTrackConstraints = { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } };
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      }
      const track = stream.getVideoTracks()[0];
      trackRef.current = track ?? null;
      const caps = track?.getCapabilities?.() as MediaTrackCapabilities & { focusMode?: string[]; exposureMode?: string[]; whiteBalanceMode?: string[]; torch?: boolean; zoom?: { min: number; max: number } };
      const advanced: MediaTrackConstraintSet[] = [];
      if (caps?.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' } as MediaTrackConstraintSet);
      if (caps?.exposureMode?.includes('continuous')) advanced.push({ exposureMode: 'continuous' } as MediaTrackConstraintSet);
      if (caps?.whiteBalanceMode?.includes('continuous')) advanced.push({ whiteBalanceMode: 'continuous' } as MediaTrackConstraintSet);
      if (advanced.length) await track.applyConstraints({ advanced }).catch(() => undefined);
      if (active) setTorchable(Boolean(caps?.torch));
      if (!active) { stream.getTracks().forEach(item => item.stop()); return; }
      streamBox.current = stream;
      const preview = video.current;
      if (preview) { preview.srcObject = stream; await preview.play(); }
      const canvas = document.createElement('canvas');
      const copy = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const copyCtx = copy.getContext('2d', { willReadFrequently: true });
      const Detector = (window as Window & { BarcodeDetector?: DetectorCtor & { getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
      let detector: { detect: (source: CanvasImageSource) => Promise<Detected[]> } | null = null;
      if (Detector) {
        let formats = FORMATS;
        try {
          const supported = await Detector.getSupportedFormats?.();
          if (supported?.length) formats = FORMATS.filter(format => supported.includes(format));
        } catch { /* use the full list */ }
        try { detector = formats.length ? new Detector({ formats }) : new Detector(); } catch { try { detector = new Detector(); } catch { detector = null; } }
      }
      const fastReader = new BrowserMultiFormatReader(FAST_HINTS);
      let scanBusy = false;
      const readBars = (target: HTMLCanvasElement) => {
        try {
          const decoded = fastReader.decodeFromCanvas(target);
          if (decoded) consider(decoded.getText());
          return Boolean(decoded);
        } catch { return false; }
      };
      const tick = () => {
        if (!active) return;
        const source = video.current;
        if (!scanBusy && ctx && source && source.readyState >= 2 && source.videoWidth > 0) {
          scanBusy = true;
          const guide = guideCrop(source);
          const bars = { x: guide.x, y: guide.y + Math.floor(guide.h * 0.34), w: guide.w, h: Math.max(28, Math.floor(guide.h * 0.34)) };
          const scale = Math.min(3, Math.max(1.4, 1800 / Math.max(1, bars.w)));
          paintRegion(source, ctx, canvas, bars, scale);
          if (copyCtx) {
            copy.width = canvas.width;
            copy.height = canvas.height;
            copyCtx.drawImage(canvas, 0, 0);
          }
          let pending = 1;
          const finish = () => { pending -= 1; if (pending <= 0) scanBusy = false; };
          if (detector) {
            pending += 1;
            void detector.detect(canvas).then(rows => {
              for (const item of rows) consider(item.rawValue || '');
            }).catch(() => undefined).finally(finish);
          }
          window.setTimeout(() => {
            if (active && copyCtx && !readBars(copy)) {
              thresholdBars(copyCtx, copy);
              readBars(copy);
            }
            finish();
          }, 0);
        }
        nativeTimer = window.setTimeout(tick, 80);
      };
      nativeTimer = window.setTimeout(tick, 40);
    };
    const readLabel = async () => {
      worker = await ocrReady.current;
      if (!worker) {
        try {
          worker = await createWorker('eng');
        } catch { return; }
      }
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz- ',
      }).catch(() => undefined);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      let reading = false;
      const read = async () => {
        if (!active || !worker || !ctx || reading) return;
        const source = video.current;
        if (!source || source.readyState < 2 || source.videoWidth <= 0) {
          ocrTimer = window.setTimeout(read, 80);
          return;
        }
        reading = true;
        const guide = guideCrop(source);
        const scale = Math.min(2.2, Math.max(1.2, 1400 / Math.max(1, guide.w)));
        paintRegion(source, ctx, canvas, guide, scale, true);
        try {
          const found = await worker.recognize(canvas);
          const text = (found.data.text || '').replace(/\s+/g, ' ').trim();
          for (const piece of labelPieces(text)) acceptLabel(piece);
          for (const code of text.match(/\d{8,14}/g) ?? []) acceptRef.current(code);
          if (!labelWorthReading(text)) {
            const now = Date.now();
            for (const [key, at] of labelSeen.current) if (now - at > 280) labelSeen.current.delete(key);
          }
        } catch { /* this frame had no readable label */ }
        finally { reading = false; }
        if (active) ocrTimer = window.setTimeout(read, 40);
      };
      nudgeOcr.current = () => {
        if (!active || reading) return;
        window.clearTimeout(ocrTimer);
        void read();
      };
      if (active) ocrTimer = window.setTimeout(read, 20);
    };
    void readLabel();
    start().catch(error => {
      if (!active) return;
      const name = error instanceof DOMException ? error.name : '';
      setCameraError(name === 'NotAllowedError' || name === 'PermissionDeniedError' ? t('scan.cameraDenied') : t('scan.cameraFailed'));
    });
    return () => {
      active = false;
      nudgeOcr.current = null;
      window.clearTimeout(nativeTimer);
      window.clearTimeout(ocrTimer);
      trackRef.current = null;
      setTorchable(false);
      setTorchOn(false);
      streamBox.current?.getTracks().forEach(track => track.stop());
    };
  }, [camera, t]);

  useEffect(() => {
    const track = trackRef.current;
    if (!camera || !track || !torchable) return;
    void track.applyConstraints({ advanced: [{ torch: torchOn } as MediaTrackConstraintSet] }).catch(() => setTorchOn(false));
  }, [camera, torchOn, torchable]);

  useEffect(() => {
    let buffer = '';
    let last = 0;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
      const now = Date.now();
      if (now - last > 45) buffer = '';
      last = now;
      if (event.key === 'Enter') {
        if (buffer.length >= 3) {
          event.preventDefault();
          acceptRef.current(buffer);
        }
        buffer = '';
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) buffer += event.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const lookup = (event: FormEvent) => {
    event.preventDefault();
    accept(code);
  };

  return <>
    <PageHead title={t('scan.title')} subtitle={t('scan.sub')}/>
    <form className="card scan-tools" onSubmit={lookup}>
      <label className="field" data-testid="field-manual-barcode"><span>{t('scan.manual')}</span>
        <input className="input scan-input" data-testid="input-manual-barcode" autoComplete="off" autoFocus enterKeyHint="search" placeholder={t('scan.manualPlaceholder')} value={code} onChange={event => setCode(event.target.value)}/>
      </label>
      <div className="scan-actions">
        <button className="btn btn-secondary" type="submit" data-testid="button-lookup-barcode" disabled={code.trim().length < 3}><Search size={16}/><span>{t('scan.check')}</span></button>
        <button className={`btn btn-primary ${camera ? 'is-on' : ''}`} type="button" data-testid="button-camera-start" onClick={() => { setCameraError(''); setMiss(''); setCamera(open => { if (!open && !eanOk(code)) setCode(''); return !open; }); }}><ScanBarcode size={16}/><span>{camera ? t('scan.cameraStop') : t('scan.cameraStart')}</span></button>
      </div>
    </form>
    {camera && <div className="scan-view">
      <video ref={video} autoPlay playsInline muted data-testid="camera-preview"/>
      <div className="scan-frame"><span><i/></span></div>
      <b className="scan-live">{live || t('scan.listening')}</b>
      {torchable && <button className={`icon-btn camera-torch ${torchOn ? 'is-on' : ''}`} type="button" onClick={() => setTorchOn(on => !on)} aria-label={torchOn ? t('scan.torchOff') : t('scan.torch')} data-testid="button-camera-torch"><Flashlight size={16}/></button>}
      <button className="icon-btn camera-stop" type="button" onClick={() => setCamera(false)} aria-label={t('scan.cameraStop')} data-testid="button-camera-stop"><X size={16}/></button>
      {cameraError && <small className="error-text scan-live-error" data-testid="status-camera-error">{cameraError}</small>}
    </div>}
    <div className="scan-feed" ref={result}>
      {(hits.length > 0 || miss) && <div className="scan-session"><span>{t('scan.sessionCount', { count: fmt(hits.reduce((sum, item) => sum + item.products.length, 0) + (miss ? 1 : 0)) })}</span><button className="btn btn-secondary" type="button" onClick={() => { setHits([]); setMiss(''); }} data-testid="button-clear-scans">{t('scan.clearAll')}</button></div>}
      {checking && <div className="scan-pending" data-testid="status-barcode-loading"><b className="scan-code">{checking}</b><span>{t('scan.checking')}</span></div>}
      {miss && <Miss key={miss} code={miss} onDone={() => setMiss('')} onSave={() => setSheet({ mode: 'create', barcode: miss })}/>}
      {hits.map(lookup => <LookupView key={lookup.products.map(product => product.id).join('-')} lookup={lookup} onEdit={product => setSheet({ mode: 'edit', productId: product.id })} onRemove={id => setHits(list => list.flatMap(item => { const products = item.products.filter(product => product.id !== id); return products.length ? [{ ...item, products, ambiguous: products.length > 1 }] : []; }))}/>)}
      {sheet && <ProductSheet mode={sheet.mode} productId={sheet.productId} presetBarcode={sheet.barcode} onClose={() => setSheet(null)} onSaved={patch => { if (sheet.mode === 'create') { setMiss(''); accept(patch.barcode || patch.name); } else if (sheet.productId) { const id = sheet.productId; setHits(list => list.map(item => ({ ...item, products: item.products.map(product => product.id === id ? { ...product, name: patch.name, code: patch.code, article: patch.article, salePrice: patch.salePrice ?? product.salePrice, barcodes: patch.barcode ? [patch.barcode, ...product.barcodes.filter(value => value !== patch.barcode)] : product.barcodes } : product) }))); } }}/>}
      {!checking && !miss && !hits.length && <p className="card scan-feed-empty" data-testid="status-scan-ready">{t('scan.feedEmpty')}</p>}
    </div>
  </>;
}
