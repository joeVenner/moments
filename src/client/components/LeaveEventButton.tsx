import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../lib/i18n";
import { prefersReducedMotion } from "../lib/motion";
import { leaveEvent, type LeaveOutcome } from "../lib/webLeave";

/**
 * "Leave" in the guest bar, with a confirm step: deletes what this browser's
 * guest shared and forgets them here, then hands back to the nickname gate.
 */
export function LeaveEventButton({
  slug,
  disabled,
  onLeft,
}: {
  slug: string;
  /** True while an upload runs from this page; leaving would race it. */
  disabled: boolean;
  onLeft: () => void;
}) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [problem, setProblem] = useState<Exclude<LeaveOutcome, "left"> | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const isLeavingRef = useRef(false);
  const reduced = prefersReducedMotion();

  const close = () => {
    if (isLeavingRef.current) return;
    setIsOpen(false);
    setProblem(null);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!isOpen) return;
    // The safe choice gets focus: Enter must not delete anything.
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `close` only reads refs and setters, so binding it once per opening is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  /** Keeps Tab between the dialog's two buttons (aria-modal: the page behind is out of reach). */
  const trapTab = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const next = document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current;
    next?.focus();
  };

  const confirm = async () => {
    isLeavingRef.current = true;
    setIsLeaving(true);
    setProblem(null);
    let outcome: LeaveOutcome;
    try {
      outcome = await leaveEvent(slug);
    } catch {
      outcome = "failed";
    } finally {
      isLeavingRef.current = false;
      setIsLeaving(false);
    }
    if (outcome === "left") {
      setIsOpen(false);
      onLeft();
      return;
    }
    setProblem(outcome);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(true)}
        disabled={disabled}
        aria-label={t("leaveEventTitle")}
        className="min-h-6 shrink-0 rounded-full px-2.5 py-1 font-mono text-xs text-[var(--color-text-muted)] underline-offset-2 transition hover:text-[var(--color-text)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-50"
      >
        {t("leaveEvent")}
      </button>

      {/* Portaled: the guest bar's backdrop-filter would otherwise become the
          containing block of this fixed overlay and trap it inside the bar. */}
      {isOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-bg)]/80 p-4 backdrop-blur-sm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="leave-event-title"
            aria-describedby="leave-event-body"
            onKeyDown={trapTab}
            // mousedown, not click: a drag that ends on the backdrop must not close it.
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <div
              className={`w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-6 shadow-2xl ${
                reduced ? "" : "animate-pop-in"
              }`}
            >
              <h2 id="leave-event-title" className="text-xl font-semibold text-[var(--color-text)]">
                {t("leaveEventTitle")}
              </h2>
              <p id="leave-event-body" className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">
                {t("leaveEventBody")}
              </p>
              <p role="status" className="mt-3 text-sm text-[var(--color-accent)] empty:hidden">
                {isLeaving
                  ? t("leaveEventLeaving")
                  : problem && t(problem === "rate_limited" ? "leaveEventRateLimited" : "leaveEventFailed")}
              </p>
              <div className="mt-6 flex justify-end gap-2">
                <button
                  ref={cancelRef}
                  type="button"
                  onClick={close}
                  aria-disabled={isLeaving}
                  className="rounded-lg border border-[var(--color-border)] px-4 py-2 font-mono text-sm text-[var(--color-text)] transition hover:bg-[var(--color-bg)] aria-disabled:opacity-50"
                >
                  {t("leaveEventCancel")}
                </button>
                <button
                  ref={confirmRef}
                  type="button"
                  onClick={() => {
                    if (!isLeavingRef.current) void confirm();
                  }}
                  aria-disabled={isLeaving}
                  aria-busy={isLeaving}
                  className="rounded-lg bg-[var(--color-accent)] px-4 py-2 font-mono text-sm font-medium text-white transition hover:bg-[var(--color-accent-dark)] aria-disabled:opacity-50"
                >
                  {isLeaving ? t("leaveEventLeaving") : t("leaveEventConfirm")}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
