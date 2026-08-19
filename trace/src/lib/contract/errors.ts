/**
 * Error codes and the plain-language text a rider is allowed to see.
 *
 * SRS §6.4: `error` is a stable machine code clients may branch on. `message`
 * is safe to display directly and must never contain an identifier, an
 * address, a phone number or an internal path.
 *
 * NFR-USE-005: every message states what happened and what to do next, in
 * language a rider can act on without knowing the system's internals.
 */

export const ERROR_CODES = [
  'INVALID_PAYLOAD',
  'UNAUTHENTICATED',
  'FORBIDDEN_ACTOR',
  'ILLEGAL_TRANSITION',
  'CHAIN_CONFLICT',
  'OUTSIDE_GEOFENCE',
  'POSITION_REQUIRED',
  'CONFIRMATION_REQUIRED',
  'SHIFT_NOT_OPEN',
  'INVALID_COORDINATE',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'TOKEN_REVOKED',
  'PIN_INCORRECT',
  'PIN_EXPIRED',
  'LOCKED_OUT',
  'GEOCODE_FAILED',
  'ALREADY_ACCEPTED',
  'RIDER_OFF_SHIFT',
  'DESTINATION_NOT_GEOCODED',
  'UNSYNCED_WORK',
  'CUSTODY_HELD',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'NETWORK_UNAVAILABLE',
  'UNKNOWN',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const RIDER_MESSAGES: Record<ErrorCode, string> = {
  INVALID_PAYLOAD: "That didn't go through. Try again, and tell dispatch if it keeps happening.",
  UNAUTHENTICATED: 'You have been signed out. Sign in again to carry on.',
  FORBIDDEN_ACTOR: 'This delivery is not assigned to you any more. Check your list.',
  ILLEGAL_TRANSITION: 'This delivery has already moved on. Pull down to refresh and see where it is.',
  CHAIN_CONFLICT: 'Something changed while you were offline. Check the delivery before carrying on.',
  OUTSIDE_GEOFENCE: 'You need to be closer to the delivery address to complete this.',
  POSITION_REQUIRED: 'Your location is needed for this step. Check that location is switched on.',
  CONFIRMATION_REQUIRED: 'The delivery needs to be confirmed before you can close it.',
  SHIFT_NOT_OPEN: 'You are off shift. Go on shift to carry on working.',
  INVALID_COORDINATE: 'Your location reading looks wrong. Move into the open and try again.',
  INVALID_TOKEN: 'That link is not valid.',
  TOKEN_EXPIRED: 'That link has expired.',
  TOKEN_REVOKED: 'That link is no longer active.',
  PIN_INCORRECT: 'That PIN is not right. Ask the recipient to read it out again.',
  PIN_EXPIRED: 'That PIN has expired. Send a new one.',
  LOCKED_OUT: 'Too many wrong PINs. Wait a moment, then send a new one.',
  GEOCODE_FAILED: 'This address could not be placed on the map. Tell dispatch.',
  ALREADY_ACCEPTED: 'Another rider has already taken this one.',
  RIDER_OFF_SHIFT: 'You are off shift. Go on shift to carry on working.',
  DESTINATION_NOT_GEOCODED: 'This delivery has no confirmed address yet. Tell dispatch.',
  UNSYNCED_WORK: 'You still have work that has not reached the office. Stay on shift until it syncs.',
  CUSTODY_HELD: 'You are still carrying a package. Finish or return it before going off shift.',
  RATE_LIMITED: 'Too many tries. Wait a moment and try again.',
  UPSTREAM_UNAVAILABLE: 'The office system is not responding. Your work is saved and will send itself.',
  NETWORK_UNAVAILABLE: 'No signal. Your work is saved and will send itself when you reconnect.',
  UNKNOWN: "Something went wrong. Your work is saved. Tell dispatch if it keeps happening.",
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Never returns undefined. An unrecognised code from a newer server build
 * degrades to UNKNOWN rather than rendering `undefined` at a rider.
 * NFR-REL-004.
 */
export function riderMessage(code: unknown): string {
  return isErrorCode(code) ? RIDER_MESSAGES[code] : RIDER_MESSAGES.UNKNOWN;
}

/** Codes where retrying the identical request may succeed later. */
const RETRYABLE: readonly ErrorCode[] = [
  'NETWORK_UNAVAILABLE',
  'UPSTREAM_UNAVAILABLE',
  'RATE_LIMITED',
];

export function isRetryable(code: unknown): boolean {
  return isErrorCode(code) && RETRYABLE.includes(code);
}

/**
 * Thrown by the transport layer. Carries the machine code so callers branch on
 * `code`, and the display string so no caller invents its own wording.
 */
export class TraceError extends Error {
  readonly code: ErrorCode;
  readonly detail: Readonly<Record<string, unknown>> | null;

  constructor(code: ErrorCode, detail: Record<string, unknown> | null = null) {
    super(riderMessage(code));
    this.name = 'TraceError';
    this.code = code;
    this.detail = detail;
  }

  get retryable(): boolean {
    return isRetryable(this.code);
  }
}
