import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { areUploadsOpen, canFinishUploads, getActiveEventBySlug, sqlTimestamp, toPublicEvent, UPLOADS_CLOSED } from "../events";
import { isR2Configured } from "../presign";
import { R2RequestError } from "../multipartPresign";
import { finalizeUpload, r2FinalizeBackend } from "../uploadFinalize";
import {
  abortUpload,
  getOwnedUpload,
  partCount,
  presignPartUrls,
  r2MultipartBackend,
  startUpload,
  type UploadSessionRow,
} from "../uploadSessions";
import { attemptEventAccess } from "../accessAttempt";
import { issueAccessGrant, verifyEventAccess } from "../eventAccess";
import {
  CHANGES_MAX_LIMIT,
  clampLimit,
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  getFeedChanges,
  getFeedPage,
  getHighlights,
  HIGHLIGHTS_DEFAULT_LIMIT,
  HIGHLIGHTS_MAX_LIMIT,
  parseCursor,
  type FeedMoment,
} from "../feed";
import { getLeaderboard } from "../leaderboard";
import { GUEST_TOKEN_HEADER, joinEventAsGuest, resolveGuestSession, toPublicParticipant } from "../guestIdentity";
import { isJoinLimited, JOIN_RATE_LIMITED, JOIN_RETRY_AFTER_SECONDS } from "../joinLimit";
import { leaveEvent } from "../guestLeave";
import { gateReaction, type ReactionState, setReaction } from "../reactions";
import { signMomentsForEvent, STREAM_SIGNING_UNAVAILABLE, StreamSigningError } from "../streamSigning";
import { withGuestMediaGrant, withGuestMediaGrants } from "../mediaAccess";
import type { Env, EventRow } from "../types";
import {
  AccessRequestSchema,
  AccessResponseSchema,
  ChangesQuerySchema,
  ErrorSchema,
  EventHeadersSchema,
  EventSchema,
  FeedChangesSchema,
  FeedPageSchema,
  FeedQuerySchema,
  HighlightsQuerySchema,
  HighlightsSchema,
  JoinHeadersSchema,
  LeaderboardSchema,
  LeaveResponseSchema,
  MomentParamSchema,
  PartUrlsRequestSchema,
  PartUrlsSchema,
  StartUploadRequestSchema,
  UploadHeadersSchema,
  UploadParamSchema,
  UploadCompleteConflictSchema,
  UploadRejectedSchema,
  UploadSessionSchema,
  UploadStatusSchema,
  ReactionHeadersSchema,
  ReactionRequestSchema,
  ReactionSchema,
  JoinRequestSchema,
  JoinResponseSchema,
  SlugParamSchema,
  TooManyAttemptsSchema,
} from "./schemas";

/**
 * Versioned API for the native iOS app, mounted at /api/v1. It reuses the
 * service modules behind the web routes; only the HTTP contract is separate.
 * The web `/api/*` routes are unchanged.
 */

type V1Env = { Bindings: Env; Variables: { event: EventRow } };

export const CLIENT_HEADER = "X-Client";
export const EVENT_ACCESS_HEADER = "X-Event-Access";

const IOS_CLIENT = /^ios\/\d{1,4}(?:\.\d{1,4}){0,2}\((\d{1,9})\)$/;

/** Build number from `X-Client: ios/<version>(<build>)`, or null for any other client. */
export function parseIosBuild(header: string | undefined): number | null {
  const match = header ? IOS_CLIENT.exec(header) : null;
  return match ? Number(match[1]) : null;
}

/**
 * True when an iOS build is older than `MIN_IOS_BUILD` (unset or invalid = no
 * minimum). Fail-open on purpose: this is an upgrade prompt, not a security
 * control, and the header is trivially spoofable.
 */
