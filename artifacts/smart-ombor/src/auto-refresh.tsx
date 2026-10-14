import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { clearCatalogDump } from '@/lib/report';

export const AUTO_REFRESH_MS = 10 * 60 * 1000;
export const AUTO_REFRESH_KEY = ['auto-refresh'] as const;

export type AutoRefreshState = { pending: boolean; last: string | null; nextAt: number };

export function AutoRefresh() {
  const cache = useQueryClient();
  const inflight = useRef(false);

  useEffect(() => {
    const stamp = (pending: boolean, last: string | null) => {
      cache.setQueryData<AutoRefreshState>(AUTO_REFRESH_KEY, {
        pending,
        last,
        nextAt: Date.now() + AUTO_REFRESH_MS,
      });
    };
    stamp(false, null);

    const run = async () => {
      if (inflight.current || document.hidden) return;
      inflight.current = true;
      stamp(true, cache.getQueryData<AutoRefreshState>(AUTO_REFRESH_KEY)?.last ?? null);
      try {
        const r = await fetch('/api/moysklad/sync', { method: 'POST' });
        if (r.ok) clearCatalogDump();
      } catch { /* the screen still reloads the latest saved data */ }
      try {
        await cache.invalidateQueries({ predicate: q => q.queryKey[0] !== AUTO_REFRESH_KEY[0] });
      } finally {
        stamp(false, new Date().toISOString());
        inflight.current = false;
      }
    };

    const arm = async () => {
      try {
        const response = await fetch('/api/dashboard');
        if (!response.ok) throw new Error('dashboard');
        const body = await response.json() as { lastSync?: string | null };
        const age = body.lastSync ? Date.now() - new Date(body.lastSync).getTime() : AUTO_REFRESH_MS;
        if (age >= AUTO_REFRESH_MS) void run();
      } catch {
        void run();
      }
    };
    void arm();
    const id = window.setInterval(() => void run(), AUTO_REFRESH_MS);
    const onVis = () => {
      const state = cache.getQueryData<AutoRefreshState>(AUTO_REFRESH_KEY);
      if (!document.hidden && state && Date.now() >= state.nextAt) void run();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [cache]);

  return null;
}
