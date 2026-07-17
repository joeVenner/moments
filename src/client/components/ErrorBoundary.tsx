import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

// Deliberately doesn't use useI18n() — this sits above the app tree and must
// render a fallback even if something in the i18n/provider layer itself throws.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Unhandled render error:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--color-bg)] px-6 text-center">
          <p className="text-lg font-semibold text-[var(--color-text)]">
            Something went wrong — please reload.
          </p>
          <p className="text-sm text-[var(--color-text-muted)]">Une erreur est survenue — veuillez recharger.</p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-full bg-[var(--color-accent)] px-5 py-2 font-mono text-sm font-medium text-white transition hover:bg-[var(--color-accent-dark)]"
          >
            Reload / Recharger
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
