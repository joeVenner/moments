import { useEffect } from "react";

/**
 * Keeps the screen awake while a large upload is in flight, so the OS doesn't
 * dim → throttle → kill the tab's upload (the #1 cause of "it died while I
 * wasn't watching" on mobile). Acquires a Screen Wake Lock while `active` is
 * true, re-acquires it on `visibilitychange → visible` (the lock auto-releases
 * when the tab hides), and releases it on stop/unmount.
 *
 * This is a foreground keep-alive only — it cannot keep an upload running after
 * the user fully backgrounds the app (no web API can on iOS in 2026). The
 * resumable chunked uploader (multipartUpload.ts) bounds the loss to one part
 * when that happens and resumes on return.
 *
 * No-ops cleanly where the API is unavailable (older iOS, permissions-policy
 * block, low-battery refusal) — the upload still works, it just isn't shielded
 * from screen-dim throttling.
 */
export function useUploadWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    async function acquire() {
      try {
        if (cancelled || !("wakeLock" in navigator)) return;
        sentinel = await navigator.wakeLock.request("screen");
      } catch {
        // Not fatal — see header. Most common: low battery / power-save refused.
      }
    }

    function onVisibility() {
      if (document.visibilityState === "visible") acquire();
    }

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}