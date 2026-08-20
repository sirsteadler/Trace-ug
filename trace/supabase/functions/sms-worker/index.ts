/**
 * Outbound SMS worker. FR-CNF-002, NFR-SEC-004.
 *
 * Drains `outbound_sms`, which is where issue_confirmation_pin() writes the
 * Tier 2 confirmation code. Until this runs, a rider taps Arrived and the
 * recipient never receives the code — the ladder silently stops at Tier 3.
 *
 * AUTH MODE. `auth: 'secret'`: this is called by pg_cron via pg_net with the
 * secret key in the apikey header, never by a browser.
 *
 * The plaintext code exists in exactly one place — the `body` column — and this
 * function is what removes it. On a successful send the body is overwritten
 * rather than left to age out via the hourly purge.
 */
import { withSupabase } from 'npm:@supabase/server';
import { smsProvider } from '../_shared/africastalking.ts';

/** Small batches: a cron tick should finish well inside the function timeout. */
const BATCH = 20;

interface OutboundRow {
  id: string;
  to_phone: string;
  body: string;
  attempts: number;
}

export default {
  fetch: withSupabase({ auth: 'secret' }, async (_req, ctx) => {
    const provider = smsProvider();

    const { data, error } = await ctx.supabaseAdmin
      .from('outbound_sms')
      .select('id, to_phone, body, attempts')
      .is('sent_at', null)
      .lt('attempts', 5)
      .neq('body', '[purged]')
      .order('created_at', { ascending: true })
      .limit(BATCH);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    const rows = (data ?? []) as OutboundRow[];
    let sent = 0;
    let failed = 0;

    for (const row of rows) {
      const result = await provider.send(row.to_phone, row.body);

      if (result.ok) {
        // Overwrite the plaintext in the same statement that marks it sent, so
        // there is no window where a sent code is still readable.
        await ctx.supabaseAdmin
          .from('outbound_sms')
          .update({ sent_at: new Date().toISOString(), body: '[purged]', last_error: null })
          .eq('id', row.id);
        sent++;
      } else {
        // Attempts are capped by the query above rather than by a retry loop
        // here: a code that has failed five times is stale anyway, and the
        // recipient should be asking the rider to resend rather than waiting.
        await ctx.supabaseAdmin
          .from('outbound_sms')
          .update({ attempts: row.attempts + 1, last_error: result.error ?? 'unknown' })
          .eq('id', row.id);
        failed++;
      }
    }

    return Response.json({ provider: provider.name, considered: rows.length, sent, failed });
  }),
};
