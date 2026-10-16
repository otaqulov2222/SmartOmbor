import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

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
        await cache.invalidateQueries({ predicate: q => q.queryKey[0] !== AUTO_REFRESH_KEY[0] });
      } finally {
        stamp(false, new Date().toISOString());
        inflight.current = false;
      }
    };

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
