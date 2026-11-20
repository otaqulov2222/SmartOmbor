/** Face ID: TinyFaceDetector + 128-d recognition (CDN, npm kerak emas). */

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model';
const SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.min.js';

type Point = { x: number; y: number };
type FaceApiNs = {
  nets: {
    tinyFaceDetector: { loadFromUri: (url: string) => Promise<void> };
    faceLandmark68Net: { loadFromUri: (url: string) => Promise<void> };
    faceRecognitionNet: { loadFromUri: (url: string) => Promise<void> };
  };
  TinyFaceDetectorOptions: new (opts: { inputSize: number; scoreThreshold: number }) => unknown;
  detectAllFaces: (input: HTMLVideoElement, options: unknown) => {
    withFaceLandmarks: () => {
      withFaceDescriptors: () => Promise<Array<{
        descriptor: Float32Array;
        detection: {
          score: number;
          box: { x: number; y: number; width: number; height: number };
        };
        landmarks: { positions: Point[] };
      }>>;
    };
  };
};

declare global {
  interface Window {
    faceapi?: FaceApiNs;
  }
}

export type FaceScanStatus =
  | 'loading'
  | 'searching'
  | 'found'
  | 'recognized'
  | 'unknown'
  | 'multi'
  | 'partial'
  | 'close'
  | 'far'
  | 'error';

