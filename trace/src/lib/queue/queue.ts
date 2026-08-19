/**
 * IndexedDB action queue for the rider PWA.
 *
 * FR-OFF-002: every action is written here BEFORE any network attempt, and the
 * interface acknowledges from the local write. Behaviour is therefore identical
 * online and offline — which is the whole point of the module.
 *
 * FR-STM-010: replay is ordered by device time, ties broken by local sequence.
 * The device clock is untrusted for validity (FR-STM-014) but it is what
 * establishes the rider's intended order, so it is what we sort by.
 */
import { openDB, type IDBPDatabase } from 'idb';
import { safeParse } from '@/lib/contract/schema';
import {
  BREADCRUMB_THIN_TARGET,
  MAX_BREADCRUMBS,
  QUEUE_DB_NAME,
  QUEUE_DB_VERSION,
  STORE_ACTIONS,
  STORE_BREADCRUMBS,
  STORE_QUARANTINE,
  queuedActionSchema,
  queuedBreadcrumbSchema,
  type QueueStats,
  type QueuedAction,
  type QueuedBreadcrumb,
  type QuarantinedRecord,
} from './types';

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(QUEUE_DB_NAME, QUEUE_DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE_ACTIONS)) {
        const s = database.createObjectStore(STORE_ACTIONS, { keyPath: 'idempotency_key' });
        s.createIndex('by_seq', 'seq');
      }
      if (!database.objectStoreNames.contains(STORE_BREADCRUMBS)) {
        const s = database.createObjectStore(STORE_BREADCRUMBS, { keyPath: 'id' });
        s.createIndex('by_created', 'created_at');
      }
      if (!database.objectStoreNames.contains(STORE_QUARANTINE)) {
        database.createObjectStore(STORE_QUARANTINE, { keyPath: 'id' });
      }
    },
  });
  return dbPromise;
}

/** Test seam. Closes the handle so a fresh IndexedDB is picked up. */
export async function __resetQueueForTests(): Promise<void> {
  if (dbPromise) {
    const d = await dbPromise;
    d.close();
    dbPromise = null;
  }
}

async function nextSeq(database: IDBPDatabase): Promise<number> {
  const tx = database.transaction(STORE_ACTIONS, 'readonly');
  const idx = tx.store.index('by_seq');
  const cursor = await idx.openCursor(null, 'prev');
  const highest = cursor ? Number(cursor.value.seq) : -1;
  await tx.done;
  return Number.isFinite(highest) ? highest + 1 : 0;
}

/**
 * Quarantine a record that failed validation coming out of storage.
 * We do not delete it: a corrupt queue that silently empties itself is
 * indistinguishable from a queue that worked.
 */
async function quarantine(
  database: IDBPDatabase,
  store: string,
  id: string,
  issues: string,
  raw: unknown,
): Promise<void> {
  const record: QuarantinedRecord = {
    id: `${store}:${id}:${Date.now()}`,
    store,
    issues,
    raw: safeStringify(raw),
    quarantined_at: Date.now(),
  };
  const tx = database.transaction([store, STORE_QUARANTINE], 'readwrite');
  await tx.objectStore(STORE_QUARANTINE).put(record);
  await tx.objectStore(store).delete(id);
  await tx.done;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[unserialisable]';
  }
}

/** FR-OFF-002 / FR-OFF-003. Returns the stored action so the caller can render it. */
export async function enqueueAction(
  input: Omit<QueuedAction, 'seq' | 'created_at' | 'attempts' | 'last_error' | 'rejected'>,
): Promise<QueuedAction> {
  const database = await db();
  const action: QueuedAction = {
    ...input,
    seq: await nextSeq(database),
    created_at: Date.now(),
    attempts: 0,
    last_error: null,
    rejected: false,
  };
  const parsed = safeParse(queuedActionSchema, action);
  if (!parsed.ok) {
    // Refuse to store something we could never replay.
    throw new Error(`Refusing to queue malformed action: ${parsed.issues}`);
  }
  // put(), not add(): re-enqueueing the same idempotency key must be a no-op
  // overwrite rather than a throw. FR-STM-004 makes replay harmless anyway.
  await database.put(STORE_ACTIONS, parsed.value);
  return parsed.value;
}

/**
 * FR-STM-010: device-time ascending, local sequence as tiebreak.
 * Rejected actions are excluded from replay but retained (FR-OFF-007).
 */
export async function pendingActions(): Promise<readonly QueuedAction[]> {
  const database = await db();
  const raw = await database.getAll(STORE_ACTIONS);
  const valid: QueuedAction[] = [];

  for (const record of raw) {
    const parsed = safeParse(queuedActionSchema, record);
    if (parsed.ok) {
      valid.push(parsed.value);
    } else {
      const id = typeof record?.idempotency_key === 'string' ? record.idempotency_key : 'unknown';
      await quarantine(database, STORE_ACTIONS, id, parsed.issues, record);
    }
  }

  return valid
    .filter((a) => !a.rejected)
    .sort((a, b) => {
      const t = a.device_time.localeCompare(b.device_time);
      return t !== 0 ? t : a.seq - b.seq;
    });
}

