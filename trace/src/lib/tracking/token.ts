import 'server-only';

/**
 * Customer tracking access. SRS §5.3.2, FR-CNF-001.
 *
 * The recipient has no account. They arrive holding a random token from an SMS
 * link, and they need a live map and a Received button. This module exchanges
 * that token for a short-lived JWT carrying a `tracking_delivery_id` claim,
 * signed with the project's JWT secret so PostgREST and Realtime both accept it
 * and RLS scopes every read to the one delivery.
 *
 * The alternative — proxying reads through a service-role endpoint — would be
 * simpler and would lose Realtime, and the moving rider is the point of the link.
 *
 * Nothing here trusts the client: the claim is minted server-side from a token
 * the database validated, and the token itself never reaches the browser's
 * Supabase session.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

/** Short, because revocation cannot reach a JWT already issued. */
export const TRACKING_JWT_TTL_SECONDS = 15 * 60;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail loudly at the boundary. A missing secret must never degrade into an
    // unsigned or misconfigured token that the database then has to reject.
    throw new Error(`${name} is not set`);
  }
  return value;
}

/**
 * Mint an HS256 JWT scoped to one delivery.
 *
 * `role: 'anon'` matters: PostgREST reads the role claim to decide which
 * database role to assume. The claim that does the actual work is
 * `tracking_delivery_id`, which every recipient RLS policy keys off.
 */
export function mintTrackingJwt(deliveryId: string, now = Date.now()): string {
  const secret = requiredEnv('SUPABASE_JWT_SECRET');
  const issuedAt = Math.floor(now / 1000);

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      role: 'anon',
      aud: 'authenticated',
      iat: issuedAt,
      exp: issuedAt + TRACKING_JWT_TTL_SECONDS,
      tracking_delivery_id: deliveryId,
    }),
  );

  const signature = base64url(
    createHmac('sha256', secret).update(`${header}.${payload}`).digest(),
  );

  return `${header}.${payload}.${signature}`;
}

/** Constant-time compare, used by tests and any future self-verification. */
export function verifyTrackingJwt(token: string): boolean {
  const secret = requiredEnv('SUPABASE_JWT_SECRET');
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return false;

  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export type TrackingLink =
  | { readonly state: 'valid'; readonly deliveryId: string; readonly jwt: string; readonly expiresAt: number }
  | { readonly state: 'closed'; readonly traceId: string; readonly status: string; readonly completedAt: string | null }
  | { readonly state: 'invalid' };

/**
 * Resolve a raw link token into a grant, a closed notice, or nothing.
 *
 * `closed` exists because the token is revoked the moment the delivery reaches
 * CONFIRMED. Without it a recipient who taps Received and then reopens the link
 * would be told the delivery does not exist, seconds after confirming it — which
 * reads as the system losing their parcel rather than as the link being spent.
 *
 * `invalid` says nothing whatsoever. Unknown, malformed and long-expired tokens
 * are one answer, so probing reveals only valid or not.
 */
export async function resolveTrackingLink(rawToken: string): Promise<TrackingLink> {
  if (!rawToken || rawToken.length < 20) return { state: 'invalid' };

  const supabase = createClient(
    requiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    { auth: { persistSession: false } },
  );

  const { data, error } = await supabase.rpc('tracking_token_state', {
    p_token: rawToken,
  });

  if (error || !data) return { state: 'invalid' };

  const row = data as Record<string, unknown>;

  if (row.state === 'valid') {
    const deliveryId = row.delivery_id as string;
    return {
      state: 'valid',
      deliveryId,
      jwt: mintTrackingJwt(deliveryId),
      expiresAt: Date.now() + TRACKING_JWT_TTL_SECONDS * 1000,
    };
  }

  if (row.state === 'closed') {
    return {
      state: 'closed',
      traceId: row.trace_id as string,
      status: row.status as string,
      completedAt: (row.completed_at as string | null) ?? null,
    };
  }

  return { state: 'invalid' };
}