export function isBelowMinimumBuild(build: number | null, minimum: string | undefined): boolean {
  if (build === null || !minimum || !/^\d{1,9}$/.test(minimum)) return false;
  return build < Number(minimum);
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

const commonErrors = {
  default: json(ErrorSchema, "Any other error (415, 5xx, ...)"),
  401: json(ErrorSchema, "Private event; send a grant from the access endpoint in X-Event-Access"),
  404: json(ErrorSchema, "No live event with this slug"),
  426: json(ErrorSchema, "This app build is too old; show the update screen"),
};

const getEventRoute = createRoute({
  method: "get",
  path: "/events/{slug}",
  operationId: "getEvent",
  tags: ["Guest"],
  request: { params: SlugParamSchema, headers: EventHeadersSchema },
  responses: {
    200: json(z.object({ event: EventSchema }).openapi("EventResponse"), "The event"),
    ...commonErrors,
  },
});

const getFeedRoute = createRoute({
  method: "get",
  path: "/events/{slug}/feed",
  operationId: "getFeed",
  tags: ["Guest"],
  request: { params: SlugParamSchema, query: FeedQuerySchema, headers: EventHeadersSchema },
  responses: {
    200: json(FeedPageSchema, "Newest-first page of visible moments"),
    400: json(ErrorSchema, "Invalid query"),
    ...commonErrors,
  },
});

const getHighlightsRoute = createRoute({
  method: "get",
  path: "/events/{slug}/highlights",
  operationId: "getHighlights",
  tags: ["Guest"],
  request: { params: SlugParamSchema, query: HighlightsQuerySchema, headers: EventHeadersSchema },
  responses: {
    200: json(HighlightsSchema, "The event's most-hearted visible moments"),
    400: json(ErrorSchema, "Invalid query"),
    429: json(ErrorSchema, "`rate_limited`: too many requests from this network; slow down"),
    ...commonErrors,
  },
});

const getLeaderboardRoute = createRoute({
  method: "get",
  path: "/events/{slug}/leaderboard",
  operationId: "getLeaderboard",
  tags: ["Guest"],
  request: { params: SlugParamSchema, headers: EventHeadersSchema },
  responses: {
    200: json(LeaderboardSchema, "Guests ranked by points from visible moments"),
    429: json(ErrorSchema, "`rate_limited`: too many requests from this network; slow down"),
    ...commonErrors,
  },
});

const getFeedChangesRoute = createRoute({
  method: "get",
  path: "/events/{slug}/feed/changes",
  operationId: "getFeedChanges",
  tags: ["Guest"],
  request: { params: SlugParamSchema, query: ChangesQuerySchema, headers: EventHeadersSchema },
  responses: {
    200: json(FeedChangesSchema, "Everything that changed after `since`, oldest first"),
    400: json(ErrorSchema, "Invalid query"),
    ...commonErrors,
  },
});

const joinEventRoute = createRoute({
  method: "post",
  path: "/events/{slug}/participants",
  operationId: "joinEvent",
  tags: ["Guest"],
  request: {
    params: SlugParamSchema,
    headers: JoinHeadersSchema,
    body: { content: { "application/json": { schema: JoinRequestSchema } }, required: true },
  },
  responses: {
    200: json(JoinResponseSchema, "Joined, or re-joined with the current guest token"),
    400: json(ErrorSchema, "Invalid body"),
    409: json(ErrorSchema, "`nickname_taken`: another device owns this nickname"),
    429: {
      description: "`rate_limited`: too many joins from this network; retry after `Retry-After` seconds",
      headers: z.object({ "Retry-After": z.string().optional() }),
      content: { "application/json": { schema: ErrorSchema } },
    },
    ...commonErrors,
  },
});

const reactionResponses = {
  200: json(ReactionSchema, "This device's reaction state and the moment's total"),
  400: json(ErrorSchema, "Invalid reactor id"),
  403: json(ErrorSchema, "`guest_required`: join the event first (once guest tokens are enforced)"),
  429: json(ErrorSchema, "`rate_limited`: too many reactions from this device; slow down"),
  ...commonErrors,
  404: json(ErrorSchema, "No live event with this slug, or `moment_not_found`"),
};

const addReactionRoute = createRoute({
  method: "put",
  path: "/events/{slug}/moments/{id}/reaction",
  operationId: "addReaction",
  tags: ["Guest"],
  summary: "Heart a moment (idempotent)",
  request: {
    params: MomentParamSchema,
    headers: ReactionHeadersSchema,
    body: { content: { "application/json": { schema: ReactionRequestSchema } }, required: true },
  },
  responses: reactionResponses,
});

const removeReactionRoute = createRoute({
  method: "delete",
  path: "/events/{slug}/moments/{id}/reaction",
  operationId: "removeReaction",
  tags: ["Guest"],
  summary: "Remove this device's heart (idempotent)",
  request: {
    params: MomentParamSchema,
    headers: ReactionHeadersSchema,
    // A body, not a query: keeps the reactor id out of access logs.
    body: { content: { "application/json": { schema: ReactionRequestSchema } }, required: true },
  },
  responses: reactionResponses,
});

const uploadErrors = {
  ...commonErrors,
  403: json(ErrorSchema, "`guest_required`: join first and send X-Guest-Token; or `uploads_closed`"),
  429: json(ErrorSchema, "`too_many_uploads` (open sessions) or `rate_limited`"),
  501: json(ErrorSchema, "`uploads_unavailable`: direct uploads are not configured"),
  502: json(ErrorSchema, "`storage_unavailable`: R2 failed; retry later"),
};

const leaveEventRoute = createRoute({
  method: "delete",
  path: "/events/{slug}/participants/me",
  operationId: "leaveEvent",
  tags: ["Guest"],
  summary: "Leave the event and delete what this guest shared from the app",
  description:
    "Cancels this guest's open upload sessions, deletes the moments made from their sessions (not web uploads under the same name), then revokes the guest token and frees the nickname. Resumable: repeat while `done` is false. After the last call the token no longer works, so a `guest_required` answer to a retry means it already finished.",
  request: { params: SlugParamSchema, headers: UploadHeadersSchema },
  responses: {
    200: json(LeaveResponseSchema, "Progress; repeat while `done` is false"),
    403: json(ErrorSchema, "`guest_required`: no valid guest token (already left, or never joined)"),
    429: json(ErrorSchema, "`rate_limited`"),
    502: json(ErrorSchema, "`storage_unavailable`: R2 failed; retry later"),
    ...commonErrors,
  },
});

const startUploadRoute = createRoute({
  method: "post",
  path: "/events/{slug}/uploads",
  operationId: "startUpload",
  tags: ["Uploads"],
  summary: "Open an upload session (idempotent per client_upload_id)",
  description:
    "A retry with the same client_upload_id returns the existing session (200), even after uploads close, so a lost response is always recoverable. If that session was aborted the answer is 409 `upload_not_open`: queue the item again under a new client_upload_id.",
  request: {
    params: SlugParamSchema,
    headers: UploadHeadersSchema,
    body: { content: { "application/json": { schema: StartUploadRequestSchema } }, required: true },
  },
  responses: {
    200: json(UploadSessionSchema, "This client_upload_id already has a session; here it is"),
    201: json(UploadSessionSchema, "Session opened"),
    400: json(ErrorSchema, "`invalid_upload`: unsupported type, size or caption"),
    409: json(ErrorSchema, "`upload_conflict`: this client_upload_id was used for a different file; `upload_not_open`: its session was aborted"),
    ...uploadErrors,
  },
});

const abortUploadRoute = createRoute({
  method: "delete",
  path: "/events/{slug}/uploads/{id}",
  operationId: "abortUpload",
  tags: ["Uploads"],
  summary: "Cancel a session (idempotent): its part URLs stop working and its slot is freed",
  request: { params: UploadParamSchema, headers: UploadHeadersSchema },
  responses: {
    200: json(UploadSessionSchema, "Aborted (or already was)"),
    409: json(ErrorSchema, "`upload_not_open`: already completed"),
    ...uploadErrors,
    404: json(ErrorSchema, "No live event with this slug, or `upload_not_found`"),
  },
});

const getUploadRoute = createRoute({
  method: "get",
  path: "/events/{slug}/uploads/{id}",
  operationId: "getUpload",
  tags: ["Uploads"],
  summary: "A session's state and which parts R2 already has",
  request: { params: UploadParamSchema, headers: UploadHeadersSchema },
  responses: {
    200: json(UploadStatusSchema, "The session"),
    ...uploadErrors,
    404: json(ErrorSchema, "No live event with this slug, or `upload_not_found`"),
  },
});

const partUrlsRoute = createRoute({
  method: "post",
  path: "/events/{slug}/uploads/{id}/part-urls",
  operationId: "getPartUrls",
  tags: ["Uploads"],
  summary: "Presigned PUT URLs for a session's parts, valid for 6 h",
  description:
    "The URLs are bearer credentials: never log them. When they expire, ask again for the parts still missing (see getUpload).",
  request: {
    params: UploadParamSchema,
    headers: UploadHeadersSchema,
    body: { content: { "application/json": { schema: PartUrlsRequestSchema } }, required: true },
  },
  responses: {
    200: json(PartUrlsSchema, "Signed URLs"),
    400: json(ErrorSchema, "`invalid_parts`: a part number outside the file"),
    409: json(ErrorSchema, "`upload_not_open`: completed or aborted; start a new session"),
    ...uploadErrors,
    404: json(ErrorSchema, "No live event with this slug, or `upload_not_found`"),
  },
});

const completeUploadRoute = createRoute({
  method: "post",
  path: "/events/{slug}/uploads/{id}/complete",
  operationId: "completeUpload",
  tags: ["Uploads"],
  summary: "Finish a session on the server once its parts are uploaded (idempotent)",
  description:
    "Call after the last part (from the background, one call is enough). The server checks every part's size, assembles the file, checks its type and creates the moment. A daily sweep finishes sessions nobody nudged. Safe to retry: a completed session returns 200 again.",
  request: { params: UploadParamSchema, headers: UploadHeadersSchema },
  responses: {
    200: json(UploadSessionSchema, "Completed; moment_id is the new moment"),
    409: json(UploadCompleteConflictSchema, "`upload_incomplete`: parts missing (see uploaded_parts); `upload_not_open`: aborted, queue the item again"),
    422: json(UploadRejectedSchema, "`upload_rejected`: the bytes don't match the session; it was aborted, queue the item again"),
    ...uploadErrors,
    404: json(ErrorSchema, "No live event with this slug, or `upload_not_found`"),
  },
});

const accessRoute = createRoute({
  method: "post",
  path: "/events/{slug}/access",
  operationId: "requestAccess",
  tags: ["Guest"],
  summary: "Exchange a PIN or invite token for an access grant",
  request: {
    params: SlugParamSchema,
    body: { content: { "application/json": { schema: AccessRequestSchema } }, required: true },
  },
  responses: {
    200: json(AccessResponseSchema, "Access granted (or not needed: public event)"),
    400: json(ErrorSchema, "Invalid body"),
    401: json(ErrorSchema, "`invalid_access`: wrong PIN or invite token"),
    404: json(ErrorSchema, "No live event with this slug"),
    426: json(ErrorSchema, "This app build is too old; show the update screen"),
    429: {
      ...json(TooManyAttemptsSchema, "Too many wrong PINs; wait or use the invite link"),
      // Always sent; optional in the contract so a proxy stripping it can't break decoding.
      headers: z.object({ "Retry-After": z.string().optional() }),
    },
    503: json(ErrorSchema, "`access_unavailable`: private events are temporarily unavailable"),
    default: json(ErrorSchema, "Any other error"),
  },
});

/** Rejects iOS builds below MIN_IOS_BUILD with 426 so the app can force an update. */
const clientVersionGate: MiddlewareHandler<V1Env> = async (c, next) => {
  if (isBelowMinimumBuild(parseIosBuild(c.req.header(CLIENT_HEADER)), c.env.MIN_IOS_BUILD)) {
    return c.json({ error: "Please update the app.", code: "client_upgrade_required" }, 426);
  }
  return next();
};

/**
 * Loads the live event once per request and applies the private-event gate.
 * The web gate in index.ts is registered on /api/events/* and does not cover
 * these paths, so every /events/{slug} route here must sit behind this.
 */
/** The one route the event gate lets through without a grant. Anchored: a
 * future route that merely ends in /access must not inherit the exemption. */
const ACCESS_PATH = /^\/api\/v1\/events\/[^/]+\/access$/;
const LEAVE_PATH = /^\/api\/v1\/events\/[^/]+\/participants\/me$/;

const eventGate: MiddlewareHandler<V1Env> = async (c, next) => {
  // Every event response is per-guest; covers the gate's own 401/404 too.
  c.header("Cache-Control", "no-store");
  const event = await getActiveEventBySlug(c.env.DB, c.req.param("slug") ?? "");
  if (!event) return c.json({ error: "event not found", code: "event_not_found" }, 404);
  // The unlock endpoint is the one way in, so it can't require access itself.
  if (c.req.method === "POST" && ACCESS_PATH.test(c.req.path)) {
    c.set("event", event);
    return next();
  }
  // Leaving needs only the guest's own token: a guest whose access lapsed
  // (new PIN) must still be able to delete what they shared. It reveals
  // nothing and touches only that guest's data.
  if (c.req.method === "DELETE" && LEAVE_PATH.test(c.req.path)) {
    c.set("event", event);
    return next();
  }
  // v1 has no legacy clients: only a signed grant in X-Event-Access counts.
  if (!(await verifyEventAccess(c, event, undefined, { signedGrantOnly: true }))) {
    return c.json({ error: "access required", code: "access_required" }, 401);
  }
  c.set("event", event);
  return next();
};

/** Stream playback tokens, then `?at=` on R2 URLs, for a private event. */
async function signFeedMedia<T extends FeedMoment>(env: Env, event: EventRow, moments: readonly T[]): Promise<T[]> {
  return withGuestMediaGrants(env.EVENT_ACCESS_SECRET, event, await signMomentsForEvent(env, event, moments));
}

export const v1 = new OpenAPIHono<V1Env>({
  // Zod's issue list is not part of the contract; clients get a stable shape.
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({ error: "invalid request", code: "invalid_request" }, 400);
    }
  },
});

