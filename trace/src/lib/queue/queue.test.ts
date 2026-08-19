import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetQueueForTests,
  acknowledgeActions,
  enqueueAction,
  enqueueBreadcrumb,
  markRejected,
  pendingActions,
  purgeAll,
  queueStats,
  rejectedActions,
  takeBreadcrumbs,
} from './queue';
import { MAX_BREADCRUMBS, type QueuedAction } from './types';
import type { TransitionRequest } from '@/lib/contract/schema';

const DELIVERY = '11111111-1111-4111-8111-111111111111';
const SHIFT = '22222222-2222-4222-8222-222222222222';

function uuid(n: number): string {
  const h = n.toString(16).padStart(12, '0');
  return `33333333-3333-4333-8333-${h}`;
}

function request(over: Partial<TransitionRequest> = {}): TransitionRequest {
  return {
    delivery_id: DELIVERY,
    to_status: 'PICKED_UP',
    idempotency_key: uuid(1),
    device_time: '2026-08-19T10:00:00.000Z',
    position: { lat: 0.3476, lng: 32.5825, accuracy_m: 9, device_time: '2026-08-19T10:00:00.000Z' },
    confirmation: null,
    reason: null,
    note: null,
    was_offline: true,
    ...over,
  };
}

function action(key: string, deviceTime: string): Omit<QueuedAction, 'seq' | 'created_at' | 'attempts' | 'last_error' | 'rejected'> {
  return {
    idempotency_key: key,
    request: request({ idempotency_key: key, device_time: deviceTime }),
    device_time: deviceTime,
  };
}

beforeEach(async () => {
  await __resetQueueForTests();
  // fake-indexeddb persists across tests in a file; clear explicitly.
  await purgeAll();
});

describe('action queue ordering — FR-STM-010', () => {
  it('replays in device-time order regardless of insertion order', async () => {
    await enqueueAction(action(uuid(3), '2026-08-19T10:00:30.000Z'));
    await enqueueAction(action(uuid(1), '2026-08-19T10:00:10.000Z'));
    await enqueueAction(action(uuid(2), '2026-08-19T10:00:20.000Z'));

    const pending = await pendingActions();
    expect(pending.map((a) => a.device_time)).toEqual([
      '2026-08-19T10:00:10.000Z',
      '2026-08-19T10:00:20.000Z',
      '2026-08-19T10:00:30.000Z',
    ]);
  });

  it('breaks identical device times by local sequence, not arbitrarily', async () => {
    const t = '2026-08-19T10:00:00.000Z';
    await enqueueAction(action(uuid(10), t));
    await enqueueAction(action(uuid(11), t));
    await enqueueAction(action(uuid(12), t));

    const pending = await pendingActions();
    expect(pending.map((a) => a.idempotency_key)).toEqual([uuid(10), uuid(11), uuid(12)]);
    expect(pending.map((a) => a.seq)).toEqual([0, 1, 2]);
  });

  it('survives a device clock that runs backwards — FR-STM-014', async () => {
    await enqueueAction(action(uuid(1), '2026-08-19T10:00:00.000Z'));
    await enqueueAction(action(uuid(2), '2026-08-19T09:59:00.000Z'));

    const pending = await pendingActions();
    // Sorted by the rider's clock as recorded. The server annotates skew; the
    // queue does not silently reorder or drop the earlier-stamped action.
    expect(pending).toHaveLength(2);
    expect(pending[0]?.device_time).toBe('2026-08-19T09:59:00.000Z');
  });
});

describe('idempotency — FR-OFF-003, FR-STM-004', () => {
  it('re-enqueueing the same key overwrites rather than duplicating', async () => {
    await enqueueAction(action(uuid(1), '2026-08-19T10:00:00.000Z'));
    await enqueueAction(action(uuid(1), '2026-08-19T10:00:00.000Z'));

    expect(await pendingActions()).toHaveLength(1);
  });

  it('refuses to store an action that could never be replayed', async () => {
    await expect(
      enqueueAction({
        idempotency_key: 'not-a-uuid',
        request: request(),
        device_time: '2026-08-19T10:00:00.000Z',
      }),
    ).rejects.toThrow(/malformed/i);
  });
});

