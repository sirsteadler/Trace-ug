/**
 * NFR-USE-008: custom 404. The most likely cause in this system is a mistyped
 * or truncated tracking link, so it says so — without disclosing whether any
 * delivery corresponding to the attempted URL exists.
 */
export default function NotFound(): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-bold text-mist-100">This link doesn&apos;t work</h1>
      <p className="text-mist-200">
        If you were sent a delivery tracking link, it may have been cut short when it was
        copied. Try opening it again from the original message.
      </p>
      <p className="text-sm text-mist-400">
        Still stuck? Contact whoever sent your delivery — they can send a fresh link.
      </p>
    </main>
  );
}
