import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { getActiveEventBySlug, toPublicEvent } from "../events";
import { verifyEventAccess } from "../eventAccess";
import {
  CHANGES_MAX_LIMIT,
  clampLimit,
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  getFeedChanges,
  getFeedPage,
  parseCursor,
} from "../feed";
import { GUEST_TOKEN_HEADER, joinEventAsGuest, toPublicParticipant } from "../guestIdentity";
import { signMomentsForEvent, STREAM_SIGNING_UNAVAILABLE, StreamSigningError } from "../streamSigning";
import type { Env, EventRow } from "../types";
import {
  ChangesQuerySchema,
  ErrorSchema,
  EventHeadersSchema,
  EventSchema,
  FeedChangesSchema,
  FeedPageSchema,
  FeedQuerySchema,
  JoinHeadersSchema,
  JoinRequestSchema,
  JoinResponseSchema,
  SlugParamSchema,
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
const eventGate: MiddlewareHandler<V1Env> = async (c, next) => {
  const event = await getActiveEventBySlug(c.env.DB, c.req.param("slug") ?? "");
  if (!event) return c.json({ error: "event not found", code: "event_not_found" }, 404);
  // v1 has no legacy clients: only a signed grant in X-Event-Access counts.
  if (!(await verifyEventAccess(c, event, undefined, { signedGrantOnly: true }))) {
    return c.json({ error: "access required", code: "access_required" }, 401);
  }
  c.set("event", event);
  return next();
};

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

v1.openapi(getEventRoute, (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ event: toPublicEvent(c.get("event")) }, 200);
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
  return c.json({ ...page, moments: await signMomentsForEvent(c.env, c.get("event"), page.moments) }, 200);
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
  return c.json({ ...changes, upserts: await signMomentsForEvent(c.env, c.get("event"), changes.upserts) }, 200);
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

export const OPENAPI_CONFIG = {
  openapi: "3.1.0",
  info: {
    title: "Moments API",
    version: "1.0.0",
    description:
      "API for the Moments native apps. Send `X-Client: ios/<version>(<build>)` on every request (set it once in a client middleware); builds below the server minimum get 426. Private-event access is still granted by the web endpoint `POST /api/events/{slug}/access` (body `{pin}` or `{invite_token}`, returns `access_token`) until it moves into v1.",
  },
  servers: [{ url: "/api/v1" }],
};

v1.doc31("/openapi.json", OPENAPI_CONFIG);

// Registered last. A mounted sub-app's notFound() is not used by the parent
// app, so unknown v1 paths get the JSON error shape from this catch-all.
v1.all("*", (c) => c.json({ error: "not found", code: "not_found" }, 404));
