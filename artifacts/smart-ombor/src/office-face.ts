/** Face ID: TinyFaceDetector + 128-d recognition (CDN, npm kerak emas). */

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model';
const SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.min.js';

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
        detection: { box: { x: number; y: number; width: number; height: number } };
      }>>;
    };
  };
};

declare global {
  interface Window {
    faceapi?: FaceApiNs;
  }
}

export type FaceScanStatus = 'loading' | 'searching' | 'found' | 'recognized' | 'unknown' | 'multi' | 'error';

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

export async function detectFaceDescriptor(video: HTMLVideoElement): Promise<{
  status: Exclude<FaceScanStatus, 'loading' | 'recognized' | 'unknown'>;
  descriptor: number[] | null;
  box: { x: number; y: number; width: number; height: number } | null;
}> {
  await ensureFaceModels();
  const api = await faceApi();
  if (!video.videoWidth || video.readyState < 2) {
    return { status: 'searching', descriptor: null, box: null };
  }
  // 160 — telefonda 224 dan sezilarli tezroq; enroll uchun yetarli.
  const options = new api.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.4 });
  const detections = await api.detectAllFaces(video, options).withFaceLandmarks().withFaceDescriptors();
  if (!detections.length) return { status: 'searching', descriptor: null, box: null };
  if (detections.length > 1) return { status: 'multi', descriptor: null, box: null };
  const hit = detections[0]!;
  const descriptor = normalizeDescriptor(hit.descriptor);
  if (!descriptor) return { status: 'error', descriptor: null, box: null };
  const box = hit.detection.box;
  return {
    status: 'found',
    descriptor,
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
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
