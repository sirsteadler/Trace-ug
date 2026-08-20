/**
 * Standard Webhooks signature verification.
 *
 * Supabase Auth signs hook payloads with a shared secret rather than sending an
 * API key, so the endpoint cannot use a Supabase auth mode. It runs with
 * `auth: 'none'` and verifies the signature here — the same shape as any
 * third-party webhook. Without this check the endpoint would send an SMS to any
 * number anyone posted to it, at your expense.
 */

/** Constant-time comparison; a fast bail on mismatch leaks signature bytes. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function decodeBase64(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * @param secret The hook secret, as Supabase presents it: `v1,whsec_<base64>`.
 * @returns true when the signature is valid AND the timestamp is recent.
 */
export async function verifyWebhook(
  request: { id: string; timestamp: string; signature: string; body: string },
  secret: string,
): Promise<boolean> {
  // Tolerate either the full `v1,whsec_...` form or a bare base64 secret.
  const raw = secret.replace(/^v1,/, '').replace(/^whsec_/, '');

  // Replay window. A captured payload replayed a day later must not still send.
  const sentAt = Number(request.timestamp) * 1000;
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 5 * 60 * 1000) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    decodeBase64(raw),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signed = `${request.id}.${request.timestamp}.${request.body}`;
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed)),
  );

  // The header may carry several space-separated versioned signatures during a
  // secret rotation. Any one matching is a pass.
  for (const part of request.signature.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    try {
      if (timingSafeEqual(expected, decodeBase64(value))) return true;
    } catch {
      // Malformed candidate; try the next.
    }
  }

  return false;
}
