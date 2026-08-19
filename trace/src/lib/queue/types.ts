/**
 * Offline action queue types. SRS §5.5, FR-OFF-001 … FR-OFF-010.
 */
import { z } from 'zod';
import { transitionRequestSchema, positionSchema } from '@/lib/contract/schema';

export const QUEUE_DB_NAME = 'trace-rider';
export const QUEUE_DB_VERSION = 1;
export const STORE_ACTIONS = 'actions';
export const STORE_BREADCRUMBS = 'breadcrumbs';
export const STORE_QUARANTINE = 'quarantine';

/**
 * FR-OFF-008: the queue is bounded. On reaching the cap, breadcrumbs are
 * thinned oldest-first while status transitions and proof references are
 * preserved without exception.
 */
export const MAX_BREADCRUMBS = 2000;
export const BREADCRUMB_THIN_TARGET = 1200;

export const queuedActionSchema = z.object({
  /** Primary key. Doubles as the server idempotency key — FR-OFF-003. */
  idempotency_key: z.uuid(),
  /** Monotonic local sequence. Ties are broken by this, never by device clock. */
  seq: z.number().int().nonnegative(),
  request: transitionRequestSchema,
  /** ISO device time, denormalised for ordered replay — FR-STM-010. */
  device_time: z.string().min(1),
  created_at: z.number(),
  attempts: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  /** Set when the server rejected the batch this action belonged to. */
  rejected: z.boolean(),
});
export type QueuedAction = z.infer<typeof queuedActionSchema>;

export const queuedBreadcrumbSchema = z.object({
  id: z.string(),
  delivery_id: z.uuid().nullable(),
  shift_id: z.uuid(),
  position: positionSchema,
  created_at: z.number(),
});
export type QueuedBreadcrumb = z.infer<typeof queuedBreadcrumbSchema>;

/**
 * A record that failed validation on the way out of IndexedDB. Kept rather
 * than deleted so a corrupt queue is diagnosable, but never replayed.
 * NFR-REL-003.
 */
export interface QuarantinedRecord {
  readonly id: string;
  readonly store: string;
  readonly issues: string;
  readonly raw: string;
  readonly quarantined_at: number;
}

export interface QueueStats {
  readonly pendingActions: number;
  readonly rejectedActions: number;
  readonly breadcrumbs: number;
  readonly quarantined: number;
}
