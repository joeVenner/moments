import { Hono } from "hono";
import type { Env, EventRow, MomentRow, ParticipantRow, LeaderboardEntry } from "./types";
import { slugify, randomSuffix } from "./slugify";
import { putMedia, pointsForContentType } from "./storage";
import { requireAdmin } from "./auth";

const app = new Hono<{ Bindings: Env }>();

// Admin-only: listing all events and creating new ones. Guest-facing routes
// (event by slug, moments, media, participants, leaderboard) stay public.
app.use("/api/events", requireAdmin);

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

async function getEventBySlug(db: D1Database, slug: string): Promise<{ id: string } | null> {
  return db.prepare("SELECT id FROM events WHERE slug = ?").bind(slug).first<{ id: string }>();
}

async function upsertParticipant(
  db: D1Database,
  eventId: string,
  nickname: string,
  avatarSeed?: string | null
): Promise<void> {
  const existing = await db
    .prepare("SELECT id FROM participants WHERE event_id = ? AND nickname = ?")
    .bind(eventId, nickname)
    .first<{ id: string }>();

  if (existing) {
    if (avatarSeed) {
      await db
        .prepare("UPDATE participants SET avatar_seed = ? WHERE id = ?")
        .bind(avatarSeed, existing.id)
        .run();
    }
    return;
  }

  await db
    .prepare(
      `INSERT INTO participants (id, event_id, nickname, avatar_seed) VALUES (?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), eventId, nickname, avatarSeed ?? null)
    .run();
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
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM moments WHERE event_id = ? ORDER BY created_at DESC"
  )
    .bind(event.id)
    .all<MomentRow>();

  return c.json({ moments: results });
});

app.post("/api/events/:slug/moments", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
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

  const points = pointsForContentType(file.type);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO moments (id, event_id, uploader_name, media_url, caption, points_awarded)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, event.id, uploaderName, mediaUrl, caption, points)
    .run();

  // Defensive: guarantees a participant row exists even if the client somehow
  // uploaded without going through the nickname-gate join step, so the
  // leaderboard and participant strip never silently drop an uploader.
  await upsertParticipant(c.env.DB, event.id, uploaderName);

  const moment = await c.env.DB.prepare("SELECT * FROM moments WHERE id = ?")
    .bind(id)
    .first<MomentRow>();

  return c.json({ moment, points_awarded: points }, 201);
});

app.get("/api/events/:slug/participants", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM participants WHERE event_id = ? ORDER BY joined_at ASC"
  )
    .bind(event.id)
    .all<ParticipantRow>();

  return c.json({ participants: results });
});

app.post("/api/events/:slug/participants", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);

  const body = await c.req.parseBody();
  const nickname = typeof body.nickname === "string" ? body.nickname.trim() : "";
  const avatarSeed = typeof body.avatar_seed === "string" ? body.avatar_seed.trim() : null;

  if (!nickname) {
    return c.json({ error: "nickname is required" }, 400);
  }

  await upsertParticipant(c.env.DB, event.id, nickname, avatarSeed);

  const participant = await c.env.DB.prepare(
    "SELECT * FROM participants WHERE event_id = ? AND nickname = ?"
  )
    .bind(event.id, nickname)
    .first<ParticipantRow>();

  return c.json({ participant }, 200);
});

app.get("/api/events/:slug/leaderboard", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT
       p.nickname AS uploader_name,
       COALESCE(SUM(m.points_awarded), 0) AS total_points,
       COUNT(m.id) AS moment_count
     FROM participants p
     LEFT JOIN moments m ON m.event_id = p.event_id AND m.uploader_name = p.nickname
     WHERE p.event_id = ?
     GROUP BY p.nickname
     ORDER BY total_points DESC, p.joined_at ASC`
  )
    .bind(event.id)
    .all<LeaderboardEntry>();

  return c.json({ leaderboard: results });
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
