import { Hono } from "hono";
import type { Env, EventRow, MomentRow } from "./types";
import { slugify, randomSuffix } from "./slugify";
import { putMedia } from "./storage";

const POINTS_PER_UPLOAD = 10;

const app = new Hono<{ Bindings: Env }>();

async function uniqueSlug(db: D1Database, title: string): Promise<string> {
  const base = slugify(title) || "event";
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${randomSuffix()}`;
    const existing = await db
      .prepare("SELECT id FROM events WHERE slug = ?")
      .bind(candidate)
      .first();
    if (!existing) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

app.get("/api/events", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM events ORDER BY created_at DESC"
  ).all<EventRow>();
  return c.json({ events: results });
});

app.post("/api/events", async (c) => {
  const body = await c.req.parseBody();
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const type = typeof body.type === "string" ? body.type.trim() : "";
  const mainCharacters =
    typeof body.main_characters === "string" ? body.main_characters.trim() : null;
  const description = typeof body.description === "string" ? body.description.trim() : null;
  const cover = body.cover instanceof File && body.cover.size > 0 ? body.cover : null;

  if (!title || !type) {
    return c.json({ error: "title and type are required" }, 400);
  }

  const id = crypto.randomUUID();
  const slug = await uniqueSlug(c.env.DB, title);

  let coverImageUrl: string | null = null;
  if (cover) {
    try {
      const { url } = await putMedia(c.env, `events/${id}/cover`, cover);
      coverImageUrl = url;
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "cover upload failed" }, 400);
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO events (id, slug, title, type, main_characters, description, cover_image_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, slug, title, type, mainCharacters, description, coverImageUrl)
    .run();

  const event = await c.env.DB.prepare("SELECT * FROM events WHERE id = ?")
    .bind(id)
    .first<EventRow>();

  return c.json({ event }, 201);
});

app.get("/api/events/:slug", async (c) => {
  const event = await c.env.DB.prepare("SELECT * FROM events WHERE slug = ?")
    .bind(c.req.param("slug"))
    .first<EventRow>();
  if (!event) return c.json({ error: "event not found" }, 404);
  return c.json({ event });
});

app.get("/api/events/:slug/moments", async (c) => {
  const event = await c.env.DB.prepare("SELECT id FROM events WHERE slug = ?")
    .bind(c.req.param("slug"))
    .first<{ id: string }>();
  if (!event) return c.json({ error: "event not found" }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM moments WHERE event_id = ? ORDER BY created_at DESC"
  )
    .bind(event.id)
    .all<MomentRow>();

  return c.json({ moments: results });
});

app.post("/api/events/:slug/moments", async (c) => {
  const event = await c.env.DB.prepare("SELECT id FROM events WHERE slug = ?")
    .bind(c.req.param("slug"))
    .first<{ id: string }>();
  if (!event) return c.json({ error: "event not found" }, 404);

  const body = await c.req.parseBody();
  const uploaderName =
    typeof body.uploader_name === "string" ? body.uploader_name.trim() : "";
  const caption = typeof body.caption === "string" ? body.caption.trim() : null;
  const file = body.file instanceof File ? body.file : null;

  if (!uploaderName || !file || file.size === 0) {
    return c.json({ error: "uploader_name and file are required" }, 400);
  }

  let mediaUrl: string;
  try {
    const { url } = await putMedia(c.env, `events/${event.id}/moments`, file);
    mediaUrl = url;
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "upload failed" }, 400);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO moments (id, event_id, uploader_name, media_url, caption, points_awarded)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, event.id, uploaderName, mediaUrl, caption, POINTS_PER_UPLOAD)
    .run();

  const moment = await c.env.DB.prepare("SELECT * FROM moments WHERE id = ?")
    .bind(id)
    .first<MomentRow>();

  return c.json({ moment, points_awarded: POINTS_PER_UPLOAD }, 201);
});

app.get("/media/*", async (c) => {
  const key = c.req.path.slice("/media/".length);
  const object = await c.env.BUCKET.get(key);
  if (!object) return c.notFound();

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: object.httpEtag,
    },
  });
});

export default app;
