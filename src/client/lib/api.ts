import type { EventData, MomentData } from "./types";

async function asJson<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "request failed");
  return body as T;
}

export function listEvents() {
  return fetch("/api/events").then((r) => asJson<{ events: EventData[] }>(r));
}

export function createEvent(data: FormData) {
  return fetch("/api/events", { method: "POST", body: data }).then((r) =>
    asJson<{ event: EventData }>(r)
  );
}

export function getEvent(slug: string) {
  return fetch(`/api/events/${slug}`).then((r) => asJson<{ event: EventData }>(r));
}

export function listMoments(slug: string) {
  return fetch(`/api/events/${slug}/moments`).then((r) =>
    asJson<{ moments: MomentData[] }>(r)
  );
}

export function uploadMoment(slug: string, data: FormData) {
  return fetch(`/api/events/${slug}/moments`, { method: "POST", body: data }).then((r) =>
    asJson<{ moment: MomentData; points_awarded: number }>(r)
  );
}
