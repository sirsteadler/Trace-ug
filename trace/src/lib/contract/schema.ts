/**
 * Runtime validation for every payload crossing a boundary.
 *
 * NFR-REL-003: "Data that has been on disk or on a wire is external data."
 * That explicitly includes records read back out of IndexedDB — a queue entry
 * written by an older build of the app is untrusted input on the way back in.
 *
 * CON-004 / NFR-MNT-001: `any` is prohibited. Parse `unknown` instead.
 */
import { z } from 'zod';
import {
  ACTOR_TYPES,
  CONFIRMATION_METHODS,
  DELIVERY_HEALTH,
  DELIVERY_STATUSES,
  FAILURE_REASONS,
} from './status';

export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export const actorTypeSchema = z.enum(ACTOR_TYPES);
export const confirmationMethodSchema = z.enum(CONFIRMATION_METHODS);
export const deliveryHealthSchema = z.enum(DELIVERY_HEALTH);
export const failureReasonSchema = z.enum(FAILURE_REASONS);

/**
 * A GPS fix. Bounds are checked rather than assumed: a device returning
 * lat 91 is a device we do not trust, and it must not reach geofence maths.
 */
export const positionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy_m: z.number().nonnegative().max(100_000),
  /** Device clock. Untrusted, but retained — FR-STM-014. */
  device_time: z.string().min(1),
  /** Android exposes this; absent elsewhere. FR-STM-007. */
  is_mock: z.boolean().optional(),
});
export type Position = z.infer<typeof positionSchema>;

export const confirmationSchema = z.object({
  method: confirmationMethodSchema,
  pin: z.string().regex(/^\d{6}$/).nullable(),
  artifact_ref: z.string().max(512).nullable(),
});
export type Confirmation = z.infer<typeof confirmationSchema>;

/** SRS §6.1.1 request body. */
export const transitionRequestSchema = z.object({
  delivery_id: z.uuid(),
  to_status: deliveryStatusSchema,
  idempotency_key: z.uuid(),
  device_time: z.string().min(1),
  position: positionSchema.nullable(),
  confirmation: confirmationSchema.nullable(),
  reason: failureReasonSchema.nullable(),
  note: z.string().max(500).nullable(),
  was_offline: z.boolean(),
});
export type TransitionRequest = z.infer<typeof transitionRequestSchema>;

/** SRS §6.1.1 success body. */
export const transitionResultSchema = z.object({
  delivery_id: z.uuid(),
  status: deliveryStatusSchema,
  event_id: z.number(),
  server_time: z.string(),
  health: deliveryHealthSchema.nullable(),
  anomalies: z.array(z.string()).default([]),
});
export type TransitionResult = z.infer<typeof transitionResultSchema>;

/**
 * The delivery as the rider sees it. Deliberately narrower than the table:
 * the rider never needs org_id, sap_document_id or the sender, so they are
 * not selected and cannot leak into the offline cache. NFR-PRV-004 in spirit.
 */
export const riderDeliverySchema = z.object({
  id: z.uuid(),
  trace_id: z.string(),
  status: deliveryStatusSchema,
  recipient_name: z.string(),
  recipient_phone: z.string(),
  pickup_address: z.string(),
  destination_address: z.string(),
  /** Null between creation and successful geocoding — SRS §3.2.1. */
  pickup_lat: z.number().nullable(),
  pickup_lng: z.number().nullable(),
  destination_lat: z.number().nullable(),
  destination_lng: z.number().nullable(),
  geofence_radius_m: z.number().int().positive(),
  item_description: z.string().nullable(),
  eta_at: z.string().nullable(),
  promised_at: z.string().nullable(),
  assigned_rider_id: z.uuid().nullable(),
  created_at: z.string(),
});
export type RiderDelivery = z.infer<typeof riderDeliverySchema>;

export const shiftSchema = z.object({
  id: z.uuid(),
  rider_id: z.uuid(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
});
export type Shift = z.infer<typeof shiftSchema>;

/** SRS §6.4 standard error envelope. */
export const errorEnvelopeSchema = z.object({
  error: z.string(),
  message: z.string(),
  detail: z.record(z.string(), z.unknown()).nullable().optional(),
  request_id: z.string().nullable().optional(),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/**
 * Parse without throwing. Callers must handle the failure branch explicitly —
 * NFR-REL-004. Returning a discriminated union makes forgetting a type error.
 */
export type ParseOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: string };

export function safeParse<T>(schema: z.ZodType<T>, input: unknown): ParseOutcome<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, issues };
}
