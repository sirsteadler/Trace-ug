'use client';

/**
 * NFR-REL-001: every distinct UI module is wrapped in one of these. A failure
 * in the live map must not crash the delivery confirmation form.
 *
 * NFR-REL-002: renders an actionable fallback naming what failed and offering
 * a retry — never a blank region, never a raw stack trace.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Named so the fallback can say WHAT failed, not just that something did. */
  readonly module: string;
  readonly children: ReactNode;
  readonly fallback?: (retry: () => void) => ReactNode;
}

interface State {
  readonly failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // NFR-PRV-005: identifiers only. No delivery data, no position, no phone
    // number reaches a log line.
    console.error('[trace:boundary]', {
      module: this.props.module,
      name: error.name,
      message: error.message,
      componentStack: info.componentStack?.slice(0, 400),
    });
  }

  #retry = (): void => {
    this.setState({ failed: false });
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.#retry);

    return (
      <div
        role="alert"
        className="rounded-xl border border-ink-500 bg-ink-800 p-4 text-mist-200"
      >
        <p className="font-semibold text-mist-100">{this.props.module} isn&apos;t loading.</p>
        <p className="mt-1 text-sm text-mist-400">
          Everything else on this screen still works. You can carry on and try this again.
        </p>
        <button
          type="button"
          onClick={this.#retry}
          className="mt-3 min-h-tap w-full rounded-lg bg-ink-600 px-4 font-semibold text-mist-100"
        >
          Try again
        </button>
      </div>
    );
  }
}
