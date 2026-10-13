import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import { CircleAlert, Flashlight, Package, ScanBarcode, Search, X } from 'lucide-react';
import { Link, useSearch } from 'wouter';
import { type BarcodeLocation, type BarcodeLookup, type Product } from '@workspace/api-client-react';
import { useI18n, type TKey } from '@/i18n';

type Detected = { rawValue?: string };
type DetectorCtor = new (options?: { formats?: string[] }) => { detect: (source: CanvasImageSource) => Promise<Detected[]> };

const FORMATS = ['aztec', 'codabar', 'code_39', 'code_93', 'code_128', 'data_matrix', 'ean_8', 'ean_13', 'itf', 'pdf417', 'qr_code', 'upc_a', 'upc_e', 'databar', 'databar_expanded'];
const FAST_HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.ITF, BarcodeFormat.CODABAR, BarcodeFormat.QR_CODE]],
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

function drawStrip(source: HTMLVideoElement, ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, y: number) {
  const vw = source.videoWidth;
  const vh = source.videoHeight;
  const sw = Math.floor(vw * 0.96);
  const sh = Math.floor(vh * 0.3);
  const sy = Math.floor(vh * y);
  const scale = Math.max(2, Math.min(3, 1800 / sw));
  canvas.width = Math.max(1, Math.floor(sw * scale));
  canvas.height = Math.max(2, Math.floor(sh * scale));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'grayscale(1) contrast(1.85)';
  ctx.drawImage(source, Math.floor((vw - sw) / 2), sy, sw, sh, 0, 0, canvas.width, canvas.height);
  ctx.filter = 'none';
}

