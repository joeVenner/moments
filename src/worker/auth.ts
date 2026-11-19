import type { Context, Next } from "hono";
import { ADMIN_RETRY_AFTER_SECONDS, attemptAdminLogin } from "./adminLogin";
import type { Env } from "./types";

/** `user:pass` from a Basic header, or null when absent or malformed. */
function basicCredentials(header: string | undefined): { username: string; password: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    // Malformed base64: treated like no credentials.
    return null;
  }
}

/**
 * HTTP Basic auth for the web dashboard. Every request that carries
 * credentials goes through the shared admin lockout (adminLogin.ts), which is
 * decided before the password is compared.
 */
export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next) {
  const credentials = basicCredentials(c.req.header("Authorization"));
  if (credentials) {
    const result = await attemptAdminLogin(c.env.DB, c.env, {
      ...credentials,
      clientIp: c.req.header("CF-Connecting-IP") ?? "unknown",
    });
    if (result === "ok") return next();
    if (result === "locked") {
      c.header("Retry-After", String(ADMIN_RETRY_AFTER_SECONDS));
      return c.json({ error: "Too many attempts" }, 429);
    }
  }
  c.header("WWW-Authenticate", 'Basic realm="Moments Admin"');
  return c.json({ error: "Unauthorized" }, 401);
}
