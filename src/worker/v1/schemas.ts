import { z } from "@hono/zod-openapi";
import { MAX_THUMBNAIL_BYTES } from "../thumbnails";
import { MAX_PIN_LENGTH, MIN_PIN_LENGTH } from "../eventAccess";
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
        "Stable machine-readable reason: invalid_request, event_not_found, access_required, invalid_access, too_many_attempts, access_unavailable, nickname_taken, guest_required, moment_not_found, rate_limited, client_upgrade_required, invalid_credentials, host_auth_required, sign_in_unavailable, media_delete_failed, plan_required, no_events_left, test_event_dates_fixed, guest_cap_reached, event_not_hosted, not_found, internal",
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

export const ReportHeadersSchema = EventHeadersSchema.extend({
  "x-guest-token": optionalHeader("This device's guest token (required: reports belong to a joined guest)"),
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

export const HostSignInRequestSchema = z
  .object({
    username: z.string().min(1).max(256),
    password: z.string().min(1).max(1024),
  })
  .openapi("HostSignInRequest");

export const HostSessionSchema = z
  .object({
    subject: z.string().openapi({ description: "Who signed in: `operator` (the admin login) for now" }),
    expires_at: z.string().openapi({ description: "UTC, `YYYY-MM-DD HH:MM:SS`; sign in again after it" }),
  })
  .openapi("HostSession");

export const HostPlanSchema = z
  .object({
    state: z.enum(["active", "canceling", "grace", "billing_retry", "lapsed", "revoked"]).openapi({
      description:
        "active: paid and renewing; canceling: paid until period_ends_at, won't renew; grace: a payment failed, full service; billing_retry: guests view only, the host reads and moderates; lapsed / revoked (refunded): the host can download until readonly_until",
    }),
    product_id: z.string().openapi({ description: "The tier in force, e.g. `host_150`" }),
    guest_cap: z.number().int().openapi({ description: "Guests per main event on this tier (joins get 10% grace above it)" }),
    pending_product_id: z.string().nullable().openapi({ description: "A downgrade that applies at the next renewal" }),
    period_ends_at: timestamp.openapi({ description: "UTC, `YYYY-MM-DD HH:MM:SS`: the end of the paid period" }),
    test_window_ends_at: timestamp.openapi({ description: "UTC, `YYYY-MM-DD HH:MM:SS`: the test event is live until then" }),
    grace_ends_at: timestamp.nullable().openapi({ description: "While in grace: when Apple's grace period ends" }),
    readonly_until: timestamp.nullable().openapi({ description: "Once the plan ended: downloads stop and data is deleted after this" }),
    can_edit: z.boolean().openapi({ description: "Create events and change their settings" }),
    can_moderate: z.boolean().openapi({ description: "Hide or delete moments" }),
    can_download: z.boolean().openapi({ description: "Open events and download everything" }),
    events_left: z
      .object({ main: z.number().int(), test: z.number().int() })
      .openapi({ description: "Events that can be created right now, by kind (0 when the plan doesn't allow creating)" }),
  })
  .openapi("HostPlan");

export const HostPlanResponseSchema = z
  .object({ plan: HostPlanSchema.nullable().openapi({ description: "Null when the host has no plan (or is the operator)" }) })
  .openapi("HostPlanResponse");

export const AdminEventSchema = EventSchema.extend({
  kind: z.enum(["legacy", "operator", "main", "test"]).openapi({
    description:
      "legacy: from before hosting plans; operator: the operator's own; main: paid by the host's plan; test: the plan's one-month test event (its dates are fixed)",
  }),
  guest_cap: z.number().int().nullable().openapi({
    description:
      "The guest limit to show the host (before the 10% grace joins allow on a main event): 15 for a test event, the plan's tier for a main event; null for no limit, or for a main event its owner's plan no longer covers",
  }),
  moment_count: z.number().int().openapi({ description: "All moments, hidden ones included" }),
  participant_count: z.number().int().openapi({ description: "Guests currently in the event (those who left are not counted)" }),
}).openapi("AdminEvent");

export const AdminEventListSchema = z
  .object({
    events: z.array(AdminEventSchema).openapi({ description: "Newest first; at most 500" }),
    truncated: z.boolean().openapi({ description: "True when older events were left out by the 500 cap" }),
  })
  .openapi("AdminEventList");

export const AdminEventParamSchema = z.object({
  id: z.string().min(1).max(100).openapi({ param: { name: "id", in: "path" }, description: "The event's id (from the events list)" }),
});

const nonNegativeCount = z.number().int().nonnegative();

export const EventAnalyticsSchema = z
  .object({
    summary: z.object({
      total_moments: nonNegativeCount,
      hidden_moments: nonNegativeCount,
      videos: nonNegativeCount,
      photos: nonNegativeCount,
      storage_bytes: nonNegativeCount.openapi({ description: "Bytes of all originals" }),
      participants: nonNegativeCount,
      reactions: nonNegativeCount,
    }),
    activity: z
      .array(z.object({ day: z.string().openapi({ description: "UTC `YYYY-MM-DD`" }), count: nonNegativeCount }))
      .openapi({ description: "Moments per UTC day since 13×24 h ago (so the oldest day may be partial), oldest first; days with none are absent" }),
    upload_states: z
      .array(z.object({ status: z.string().openapi({ description: "`open`, `completed` or `aborted` today; treat any other value as unknown" }), count: nonNegativeCount }))
      .openapi({ description: "Upload attempts by state" }),
  })
  .openapi("EventAnalytics");

export const AdminEventDetailSchema = z
  .object({
    event: AdminEventSchema,
    share: z
      .object({
        event_url: z.string().url().openapi({ description: "The guest page; put this in the QR code" }),
        invite_url: z.string().url().nullable().openapi({ description: "Private events only: opens the event without its PIN. Share with care." }),
      })
      .openapi("EventShareLinks"),
    analytics: EventAnalyticsSchema,
  })
  .openapi("AdminEventDetail");

const ModerationStatusSchema = z.enum(["approved", "hidden"]);

export const AdminMomentSchema = z
  .object({
    id: z.string(),
    event_id: z.string(),
    uploader_name: z.string(),
    caption: z.string().nullable(),
    created_at: timestamp,
    mime_type: z.string().nullable(),
    size_bytes: z.number().int().nullable(),
    moderation_status: ModerationStatusSchema.openapi({ description: "`hidden` moments are invisible to guests" }),
    reaction_count: nonNegativeCount,
    report_count: nonNegativeCount.openapi({
      description: "How many guests reported it (one report per guest); who reported is never shown",
    }),
    media: MediaSchema,
  })
  .openapi("AdminMoment", {
    description:
      "Its `/media/...` URLs carry an `mv` admin view signature (not `at`) valid 1-2 hours, so hidden moments load too; reload the list for fresh ones.",
  });

export const AdminMomentListSchema = z
  .object({
    moments: z.array(AdminMomentSchema).openapi({ description: "Newest first, hidden ones included; at most 500" }),
    truncated: z.boolean().openapi({ description: "True when older moments were left out by the 500 cap" }),
  })
  .openapi("AdminMomentList");

export const AdminMomentParamSchema = z.object({
  id: z.string().min(1).max(100).openapi({ param: { name: "id", in: "path" } }),
});

export const ModerationBodySchema = z
  .object({ status: ModerationStatusSchema.openapi({ description: "`hidden` hides it from guests; `approved` shows it again" }) })
  .openapi("ModerationRequest");

const eventTitle = z.string().trim().min(1).max(120);
const eventType = z.string().trim().min(1).max(60).openapi({ description: "Free text, e.g. Wedding, Birthday" });
const optionalText = (max: number, description: string) =>
  z.string().trim().max(max).nullable().optional().openapi({ description: `${description} Empty or null clears it.` });
/**
 * Full ISO 8601 with an explicit zone, so no host's time is silently shifted,
 * or empty to clear the date: generated clients (the iOS one) can't send an
 * explicit null, they leave the field out, which means "unchanged".
 */
const ISO_DATE_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const eventDate = (description: string) =>
  z
    .string()
    .regex(ISO_DATE_TIME)
    .nullable()
    .optional()
    .openapi({ description: `${description} ISO 8601 with a time zone (e.g. 2026-12-05T18:00:00+01:00), years 2000-2100; empty or null clears it.` });

export const CreateAdminEventBodySchema = z
  .object({
    title: eventTitle,
    type: eventType,
    main_characters: optionalText(200, "Who it's about, e.g. Sara & Omar."),
    description: optionalText(1000, "Shown to guests under the title."),
    starts_at: eventDate("When the event happens."),
    expires_at: eventDate("When uploads stop and the event is later deleted; null keeps it open. Not allowed for a test event."),
    kind: z.enum(["main", "test"]).optional().openapi({
      description:
        "Which of the plan's events to use (default main). A test event's dates come from the plan: uploads close a month after purchase and it is deleted a week later.",
    }),
  })
  .strict()
  .openapi("CreateAdminEventRequest");

export const UpdateAdminEventBodySchema = z
  .object({
    title: eventTitle.optional(),
    type: eventType.optional(),
    main_characters: optionalText(200, "Who it's about."),
    description: optionalText(1000, "Shown to guests under the title."),
    starts_at: eventDate("When the event happens."),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), { message: "nothing to change" })
  .openapi("UpdateAdminEventRequest");

export const UpdateEventAccessBodySchema = z
  .object({
    mode: z.enum(["public", "private"]).openapi({ description: "`private` needs a PIN: one sent here, or the one it already has" }),
    pin: z
      .string()
      .trim()
      .min(MIN_PIN_LENGTH)
      .max(MAX_PIN_LENGTH)
      .optional()
      .openapi({
        description: `A new PIN, ${MIN_PIN_LENGTH}-${MAX_PIN_LENGTH} characters. Never returned. Setting one signs every guest out and replaces the invite link.`,
      }),
  })
  .strict()
  .openapi("UpdateEventAccessRequest");

export const UpdateEventLifecycleBodySchema = z
  .object({
    uploads_close_at: eventDate("When guests can no longer share; may be in the past to close uploads now."),
    purge_after: eventDate("When the event and its media are deleted; must be in the future."),
    expires_at: eventDate("The single end date: closes uploads and deletes the event, so it must be in the future (to close uploads now, send uploads_close_at). Sent alone, it replaces both split dates."),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), { message: "nothing to change" })
  .openapi("UpdateEventLifecycleRequest");

export const HostSignInResponseSchema = HostSessionSchema.extend({
  token: z.string().openapi({ description: "Send as `Authorization: Bearer <token>`. Returned only here; keep it in the keychain." }),
  token_type: z.string().openapi({ description: "`Bearer`" }),
}).openapi("HostSignInResponse");
