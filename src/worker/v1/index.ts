import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { getActiveEventBySlug, sqlTimestamp, toPublicEvent } from "../events";
import { attemptEventAccess } from "../accessAttempt";
import { issueAccessGrant, verifyEventAccess } from "../eventAccess";
import {
  CHANGES_MAX_LIMIT,
  clampLimit,
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  getFeedChanges,
  getFeedPage,
  parseCursor,
  type FeedMoment,
} from "../feed";
import { GUEST_TOKEN_HEADER, joinEventAsGuest, resolveGuestSession, toPublicParticipant } from "../guestIdentity";
import { type ReactionState, setReaction } from "../reactions";
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
  JoinHeadersSchema,
  MomentParamSchema,
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
  const result = await joinEventAsGuest(c.env.DB, {
    eventId: c.get("event").id,
    nickname: body.nickname,
    avatarSeed: body.avatar_seed || null,
    presentedToken: c.req.header(GUEST_TOKEN_HEADER) ?? null,
    enforceClaims: c.env.GUEST_TOKENS_ENFORCED === "true",
  });
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
  const session = await resolveGuestSession(c.env.DB, event.id, c.req.header(GUEST_TOKEN_HEADER));
  if (c.env.GUEST_TOKENS_ENFORCED === "true" && !session) {
    return { ok: false, status: 403, body: { error: "join the event first", code: "guest_required" } };
  }
  if (c.env.REACTION_LIMITER) {
    const who = session ? `guest:${session.sessionId}` : `ip:${c.req.header("CF-Connecting-IP") ?? "unknown"}`;
    const { success } = await c.env.REACTION_LIMITER.limit({ key: `${event.id}:${who}` });
    if (!success) return { ok: false, status: 429, body: { error: "too many reactions", code: "rate_limited" } };
  }
  const state = await setReaction(c.env.DB, { eventId: event.id, momentId, reactorId, reacted });
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
