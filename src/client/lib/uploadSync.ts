export const UPLOAD_SYNC_TAG = "resume-moment-uploads";
export const PAGE_RESUME_EVENT = "moment-upload-resume-requested";

interface SyncCapableRegistration extends ServiceWorkerRegistration {
  sync?: { register(tag: string): Promise<void> };
}

/** Best effort: Background Sync is available mainly on Chromium. */
export async function requestUploadBackgroundSync(
  supplied?: ServiceWorkerRegistration
): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  // `navigator.serviceWorker.ready` has no rejection path and can stay pending
  // indefinitely when registration failed or the first worker has not activated
  // yet. Background Sync is an enhancement, so never let it block the foreground
  // upload before the first R2 part starts.
  const registration = (supplied ?? (await navigator.serviceWorker.getRegistration())) as
    | SyncCapableRegistration
    | undefined;
  if (!registration) return;
  await registration.sync?.register(UPLOAD_SYNC_TAG).catch(() => {});
}

export function requestPageUploadResume(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PAGE_RESUME_EVENT));
}
