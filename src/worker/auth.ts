import type { Context, Next } from "hono";
import type { Env } from "./types";

export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next) {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    const user = decoded.slice(0, separator);
    const pass = decoded.slice(separator + 1);
    if (user === c.env.ADMIN_USER && pass === c.env.ADMIN_PASSWORD) {
      await next();
      return;
    }
  }
  c.header("WWW-Authenticate", 'Basic realm="Moments Admin"');
  return c.json({ error: "Unauthorized" }, 401);
}
