/**
 * The customer tracking link. SRS §5.3.2.
 *
 * One screen, one button, no account, no install. The recipient arrives from an
 * SMS holding a random token; everything below is decided server-side before a
 * single byte of delivery data reaches the browser.
 */
import { notFound } from 'next/navigation';
import { resolveTrackingLink } from '@/lib/tracking/token';
import { TrackingView } from './TrackingView';

/** Never cached. A tracking link is a live view of a moving thing. */
export const dynamic = 'force-dynamic';

export default async function TrackingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const link = await resolveTrackingLink(token);

  // Says nothing. Unknown, malformed and expired are one answer.
  if (link.state === 'invalid') notFound();

  if (link.state === 'closed') {
    const when = link.completedAt
      ? new Date(link.completedAt).toLocaleString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          day: 'numeric',
          month: 'short',
        })
      : null;

    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
        <div className="rounded-2xl bg-ink-800 p-8 text-center">
          <div
            aria-hidden
            className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-go-700 text-3xl"
          >
            ✓
          </div>
          <h1 className="text-xl font-semibold text-mist-100">Delivery confirmed</h1>
          <p className="mt-3 text-mist-400">
            {when ? `Confirmed at ${when}.` : 'This delivery has been confirmed.'} This
            tracking link is now closed.
          </p>
          <p className="wrap-hard mt-6 text-sm text-mist-400">{link.traceId}</p>
        </div>
      </main>
    );
  }

  // The token goes to the client deliberately: it is the bearer credential the
  // recipient already holds, and the browser exchanges it for a bound session.
  // Nothing about the delivery travels with it.
  return <TrackingView token={token} />;
}
