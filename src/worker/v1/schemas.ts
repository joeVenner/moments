import { z } from "@hono/zod-openapi";
import { MAX_THUMBNAIL_BYTES } from "../thumbnails";
import { MAX_PIN_LENGTH } from "../eventAccess";
import { MAX_NICKNAME_LENGTH } from "../guestIdentity";
import { CLIENT_UPLOAD_ID_PATTERN, MAX_CAPTION_LENGTH } from "../uploadSessions";
import { CAPTION_FORBIDDEN } from "../captionText";

/**
 * Schemas for the native app API. The OpenAPI document generated from these
 * is committed at openapi/v1.json and feeds swift-openapi-generator.
 * Requests are validated against them; responses are checked in tests.
 */

const timestamp = z.string().openapi({ description: "UTC, `YYYY-MM-DD HH:MM:SS`", example: "2026-11-17 18:30:00" });
// Query values arrive as text; validated as digits, documented as integers so
// generated clients take Int.
const cursor = z.string().regex(/^\d{1,15}$/).openapi({ type: "integer", minimum: 0 });
const limit = z.string().regex(/^\d{1,4}$/).openapi({ type: "integer", minimum: 1 });

export const ErrorSchema = z
  .object({
    error: z.string(),
    code: z.string().openapi({
      description:
        "Stable machine-readable reason: invalid_request, event_not_found, access_required, invalid_access, too_many_attempts, access_unavailable, nickname_taken, guest_required, moment_not_found, rate_limited, client_upgrade_required, not_found, internal",
    }),
  })
  .openapi("Error");

export const EventSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    type: z.string(),
    main_characters: z.string().nullable(),
    description: z.string().nullable(),
    cover_image_url: z.string().nullable(),
    created_at: timestamp,
    starts_at: timestamp.nullable(),
    expires_at: timestamp.nullable().openapi({ description: "Legacy single end date; the two fields below default to it" }),
    uploads_close_at: timestamp.nullable().openapi({ description: "New uploads stop here (null = expires_at)" }),
    purge_after: timestamp.nullable().openapi({ description: "Event and media are deleted after this (null = expires_at)" }),
    archived_at: timestamp.nullable(),
    access_mode: z.enum(["public", "private"]),
    uploads_open: z.boolean().openapi({ description: "Whether new uploads are accepted right now" }),
  })
  .openapi("Event");

export const ParticipantSchema = z
  .object({
    id: z.string(),
    event_id: z.string(),
    nickname: z.string(),
    avatar_seed: z.string().nullable(),
    joined_at: timestamp,
  })
  .openapi("Participant");

export const MediaSchema = z
  .object({
    kind: z.enum(["image", "video"]),
    url: z.string().openapi({ description: "Original. `/media/...` is relative to the API origin; Stream URLs are absolute." }),
    thumb_url: z.string().nullable().openapi({ description: "About 400 px grid thumbnail" }),
    display_url: z.string().nullable().openapi({ description: "About 1600 px viewer image" }),
    poster_url: z.string().nullable(),
    hls_url: z.string().nullable().openapi({ description: "Stream videos only; 404 until processing finishes" }),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    duration_ms: z.number().int().nullable(),
    blurhash: z.string().nullable(),
  })
  .openapi("Media", {
    description:
      "For private events each `/media/...` URL carries an `at` query parameter: a signature for that one object, valid 6-12 hours and revoked when the host changes access. Use the URL as given (cache by path); refresh the feed for new signatures.",
  });

export const MomentSchema = z
  .object({
    id: z.string(),
    event_id: z.string(),
    uploader_name: z.string(),
    media_url: z.string(),
    caption: z.string().nullable(),
    points_awarded: z.number().int(),
    created_at: timestamp,
    size_bytes: z.number().int().nullable(),
    mime_type: z.string().nullable(),
    seq: z.number().int(),
    change_seq: z.number().int(),
    reaction_count: z.number().int(),
    reacted: z.boolean(),
    media: MediaSchema,
  })
  .openapi("Moment");

export const FeedPageSchema = z
  .object({
    moments: z.array(MomentSchema),
    next_before: z.number().int().nullable().openapi({ description: "Pass as `before` for older moments; null on the last page" }),
    cursor: z.number().int().openapi({ description: "Pass as `since` to the changes endpoint" }),
  })
  .openapi("FeedPage");

