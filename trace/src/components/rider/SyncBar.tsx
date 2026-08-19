'use client';

/**
 * FR-RDR-012. Permanently visible, never a toast that disappears before a
 * rider on a motorcycle has read it.
 */
import { useSyncStatus } from '@/hooks/useSyncStatus';

export function SyncBar(): React.JSX.Element {
  const { state, stats, online, syncNow } = useSyncStatus();
  const queued = stats.pendingActions;

  const tone =
    state.kind === 'blocked'
      ? 'bg-stop-500/15 text-stop-500 border-stop-500/40'
      : !online || state.kind === 'offline'
        ? 'bg-warn-500/15 text-warn-500 border-warn-500/40'
        : queued > 0
          ? 'bg-info-500/15 text-info-500 border-info-500/40'
          : 'bg-ink-800 text-mist-400 border-ink-600';

  const label =
    state.kind === 'blocked'
      ? state.reason
      : !online || state.kind === 'offline'
        ? queued > 0
          ? `No signal — ${queued} saved, will send itself`
          : 'No signal — you can keep working'
        : state.kind === 'syncing'
          ? `Sending ${state.total}…`
          : queued > 0
            ? `${queued} waiting to send`
            : 'All work sent';

  return (
    <div
      className={`flex items-center gap-3 border-b px-4 py-2 text-sm ${tone}`}
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
          state.kind === 'blocked'
            ? 'bg-stop-500'
            : !online
              ? 'bg-warn-500'
              : queued > 0
                ? 'bg-info-500'
                : 'bg-go-500'
        }`}
      />
      <span className="wrap-hard flex-1">{label}</span>
      {(queued > 0 || state.kind === 'blocked') && online ? (
        <button
          type="button"
          onClick={syncNow}
          className="shrink-0 rounded-md bg-ink-600 px-3 py-1.5 font-semibold text-mist-100"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
