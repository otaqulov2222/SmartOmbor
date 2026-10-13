import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import { CircleAlert, Package, ScanBarcode, Search, X } from 'lucide-react';
import { Link, useSearch } from 'wouter';
import { type BarcodeLocation, type BarcodeLookup, type Product } from '@workspace/api-client-react';
import { useI18n, type TKey } from '@/i18n';

type Detected = { rawValue?: string };
type DetectorCtor = new (options?: { formats?: string[] }) => { detect: (source: HTMLVideoElement) => Promise<Detected[]> };

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix'];
const ZXING_HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.TRY_HARDER, true],
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF, BarcodeFormat.QR_CODE]],
]);

function beep(ok: boolean) {
  try {
    const ctx = new AudioContext();
    const tone = ctx.createOscillator();
    const gain = ctx.createGain();
    tone.frequency.value = ok ? 880 : 240;
    gain.gain.value = 0.04;
    tone.connect(gain);
    gain.connect(ctx.destination);
    tone.start();
    tone.stop(ctx.currentTime + 0.07);
    window.setTimeout(() => void ctx.close(), 250);
  } catch { /* sound is optional */ }
  navigator.vibrate?.(ok ? 25 : [20, 30, 20]);
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
  const clean = readCode(raw).replace(/\s/g, '');
  if (eanOk(clean)) return clean;
  if (/^\d{6}$|^\d{13}$/.test(clean)) return clean;
  if (/^[A-Za-z0-9._/-]{4,40}$/.test(clean) && !/^\d+$/.test(clean)) return clean;
  return '';
}

function labelWorthReading(text: string) {
  const tokens = [...text.matchAll(/\d{4,6}/g)].map(match => match[0]);
  return tokens.some(token => token.length >= 5) || tokens.filter(token => token.length === 4).length >= 2;
}

async function resolveScanRequest(code: string, text: string): Promise<BarcodeLookup> {
  const params = new URLSearchParams();
  if (code) params.set('code', code);
  if (text) params.set('text', text);
  const response = await fetch(`/api/products/resolve?${params}`);
  if (!response.ok) throw new Error(response.statusText);
  return response.json() as Promise<BarcodeLookup>;
}

function Hit({ product, locations, code }: { product: Product; locations: BarcodeLocation[]; code: string }) {
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
    </div>
    <div className="scan-row-side"><b>{fmt(product.stock)}</b><span>{money(product.salePrice)}</span></div>
  </article>;
}

function Miss({ code, onDone }: { code: string; onDone: () => void }) {
  const { t } = useI18n();
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    const leave = window.setTimeout(() => setLeaving(true), 5000);
    const done = window.setTimeout(() => doneRef.current(), 5600);
    return () => { window.clearTimeout(leave); window.clearTimeout(done); };
  }, []);
  return <div className={`notice notice-error scan-miss ${leaving ? 'is-leaving' : ''}`} data-testid="status-barcode-not-found"><CircleAlert size={18}/><div><b>{t('scan.notFound')}</b><p>{t('scan.notFoundBody', { code })}</p></div></div>;
}

function LookupView({ lookup }: { lookup: BarcodeLookup }) {
  const { t } = useI18n();
  const locations = lookup.locations ?? [];
  const code = lookup.barcode;
  if (lookup.ambiguous) return <div className="scan-stack">
    <p className="muted">{t('scan.ambiguousBody')}</p>
    {lookup.products.map(product => <Hit key={product.id} product={product} locations={locations} code={code}/>)}
  </div>;
  return <Hit product={lookup.products[0]} locations={locations} code={code}/>;
}