// Client mistakes the validator raises itself (e.g. a non-JSON body) keep
// their 4xx status and the stable error shape instead of becoming a 500.
v1.onError((err, c) => {
  if (err instanceof StreamSigningError) return c.json(STREAM_SIGNING_UNAVAILABLE, 503);
  if (err instanceof HTTPException && err.status < 500) {
    return c.json({ error: "invalid request", code: "invalid_request" }, err.status);
  }
  console.error(err);
  return c.json({ error: "Internal server error", code: "internal" }, 500);
});

v1.use("*", clientVersionGate);
// Hono's "/*" also matches "/events/:slug" itself, so this one line gates
// the event route and everything below it (registering both runs it twice).
v1.use("/events/:slug/*", eventGate);

v1.openapi(getEventRoute, async (c) => {
  c.header("Cache-Control", "no-store");
  const event = c.get("event");
  const publicEvent = toPublicEvent(event);
  const cover = await withGuestMediaGrant(c.env.EVENT_ACCESS_SECRET, event, publicEvent.cover_image_url);
  return c.json({ event: { ...publicEvent, cover_image_url: cover } }, 200);
});

v1.openapi(getFeedRoute, async (c) => {
  const query = c.req.valid("query");
  const page = await getFeedPage(c.env.DB, {
    eventId: c.get("event").id,
    before: parseCursor(query.before),
    limit: clampLimit(query.limit, FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT),
    reactorId: query.reactor_id ?? "",
  });
  c.header("Cache-Control", "no-store");
  return c.json({ ...page, moments: await signFeedMedia(c.env, c.get("event"), page.moments) }, 200);
});

