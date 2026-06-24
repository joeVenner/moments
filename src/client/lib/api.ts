import type { EventData, MomentData } from "./types";
import { getAdminAuthHeader } from "./adminAuth";

export class UnauthorizedError extends Error {}

async function asJson<T>(res: Response): Promise<T> {
  if (res.status === 401) throw new UnauthorizedError("Unauthorized");
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "request failed");
  return body as T;
}

function adminHeaders(): HeadersInit {
  const auth = getAdminAuthHeader();
  return auth ? { Authorization: auth } : {};
}

export function listEvents() {
  return fetch("/api/events", { headers: adminHeaders() }).then((r) =>
    asJson<{ events: EventData[] }>(r)
  );
}

export function createEvent(data: FormData) {
  return fetch("/api/events", { method: "POST", headers: adminHeaders(), body: data }).then((r) =>
    asJson<{ event: EventData }>(r)
  );
}

export async function verifyAdminCredentials(username: string, password: string): Promise<boolean> {
  const res = await fetch("/api/events", {
    headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` },
  });
  return res.ok;
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