let modelsReady = false;
let loading: Promise<FaceApiNs> | null = null;

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[data-face-api="1"]`) as HTMLScriptElement | null;
    if (existing && window.faceapi) {
      resolve();
      return;
    }
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('face-api')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.faceApi = '1';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('face-api'));
    document.head.appendChild(script);
  });
}

async function faceApi(): Promise<FaceApiNs> {
  if (window.faceapi?.nets) return window.faceapi;
  if (!loading) {
    loading = (async () => {
      await loadScript(SCRIPT_URL);
      const api = window.faceapi;
      if (!api?.nets) throw new Error('face-api');
      return api;
    })().catch((error) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}

export async function ensureFaceModels() {
  if (modelsReady) return;
  const api = await faceApi();
  await Promise.all([
    api.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    api.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    api.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]);
  modelsReady = true;
}

function normalizeDescriptor(raw: Float32Array | number[] | null | undefined): number[] | null {
  if (!raw || raw.length !== 128) return null;
  const out: number[] = [];
  for (let i = 0; i < 128; i += 1) {
    const value = Number(raw[i]);
    if (!Number.isFinite(value)) return null;
    out.push(Math.round(value * 1e6) / 1e6);
  }
  return out;
}

function avgPoint(points: Point[], from: number, to: number): Point {
  let x = 0;
  let y = 0;
  const n = to - from + 1;
  for (let i = from; i <= to; i += 1) {
    x += points[i]!.x;
    y += points[i]!.y;
  }
  return { x: x / n, y: y / n };
}

export type FaceQualityResult =
  | { ok: true }
  | { ok: false; reason: 'partial' | 'close' | 'far' };

/**
 * Oval ichida to‘liq yuz: peshona→iyak, markazda, ortacha masofa.
 * Juda yaqin (kesilgan) yoki juda uzoq (kichik) — rad.
 */
export function faceQualityCheck(
  box: { x: number; y: number; width: number; height: number },
  score: number,
  landmarks: Point[] | undefined,
  videoW: number,
  videoH: number,
): FaceQualityResult {
  if (!Number.isFinite(score) || score < 0.55) return { ok: false, reason: 'partial' };
  if (!videoW || !videoH) return { ok: false, reason: 'partial' };
  const minSide = Math.min(videoW, videoH);
  const faceRatio = box.height / minSide;

  // Juda yaqin — yuz ovaldan chiqib ketadi / qora hoshiya.
  if (faceRatio > 0.78 || box.width > minSide * 0.78) return { ok: false, reason: 'close' };
  // Juda uzoq — kichkina nuqta.
  if (faceRatio < 0.28 || box.width < minSide * 0.22) return { ok: false, reason: 'far' };

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // Markaziy oval zonasi (viewport object-position bilan mos).
  if (cx < videoW * 0.18 || cx > videoW * 0.82) return { ok: false, reason: 'partial' };
  if (cy < videoH * 0.22 || cy > videoH * 0.62) return { ok: false, reason: 'partial' };
  if (box.y < videoH * 0.04 || box.y + box.height > videoH * 0.82) return { ok: false, reason: 'partial' };

  if (!landmarks || landmarks.length < 68) return { ok: false, reason: 'partial' };
  const leftEye = avgPoint(landmarks, 36, 41);
  const rightEye = avgPoint(landmarks, 42, 47);
  const nose = landmarks[30]!;
  const chin = landmarks[8]!;
  const mouth = avgPoint(landmarks, 48, 54);
  const eyeY = (leftEye.y + rightEye.y) / 2;
  const eyeSpan = Math.abs(rightEye.x - leftEye.x);
  if (eyeSpan < box.width * 0.18) return { ok: false, reason: 'partial' };

  const rel = (y: number) => (y - box.y) / Math.max(1, box.height);
  const eyeR = rel(eyeY);
  const noseR = rel(nose.y);
  const mouthR = rel(mouth.y);
  const chinR = rel(chin.y);
  if (eyeR < 0.10 || eyeR > 0.52) return { ok: false, reason: 'partial' };
  if (noseR < 0.26 || noseR > 0.70) return { ok: false, reason: 'partial' };
  if (mouthR < 0.46 || mouthR > 0.90) return { ok: false, reason: 'partial' };
  if (chinR < 0.72 || chinR > 1.15) return { ok: false, reason: 'partial' };
  if (!(eyeY < nose.y && nose.y < mouth.y && mouth.y < chin.y)) return { ok: false, reason: 'partial' };
  return { ok: true };
}

/** @deprecated — faceQualityCheck ishlating */
export function faceQualityOk(
  box: { x: number; y: number; width: number; height: number },
  score: number,
  landmarks: Point[] | undefined,
  videoW: number,
  videoH: number,
): boolean {
  return faceQualityCheck(box, score, landmarks, videoW, videoH).ok;
}

export async function detectFaceDescriptor(video: HTMLVideoElement): Promise<{
  status: Exclude<FaceScanStatus, 'loading' | 'recognized' | 'unknown'>;
  descriptor: number[] | null;
  box: { x: number; y: number; width: number; height: number } | null;
  score: number;
}> {
  await ensureFaceModels();
  const api = await faceApi();
  if (!video.videoWidth || video.readyState < 2) {
    return { status: 'searching', descriptor: null, box: null, score: 0 };
  }
  // 320 — telefon selfie uchun barqarorroq framing.
  const options = new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  const detections = await api.detectAllFaces(video, options).withFaceLandmarks().withFaceDescriptors();
  if (!detections.length) return { status: 'searching', descriptor: null, box: null, score: 0 };
  if (detections.length > 1) return { status: 'multi', descriptor: null, box: null, score: 0 };
  const hit = detections[0]!;
  const box = hit.detection.box;
  const score = Number(hit.detection.score) || 0;
  const positions = hit.landmarks?.positions;
  const quality = faceQualityCheck(
    { x: box.x, y: box.y, width: box.width, height: box.height },
    score,
    positions,
    video.videoWidth,
    video.videoHeight,
  );
  if (!quality.ok) {
    return {
      status: quality.reason,
      descriptor: null,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      score,
    };
  }
  const descriptor = normalizeDescriptor(hit.descriptor);
  if (!descriptor) return { status: 'error', descriptor: null, box: null, score };
  return {
    status: 'found',
    descriptor,
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    score,
  };
}

export function euclidean(a: number[], b: number[]) {
  if (a.length !== b.length) return 99;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export function bestDistance(probe: number[], gallery: number[][]) {
  let best = 99;
  for (const item of gallery) {
    const d = euclidean(probe, item);
    if (d < best) best = d;
  }
  return best;
}