/**
 * Highlights and the leaderboard read the whole event on every call, so they
 * are limited per event and IP (no session lookup: reads stay one query).
 */
async function isReadLimited(c: Context<V1Env>): Promise<boolean> {
  if (!c.env.GUEST_READ_LIMITER) return false;
  const key = `${c.get("event").id}:ip:${c.req.header("CF-Connecting-IP") ?? "unknown"}`;
  return !(await c.env.GUEST_READ_LIMITER.limit({ key })).success;
}

const RATE_LIMITED = { error: "too many requests", code: "rate_limited" };

v1.openapi(getHighlightsRoute, async (c) => {
  if (await isReadLimited(c)) return c.json(RATE_LIMITED, 429);
  const query = c.req.valid("query");
  const moments = await getHighlights(c.env.DB, {
    eventId: c.get("event").id,
    limit: clampLimit(query.limit, HIGHLIGHTS_DEFAULT_LIMIT, HIGHLIGHTS_MAX_LIMIT),
    reactorId: query.reactor_id ?? "",
  });
  c.header("Cache-Control", "no-store");
  return c.json({ moments: await signFeedMedia(c.env, c.get("event"), moments) }, 200);
});

v1.openapi(getLeaderboardRoute, async (c) => {
  if (await isReadLimited(c)) return c.json(RATE_LIMITED, 429);
  c.header("Cache-Control", "no-store");
  return c.json({ entries: await getLeaderboard(c.env.DB, c.get("event").id) }, 200);
});

