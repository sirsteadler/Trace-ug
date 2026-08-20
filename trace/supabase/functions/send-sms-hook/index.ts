/**
 * Supabase Auth "Send SMS" hook. FR-AUT-001.
 *
 * Supabase calls this instead of its built-in providers whenever it needs to
 * deliver a login OTP, which is what lets Africa's Talking serve as the auth
 * SMS provider despite not being one of the natively supported four.
 *
 * AUTH MODE. `auth: 'none'`, deliberately and narrowly. Supabase Auth signs the
 * payload with a shared hook secret rather than sending an API key, so no
 * Supabase auth mode can verify it. The endpoint is not public: it verifies the
 * Standard Webhooks signature itself and refuses everything else. Without that
 * check this would send an SMS to any number anyone posted, at your expense.
 *
 * config.toml sets verify_jwt = false for the same reason — the platform JWT
 * check would reject Supabase's own hook call before it reached this handler.
 */
import { withSupabase } from 'npm:@supabase/server';
import { smsProvider } from '../_shared/africastalking.ts';
import { verifyWebhook } from '../_shared/webhook.ts';

interface HookPayload {
  user: { phone?: string };
  sms: { otp: string };
}

export default {
  fetch: withSupabase({ auth: 'none' }, async (req: Request) => {
    const secret = Deno.env.get('SEND_SMS_HOOK_SECRET');
    if (!secret) {
      // Fail closed. An unconfigured secret must never mean "accept anything".
      console.error('SEND_SMS_HOOK_SECRET is not set');
      return Response.json({ error: 'not configured' }, { status: 500 });
    }

    const body = await req.text();

    const valid = await verifyWebhook(
      {
        id: req.headers.get('webhook-id') ?? '',
        timestamp: req.headers.get('webhook-timestamp') ?? '',
        signature: req.headers.get('webhook-signature') ?? '',
        body,
      },
      secret,
    );

    if (!valid) {
      return Response.json({ error: 'invalid signature' }, { status: 401 });
    }

    const payload = JSON.parse(body) as HookPayload;
    const phone = payload.user?.phone;
    const otp = payload.sms?.otp;

    if (!phone || !otp) {
      return Response.json({ error: 'malformed payload' }, { status: 400 });
    }

    const provider = smsProvider();
    const result = await provider.send(
      phone.startsWith('+') ? phone : `+${phone}`,
      `${otp} is your TRACE sign-in code. It expires in 10 minutes. Do not share it.`,
    );

    if (!result.ok) {
      // Returning an error tells Supabase Auth the send failed, so the caller
      // sees "could not send a code" rather than waiting for an SMS that is
      // never coming.
      console.error(`sms send failed via ${provider.name}: ${result.error}`);
      return Response.json({ error: 'delivery failed' }, { status: 502 });
    }

    // The OTP is never logged. NFR-SEC-004.
    console.log(`otp delivered via ${provider.name} (${result.messageId})`);
    return Response.json({});
  }),
};
