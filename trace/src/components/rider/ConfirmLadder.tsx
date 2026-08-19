'use client';

/**
 * SRS v1.2 §5.4 — the two-tier ladder.
 *
 *   Tier 1  the recipient reads out the code we SMSed them on ARRIVED
 *   Tier 2  signature or photo, when their phone is unreachable
 *
 * The rider may descend at any time. A rider standing at a door with an
 * unreachable recipient must never be trapped by a code that will not come.
 * They may never ascend: only the recipient's own code proves the recipient.
 */
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { PrimaryAction } from '@/components/rider/PrimaryAction';
import {
  FALLBACK_REASONS,
  FALLBACK_REASON_LABELS,
  PIN_LENGTH,
  isWellFormedPin,
  type FallbackReason,
} from '@/lib/contract';

interface Props {
  readonly deliveryId: string;
  readonly recipientName: string;
  readonly onSubmitPin: (pin: string) => Promise<string | null>;
  readonly onFallback: (reason: FallbackReason) => Promise<void>;
}

export function ConfirmLadder({
  deliveryId,
  recipientName,
  onSubmitPin,
  onFallback,
}: Props): React.JSX.Element {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [tier, setTier] = useState<1 | 2>(1);
  const [reason, setReason] = useState<FallbackReason | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function resend(): Promise<void> {
    setBusy(true);
    setProblem(null);
    const { data, error } = await supabase().rpc('resend_confirmation_pin', {
      p_delivery: deliveryId,
    });
    setBusy(false);
    if (error) {
      setProblem('Could not send the code again just yet. Wait a moment.');
      setCooldown(60);
      return;
    }
    if (data && typeof data === 'object' && 'sent_to' in data) {
      setSentTo(String((data as Record<string, unknown>).sent_to));
    }
    setCooldown(60);
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setProblem(null);
    const failure = await onSubmitPin(pin.trim());
    setBusy(false);
    if (failure) {
      setProblem(failure);
      setPin('');
    }
  }

  if (tier === 2) {
    return (
      <section className="space-y-4" aria-label="Confirm without a code">
        <div>
          <h2 className="text-lg font-bold text-mist-100">Confirm without a code</h2>
          <p className="mt-1 text-sm text-mist-400">
            This records a weaker proof of delivery. Dispatch will see that no code was used.
          </p>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-mist-200">Why?</legend>
          {FALLBACK_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setReason(r)}
              aria-pressed={reason === r}
              className={`min-h-tap w-full rounded-xl border px-4 text-left text-mist-100 ${
                reason === r
                  ? 'border-go-500 bg-go-500/10'
                  : 'border-ink-500 bg-ink-800'
              }`}
            >
              {FALLBACK_REASON_LABELS[r]}
            </button>
          ))}
        </fieldset>

        <PrimaryAction
          label="Take photo and finish"
          disabled={reason === null}
          hint={reason === null ? 'Choose a reason first.' : undefined}
          busy={busy}
          onPress={() => {
            if (!reason) return;
            setBusy(true);
            void onFallback(reason).finally(() => setBusy(false));
          }}
        />

        <button
          type="button"
          onClick={() => setTier(1)}
          className="min-h-tap w-full text-sm text-info-500 underline"
        >
          Go back to the code
        </button>
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-label="Confirm with code">
      <div>
        <h2 className="text-lg font-bold text-mist-100">Ask for the code</h2>
        <p className="wrap-hard mt-1 text-sm text-mist-400">
          We sent {recipientName} a {PIN_LENGTH}-digit code
          {sentTo ? ` on ${sentTo}` : ''}. Ask them to read it out.
        </p>
      </div>

      <label className="block">
        <span className="sr-only">Delivery code</span>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          maxLength={PIN_LENGTH}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          placeholder={'0'.repeat(PIN_LENGTH)}
          className="min-h-[4.5rem] w-full rounded-2xl border border-ink-500 bg-ink-800
            text-center text-4xl tracking-[0.35em] text-mist-100 placeholder:text-mist-400/40"
        />
      </label>

      {problem ? (
        <p role="alert" className="text-sm text-stop-500">
          {problem}
        </p>
      ) : null}

      <PrimaryAction
        label="Confirm delivery"
        disabled={!isWellFormedPin(pin)}
        hint={isWellFormedPin(pin) ? undefined : `Enter all ${PIN_LENGTH} digits.`}
        busy={busy}
        onPress={() => void submit()}
      />

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => void resend()}
          disabled={cooldown > 0 || busy}
          className="min-h-tap flex-1 rounded-xl border border-ink-500 bg-ink-800
            text-sm font-semibold text-mist-200 disabled:opacity-40"
        >
          {cooldown > 0 ? `Send again in ${cooldown}s` : 'Send the code again'}
        </button>
        <button
          type="button"
          onClick={() => setTier(2)}
          className="min-h-tap flex-1 rounded-xl border border-ink-500 bg-ink-800
            text-sm font-semibold text-mist-200"
        >
          No code?
        </button>
      </div>
    </section>
  );
}