v1.openapi(getFeedChangesRoute, async (c) => {
  const query = c.req.valid("query");
  const changes = await getFeedChanges(c.env.DB, {
    eventId: c.get("event").id,
    since: Number(query.since),
    limit: clampLimit(query.limit, CHANGES_MAX_LIMIT, CHANGES_MAX_LIMIT),
    reactorId: query.reactor_id ?? "",
  });
  c.header("Cache-Control", "no-store");
  return c.json({ ...changes, upserts: await signFeedMedia(c.env, c.get("event"), changes.upserts) }, 200);
});

v1.openapi(joinEventRoute, async (c) => {
  const body = c.req.valid("json");
  const eventId = c.get("event").id;
  const result = await joinEventAsGuest(c.env.DB, {
    eventId,
    nickname: body.nickname,
    avatarSeed: body.avatar_seed || null,
    presentedToken: c.req.header(GUEST_TOKEN_HEADER) ?? null,
    enforceClaims: c.env.GUEST_TOKENS_ENFORCED === "true",
    isLimited: () => isJoinLimited(c.env.JOIN_LIMITER, eventId, c.req.header("CF-Connecting-IP")),
  });
  if (!result.ok && result.error === "rate_limited") {
    return c.json(JOIN_RATE_LIMITED, 429, { "Retry-After": String(JOIN_RETRY_AFTER_SECONDS) });
  }
  if (!result.ok) {
    return c.json({ error: "This nickname is already taken in this event.", code: result.error }, 409);
  }
  const participant = toPublicParticipant(result.participant);
  return c.json(result.guestToken ? { participant, guest_token: result.guestToken } : { participant }, 200);
});

type ReactionOutcome =
  | { ok: true; state: ReactionState }
  | { ok: false; status: 403 | 404 | 429; body: { error: string; code: string } };

/**
 * Shared by add and remove: guest check (when enforced), rate limit, then
 * the write. The limiter keys on the guest session when there is one, else
 * the client IP, and runs before any moment query.
 */
