/**
 * Delivery status vocabulary and the state machine transition table.
 *
 * SRS v1.1 §3.3, §4.1, §4.2.
 *
 * NFR-MNT-003: this table exists in EXACTLY ONE place. The client imports it to
 * decide which action to offer; the server guard in
 * supabase/migrations/0004_transition_fn.sql mirrors it. Two hand-maintained
 * copies will diverge, so the SQL is generated from this file by
 * `scripts/generate-transition-sql.ts` rather than typed out again.
 *
 * CON-002: the client may only *request* a transition. Anything this table
 * permits is still independently re-checked server side.
 */

export const DELIVERY_STATUSES = [
  'CREATED',
  'ASSIGNED',
  'ACCEPTED',
  'AT_PICKUP',
  'PICKED_UP',
  'IN_TRANSIT',
  'ARRIVED',
  'DELIVERED',
  'CONFIRMED',
  'FAILED',
  'RETURNED',
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const ACTOR_TYPES = ['rider', 'admin', 'recipient', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * SRS v1.0 §5.4. The ladder is THREE tiers:
 *
 *   Tier 1  recipient_tap        — the recipient taps Received in the tracking
 *                                  link or installed app. FR-CNF-001.
 *   Tier 2  pin_entry            — server SMSes an OTP on ARRIVED; the recipient
 *                                  reads it aloud; the rider enters it.
 *   Tier 3  signature|photograph — the rider's account of the handover, used
 *                                  when the recipient is absent or unreachable.
 *
 * The two-tier reading withdrew `recipient_tap`, which is the tier the brief
 * asks for by name and the one §16 of the concept note demonstrates. Restored.
 */
export const CONFIRMATION_METHODS = [
  'recipient_tap',
  'pin_entry',
  'signature',
  'photograph',
] as const;
export type ConfirmationMethod = (typeof CONFIRMATION_METHODS)[number];

/** Which rung a method belongs to. Recorded on the delivery — FR-CNF-008. */
export const CONFIRMATION_TIER: Record<ConfirmationMethod, 1 | 2 | 3> = {
  recipient_tap: 1,
  pin_entry: 2,
  signature: 3,
  photograph: 3,
};

/**
 * Tiers 1 and 2 both carry the recipient's own affirmation — a tap they made, or
 * a code only they received — so either takes the delivery through to CONFIRMED
 * in the same transaction (FR-CNF-001).
 *
 * Tier 3 is the rider's account of the handover. It ends at DELIVERED and waits
 * for the asynchronous SMS reply (FR-CNF-005); dispatch sees it as "delivered,
 * unconfirmed" rather than having it silently upgraded by the system.
 */
export function reachesConfirmed(method: ConfirmationMethod): boolean {
  return CONFIRMATION_TIER[method] <= 2;
}

/**
 * FR-CNF-009. Tier 1 is the recipient asserting receipt, so only a recipient may
 * claim it: a rider who could select it would be manufacturing the strongest
 * proof in the system unaided. Enforced server-side in delivery_transition().
 */
export function methodAllowedForActor(
  method: ConfirmationMethod,
  actor: ActorType,
): boolean {
  return method === 'recipient_tap' ? actor === 'recipient' : actor === 'rider';
}

export const DELIVERY_HEALTH = ['green', 'amber', 'red'] as const;
export type DeliveryHealth = (typeof DELIVERY_HEALTH)[number];

/** States from which no transition leaves. SRS §4.2. */
export const TERMINAL_STATUSES: readonly DeliveryStatus[] = [
  'CONFIRMED',
  'FAILED',
  'RETURNED',
] as const;

export function isTerminal(status: DeliveryStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface Transition {
  /** Identifier from SRS §4.2, so a rejection can cite the row. */
  readonly id: string;
  readonly from: DeliveryStatus | null;
  readonly to: DeliveryStatus;
  readonly actors: readonly ActorType[];
  /** Rider position must be present on the request. */
  readonly requiresPosition: boolean;
  /** Server must validate distance to destination. FR-STM-003. */
  readonly requiresGeofence: boolean;
  /** A completed confirmation tier must accompany the request. */
  readonly requiresConfirmation: boolean;
  /** A reason from the controlled vocabulary is mandatory. */
  readonly requiresReason: boolean;
}

/**
 * SRS §4.2, exhaustive. A pair absent from this table is rejected with
 * ILLEGAL_TRANSITION — by the server, not merely hidden by the interface.
 */
export const TRANSITIONS: readonly Transition[] = [
  { id: 'T-01', from: null,         to: 'CREATED',    actors: ['admin', 'system'],     requiresPosition: false, requiresGeofence: false, requiresConfirmation: false, requiresReason: false },
  { id: 'T-02', from: 'CREATED',    to: 'ASSIGNED',   actors: ['admin'],               requiresPosition: false, requiresGeofence: false, requiresConfirmation: false, requiresReason: false },
  { id: 'T-03', from: 'ASSIGNED',   to: 'ACCEPTED',   actors: ['rider'],               requiresPosition: false, requiresGeofence: false, requiresConfirmation: false, requiresReason: false },
  { id: 'T-04', from: 'ASSIGNED',   to: 'CREATED',    actors: ['rider'],               requiresPosition: false, requiresGeofence: false, requiresConfirmation: false, requiresReason: true  },
  { id: 'T-05', from: 'ASSIGNED',   to: 'ASSIGNED',   actors: ['admin'],               requiresPosition: false, requiresGeofence: false, requiresConfirmation: false, requiresReason: false },
  { id: 'T-06', from: 'ACCEPTED',   to: 'AT_PICKUP',  actors: ['rider'],               requiresPosition: true,  requiresGeofence: false, requiresConfirmation: false, requiresReason: false },
  { id: 'T-07', from: 'AT_PICKUP',  to: 'PICKED_UP',  actors: ['rider'],               requiresPosition: true,  requiresGeofence: false, requiresConfirmation: false, requiresReason: false },
  { id: 'T-08', from: 'PICKED_UP',  to: 'IN_TRANSIT', actors: ['rider', 'system'],     requiresPosition: true,  requiresGeofence: false, requiresConfirmation: false, requiresReason: false },
  { id: 'T-09', from: 'IN_TRANSIT', to: 'ARRIVED',    actors: ['rider'],               requiresPosition: true,  requiresGeofence: false, requiresConfirmation: false, requiresReason: false },
  { id: 'T-10', from: 'ARRIVED',    to: 'DELIVERED',  actors: ['rider'],               requiresPosition: true,  requiresGeofence: true,  requiresConfirmation: true,  requiresReason: false },
  { id: 'T-11', from: 'DELIVERED',  to: 'CONFIRMED',  actors: ['recipient', 'system'], requiresPosition: false, requiresGeofence: false, requiresConfirmation: false, requiresReason: false },

  // T-12: FAILED is reachable from ASSIGNED through ARRIVED.
  ...(['ASSIGNED', 'ACCEPTED', 'AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED'] as const).map(
    (from): Transition => ({
      id: 'T-12', from, to: 'FAILED', actors: ['rider', 'admin'],
      requiresPosition: false, requiresGeofence: false, requiresConfirmation: false, requiresReason: true,
    }),
  ),

  // T-13: RETURNED only once custody has transferred.
  ...(['PICKED_UP', 'IN_TRANSIT', 'ARRIVED'] as const).map(
    (from): Transition => ({
      id: 'T-13', from, to: 'RETURNED', actors: ['rider', 'admin'],
      requiresPosition: false, requiresGeofence: false, requiresConfirmation: false, requiresReason: true,
    }),
  ),
];

export function findTransition(
  from: DeliveryStatus | null,
  to: DeliveryStatus,
): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function isLegalTransition(from: DeliveryStatus | null, to: DeliveryStatus): boolean {
  return findTransition(from, to) !== undefined;
}

/**
 * Transitions the given actor may request from the given state.
 * Drives which control the rider sees — an affordance, never an authorisation.
 */
export function allowedTransitions(
  from: DeliveryStatus,
  actor: ActorType,
): readonly Transition[] {
  return TRANSITIONS.filter((t) => t.from === from && t.actors.includes(actor));
}

/** Controlled vocabulary for FAILED / RETURNED / decline. FR-RDR-014, T-04. */
export const FAILURE_REASONS = [
  'recipient_unavailable',
  'recipient_refused',
  'address_not_found',
  'address_inaccessible',
  'package_damaged',
  'vehicle_breakdown',
  'unsafe_conditions',
  'other',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const FAILURE_REASON_LABELS: Record<FailureReason, string> = {
  recipient_unavailable: 'Nobody there',
  recipient_refused: 'Recipient refused it',
  address_not_found: "Couldn't find the address",
  address_inaccessible: "Couldn't reach the address",
  package_damaged: 'Package damaged',
  vehicle_breakdown: 'Vehicle broke down',
  unsafe_conditions: 'Not safe to deliver',
  other: 'Something else',
};


/**
 * Side effects the SERVER performs on a transition. Declared here so the
 * client knows what to expect without implementing any of it — the rider app
 * must never send an SMS or decide that one was warranted.
 *
 * SRS v1.2: reaching ARRIVED dispatches the Tier 1 OTP automatically. The
 * rider does not request it; they arrive, and the code is already on its way.
 */
export const SERVER_SIDE_EFFECTS: Partial<Record<DeliveryStatus, readonly string[]>> = {
  ARRIVED: ['dispatch_confirmation_pin'],
  ASSIGNED: ['notify_rider', 'sms_tracking_link'],
  DELIVERED: ['sap_write_back'],
};
