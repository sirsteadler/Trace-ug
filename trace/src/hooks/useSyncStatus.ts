'use client';

/**
 * FR-RDR-012: connection state and queued action count are permanently
 * visible. A rider must be able to tell at a glance whether their work has
 * reached the office.
 */
import { useEffect, useState } from 'react';
import { startAutoSync, syncOnce, type SyncState } from '@/lib/sync/sync';
import { queueStats } from '@/lib/queue/queue';
import type { QueueStats } from '@/lib/queue/types';

const EMPTY: QueueStats = {
  pendingActions: 0,
  rejectedActions: 0,
  breadcrumbs: 0,
  quarantined: 0,
};

export function useSyncStatus(): {
  state: SyncState;
  stats: QueueStats;
  online: boolean;
  syncNow: () => void;
} {
  const [state, setState] = useState<SyncState>({ kind: 'idle' });
  const [stats, setStats] = useState<QueueStats>(EMPTY);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let alive = true;

    const refreshOnline = (): void => {
      if (alive) setOnline(navigator.onLine);
    };
    refreshOnline();
    window.addEventListener('online', refreshOnline);
    window.addEventListener('offline', refreshOnline);

    void queueStats().then((s) => {
      if (alive) setStats(s);
    });

    const stop = startAutoSync((next, s) => {
      if (!alive) return;
      setState(next);
      setStats(s);
    });

    return () => {
      alive = false;
      window.removeEventListener('online', refreshOnline);
      window.removeEventListener('offline', refreshOnline);
      stop();
    };
  }, []);

  return {
    state,
    stats,
    online,
    syncNow: () => {
      void syncOnce((next, s) => {
        setState(next);
        setStats(s);
      });
    },
  };
}
