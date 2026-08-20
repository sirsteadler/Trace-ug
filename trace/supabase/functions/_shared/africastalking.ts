/**
 * Africa's Talking SMS provider. Concept note §12, decision 12.
 *
 * One interface with one implementation behind it. Twilio was the obvious
 * alternative and is not viable here: it offers no trial in Uganda, and its
 * international A2P routes to Ugandan networks are both dearer and less
 * reliable than a local aggregator.
 *
 * Everything above this file talks to SmsProvider, so swapping aggregators is
 * one new file and an environment variable.
 */

export interface SmsResult {
  readonly ok: boolean;
  readonly messageId?: string;
  readonly cost?: string;
  /** Present on failure. Safe to log — never contains the message body. */
  readonly error?: string;
}

export interface SmsProvider {
  readonly name: string;
  send(to: string, message: string): Promise<SmsResult>;
}

/**
 * Africa's Talking returns per-recipient status codes rather than an HTTP error,
 * so a 200 response can still describe a failed send. These are the ones that
 * mean the message was accepted for delivery.
 */
const ACCEPTED = new Set([100, 101, 102]);

interface ATRecipient {
  statusCode: number;
  number: string;
  status: string;
  cost: string;
  messageId: string;
}

export function africasTalking(config: {
  username: string;
  apiKey: string;
  senderId?: string;
  sandbox?: boolean;
}): SmsProvider {
  const endpoint = config.sandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';

  return {
    name: config.sandbox ? 'africastalking:sandbox' : 'africastalking',

    async send(to, message) {
      const body = new URLSearchParams({
        username: config.username,
        to,
        message,
      });
      // Optional: an unapproved sender ID is rejected outright, so it is only
      // sent when configured. Without it the message arrives from a shortcode.
      if (config.senderId) body.set('from', config.senderId);

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            apiKey: config.apiKey,
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        });
      } catch (cause) {
        return { ok: false, error: `network: ${String(cause)}` };
      }

      if (!response.ok) {
        return { ok: false, error: `http ${response.status}` };
      }

      const payload = (await response.json()) as {
        SMSMessageData?: { Recipients?: ATRecipient[] };
      };

      const recipient = payload.SMSMessageData?.Recipients?.[0];
      if (!recipient) {
        return { ok: false, error: 'no recipient in response' };
      }
      if (!ACCEPTED.has(recipient.statusCode)) {
        return { ok: false, error: `${recipient.statusCode} ${recipient.status}` };
      }

      return { ok: true, messageId: recipient.messageId, cost: recipient.cost };
    },
  };
}

/**
 * Logs instead of sending. Used when no credentials are configured, so that
 * development and the offline demo proceed without an SMS account — and so a
 * missing key degrades to a visible no-op rather than a silent failure.
 */
export function consoleSms(): SmsProvider {
  return {
    name: 'console',
    async send(to, message) {
      console.log(`[sms:console] would send to ${to}: ${message}`);
      return { ok: true, messageId: `console-${crypto.randomUUID()}` };
    },
  };
}

/** Chooses a provider from the environment. */
export function smsProvider(): SmsProvider {
  const apiKey = Deno.env.get('AT_API_KEY');
  const username = Deno.env.get('AT_USERNAME');

  if (!apiKey || !username) return consoleSms();

  return africasTalking({
    username,
    apiKey,
    senderId: Deno.env.get('AT_SENDER_ID') || undefined,
    sandbox: username === 'sandbox',
  });
}