async function applyReaction(
  c: Context<V1Env>,
  momentId: string,
  reactorId: string,
  reacted: boolean
): Promise<ReactionOutcome> {
  const event = c.get("event");
  const gate = await gateReaction(c.env, {
    eventId: event.id,
    token: c.req.header(GUEST_TOKEN_HEADER),
    clientIp: c.req.header("CF-Connecting-IP"),
    reactorId,
  });
  if (!gate.ok) return { ok: false, status: gate.status, body: gate.body };
  const state = await setReaction(c.env.DB, { eventId: event.id, momentId, reactorId: gate.reactorId, reacted });
  if (!state) return { ok: false, status: 404, body: { error: "moment not found", code: "moment_not_found" } };
  return { ok: true, state };
}

v1.openapi(addReactionRoute, async (c) => {
  const outcome = await applyReaction(c, c.req.valid("param").id, c.req.valid("json").reactor_id, true);
  return outcome.ok ? c.json(outcome.state, 200) : c.json(outcome.body, outcome.status);
});

v1.openapi(removeReactionRoute, async (c) => {
  const outcome = await applyReaction(c, c.req.valid("param").id, c.req.valid("json").reactor_id, false);
  return outcome.ok ? c.json(outcome.state, 200) : c.json(outcome.body, outcome.status);
});

// ---------------------------------------------------------------------------
// Uploads. Every session belongs to the guest who opened it: the guest token
// is required (whatever GUEST_TOKENS_ENFORCED says; this API is new), and a
// session id from another guest or event is a 404.

const UPLOAD_NOT_FOUND = { error: "upload not found", code: "upload_not_found" };
const UPLOAD_NOT_OPEN = { error: "upload is not open; start a new one", code: "upload_not_open" };
const UPLOADS_UNAVAILABLE = { error: "Direct uploads are not configured.", code: "uploads_unavailable" };
const STORAGE_UNAVAILABLE = { error: "Storage is unavailable; try again.", code: "storage_unavailable" };

function toUploadSession(row: UploadSessionRow) {
  return {
    id: row.id,
    client_upload_id: row.client_upload_id,
    status: row.status,
    content_type: row.content_type,
    size: row.size_bytes,
    part_size: row.part_size,
    part_count: partCount(row),
    created_at: row.created_at,
    completed_at: row.completed_at,
    moment_id: row.moment_id,
  };
}

/** Ids, status and S3 error code only: R2 bodies can echo the key, and keys embed filenames. */
function logUploadError(event: string, fields: Record<string, unknown>, err: unknown) {
  const detail =
    err instanceof R2RequestError
      ? { error: err.name, operation: err.operation, status: err.status, s3Code: err.code }
      : { error: err instanceof Error ? err.name : "unknown" };
  console.error(JSON.stringify({ scope: "upload", event, ...fields, ...detail }));
}

/** The calling guest, or null; resolved from X-Guest-Token. */
async function uploadGuest(c: Context<V1Env>) {
  return resolveGuestSession(c.env.DB, c.get("event").id, c.req.header(GUEST_TOKEN_HEADER));
}

const GUEST_REQUIRED = { error: "join the event first", code: "guest_required" };

/** Per-guest limiter for the session routes that call R2. */
async function isUploadLimited(c: Context<V1Env>, sessionId: string): Promise<boolean> {
  if (!c.env.UPLOAD_LIMITER) return false;
  return !(await c.env.UPLOAD_LIMITER.limit({ key: `${c.get("event").id}:guest:${sessionId}` })).success;
}

v1.openapi(leaveEventRoute, async (c) => {
  const event = c.get("event");
  const guest = await uploadGuest(c);
  if (!guest) return c.json(GUEST_REQUIRED, 403);
  if (await isUploadLimited(c, guest.sessionId)) return c.json(RATE_LIMITED, 429);
  c.header("Cache-Control", "no-store");
  try {
    const result = await leaveEvent(c.env.DB, c.env.BUCKET, r2MultipartBackend(c.env), {
      eventId: event.id,
      participantId: guest.participant.id,
    });
    return c.json(result, 200);
  } catch (err) {
    logUploadError("v1_leave_failed", { eventId: event.id }, err);
    return c.json(STORAGE_UNAVAILABLE, 502);
  }
});

