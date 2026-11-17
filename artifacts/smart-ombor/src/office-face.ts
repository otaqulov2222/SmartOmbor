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

/** To‘liq yuz: oval ichida, yetarli o‘lcham, ko‘z–burun–og‘iz joylashuvi. */
export function faceQualityOk(
  box: { x: number; y: number; width: number; height: number },
  score: number,
  landmarks: Point[] | undefined,
  videoW: number,
  videoH: number,
): boolean {
  if (!Number.isFinite(score) || score < 0.58) return false;
  if (!videoW || !videoH) return false;
  const minSide = Math.min(videoW, videoH);
  // Peshona/fragment — kichik yoki juda yuqori box.
  if (box.width < minSide * 0.24 || box.height < minSide * 0.30) return false;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // Oval zonasi (markaz, biroz yuqoriroq).
  if (cx < videoW * 0.20 || cx > videoW * 0.80) return false;
  if (cy < videoH * 0.18 || cy > videoH * 0.58) return false;
  // Box ovalga sig‘ishi kerak — juda past/yuqori emas.
  if (box.y < videoH * 0.02 || box.y + box.height > videoH * 0.78) return false;

  if (!landmarks || landmarks.length < 68) return false;
  const leftEye = avgPoint(landmarks, 36, 41);
  const rightEye = avgPoint(landmarks, 42, 47);
  const nose = landmarks[30]!;
  const chin = landmarks[8]!;
  const mouth = avgPoint(landmarks, 48, 54);
  const eyeY = (leftEye.y + rightEye.y) / 2;
  const eyeSpan = Math.abs(rightEye.x - leftEye.x);
  if (eyeSpan < box.width * 0.22) return false;

  const rel = (y: number) => (y - box.y) / Math.max(1, box.height);
  const eyeR = rel(eyeY);
  const noseR = rel(nose.y);
  const mouthR = rel(mouth.y);
  const chinR = rel(chin.y);
  // To‘liq yuz: ko‘zlar yuqorida, og‘iz/chin pastda. Faqat peshona bo‘lsa chin pastga tushmaydi.
  if (eyeR < 0.12 || eyeR > 0.48) return false;
  if (noseR < 0.28 || noseR > 0.68) return false;
  if (mouthR < 0.48 || mouthR > 0.88) return false;
  if (chinR < 0.78 || chinR > 1.12) return false;
  if (!(eyeY < nose.y && nose.y < mouth.y && mouth.y < chin.y)) return false;
  return true;
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
  const options = new api.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.55 });
  const detections = await api.detectAllFaces(video, options).withFaceLandmarks().withFaceDescriptors();
  if (!detections.length) return { status: 'searching', descriptor: null, box: null, score: 0 };
  if (detections.length > 1) return { status: 'multi', descriptor: null, box: null, score: 0 };
  const hit = detections[0]!;
  const box = hit.detection.box;
  const score = Number(hit.detection.score) || 0;
  const positions = hit.landmarks?.positions;
  if (!faceQualityOk(
    { x: box.x, y: box.y, width: box.width, height: box.height },
    score,
    positions,
    video.videoWidth,
    video.videoHeight,
  )) {
    return {
      status: 'partial',
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
