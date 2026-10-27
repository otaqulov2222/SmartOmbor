import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSyncMoysklad } from '@workspace/api-client-react';

export const AUTO_REFRESH_MS = 5 * 60 * 1000;
export const AUTO_REFRESH_KEY = ['auto-refresh'] as const;
const KEEP_DURING_CATALOG_SYNC = new Set(['auto-refresh', 'partner-detail', 'partner-factories', 'partner-alerts']);

function keepDuringCatalogSync(queryKey: readonly unknown[]) {
  return KEEP_DURING_CATALOG_SYNC.has(String(queryKey[0] ?? ''));
}

export type AutoRefreshState = { pending: boolean; last: string | null; nextAt: number };

type SyncState = { running?: boolean; lastSync?: string | null; error?: string | null };

function stampOf(value: string | Date | null | undefined) {
  if (!value) return 0;
  const time = typeof value === 'string' ? Date.parse(value) : value.getTime();
  return Number.isFinite(time) ? time : 0;
}

async function waitForCatalogSync(prevLastSync: string | Date | null | undefined) {
  const prev = stampOf(prevLastSync);
  for (let i = 0; i < 90; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const response = await fetch('/api/moysklad/sync').catch(() => null);
    if (!response || response.status === 404) return;
    const state = response.ok ? await response.json().catch(() => null) as SyncState | null : null;
    if (!state || state.running) continue;
    const last = stampOf(state.lastSync);
    if (state.error && last <= prev) throw new Error(state.error);
    return;
  }
}

export function useCatalogRefresh() {
  const cache = useQueryClient();
  const sync = useSyncMoysklad();
  const [waiting, setWaiting] = useState(false);
  const [pollError, setPollError] = useState<Error | null>(null);

  const refresh = () => {
    setPollError(null);
    setWaiting(true);
    sync.mutate(undefined, {
      onSettled: async (data, error) => {
        try {
          if (!error && data?.status === 'running') await waitForCatalogSync(data.finishedAt);
          if (!error && data?.error !== 'already-fresh') {
            await cache.invalidateQueries({ predicate: q => !keepDuringCatalogSync(q.queryKey) });
          }
        } catch (caught) {
          setPollError(caught instanceof Error ? caught : new Error('sync'));
        } finally {
          setWaiting(false);
        }
      },
    });
  };

  return {
    refresh,
    pending: sync.isPending || waiting,
    isError: Boolean(pollError) || (sync.isError && !waiting),
    error: pollError ?? (sync.error instanceof Error ? sync.error : null),
    isSuccess: sync.isSuccess && !waiting && !pollError,
    data: sync.data,
  };
}

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
        const response = await fetch('/api/moysklad/sync', { method: 'POST' }).catch(() => undefined);
        const body = response && response.ok ? await response.json().catch(() => null) as { status?: string; finishedAt?: string | null; error?: string | null } | null : null;
        if (body?.status === 'running') await waitForCatalogSync(body.finishedAt).catch(() => undefined);
        if (body && body.error !== 'already-fresh') {
          await cache.invalidateQueries({ predicate: q => !keepDuringCatalogSync(q.queryKey) });
        }
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
