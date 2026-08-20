/**
 * Browser Supabase client.
 *
 * NFR-SEC-012: the ANON key only. The service-role key must never reach a
 * client bundle. Safety rests on the RLS matrix in SRS §3.5 — if RLS is
 * misconfigured, publishing the anon key is what makes that fatal, which is
 * why TC-018 tests every cell of the matrix adversarially.
 *
 * NFR-SEC-014: the session lives in a cookie the auth helper marks HttpOnly,
 * Secure and SameSite=Lax. No session token is written to localStorage.
 */
import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

function readEnv(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    // Fail loudly at the boundary rather than producing a client that 401s
    // on every call and looks like an auth bug.
    throw new Error(
      `${name} is not set. Copy .env.local.example to .env.local and fill it in.`,
    );
  }
  return value;
}

export function supabase(): SupabaseClient {
  cached ??= createBrowserClient(
    readEnv(process.env.NEXT_PUBLIC_SUPABASE_URL, 'NEXT_PUBLIC_SUPABASE_URL'),
    readEnv(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  );
  return cached;
}

/** Guard used by the build check for NFR-SEC-012. */
export function assertNoServiceRoleKey(bundle: string): void {
  if (/service_role/.test(bundle)) {
    throw new Error('service-role key detected in client output — NFR-SEC-012');
  }
}