export const FeedChangesSchema = z
  .object({
    upserts: z.array(MomentSchema),
    removed: z.array(z.string()),
    cursor: z.number().int(),
    has_more: z.boolean().openapi({ description: "More changes are waiting; call again with `cursor` right away" }),
  })
  .openapi("FeedChanges");

export const HighlightsSchema = z
  .object({ moments: z.array(MomentSchema).openapi({ description: "Most-hearted first, newest first among ties" }) })
  .openapi("Highlights");

export const HighlightsQuerySchema = z.object({
  limit: limit.optional(),
});

export const LeaderboardEntrySchema = z
  .object({
    participant_id: z.string(),
    nickname: z.string(),
    avatar_seed: z.string().nullable(),
    total_points: z.number().int(),
    moment_count: z.number().int(),
    rank: z.number().int().openapi({ description: "1-based; equal points share a rank (1, 1, 3)" }),
  })
  .openapi("LeaderboardEntry");

export const LeaderboardSchema = z
  .object({ entries: z.array(LeaderboardEntrySchema).openapi({ description: "Best first; earlier joiners first among ties. At most 500 guests" }) })
  .openapi("Leaderboard");

export const SlugParamSchema = z.object({
  slug: z.string().min(1).max(200).openapi({ param: { name: "slug", in: "path" } }),
});

export const MomentParamSchema = SlugParamSchema.extend({
  id: z.string().min(1).max(100).openapi({ param: { name: "id", in: "path" } }),
});

export const ReactionSchema = z
  .object({
    reacted: z.boolean(),
    reaction_count: z.number().int(),
  })
  .openapi("Reaction");

export const FeedQuerySchema = z.object({
  before: cursor.optional(),
  limit: limit.optional(),
});

export const ChangesQuerySchema = z.object({
  since: cursor,
  limit: limit.optional(),
});

export const JoinRequestSchema = z
  .object({
    nickname: z.string().trim().min(1).max(MAX_NICKNAME_LENGTH),
    avatar_seed: z.string().trim().max(100).optional(),
  })
  .openapi("JoinRequest");

export const JoinResponseSchema = z
  .object({
    participant: ParticipantSchema,
    guest_token: z
      .string()
      .optional()
      .openapi({ description: "Present only when this request claimed the nickname. Store it and send it as X-Guest-Token." }),
  })
  .openapi("JoinResponse");

export const LeaveResponseSchema = z
  .object({
    done: z.boolean().openapi({
      description: "True once everything is deleted and the guest token is revoked; false: call again with the same token",
    }),
  })
  .openapi("LeaveResponse");

export const AccessRequestSchema = z
  .object({
    // Trimmed before the length check, like the web route.
    pin: z.string().trim().max(MAX_PIN_LENGTH).optional(),
    invite_token: z.string().max(200).optional().openapi({ description: "The `invite` value from the event link" }),
  })
  .refine((body) => Boolean(body.pin?.trim() || body.invite_token), { message: "pin or invite_token is required" })
  .openapi("AccessRequest");

export const AccessResponseSchema = z
  .object({
    access_token: z.string().nullable().openapi({
      description: "Send as X-Event-Access on every request for this event. Null for public events (nothing to send).",
    }),
    expires_at: timestamp.nullable().openapi({ description: "When the grant stops working; ask again after this" }),
  })
  .openapi("AccessResponse");

export const TooManyAttemptsSchema = z
  .object({
    error: z.string(),
    code: z.string().openapi({ description: "`too_many_attempts`" }),
    retry_after_seconds: z.number().int(),
  })
  .openapi("TooManyAttempts");

// Lowercase keys: Hono's header validator sees lowercased names, and HTTP
// header names are case-insensitive anyway.
const optionalHeader = (description: string) => z.string().max(512).optional().openapi({ description });

export const EventHeadersSchema = z.object({
  "x-event-access": optionalHeader("Access grant; required for private events only"),
});

/** Reads that report `reacted`: it is the token's guest's heart. */
export const ViewerHeadersSchema = EventHeadersSchema.extend({
  "x-guest-token": optionalHeader("This device's guest token; `reacted` reports this guest's hearts"),
});

export const ReactionHeadersSchema = EventHeadersSchema.extend({
  "x-guest-token": optionalHeader("This device's guest token (required: hearts belong to a joined guest)"),
});