v1.openapi(startUploadRoute, async (c) => {
  const event = c.get("event");
  const guest = await uploadGuest(c);
  if (!guest) return c.json(GUEST_REQUIRED, 403);
  if (!isR2Configured(c.env)) return c.json(UPLOADS_UNAVAILABLE, 501);
  const body = c.req.valid("json");
  let result;
  try {
    result = await startUpload(
      c.env.DB,
      r2MultipartBackend(c.env),
      {
        eventId: event.id,
        participantId: guest.participant.id,
        nickname: guest.participant.nickname,
        clientUploadId: body.client_upload_id,
        contentType: body.content_type,
        size: body.size,
        caption: body.caption || null,
        filename: body.filename ?? null,
      },
      {
        canStartNew: async () => {
          if (!areUploadsOpen(event)) return "closed";
          return (await isUploadLimited(c, guest.sessionId)) ? "rate_limited" : "ok";
        },
        onCleanupError: (err) => logUploadError("v1_upload_cleanup_failed", { eventId: event.id }, err),
      }
    );
  } catch (err) {
    logUploadError("v1_upload_start_failed", { eventId: event.id, sizeBytes: body.size }, err);
    return c.json(STORAGE_UNAVAILABLE, 502);
  }
  switch (result.kind) {
    case "invalid":
      return c.json({ error: result.message, code: "invalid_upload" }, 400);
    case "conflict":
      return c.json({ error: "client_upload_id was used for a different file", code: "upload_conflict" }, 409);
    case "not_open":
      return c.json(UPLOAD_NOT_OPEN, 409);
    case "closed":
      return c.json(UPLOADS_CLOSED, 403);
    case "rate_limited":
      return c.json(RATE_LIMITED, 429);
    case "too_many_open":
      return c.json({ error: "too many uploads in progress", code: "too_many_uploads" }, 429);
    case "guest_gone":
      return c.json(GUEST_REQUIRED, 403);
    case "existing":
      return c.json(toUploadSession(result.session), 200);
    case "started":
      return c.json(toUploadSession(result.session), 201);
  }
});

v1.openapi(getUploadRoute, async (c) => {
  const event = c.get("event");
  const guest = await uploadGuest(c);
  if (!guest) return c.json(GUEST_REQUIRED, 403);
  const session = await getOwnedUpload(c.env.DB, { eventId: event.id, participantId: guest.participant.id, uploadId: c.req.valid("param").id });
  if (!session) return c.json(UPLOAD_NOT_FOUND, 404);
  if (session.status !== "open") return c.json({ upload: toUploadSession(session), uploaded_parts: [] }, 200);
  if (!isR2Configured(c.env)) return c.json(UPLOADS_UNAVAILABLE, 501);
  if (await isUploadLimited(c, guest.sessionId)) return c.json(RATE_LIMITED, 429);
  try {
    const parts = await r2MultipartBackend(c.env).listParts(session.key, session.upload_id);
    return c.json({ upload: toUploadSession(session), uploaded_parts: parts.map((p) => p.partNumber).sort((a, b) => a - b) }, 200);
  } catch (err) {
    logUploadError("v1_upload_status_failed", { eventId: event.id, uploadRecordId: session.id }, err);
    return c.json(STORAGE_UNAVAILABLE, 502);
  }
});

v1.openapi(partUrlsRoute, async (c) => {
  const event = c.get("event");
  const guest = await uploadGuest(c);
  if (!guest) return c.json(GUEST_REQUIRED, 403);
  const session = await getOwnedUpload(c.env.DB, { eventId: event.id, participantId: guest.participant.id, uploadId: c.req.valid("param").id });
  if (!session) return c.json(UPLOAD_NOT_FOUND, 404);
  if (session.status !== "open") return c.json(UPLOAD_NOT_OPEN, 409);
  // Sessions opened before the close may finish during the grace period.
  if (!canFinishUploads(event)) return c.json(UPLOADS_CLOSED, 403);
  if (!isR2Configured(c.env)) return c.json(UPLOADS_UNAVAILABLE, 501);
  if (await isUploadLimited(c, guest.sessionId)) return c.json(RATE_LIMITED, 429);
  try {
    const result = await presignPartUrls(r2MultipartBackend(c.env), session, c.req.valid("json").part_numbers);
    if (result.kind === "invalid") return c.json({ error: result.message, code: "invalid_parts" }, 400);
    return c.json({ expires_at: sqlTimestamp(result.expiresAt), parts: result.parts }, 200);
  } catch (err) {
    logUploadError("v1_upload_part_urls_failed", { eventId: event.id, uploadRecordId: session.id }, err);
    return c.json(STORAGE_UNAVAILABLE, 502);
  }
});

v1.openapi(abortUploadRoute, async (c) => {
  const event = c.get("event");
  const guest = await uploadGuest(c);
  if (!guest) return c.json(GUEST_REQUIRED, 403);
  const session = await getOwnedUpload(c.env.DB, { eventId: event.id, participantId: guest.participant.id, uploadId: c.req.valid("param").id });
  if (!session) return c.json(UPLOAD_NOT_FOUND, 404);
  if (session.status === "completed") return c.json(UPLOAD_NOT_OPEN, 409);
  if (session.status === "aborted") return c.json(toUploadSession(session), 200);
  if (!isR2Configured(c.env)) return c.json(UPLOADS_UNAVAILABLE, 501);
  if (await isUploadLimited(c, guest.sessionId)) return c.json(RATE_LIMITED, 429);
  try {
    const result = await abortUpload(c.env.DB, r2MultipartBackend(c.env), session);
    if (result.kind === "completed") return c.json(UPLOAD_NOT_OPEN, 409);
    return c.json(toUploadSession(result.session), 200);
  } catch (err) {
    logUploadError("v1_upload_abort_failed", { eventId: event.id, uploadRecordId: session.id }, err);
    return c.json(STORAGE_UNAVAILABLE, 502);
  }
});

