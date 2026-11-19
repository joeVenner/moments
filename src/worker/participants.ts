import { eventGuestCap, guestFitsSql } from "./guestCap";

/**
 * Makes sure a web uploader is one of the event's guests, whether or not
 * they went through the join step first. Never adds anyone to a full event.
 */
export async function upsertParticipant(
  db: D1Database,
  eventId: string,
  nickname: string,
  avatarSeed?: string | null
): Promise<void> {
  const existing = await db
    .prepare("SELECT id, avatar_seed FROM participants WHERE event_id = ? AND nickname = ?")
    .bind(eventId, nickname)
    .first<{ id: string; avatar_seed: string | null }>();

  if (existing) {
    // Keep the avatar the guest first picked. Re-joining with the same nickname
    // (e.g. from another device, or after clearing local storage) must NOT
    // regenerate the face everyone else already sees — only backfill a seed if
    // they originally joined without one (e.g. uploaded before going through
    // the nickname gate). Never replace an already-chosen face.
    if (avatarSeed && !existing.avatar_seed) {
      await db
        .prepare("UPDATE participants SET avatar_seed = ? WHERE id = ?")
        .bind(avatarSeed, existing.id)
        .run();
    }
    return;
  }

  // A full event adds nobody: the moment still counts, but an upload can't
  // be a way around the guest limit. Checked in the insert itself.
  await db
    .prepare(
      `INSERT INTO participants (id, event_id, nickname, avatar_seed)
       SELECT ?1, ?2, ?3, ?4 WHERE ${guestFitsSql("?5", "?2", "?3")}`
    )
    .bind(crypto.randomUUID(), eventId, nickname, avatarSeed ?? null, await eventGuestCap(db, eventId))
    .run();
}
