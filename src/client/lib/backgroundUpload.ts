import uploadServiceWorkerUrl from "../uploadServiceWorker.ts?worker&url";
import { requestUploadBackgroundSync } from "./uploadSync";

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
  });
  await requestUploadBackgroundSync(registration);
}
