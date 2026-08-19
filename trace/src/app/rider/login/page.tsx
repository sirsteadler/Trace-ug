'use client';

/**
 * FR-AUT-001 / FR-RDR-001: phone number and SMS OTP. No rider password exists,
 * so none can be stolen.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { PrimaryAction } from '@/components/rider/PrimaryAction';

type Stage = 'phone' | 'code';

export default function RiderLogin(): React.JSX.Element {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function sendCode(): Promise<void> {
    setBusy(true);
    setProblem(null);
    const { error } = await supabase().auth.signInWithOtp({ phone: phone.trim() });
    setBusy(false);
    if (error) {
      // FR-AUT-010 rate limiting surfaces here. Never confirm whether the
      // number is registered — that would enumerate riders. NFR-SEC-009.
      setProblem('Could not send a code. Check the number and try again shortly.');
      return;
    }
    setStage('code');
  }

  async function verify(): Promise<void> {
    setBusy(true);
    setProblem(null);
    const { error } = await supabase().auth.verifyOtp({
      phone: phone.trim(),
      token: code.trim(),
      type: 'sms',
    });
    setBusy(false);
    if (error) {
      setProblem('That code is not right. Check it and try again.');
      return;
    }
    router.replace('/rider');
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pb-8 pt-16">
      <h1 className="text-3xl font-bold tracking-tight text-mist-100">TRACE</h1>
      <p className="mt-1 text-mist-400">Rider sign in</p>

      <div className="mt-10 flex-1 space-y-5">
        {stage === 'phone' ? (
          <label className="block">
            <span className="text-sm font-medium text-mist-200">Your phone number</span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+256 7XX XXX XXX"
              className="mt-2 min-h-tap w-full rounded-xl border border-ink-500 bg-ink-800
                px-4 text-lg text-mist-100 placeholder:text-mist-400/60"
            />
          </label>
        ) : (
          <label className="block">
            <span className="text-sm font-medium text-mist-200">
              Enter the code we sent you
            </span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="000000"
              className="mt-2 min-h-tap w-full rounded-xl border border-ink-500 bg-ink-800
                px-4 text-center text-3xl tracking-[0.4em] text-mist-100"
            />
            <button
              type="button"
              onClick={() => setStage('phone')}
              className="mt-3 text-sm text-info-500 underline"
            >
              Use a different number
            </button>
          </label>
        )}

        {problem ? (
          <p role="alert" className="text-sm text-stop-500">
            {problem}
          </p>
        ) : null}
      </div>

      <PrimaryAction
        label={stage === 'phone' ? 'Send me a code' : 'Sign in'}
        busy={busy}
        disabled={stage === 'phone' ? phone.trim().length < 9 : code.trim().length < 4}
        onPress={() => void (stage === 'phone' ? sendCode() : verify())}
      />
    </main>
  );
}