function drawLabel(source: HTMLVideoElement, ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
  const vw = source.videoWidth;
  const vh = source.videoHeight;
  const cw = Math.floor(vw * 0.7);
  const ch = Math.floor(vh * 0.16);
  const scale = Math.min(3, 1600 / cw);
  canvas.width = Math.max(1, Math.floor(cw * scale));
  canvas.height = Math.max(8, Math.floor(ch * scale));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.filter = 'grayscale(1) contrast(1.8)';
  ctx.drawImage(source, Math.floor((vw - cw) / 2), Math.floor(vh * 0.36), cw, ch, 0, 0, canvas.width, canvas.height);
  ctx.filter = 'none';
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const ink = data[i] < 150 ? 0 : 255;
    data[i] = ink;
    data[i + 1] = ink;
    data[i + 2] = ink;
  }
  ctx.putImageData(image, 0, 0);
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
  const [torchOn, setTorchOn] = useState(false);
  const [torchable, setTorchable] = useState(false);
  const [live, setLive] = useState('');
  const video = useRef<HTMLVideoElement | null>(null);
  const ocrReady = useRef<Promise<Worker | null> | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const result = useRef<HTMLDivElement | null>(null);
  const acceptRef = useRef<(value: string) => void>(() => {});
  const labelRef = useRef('');
  const labelSeen = useRef('');
  const labelFlight = useRef('');
  const labelSeenAt = useRef(0);
  const generation = useRef(0);
  const holdTimer = useRef(0);
  const lastBeep = useRef({ key: '', at: 0 });
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
    setLive(lookup.products[0].name);
    setCode(lookup.barcode || lookup.products[0].code || '');
    if (!repeat) beep(true);
    setHits(list => [lookup, ...list.filter(item => item.products.map(product => product.id).join('-') !== key)].slice(0, 16));
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
    }, 1100);
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
      } else if (generation.current === gen) {
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
    if (signature === labelSeen.current) {
      labelSeenAt.current = Date.now();
      return;
    }
    if (signature === labelFlight.current) return;
    labelFlight.current = signature;
    labelRef.current = value;
    void resolveScanRequest('', value).then(lookup => {
      if (labelFlight.current === signature) labelFlight.current = '';
      if (!lookup.products.length) return;
      labelSeen.current = signature;
      labelSeenAt.current = Date.now();
      const recent = recentCode.current;
      if (recent.value && Date.now() - recent.at < 1500) remember(recent.value, lookup);
      showHit(lookup);
    }).catch(() => {
      if (labelFlight.current === signature) labelFlight.current = '';
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
    let stripTimer = 0;
    let ocrTimer = 0;
    let worker: Worker | null = null;
    const streamBox: { current: MediaStream | null } = { current: null };
    const last = { value: '', at: 0 };
    const hit = (value: string) => {
      const now = Date.now();
      if (value === last.value && now - last.at < 420) {
        last.at = now;
        return;
      }
      last.value = value;
      last.at = now;
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
      if (caps?.zoom && caps.zoom.max > 1.2) advanced.push({ zoom: Math.min(1.6, caps.zoom.max) } as MediaTrackConstraintSet);
      if (advanced.length) await track.applyConstraints({ advanced }).catch(() => undefined);
      if (active) setTorchable(Boolean(caps?.torch));
      if (!active) { stream.getTracks().forEach(item => item.stop()); return; }
      streamBox.current = stream;
      const preview = video.current;
      if (preview) { preview.srcObject = stream; await preview.play(); }
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const Detector = (window as Window & { BarcodeDetector?: DetectorCtor & { getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
      let detector: { detect: (source: CanvasImageSource) => Promise<Detected[]> } | null = null;
      if (Detector) {
        let formats = FORMATS;
        try {
          const supported = await Detector.getSupportedFormats?.();
          if (supported?.length) formats = FORMATS.filter(format => supported.includes(format));
        } catch { /* use the full list */ }
        try { detector = new Detector({ formats }); } catch { try { detector = new Detector(); } catch { detector = null; } }
      }
      const fastReader = new BrowserMultiFormatReader(FAST_HINTS);
      const bands = [0.44, 0.52, 0.6, 0.68];
      let band = 0;
      let nativeBusy = false;
      const tick = () => {
        if (!active) return;
        const source = video.current;
        if (!nativeBusy && detector && source && source.readyState >= 2) {
          nativeBusy = true;
          void detector.detect(source).then(rows => {
            for (const item of rows) consider(item.rawValue || '');
          }).catch(() => undefined).finally(() => { nativeBusy = false; });
        }
        nativeTimer = window.setTimeout(tick, 50);
      };
      const decodeStrip = () => {
        if (!active) return;
        const source = video.current;
        if (ctx && source && source.readyState >= 2 && source.videoWidth > 0) {
          window.setTimeout(() => {
            try {
              drawStrip(source, ctx, canvas, bands[band % bands.length]);
              band += 1;
              const decoded = fastReader.decodeFromCanvas(canvas);
              if (decoded) consider(decoded.getText());
            } catch { /* this strip has no barcode */ }
          }, 0);
        }
        stripTimer = window.setTimeout(decodeStrip, 280);
      };
      nativeTimer = window.setTimeout(tick, 40);
      stripTimer = window.setTimeout(decodeStrip, 120);
    };
    const readLabel = async () => {
      worker = await ocrReady.current;
      if (!worker) {
        try {
          worker = await createWorker('eng');
          await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
        } catch { return; }
      }
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
        drawLabel(source, ctx, canvas);
        try {
          await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789- ' });
          const found = await worker.recognize(canvas);
          const text = (found.data.text || '').replace(/\s+/g, ' ').trim();
          if (text && Date.now() - lastBeep.current.at > 800) setLive(text.slice(0, 72));
          if (labelWorthReading(text)) acceptLabel(text);
          else if (labelSeen.current && Date.now() - labelSeenAt.current > 480) labelSeen.current = '';
        } catch { /* this frame has no readable text */ }
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
      window.clearTimeout(stripTimer);
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
      {checking && <div className="scan-pending" data-testid="status-barcode-loading"><b className="scan-code">{checking}</b><span>{t('scan.checking')}</span></div>}
      {miss && <Miss key={miss} code={miss} onDone={() => setMiss('')}/>}
      {hits.map(lookup => <LookupView key={lookup.products.map(product => product.id).join('-')} lookup={lookup}/>)}
      {!checking && !miss && !hits.length && <p className="card scan-feed-empty" data-testid="status-scan-ready">{t('scan.feedEmpty')}</p>}
    </div>
  </>;
}
