/**
 * Agent jonli GPS — kabinetga bog‘liq emas.
 * Agent tizimga login qilgan bo‘lsa (har qanday sahifa) admin /gps da kuzatadi.
 */
import { useEffect, useRef } from 'react';
import { kpiFetch } from './api';

export type LiveGpsCoords = {
  lat: number;
  lng: number;
  accuracy: number;
  heading: number | null;
  speed: number | null;
};

type Props = {
  /** staff session (asosiy tizim) yoki /agent token */
  mode?: 'admin' | 'agent';
  enabled?: boolean;
  onCoords?: (coords: LiveGpsCoords | null) => void;
  onHint?: (hint: string | null) => void;
};

export function AgentLiveGpsTracker({
  mode = 'admin',
  enabled = true,
  onCoords,
  onHint,
}: Props) {
  const onCoordsRef = useRef(onCoords);
  const onHintRef = useRef(onHint);
  onCoordsRef.current = onCoords;
  onHintRef.current = onHint;

  useEffect(() => {
    if (!enabled) return;
    if (!navigator.geolocation) {
      onHintRef.current?.('Telefon GPS qo‘llab-quvvatlamaydi.');
      return;
    }

    let lastPosted = 0;
    let locked: (LiveGpsCoords & { at: number }) | null = null;
    let wakeLock: { release: () => Promise<void> } | null = null;
    let leftSent = false;

    const NOISE_M = 0.45;
    const STEP_M = 0.7;
    // Server 120 m gacha qabul qiladi; telefon ichida GPS ko‘pincha 40–90 m
    const BAD_ACC_M = 110;
    const rad = (n: number) => (n * Math.PI) / 180;
    const distM = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
      const dLat = rad(b.lat - a.lat);
      const dLng = rad(b.lng - a.lng);
      const x =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
      return 2 * 6371000 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    };

    const postLoc = (payload: {
      lat: number;
      lng: number;
      accuracy: number;
      heading?: number | null;
      source: string;
    }) =>
      kpiFetch(
        '/kpi/agent/location',
        {
          method: 'POST',
          body: JSON.stringify(payload),
          keepalive: payload.source === 'leave',
        },
        mode,
      ).catch(() => undefined);

    const onGpsFail = () => {
      onHintRef.current?.('GPS ruxsati yo‘q yoki o‘chiq. Sozlamadan GPS ni yoqing.');
    };

    const sendLoc = (pos: GeolocationPosition) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = Number(pos.coords.accuracy);
      const speed =
        pos.coords.speed != null && Number.isFinite(pos.coords.speed) ? Math.max(0, pos.coords.speed) : null;
      const rawHeading =
        pos.coords.heading != null && Number.isFinite(pos.coords.heading) && pos.coords.heading >= 0
          ? pos.coords.heading
          : null;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      if (!Number.isFinite(accuracy) || accuracy <= 0) return;
      if (accuracy > BAD_ACC_M && locked && locked.accuracy + 10 < accuracy) return;

      const moved = locked ? distM(locked, { lat, lng }) : Infinity;
      const speedWalk = speed != null && speed >= 0.25;
      const walking = speedWalk || moved >= STEP_M;

      if (locked && !walking && moved < NOISE_M) {
        if (accuracy + 0.5 < locked.accuracy) {
          locked = { ...locked, accuracy, at: Date.now() };
          onCoordsRef.current?.({
            lat: locked.lat,
            lng: locked.lng,
            accuracy: locked.accuracy,
            heading: null,
            speed: 0,
          });
        }
        onHintRef.current?.(null);
        return;
      }

      if (locked && !speedWalk && moved < 1.5 && accuracy > locked.accuracy + 30) {
        onHintRef.current?.(null);
        return;
      }

      const next: LiveGpsCoords = {
        lat,
        lng,
        accuracy,
        heading: walking ? rawHeading : null,
        speed: speedWalk ? speed : walking ? Math.max(speed ?? 0, 0.5) : 0,
      };
      locked = { ...next, at: Date.now() };
      onHintRef.current?.(null);
      onCoordsRef.current?.(next);

      const now = Date.now();
      // Birinchi nuqta darhol; keyin yurishda 3s, turganda 8s
      const postEvery = lastPosted === 0 ? 0 : walking ? 3_000 : 8_000;
      if (now - lastPosted < postEvery) return;
      lastPosted = now;
      void postLoc({
        lat: next.lat,
        lng: next.lng,
        accuracy: next.accuracy,
        heading: next.heading,
        source: 'live',
      });
    };

    navigator.geolocation.getCurrentPosition(sendLoc, onGpsFail, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 0,
    });
    const watchId = navigator.geolocation.watchPosition(sendLoc, onGpsFail, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000,
    });

    const requestWake = async () => {
      try {
        const navAny = navigator as Navigator & {
          wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
        };
        if (!navAny.wakeLock) return;
        wakeLock = await navAny.wakeLock.request('screen');
      } catch {
        /* ignore */
      }
    };
    void requestWake();

    // Ekran ochiq bo‘lsa har 12s heartbeat — admin "uzilgan" deb ko‘rmasin
    const heartbeat = window.setInterval(() => {
      if (!locked) return;
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastPosted < 12_000) return;
      lastPosted = now;
      void postLoc({
        lat: locked.lat,
        lng: locked.lng,
        accuracy: locked.accuracy,
        heading: locked.heading,
        source: 'heartbeat',
      });
    }, 12_000);

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void requestWake();
      navigator.geolocation.getCurrentPosition(sendLoc, onGpsFail, {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 0,
      });
    };

    const sendLeave = () => {
      if (leftSent || !locked) return;
      leftSent = true;
      void postLoc({
        lat: locked.lat,
        lng: locked.lng,
        accuracy: locked.accuracy,
        heading: locked.heading,
        source: 'leave',
      });
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', sendLeave);
    window.addEventListener('beforeunload', sendLeave);

    return () => {
      navigator.geolocation.clearWatch(watchId);
      window.clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', sendLeave);
      window.removeEventListener('beforeunload', sendLeave);
      sendLeave();
      void wakeLock?.release().catch(() => undefined);
    };
  }, [enabled, mode]);

  return null;
}
