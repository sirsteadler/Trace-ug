/**
 * Reconnection sync. SRS §5.5, FR-OFF-005 … FR-OFF-007.
 *
 * The rider app writes locally first and syncs second (FR-OFF-002), so this
 * module is the only place that talks to the server about queued work. It is
 * deliberately not a React concern: it runs whether or not a screen is mounted.
 */
import {
  acknowledgeActions,
  markRejected,
  pendingActions,
  queueStats,
} from '@/lib/queue/queue';
import type { QueueStats } from '@/lib/queue/types';
import { replayBatch } from '@/lib/supabase/rpc';
import { TraceError } from '@/lib/contract';

export type SyncState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'syncing'; readonly total: number }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'offline' };

export type SyncListener = (state: SyncState, stats: QueueStats) => void;

function uuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

let running = false;

/**
 * Replays the queue once. Safe to call concurrently — the guard makes the
 * second caller a no-op rather than double-submitting, and idempotency keys
 * make even a lost guard harmless (FR-STM-004).
 */
export async function syncOnce(notify?: SyncListener): Promise<SyncState> {
  if (running) return { kind: 'syncing', total: 0 };
  running = true;

  const emit = async (state: SyncState): Promise<SyncState> => {
    if (notify) notify(state, await queueStats());
    return state;
  };

  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return await emit({ kind: 'offline' });
    }

    const pending = await pendingActions();
    if (pending.length === 0) return await emit({ kind: 'idle' });

    await emit({ kind: 'syncing', total: pending.length });

    const outcome = await replayBatch(
      uuid(),
      pending.map((a) => a.request),
    );

    if (outcome.rejected) {
      // FR-OFF-007: retained, surfaced, never silently discarded.
      await markRejected(outcome.rejected.keys, outcome.rejected.reason);
      return await emit({ kind: 'blocked', reason: outcome.rejected.reason });
    }

    // FR-OFF-006: remove only what the server acknowledged. Anything it did
    // not acknowledge stays queued and is retried — made harmless by the
    // idempotency key it already carries.
    await acknowledgeActions(outcome.committed);
    return await emit({ kind: 'idle' });
  } catch (error) {
    if (error instanceof TraceError && error.retryable) {
      return await emit({ kind: 'offline' });
    }
    const reason = error instanceof TraceError ? error.message : 'Sync failed. Your work is saved.';
    return await emit({ kind: 'blocked', reason });
  } finally {
    running = false;
  }
}

/**
 * Replay on reconnection and on a slow heartbeat. The heartbeat exists because
 * `online` does not fire when a captive portal or a dead cell tower silently
 * eats traffic — the browser still believes it is online.
 */
export function startAutoSync(notify?: SyncListener, heartbeatMs = 30_000): () => void {
  if (typeof window === 'undefined') return () => {};

  const run = (): void => {
    void syncOnce(notify);
  };

  window.addEventListener('online', run);
  const timer = setInterval(run, heartbeatMs);
  run();

  return () => {
    window.removeEventListener('online', run);
    clearInterval(timer);
  };
}
