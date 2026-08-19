import 'server-only';

/**
 * Customer tracking access. SRS §5.3.2, FR-CNF-001.
 *
 * The recipient has no account. They arrive from an SMS holding a random token
 * and need a live map and a Received button.
 *
 * This module answers one question, server-side, before any delivery data
 * reaches the browser: is this link live, spent, or meaningless? The browser
 * then signs in anonymously and calls claim_tracking_token() to bind that
 * session to the delivery; RLS does the rest.
 *
 * There is no JWT minting here. The project signs with ES256 and Supabase holds
 * the private key, so nothing outside Supabase can produce a token it accepts.
 * The binding table reaches the same place and revokes instantly, which an
 * issued JWT could never do.
 */
import { createClient } from '@supabase/supabase-js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export type TrackingLink =
  | { readonly state: 'valid' }
  | {
      readonly state: 'closed';
      readonly traceId: string;
      readonly status: string;
      readonly completedAt: string | null;
    }
  | { readonly state: 'invalid' };

/**
 * Resolve a raw link token into a page state.
 *
 * `closed` exists because the token is revoked the moment the delivery reaches
 * CONFIRMED. Without it, a recipient who taps Received and then reopens the link
 * is told the delivery does not exist seconds after confirming it — which reads
 * as the system losing their parcel rather than as the link being spent.
 *
 * `invalid` says nothing at all. Unknown, malformed and long-expired tokens are
 * one answer, so probing reveals only valid or not.
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

  if (row.state === 'valid') return { state: 'valid' };

  if (row.state === 'closed') {
    return {
      state: 'closed',
      traceId: String(row.trace_id ?? ''),
      status: String(row.status ?? ''),
      completedAt: (row.completed_at as string | null) ?? null,
    };
  }

  return { state: 'invalid' };
}