export const JoinHeadersSchema = EventHeadersSchema.extend({
  "x-guest-token": optionalHeader("This device's guest token, if it has one for this event"),
});

export const UploadHeadersSchema = EventHeadersSchema.extend({
  "x-guest-token": optionalHeader("This device's guest token (required: uploads belong to a joined guest)"),
});

export const UploadParamSchema = SlugParamSchema.extend({
  id: z.string().min(1).max(100).openapi({ param: { name: "id", in: "path" } }),
});

export const StartUploadRequestSchema = z
  .object({
    client_upload_id: z
      .string()
      .regex(CLIENT_UPLOAD_ID_PATTERN)
      .openapi({ description: "The app's UUID for this queued item; a retried init with it returns the same session" }),
    content_type: z.string().min(1).max(100).openapi({ example: "image/jpeg" }),
    size: z.number().int().positive().openapi({ description: "Exact file size in bytes (max 512 MB)" }),
    caption: z
      .string()
      .trim()
      .max(MAX_CAPTION_LENGTH)
      // Plain text: no controls but line breaks, no bidi overrides (captionText.ts).
      .refine((value) => !CAPTION_FORBIDDEN.test(value), "caption has control or text-direction characters")
      .optional(),
    filename: z.string().max(255).optional().openapi({ description: "Original name; only sanitized letters survive in the key" }),
  })
  .openapi("StartUploadRequest");

export const UploadSessionSchema = z
  .object({
    id: z.string(),
    client_upload_id: z.string(),
    // A plain string, not an enum (see the enum guard in openapi.test.ts).
    status: z.string().openapi({ description: "`open`, `completed` or `aborted`; more may be added" }),
    content_type: z.string(),
    size: z.number().int(),
    part_size: z.number().int().openapi({ description: "Bytes per part; every part but the last is exactly this size" }),
    part_count: z.number().int(),
    created_at: timestamp,
    completed_at: timestamp.nullable(),
    moment_id: z.string().nullable().openapi({ description: "The moment this upload became, once completed" }),
  })
  .openapi("UploadSession");

export const UploadCompleteConflictSchema = z
  .object({
    error: z.string(),
    code: z.string().openapi({ description: "`upload_incomplete` or `upload_not_open`" }),
    uploaded_parts: z
      .array(z.number().int())
      .optional()
      .openapi({ description: "With `upload_incomplete`: parts R2 has; upload the rest, then complete again" }),
  })
  .openapi("UploadCompleteConflict");

export const UploadRejectedSchema = z
  .object({
    error: z.string(),
    code: z.string().openapi({ description: "`upload_rejected`" }),
    reason: z.string().openapi({ description: "`part_size_mismatch`, `object_mismatch` or `signature_mismatch`; more may be added" }),
  })
  .openapi("UploadRejected");

export const UploadStatusSchema = z
  .object({
    upload: UploadSessionSchema,
    uploaded_parts: z
      .array(z.number().int())
      .openapi({ description: "Part numbers R2 already has (open sessions only); upload the rest" }),
  })
  .openapi("UploadStatus");

export const PartUrlsRequestSchema = z
  .object({
    part_numbers: z
      .array(z.number().int().min(1))
      .min(1)
      .max(1000)
      .optional()
      .openapi({ description: "Parts to sign; omit for all of them (an empty list is an error)" }),
  })
  .openapi("PartUrlsRequest");

export const ThumbnailUrlRequestSchema = z
  .object({
    size: z
      .number()
      .int()
      .min(1)
      .max(MAX_THUMBNAIL_BYTES)
      .openapi({ description: `The thumbnail's exact size in bytes (at most ${MAX_THUMBNAIL_BYTES})` }),
  })
  .openapi("ThumbnailUrlRequest");

export const ThumbnailUrlSchema = z
  .object({
    expires_at: timestamp,
    url: z.string().openapi({
      description:
        "Presigned PUT URL for the ~400 px JPEG thumbnail. Send exactly `Content-Type: image/jpeg` and the declared size; anything else is refused. A bearer credential: never log it.",
    }),
  })
  .openapi("ThumbnailUrl");

export const PartUrlsSchema = z
  .object({
    expires_at: timestamp,
    parts: z.array(
      z.object({
        part_number: z.number().int(),
        url: z.string().openapi({ description: "Presigned PUT URL; send the part's bytes with no extra x-amz or checksum headers" }),
      })
    ),
  })
  .openapi("PartUrls");
