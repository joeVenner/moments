import uploadServiceWorkerUrl from "../uploadServiceWorker.ts?worker&url";
import { requestUploadBackgroundSync } from "./uploadSync";
import { GUEST_REQUIRED_EVENT, guestRequiredDetail } from "./guestRequired";

export async function registerUploadServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.register(uploadServiceWorkerUrl, {
    type: "module",
    scope: "/",
  });
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.type === "moment-upload-completed") {
      window.dispatchEvent(new CustomEvent("moment-upload-completed", { detail: event.data }));
    }
    const refusal = guestRequiredDetail(event.data);
    if (refusal) window.dispatchEvent(new CustomEvent(GUEST_REQUIRED_EVENT, { detail: refusal }));
  });
  await requestUploadBackgroundSync(registration);
}
