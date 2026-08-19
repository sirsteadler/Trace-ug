'use client';

/**
 * NFR-USE-006: exactly one primary action per screen.
 * NFR-USE-001: 56px minimum height, thumb zone, generous separation.
 * §5.2.2: the label is a verb. The rider reads one word and acts.
 */
interface Props {
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly tone?: 'go' | 'warn';
  readonly onPress: () => void;
}

export function PrimaryAction({
  label,
  hint,
  disabled = false,
  busy = false,
  tone = 'go',
  onPress,
}: Props): React.JSX.Element {
  const base = tone === 'go' ? 'bg-go-500 text-ink-900' : 'bg-warn-500 text-ink-900';

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onPress}
        disabled={disabled || busy}
        aria-busy={busy}
        className={`min-h-[4.5rem] w-full rounded-2xl px-6 text-xl font-bold tracking-tight
          transition-opacity disabled:opacity-40 ${base}`}
      >
        {busy ? 'Working…' : label}
      </button>
      {/* §5.3.3: a disabled control explains itself rather than reading as broken. */}
      {hint ? <p className="px-1 text-center text-sm text-mist-400">{hint}</p> : null}
    </div>
  );
}
