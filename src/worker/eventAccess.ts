import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Env, EventRow } from "./types";

const encoder = new TextEncoder();
const ITERATIONS = 100_000;

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashEventPin(pin: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: ITERATIONS },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

export function accessCookieName(eventId: string): string {
  return `moments_access_${eventId.replace(/[^a-zA-Z0-9]/g, "")}`;
}

export function hasEventAccess(c: Context<{ Bindings: Env }>, event: Pick<EventRow, "id" | "access_mode" | "invite_token">): boolean {
  if (event.access_mode !== "private") return true;
  const supplied = c.req.header("X-Event-Access") ?? getCookie(c, accessCookieName(event.id));
  return Boolean(event.invite_token && supplied === event.invite_token);
}

export function grantEventAccess(c: Context<{ Bindings: Env }>, event: Pick<EventRow, "id" | "invite_token">): void {
  if (!event.invite_token) return;
  setCookie(c, accessCookieName(event.id), event.invite_token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export function randomAccessToken(): string {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}
