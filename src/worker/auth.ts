import type { Context, Next } from "hono";
import type { Env } from "./types";

export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next) {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const separator = decoded.indexOf(":");
      const user = decoded.slice(0, separator);
      const pass = decoded.slice(separator + 1);
      if (user === c.env.ADMIN_USER && pass === c.env.ADMIN_PASSWORD) {
        await next();
        return;
      }
    } catch {
      // Malformed base64 in the Authorization header — fall through to 401 below.
    }
  }

  // Only failed/missing credentials count against the limiter, so the
  // dashboard's normal authenticated GET /api/events polling is unaffected.
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.ADMIN_AUTH_LIMITER.limit({ key: ip });
  if (!success) {
    return c.json({ error: "Too many attempts" }, 429);
  }

  c.header("WWW-Authenticate", 'Basic realm="Moments Admin"');
  return c.json({ error: "Unauthorized" }, 401);
}