describe('acknowledgement — FR-OFF-006', () => {
  it('removes only after the server acknowledges', async () => {
    await enqueueAction(action(uuid(1), '2026-08-19T10:00:00.000Z'));
    await enqueueAction(action(uuid(2), '2026-08-19T10:00:01.000Z'));

    expect(await pendingActions()).toHaveLength(2);
    await acknowledgeActions([uuid(1)]);

    const pending = await pendingActions();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.idempotency_key).toBe(uuid(2));
  });
});

describe('rejection — FR-OFF-007', () => {
  it('retains a rejected batch and excludes it from replay', async () => {
    await enqueueAction(action(uuid(1), '2026-08-19T10:00:00.000Z'));
    await enqueueAction(action(uuid(2), '2026-08-19T10:00:01.000Z'));

    await markRejected([uuid(1), uuid(2)], 'CHAIN_CONFLICT: cancelled by dispatch');

    expect(await pendingActions()).toHaveLength(0);
    const rejected = await rejectedActions();
    expect(rejected).toHaveLength(2);
    expect(rejected[0]?.last_error).toContain('CHAIN_CONFLICT');
    expect(rejected[0]?.attempts).toBe(1);
  });
});

describe('bounded queue — FR-OFF-008', () => {
  it('thins breadcrumbs oldest-first and never touches transitions', async () => {
    await enqueueAction(action(uuid(1), '2026-08-19T10:00:00.000Z'));

    for (let i = 0; i < MAX_BREADCRUMBS + 50; i += 1) {
      await enqueueBreadcrumb({
        id: `crumb-${String(i).padStart(5, '0')}`,
        delivery_id: DELIVERY,
        shift_id: SHIFT,
        position: {
          lat: 0.3476,
          lng: 32.5825,
          accuracy_m: 9,
          device_time: new Date(1_760_000_000_000 + i * 1000).toISOString(),
        },
        created_at: 1_760_000_000_000 + i * 1000,
      });
    }

    const stats = await queueStats();
    expect(stats.breadcrumbs).toBeLessThanOrEqual(MAX_BREADCRUMBS);
    // The transition survived the thinning without exception.
    expect(stats.pendingActions).toBe(1);

    const crumbs = await takeBreadcrumbs(5);
    // Oldest were dropped, so the survivors do not start at index 0.
    expect(crumbs[0]?.id).not.toBe('crumb-00000');
  });
});

describe('corrupt records — NFR-REL-003', () => {
  it('quarantines an unparseable record instead of replaying or vanishing it', async () => {
    const { openDB } = await import('idb');
    const raw = await openDB('trace-rider', 1);
    await raw.put('actions', {
      idempotency_key: uuid(9),
      seq: 'not-a-number',
      request: { nonsense: true },
      device_time: '2026-08-19T10:00:00.000Z',
      created_at: Date.now(),
      attempts: 0,
      last_error: null,
      rejected: false,
    });
    raw.close();

    const pending = await pendingActions();
    expect(pending).toHaveLength(0);

    const stats = await queueStats();
    expect(stats.quarantined).toBe(1);
  });
});

describe('teardown — FR-AUT-008', () => {
  it('purges every store', async () => {
    await enqueueAction(action(uuid(1), '2026-08-19T10:00:00.000Z'));
    await enqueueBreadcrumb({
      id: 'c1', delivery_id: DELIVERY, shift_id: SHIFT,
      position: { lat: 0, lng: 32, accuracy_m: 5, device_time: '2026-08-19T10:00:00.000Z' },
      created_at: Date.now(),
    });

    await purgeAll();
    const stats = await queueStats();
    expect(stats).toEqual({ pendingActions: 0, rejectedActions: 0, breadcrumbs: 0, quarantined: 0 });
  });
});