v1.openapi(completeUploadRoute, async (c) => {
  const event = c.get("event");
  const guest = await uploadGuest(c);
  if (!guest) return c.json(GUEST_REQUIRED, 403);
  const session = await getOwnedUpload(c.env.DB, { eventId: event.id, participantId: guest.participant.id, uploadId: c.req.valid("param").id });
  if (!session) return c.json(UPLOAD_NOT_FOUND, 404);
  if (session.status === "completed") {
    // Without a moment it was deleted since (moderation): finished, not retryable.
    return session.moment_id ? c.json(toUploadSession(session), 200) : c.json(UPLOAD_NOT_OPEN, 409);
  }
  if (session.status === "aborted") return c.json(UPLOAD_NOT_OPEN, 409);
  if (!canFinishUploads(event)) return c.json(UPLOADS_CLOSED, 403);
  if (!isR2Configured(c.env)) return c.json(UPLOADS_UNAVAILABLE, 501);
  if (await isUploadLimited(c, guest.sessionId)) return c.json(RATE_LIMITED, 429);
  try {
    const result = await finalizeUpload(c.env.DB, r2FinalizeBackend(c.env), session);
    switch (result.kind) {
      case "completed":
        return c.json(toUploadSession(result.session), 200);
      case "incomplete":
        return c.json({ error: "parts are missing", code: "upload_incomplete", uploaded_parts: result.uploadedParts }, 409);
      case "rejected":
        console.warn(JSON.stringify({ scope: "upload", event: "v1_upload_rejected", eventId: event.id, uploadRecordId: session.id, reason: result.reason }));
        return c.json({ error: "the uploaded file doesn't match", code: "upload_rejected", reason: result.reason }, 422);
      case "not_open":
        return c.json(UPLOAD_NOT_OPEN, 409);
    }
  } catch (err) {
    logUploadError("v1_upload_complete_failed", { eventId: event.id, uploadRecordId: session.id }, err);
    return c.json(STORAGE_UNAVAILABLE, 502);
  }
});

// No cookie here: native clients keep the grant themselves (keychain).
v1.openapi(accessRoute, async (c) => {
  c.header("Cache-Control", "no-store");
  const event = c.get("event");
  if (event.access_mode !== "private") return c.json({ access_token: null, expires_at: null }, 200);
  const secret = c.env.EVENT_ACCESS_SECRET;
  if (!secret) {
    console.error(JSON.stringify({ msg: "event_access_secret_missing", route: "v1_access" }));
    return c.json({ error: "Private events are temporarily unavailable.", code: "access_unavailable" }, 503);
  }
  const body = c.req.valid("json");
  const result = await attemptEventAccess(c.env.DB, secret, event, {
    pin: body.pin ?? "",
    inviteToken: body.invite_token ?? "",
    clientIp: c.req.header("CF-Connecting-IP") ?? "unknown",
  });
  if (result.kind === "blocked") {
    return c.json(
      { error: "Too many attempts. Ask the host for the invitation link.", code: "too_many_attempts", retry_after_seconds: result.retryAfterSeconds },
      429,
      { "Retry-After": String(result.retryAfterSeconds) }
    );
  }
  if (result.kind === "invalid") return c.json({ error: "Wrong PIN or invitation.", code: "invalid_access" }, 401);
  const grant = await issueAccessGrant(secret, event);
  return c.json({ access_token: grant.accessToken, expires_at: sqlTimestamp(new Date(grant.expiresAt * 1000)) }, 200);
});

export const OPENAPI_CONFIG = {
  openapi: "3.1.0",
  info: {
    title: "Moments API",
    version: "1.0.0",
    description:
      "API for the Moments native apps. Send `X-Client: ios/<version>(<build>)` on every request (set it once in a client middleware); builds below the server minimum get 426. For a private event, get a grant from `POST /events/{slug}/access` and send it as `X-Event-Access`.",
  },
  servers: [{ url: "/api/v1" }],
};

v1.doc31("/openapi.json", OPENAPI_CONFIG);

// Registered last. A mounted sub-app's notFound() is not used by the parent
// app, so unknown v1 paths get the JSON error shape from this catch-all.
v1.all("*", (c) => c.json({ error: "not found", code: "not_found" }, 404));