/** FR-OFF-006: remove only after the server has acknowledged. */
export async function acknowledgeActions(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const database = await db();
  const tx = database.transaction(STORE_ACTIONS, 'readwrite');
  await Promise.all(keys.map((k) => tx.store.delete(k)));
  await tx.done;
}

/**
 * FR-OFF-007: a rejected batch is retained locally and surfaced, never
 * discarded silently. Marking rather than deleting keeps it inspectable.
 */
export async function markRejected(keys: readonly string[], reason: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(STORE_ACTIONS, 'readwrite');
  for (const key of keys) {
    const existing = await tx.store.get(key);
    if (!existing) continue;
    await tx.store.put({
      ...existing,
      rejected: true,
      attempts: Number(existing.attempts ?? 0) + 1,
      last_error: reason.slice(0, 300),
    });
  }
  await tx.done;
}

export async function rejectedActions(): Promise<readonly QueuedAction[]> {
  const database = await db();
  const raw = await database.getAll(STORE_ACTIONS);
  return raw
    .map((r) => safeParse(queuedActionSchema, r))
    .filter((p): p is { ok: true; value: QueuedAction } => p.ok)
    .map((p) => p.value)
    .filter((a) => a.rejected);
}

export async function clearRejected(): Promise<void> {
  const rejected = await rejectedActions();
  await acknowledgeActions(rejected.map((a) => a.idempotency_key));
}

/**
 * FR-OFF-008: bounded queue. Thinning drops the OLDEST breadcrumbs first and
 * touches nothing in the action store, so a long dead zone costs position
 * resolution and never costs a status transition or a proof reference.
 */
export async function enqueueBreadcrumb(crumb: QueuedBreadcrumb): Promise<void> {
  const parsed = safeParse(queuedBreadcrumbSchema, crumb);
  if (!parsed.ok) return; // A bad fix is dropped; it is not worth failing a shift over.

  const database = await db();
  await database.put(STORE_BREADCRUMBS, parsed.value);

  const count = await database.count(STORE_BREADCRUMBS);
  if (count <= MAX_BREADCRUMBS) return;

  const tx = database.transaction(STORE_BREADCRUMBS, 'readwrite');
  const idx = tx.store.index('by_created');
  let cursor = await idx.openCursor();
  let remaining = count - BREADCRUMB_THIN_TARGET;
  while (cursor && remaining > 0) {
    await cursor.delete();
    remaining -= 1;
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function takeBreadcrumbs(limit = 500): Promise<readonly QueuedBreadcrumb[]> {
  const database = await db();
  const raw = await database.getAll(STORE_BREADCRUMBS);
  const valid: QueuedBreadcrumb[] = [];
  for (const record of raw) {
    const parsed = safeParse(queuedBreadcrumbSchema, record);
    if (parsed.ok) valid.push(parsed.value);
    else {
      const id = typeof record?.id === 'string' ? record.id : 'unknown';
      await quarantine(database, STORE_BREADCRUMBS, id, parsed.issues, record);
    }
  }
  return valid.sort((a, b) => a.created_at - b.created_at).slice(0, limit);
}

export async function acknowledgeBreadcrumbs(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const database = await db();
  const tx = database.transaction(STORE_BREADCRUMBS, 'readwrite');
  await Promise.all(ids.map((id) => tx.store.delete(id)));
  await tx.done;
}

export async function queueStats(): Promise<QueueStats> {
  const database = await db();
  const actions = await database.getAll(STORE_ACTIONS);
  let pending = 0;
  let rejected = 0;
  for (const a of actions) {
    if (a?.rejected === true) rejected += 1;
    else pending += 1;
  }
  return {
    pendingActions: pending,
    rejectedActions: rejected,
    breadcrumbs: await database.count(STORE_BREADCRUMBS),
    quarantined: await database.count(STORE_QUARANTINE),
  };
}

/**
 * FR-AUT-008 / FR-OFF-010: going off shift clears sensitive local caches —
 * but only after successful synchronisation. The caller is responsible for
 * refusing to go off shift while `pendingActions()` is non-empty; this
 * function is the teardown itself and does not second-guess that decision.
 */
export async function purgeAll(): Promise<void> {
  const database = await db();
  const tx = database.transaction(
    [STORE_ACTIONS, STORE_BREADCRUMBS, STORE_QUARANTINE],
    'readwrite',
  );
  await Promise.all([
    tx.objectStore(STORE_ACTIONS).clear(),
    tx.objectStore(STORE_BREADCRUMBS).clear(),
    tx.objectStore(STORE_QUARANTINE).clear(),
  ]);
  await tx.done;
}
