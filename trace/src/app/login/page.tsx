'use client';

/**
 * Dispatch sign-in. FR-AUT-001.
 *
 * Phone and SMS OTP, the same as the rider app: one auth path for the whole
 * product, and no staff password to be stolen or reused.
 */
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';

type Stage = 'phone' | 'code';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/dashboard';

  const [stage, setStage] = useState<Stage>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function sendCode() {
    setBusy(true);
    setProblem(null);
    const { error } = await supabase().auth.signInWithOtp({ phone: phone.trim() });
    setBusy(false);
    if (error) {
      // Never confirm whether the number is registered: that enumerates staff.
      // NFR-SEC-009.
      setProblem('Could not send a code. Check the number and try again shortly.');
      return;
    }
    setStage('code');
  }

  async function verify() {
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
    router.replace(next);
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pb-8 pt-16">
      <h1 className="text-3xl font-bold tracking-tight text-mist-100">TRACE</h1>
      <p className="mt-1 text-mist-400">Dispatch sign in</p>

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
              className="mt-2 min-h-tap w-full rounded-xl border border-ink-500 bg-ink-800 px-4 text-lg text-mist-100 placeholder:text-mist-400/60"
            />
          </label>
        ) : (
          <label className="block">
            <span className="text-sm font-medium text-mist-200">
              Code sent to {phone}
            </span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="000000"
              className="mt-2 min-h-tap w-full rounded-xl border border-ink-500 bg-ink-800 px-4 text-2xl tracking-[0.4em] text-mist-100 placeholder:text-mist-400/60"
            />
          </label>
        )}

        {problem && (
          <p role="alert" className="rounded-xl bg-ink-800 px-4 py-3 text-stop-500">
            {problem}
          </p>
        )}
      </div>

      <button
        type="button"
        disabled={busy || (stage === 'phone' ? phone.trim().length < 9 : code.trim().length < 6)}
        onClick={() => void (stage === 'phone' ? sendCode() : verify())}
        className="min-h-tap w-full rounded-2xl bg-go-600 px-6 text-lg font-semibold text-ink-900 disabled:opacity-50"
      >
        {busy ? 'Working…' : stage === 'phone' ? 'Send code' : 'Sign in'}
      </button>
    </main>
  );
}

export default function LoginPage() {
  // useSearchParams needs a boundary; the fallback is what renders while the
  // client bundle arrives, so it should look like the form rather than a spinner.
  return (
    <Suspense fallback={<main className="min-h-dvh" />}>
      <LoginForm />
    </Suspense>
  );
}