export function ScannerPage() {
  const { t } = useI18n();
  const initial = new URLSearchParams(useSearch()).get('code')?.trim() || '';
  const [code, setCode] = useState(initial);
  const [hits, setHits] = useState<BarcodeLookup[]>([]);
  const [checking, setChecking] = useState(initial);
  const [miss, setMiss] = useState('');
  const [camera, setCamera] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const video = useRef<HTMLVideoElement | null>(null);
  const result = useRef<HTMLDivElement | null>(null);
  const acceptRef = useRef<(value: string) => void>(() => {});
  const labelRef = useRef('');
  const labelSeen = useRef('');
  const generation = useRef(0);
  const holdTimer = useRef(0);

  const showHit = (lookup: BarcodeLookup) => {
    if (!lookup.products.length) return;
    generation.current += 1;
    window.clearTimeout(holdTimer.current);
    setChecking('');
    setMiss('');
    setCode(lookup.barcode || code);
    setHits(list => {
      const key = lookup.products.map(product => product.id).join('-');
      if (list.some(item => item.products.map(product => product.id).join('-') === key)) return list;
      beep(true);
      return [lookup, ...list].slice(0, 12);
    });
    window.setTimeout(() => result.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 40);
  };

  const scheduleMiss = (value: string, gen: number) => {
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      if (generation.current !== gen) return;
      setChecking('');
      setMiss(value);
      beep(false);
    }, eanOk(value) ? 1800 : 4000);
  };

  const accept = (value: string) => {
    const clean = readCode(value);
    if (clean.length < 3) return;
    const gen = ++generation.current;
    window.clearTimeout(holdTimer.current);
    setCode(clean);
    setMiss('');
    setChecking(clean);
    void resolveScanRequest(clean, labelRef.current).then(lookup => {
      if (generation.current !== gen) return;
      if (lookup.products.length) showHit(lookup);
      else scheduleMiss(clean, gen);
    }).catch(() => {
      if (generation.current !== gen) return;
      setChecking('');
      setMiss(clean);
    });
  };
  acceptRef.current = accept;

  const acceptLabel = (value: string) => {
    const signature = [...value.matchAll(/\d{2}-\d{2}|\d{4,6}/g)].map(match => match[0]).sort().join('|');
    if (!signature || signature === labelSeen.current) return;
    labelSeen.current = signature;
    labelRef.current = value;
    void resolveScanRequest('', value).then(lookup => {
      if (lookup.products.length) showHit(lookup);
    }).catch(() => undefined);
  };

  useEffect(() => {
    if (initial) accept(initial);
    return () => window.clearTimeout(holdTimer.current);
  }, [initial]);

  useEffect(() => {
    if (!camera) return;
    let active = true;
    let timer = 0;
    let ocrTimer = 0;
    let worker: Worker | null = null;
    const streamBox: { current: MediaStream | null } = { current: null };
    const last = { value: '', at: 0 };
    const streak = { value: '', n: 0 };
    const hit = (value: string) => {
      const now = Date.now();
      if (value === last.value && now - last.at < 1200) return;
      last.value = value;
      last.at = now;
      acceptRef.current(value);
    };
    const consider = (raw: string) => {
      const clean = cameraCode(raw);
      if (!clean) return;
      if (eanOk(clean)) { hit(clean); return; }
      streak.n = streak.value === clean ? streak.n + 1 : 1;
      streak.value = clean;
      if (streak.n >= 3) hit(clean);
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
      const caps = track?.getCapabilities?.() as MediaTrackCapabilities & { focusMode?: string[]; zoom?: { min: number; max: number } };
      const advanced: MediaTrackConstraintSet[] = [];
      if (caps?.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' } as MediaTrackConstraintSet);
      if (caps?.zoom && caps.zoom.max > 1.2) advanced.push({ zoom: Math.min(1.6, caps.zoom.max) } as MediaTrackConstraintSet);
      if (advanced.length) await track.applyConstraints({ advanced }).catch(() => undefined);
      if (!active) { stream.getTracks().forEach(item => item.stop()); return; }
      streamBox.current = stream;
      const preview = video.current;
      if (preview) { preview.srcObject = stream; await preview.play(); }
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const Detector = (window as Window & { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
      let detector: { detect: (source: CanvasImageSource) => Promise<Detected[]> } | null = null;
      if (Detector) { try { detector = new Detector({ formats: FORMATS }); } catch { detector = new Detector(); } }
      const reader = new BrowserMultiFormatReader(ZXING_HINTS);
      let busy = false;
      let magnify = false;
      const tick = async () => {
        if (!active) return;
        const source = video.current;
        if (!busy && ctx && source && source.readyState >= 2 && source.videoWidth > 0) {
          busy = true;
          try {
            const native = detector ? await detector.detect(source) : [];
            const nativeCodes = native.map(item => cameraCode(item.rawValue || '')).filter(Boolean);
            const nativeHit = nativeCodes.find(eanOk) || nativeCodes[0];
            if (nativeHit) consider(nativeHit);
            else {
              const vw = source.videoWidth;
              const vh = source.videoHeight;
              magnify = !magnify;
              if (magnify) {
                const sw = Math.floor(vw * 0.62);
                const sh = Math.floor(vh * 0.62);
                canvas.width = sw * 2;
                canvas.height = sh * 2;
                ctx.drawImage(source, Math.floor((vw - sw) / 2), Math.floor((vh - sh) / 2), sw, sh, 0, 0, canvas.width, canvas.height);
              } else {
                const scale = Math.min(1, 1600 / Math.max(vw, vh));
                canvas.width = Math.max(1, Math.floor(vw * scale));
                canvas.height = Math.max(1, Math.floor(vh * scale));
                ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
              }
              const decoded = reader.decodeFromCanvas(canvas);
              if (decoded) consider(decoded.getText());
            }
          } catch { /* this frame has no barcode */ }
          finally { busy = false; }
        }
        timer = window.setTimeout(tick, 50);
      };
      timer = window.setTimeout(tick, 50);
    };
    const readLabel = async () => {
      try {
        worker = await createWorker('eng');
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
          user_defined_dpi: '300',
        });
      } catch { return; }
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      let turn = false;
      const read = async () => {
        if (!active || !worker || !ctx) return;
        const source = video.current;
        if (source && source.readyState >= 2 && source.videoWidth > 0) {
          const vw = source.videoWidth;
          const vh = source.videoHeight;
          const cw = Math.floor(vw * 0.78);
          const ch = Math.floor(vh * 0.46);
          const sx = Math.floor((vw - cw) / 2);
          const sy = Math.floor((vh - ch) / 2);
          if (turn) {
            canvas.width = ch * 2;
            canvas.height = cw * 2;
            ctx.setTransform(0, 2, -2, 0, canvas.width, 0);
          } else {
            canvas.width = cw * 2;
            canvas.height = ch * 2;
            ctx.setTransform(2, 0, 0, 2, 0, 0);
          }
          ctx.drawImage(source, sx, sy, cw, ch, 0, 0, cw, ch);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          try {
            const found = await worker.recognize(canvas);
            const text = found.data.text || '';
            if (labelWorthReading(text)) acceptLabel(text);
            else turn = !turn;
          } catch { /* this frame has no readable text */ }
        }
        ocrTimer = window.setTimeout(read, 650);
      };
      if (active) ocrTimer = window.setTimeout(read, 300);
    };
    void readLabel();
    start().catch(error => {
      if (!active) return;
      const name = error instanceof DOMException ? error.name : '';
      setCameraError(name === 'NotAllowedError' || name === 'PermissionDeniedError' ? t('scan.cameraDenied') : t('scan.cameraFailed'));
    });
    return () => {
      active = false;
      window.clearTimeout(timer);
      window.clearTimeout(ocrTimer);
      void worker?.terminate();
      streamBox.current?.getTracks().forEach(track => track.stop());
    };
  }, [camera, t]);

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
      <b className="scan-live">{t('scan.listening')}</b>
      <button className="icon-btn camera-stop" type="button" onClick={() => setCamera(false)} aria-label={t('scan.cameraStop')} data-testid="button-camera-stop"><X size={16}/></button>
      {cameraError && <small className="error-text scan-live-error" data-testid="status-camera-error">{cameraError}</small>}
    </div>}
    <div className="scan-feed" ref={result}>
      {checking && <div className="scan-pending" data-testid="status-barcode-loading"><b className="scan-code">{checking}</b><span>{t('scan.checking')}</span></div>}
      {miss && <Miss key={miss} code={miss} onDone={() => setMiss('')}/>}
      {hits.map(lookup => <LookupView key={lookup.products.map(product => product.id).join('-')} lookup={lookup}/>)}
      {!checking && !miss && !hits.length && <p className="card scan-feed-empty" data-testid="status-scan-ready">{t('scan.feedEmpty')}</p>}
    </div>
  </>;
}
