/**
 * Confirmation ladder rules. SRS v1.2 §5.4.
 *
 * Tier 1  pin_entry            primary — OTP SMSed to the recipient on ARRIVED
 * Tier 2  signature|photograph fallback — phone unreachable / code never came
 *
 * Every tier is geofence-validated server side (FR-CNF-007). Nothing here
 * grants a completion; this module decides what the rider is *offered*.
 */
import { CONFIRMATION_TIER, type ConfirmationMethod } from './status';

/** FR-CNF-003. Attempts before a temporary lockout, mirrored by the server. */
export const PIN_MAX_ATTEMPTS = 5;
/** FR-CNF-002. Mirrors the server default so the UI can count down honestly. */
export const PIN_TTL_SECONDS = 15 * 60;
export const PIN_LENGTH = 6;
/** Rate limit on resend, so a rider hammering the button cannot bill the pilot. */
export const PIN_RESEND_COOLDOWN_SECONDS = 60;

export const PIN_PATTERN = new RegExp(`^\\d{${PIN_LENGTH}}$`);

export function isWellFormedPin(input: string): boolean {
  return PIN_PATTERN.test(input.trim());
}

/**
 * FR-CNF-009, restated for two tiers: the rider may descend the ladder but
 * never ascend it. Descending is a deliberate act with a recorded reason —
 * it produces a weaker proof and the record must show that.
 */
export const FALLBACK_REASONS = [
  'phone_unreachable',
  'code_not_received',
  'recipient_absent',
  'recipient_cannot_read_code',
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

export const FALLBACK_REASON_LABELS: Record<FallbackReason, string> = {
  phone_unreachable: 'Their phone is off or unreachable',
  code_not_received: 'The code never arrived',
  recipient_absent: 'Recipient is not here',
  recipient_cannot_read_code: 'They cannot read the code out',
};

export interface LadderState {
  readonly tier: 1 | 2;
  readonly attemptsUsed: number;
  readonly lockedUntil: number | null;
  readonly pinExpiresAt: number | null;
  readonly lastSentAt: number | null;
}

export function attemptsLeft(state: LadderState): number {
  return Math.max(0, PIN_MAX_ATTEMPTS - state.attemptsUsed);
}

export function isLockedOut(state: LadderState, now = Date.now()): boolean {
  return state.lockedUntil !== null && state.lockedUntil > now;
}

export function isPinExpired(state: LadderState, now = Date.now()): boolean {
  return state.pinExpiresAt !== null && state.pinExpiresAt <= now;
}

/**
 * Resend is blocked during the cooldown. Returns seconds remaining, or 0.
 * Returning a number rather than a boolean lets the UI show a countdown
 * instead of an inert button with no explanation — NFR-USE-005.
 */
export function resendCooldownRemaining(state: LadderState, now = Date.now()): number {
  if (state.lastSentAt === null) return 0;
  const elapsed = (now - state.lastSentAt) / 1000;
  return Math.max(0, Math.ceil(PIN_RESEND_COOLDOWN_SECONDS - elapsed));
}

/** Whether the rider may submit a PIN at all right now. */
export function canSubmitPin(state: LadderState, now = Date.now()): boolean {
  return (
    state.tier === 1 &&
    !isLockedOut(state, now) &&
    !isPinExpired(state, now) &&
    attemptsLeft(state) > 0
  );
}

/**
 * The rider may drop to Tier 2 at any point — a rider standing at a door with
 * an unreachable recipient must never be trapped by a code that will not come.
 */
export function canDescend(state: LadderState): boolean {
  return state.tier === 1;
}

export function tierOf(method: ConfirmationMethod): 1 | 2 {
  return CONFIRMATION_TIER[method];
}
