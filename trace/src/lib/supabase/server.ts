import 'server-only';

/**
 * Server-side Supabase client. NFR-SEC-012 and NFR-SEC-014.
 *
 * The ANON key only, as in the browser. The session travels in cookies the auth
 * helper marks HttpOnly, so a server component reads the caller's own identity
 * and RLS applies to it exactly as it would in the browser — the server tier
 * gains no privilege by being the server tier.
 *
 * There is deliberately no service-role client anywhere in this application.
 * Every privileged operation is a SECURITY DEFINER function with its own
 * authorisation check, which is auditable in one place; a service-role client
 * would move that decision into whichever route handler happened to hold it.
 */
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';

function readEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `${name} is not set. Copy .env.local.example to .env.local and fill it in.`,
    );
  }
  return value;
}

export async function supabaseServer(): Promise<SupabaseClient> {
  const store = await cookies();

  return createServerClient(
    readEnv('NEXT_PUBLIC_SUPABASE_URL'),
    readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll() {
          return store.getAll();
        },
        setAll(toSet) {
          try {
            for (const { name, value, options } of toSet) {
              store.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Middleware refreshes the session, so this is safe to ignore
            // rather than something to surface.
          }
        },
      },
    },
  );
}

/** The caller's profile, or null. Used by layouts to decide what to render. */
export async function currentProfile(): Promise<{
  id: string;
  role: string;
  full_name: string;
  org_id: string;
} | null> {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from('profiles')
    .select('id, role, full_name, org_id')
    .eq('id', user.id)
    .maybeSingle();

  return (data as { id: string; role: string; full_name: string; org_id: string }) ?? null;
}
