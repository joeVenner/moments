import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { areUploadsOpen, canFinishUploads, getActiveEventBySlug, sqlTimestamp, toPublicEvent, UPLOADS_CLOSED } from "../events";
import { isR2Configured } from "../presign";
import { presignBoundPutUrl, R2RequestError } from "../multipartPresign";
import { MAX_THUMBNAIL_BYTES, THUMBNAIL_CONTENT_TYPE, THUMBNAIL_URL_TTL_SECONDS, thumbnailKeys, thumbnailUploadKey } from "../thumbnails";
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
import { leaveEvent, leaveStorage } from "../guestLeave";
import { gateReaction, type ReactionState, setReaction, viewerReactorId } from "../reactions";
import { signMomentsForEvent, STREAM_SIGNING_UNAVAILABLE, StreamSigningError } from "../streamSigning";
import { withGuestMediaGrant, withGuestMediaGrants } from "../mediaAccess";
import type { Env, EventRow } from "../types";
import {
  bearerToken,
  createHostSession,
  deleteHostSession,
  type HostSession,
  isHostSignInConfigured,
  resolveHostSession,
} from "../hostSessions";
import { ADMIN_RETRY_AFTER_SECONDS, attemptAdminLogin } from "../adminLogin";
import { getAdminEventDetail, listAdminEvents } from "../adminEvents";
import { findHostEvent, findHostMomentEvent, ownerScope, type HostEventRef } from "../eventOwnership";
import {
  insertEvent,
  insertPlanEvent,
  normalizeDate,
  type NewEvent,
  type PlanEventDates,
  type PlanEventSpec,
  updateEventDetails,
} from "../eventWrites";
import { planAccess, testEventDates } from "../plans";
import { loadLivePlan } from "../plansRepo";
import { canGuestsShare, canGuestsView, EVENT_NOT_HOSTED, eventPlanAccess } from "../eventPlanAccess";
import { lifecycleChangeFrom, type SettingsResult, updateEventAccess, updateEventLifecycle } from "../eventSettings";
import { deleteAdminMoment, listAdminMoments, setMomentModeration } from "../adminModeration";
import {
  AccessRequestSchema,
  AccessResponseSchema,
  AdminEventDetailSchema,
  AdminEventListSchema,
  AdminEventParamSchema,
  AdminMomentListSchema,
  AdminMomentParamSchema,
  AdminMomentSchema,
  ModerationBodySchema,
  CreateAdminEventBodySchema,
  UpdateAdminEventBodySchema,
  UpdateEventAccessBodySchema,
  UpdateEventLifecycleBodySchema,
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
  ThumbnailUrlRequestSchema,
  ThumbnailUrlSchema,
  UploadHeadersSchema,
  UploadParamSchema,
  UploadCompleteConflictSchema,
  UploadRejectedSchema,
  UploadSessionSchema,
  UploadStatusSchema,
  ReactionHeadersSchema,
  ViewerHeadersSchema,
  ReactionSchema,
  JoinRequestSchema,
  JoinResponseSchema,
  SlugParamSchema,
  TooManyAttemptsSchema,
  HostSessionSchema,
  HostSignInRequestSchema,
  HostSignInResponseSchema,
} from "./schemas";

/**
 * Versioned API for the native iOS app, mounted at /api/v1. It reuses the
 * service modules behind the web routes; only the HTTP contract is separate.
 * The web `/api/*` routes are unchanged.
 */

type V1Env = { Bindings: Env; Variables: { event: EventRow; hostSession: HostSession } };

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
  410: json(ErrorSchema, "`event_not_hosted`: the host's plan no longer covers this event; show that it is no longer hosted"),
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
  request: { params: SlugParamSchema, query: FeedQuerySchema, headers: ViewerHeadersSchema },
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
  request: { params: SlugParamSchema, query: HighlightsQuerySchema, headers: ViewerHeadersSchema },
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
  request: { params: SlugParamSchema, query: ChangesQuerySchema, headers: ViewerHeadersSchema },
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
    409: json(ErrorSchema, "`nickname_taken`: another device owns this nickname; `guest_cap_reached`: the event has as many guests as its plan allows (guests already in it can always rejoin)"),
    429: {
      description: "`rate_limited`: too many joins from this network; retry after `Retry-After` seconds",
      headers: z.object({ "Retry-After": z.string().optional() }),
      content: { "application/json": { schema: ErrorSchema } },
    },
    ...commonErrors,
  },
});

const reactionResponses = {
  200: json(ReactionSchema, "The guest's reaction state and the moment's total"),
  400: json(ErrorSchema, "`invalid_request`: a malformed moment id"),
  403: json(ErrorSchema, "`guest_required`: join the event first: no X-Guest-Token was sent, or it is unknown (the guest left)"),
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
  summary: "Leave the event and delete what this guest shared",
  description:
    "Cancels this guest's open uploads, deletes every moment shared with this guest token (not moments under the same name shared without it), then revokes the guest token and frees the nickname. Resumable: repeat while `done` is false. After the last call the token no longer works, so a `guest_required` answer to a retry means it already finished.",
  request: { params: SlugParamSchema, headers: UploadHeadersSchema },
  responses: {
    200: json(LeaveResponseSchema, "Progress; repeat while `done` is false"),
    403: json(ErrorSchema, "`guest_required`: no valid guest token (already left, or never joined)"),
    429: json(ErrorSchema, "`rate_limited`"),
    502: json(ErrorSchema, "`storage_unavailable`: R2 or Stream failed; retry later"),
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

const thumbnailUrlRoute = createRoute({
  method: "post",
  path: "/events/{slug}/uploads/{id}/thumbnail-url",
  operationId: "getThumbnailUrl",
  tags: ["Uploads"],
  summary: "A presigned PUT URL for the session's grid thumbnail, valid for 6 h (optional)",
  description:
    `Optional. Call after startUpload and before completeUpload, with the thumbnail's exact size. PUT the ~400 px JPEG to \`url\` with \`Content-Type: image/jpeg\` and a body of exactly \`size\` bytes (at most ${MAX_THUMBNAIL_BYTES}), no other headers; R2 refuses anything else. completeUpload checks it (a whole JPEG) and the feed serves it as \`thumb_url\`. A thumbnail sent after completeUpload, or a missing or bad one, is dropped: the moment completes without \`thumb_url\`. Asking again gives a new URL.`,
  request: {
    params: UploadParamSchema,
    headers: UploadHeadersSchema,
    body: { content: { "application/json": { schema: ThumbnailUrlRequestSchema } }, required: true },
  },
  responses: {
    200: json(ThumbnailUrlSchema, "Signed URL"),
    400: json(ErrorSchema, "Invalid body (size missing or too large)"),
    409: json(ErrorSchema, "`upload_not_open`: completed or aborted; complete without a thumbnail"),
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
    "Call after the last part (from the background, one call is enough). The server checks every part's size, assembles the file, checks its type and creates the moment. An hourly sweep finishes sessions nobody nudged. Safe to retry: a completed session returns 200 again.",
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

const HOST_SECURITY = [{ hostSession: [] }];

const signInRoute = createRoute({
  method: "post",
  path: "/admin/session",
  operationId: "signIn",
  tags: ["Host"],
  summary: "Sign in as a host and get a bearer token",
  description:
    "Uses the admin username and password for now. Every attempt counts against a per-IP limit (10 a minute), right or wrong, and failed logins share a 15-minute lockout with the web dashboard.",
  request: { body: { content: { "application/json": { schema: HostSignInRequestSchema } }, required: true } },
  responses: {
    201: json(HostSignInResponseSchema, "Signed in; the token is shown only here"),
    400: json(ErrorSchema, "`invalid_request`: missing or oversized username or password"),
    401: json(ErrorSchema, "`invalid_credentials`: wrong username or password"),
    426: json(ErrorSchema, "This app build is too old; show the update screen"),
    429: {
      ...json(ErrorSchema, "`rate_limited`: too many sign-in attempts from this network, or too many failed admin logins overall; wait for Retry-After"),
      headers: z.object({ "Retry-After": z.string().optional() }),
    },
    503: json(ErrorSchema, "`sign_in_unavailable`: host sign-in is not set up on this server"),
    default: json(ErrorSchema, "Any other error"),
  },
});

const getSessionRoute = createRoute({
  method: "get",
  path: "/admin/session",
  operationId: "getHostSession",
  tags: ["Host"],
  summary: "Check the current host session",
  security: HOST_SECURITY,
  responses: {
    200: json(HostSessionSchema, "The session is live"),
    401: json(ErrorSchema, "`host_auth_required`: no token, or it expired, was signed out, or the admin password changed"),
    426: json(ErrorSchema, "This app build is too old; show the update screen"),
    default: json(ErrorSchema, "Any other error"),
  },
});

const listAdminEventsRoute = createRoute({
  method: "get",
  path: "/admin/events",
  operationId: "listAdminEvents",
  tags: ["Host"],
  summary: "Every event, newest first, with moment and guest counts",
  security: HOST_SECURITY,
  responses: {
    200: json(AdminEventListSchema, "The host's events"),
    401: json(ErrorSchema, "`host_auth_required`: sign in again"),
    426: json(ErrorSchema, "This app build is too old; show the update screen"),
    default: json(ErrorSchema, "Any other error"),
  },
});

/** On every host route that takes an event or moment id (see ownerGate). */
const planGated = {
  402: json(
    ErrorSchema,
    "`plan_required`: on an event a plan pays for, the host's plan no longer allows this (editing, moderating, or downloading after the read-only window)"
  ),
};

const getAdminEventRoute = createRoute({
  method: "get",
  path: "/admin/events/{id}",
  operationId: "getAdminEvent",
  tags: ["Host"],
  summary: "One event with its share links and analytics",
  security: HOST_SECURITY,
  request: { params: AdminEventParamSchema },
  responses: {
    200: json(AdminEventDetailSchema, "The event"),
    401: json(ErrorSchema, "`host_auth_required`: sign in again"),
    404: json(ErrorSchema, "`event_not_found`"),
    ...planGated,
    426: json(ErrorSchema, "This app build is too old; show the update screen"),
    default: json(ErrorSchema, "Any other error"),
  },
});

const hostErrors = {
  401: json(ErrorSchema, "`host_auth_required`: sign in again"),
  426: json(ErrorSchema, "This app build is too old; show the update screen"),
  default: json(ErrorSchema, "Any other error"),
};

const listAdminMomentsRoute = createRoute({
  method: "get",
  path: "/admin/events/{id}/moments",
  operationId: "listAdminMoments",
  tags: ["Host"],
  summary: "Every moment of an event, hidden ones included, for moderation",
  security: HOST_SECURITY,
  request: { params: AdminEventParamSchema },
  responses: {
    200: json(AdminMomentListSchema, "The moments"),
    404: json(ErrorSchema, "`event_not_found`"),
    ...planGated,
    ...hostErrors,
  },
});

const moderateMomentRoute = createRoute({
  method: "patch",
  path: "/admin/moments/{id}",
  operationId: "moderateMoment",
  tags: ["Host"],
  summary: "Hide a moment from guests, or show it again",
  security: HOST_SECURITY,
  request: { params: AdminMomentParamSchema, body: { required: true, content: { "application/json": { schema: ModerationBodySchema } } } },
  responses: {
    200: json(z.object({ moment: AdminMomentSchema }).openapi("AdminMomentResponse"), "The moment as it is now"),
    404: json(ErrorSchema, "`moment_not_found`"),
    ...planGated,
    ...hostErrors,
  },
});

const deleteMomentRoute = createRoute({
  method: "delete",
  path: "/admin/moments/{id}",
  operationId: "deleteMoment",
  tags: ["Host"],
  summary: "Delete a moment and its files for good",
  security: HOST_SECURITY,
  request: { params: AdminMomentParamSchema },
  responses: {
    204: { description: "Deleted" },
    404: json(ErrorSchema, "`moment_not_found`"),
    ...planGated,
    502: json(ErrorSchema, "`media_delete_failed`: the files couldn't be removed; nothing was deleted, try again"),
    ...hostErrors,
  },
});

const createAdminEventRoute = createRoute({
  method: "post",
  path: "/admin/events",
  operationId: "createAdminEvent",
  tags: ["Host"],
  summary: "Create an event (public, open for uploads); its slug comes from the title",
  security: HOST_SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: CreateAdminEventBodySchema } } } },
  responses: {
    201: json(AdminEventDetailSchema, "The new event"),
    400: json(ErrorSchema, "`invalid_request`: a missing title or type, a field too long, a bad date, an end date that is past or before the start, an end date on a test event, or a test event asked for by the operator"),
    402: json(ErrorSchema, "`plan_required`: no hosting plan that allows new events (none, ended, or a payment is failing)"),
    409: json(ErrorSchema, "`no_events_left`: every event of that kind the plan includes is used (an Extra event adds a main one), or the test event's month is over"),
    429: json(ErrorSchema, "`rate_limited`: too many new events in a minute; see Retry-After"),
    ...hostErrors,
  },
});

const updateAdminEventRoute = createRoute({
  method: "patch",
  path: "/admin/events/{id}",
  operationId: "updateAdminEvent",
  tags: ["Host"],
  summary: "Change an event's title, type, people, description or date; the slug (and so its links) never changes",
  security: HOST_SECURITY,
  request: {
    params: AdminEventParamSchema,
    body: { required: true, content: { "application/json": { schema: UpdateAdminEventBodySchema } } },
  },
  responses: {
    200: json(AdminEventDetailSchema, "The event as it is now"),
    400: json(ErrorSchema, "`invalid_request`: nothing to change, an empty title or type, a field too long, or a bad date"),
    404: json(ErrorSchema, "`event_not_found`"),
    ...planGated,
    ...hostErrors,
  },
});

const updateEventAccessRoute = createRoute({
  method: "patch",
  path: "/admin/events/{id}/access",
  operationId: "updateEventAccess",
  tags: ["Host"],
  summary: "Make an event public or private, optionally with a new PIN",
  security: HOST_SECURITY,
  request: {
    params: AdminEventParamSchema,
    body: { required: true, content: { "application/json": { schema: UpdateEventAccessBodySchema } } },
  },
  responses: {
    200: json(AdminEventDetailSchema, "The event as it is now (with the new invite link when the PIN changed)"),
    400: json(ErrorSchema, "`invalid_request`: an unknown mode, a PIN of the wrong length, or private with no PIN"),
    404: json(ErrorSchema, "`event_not_found`"),
    ...planGated,
    ...hostErrors,
  },
});

const updateEventLifecycleRoute = createRoute({
  method: "patch",
  path: "/admin/events/{id}/lifecycle",
  operationId: "updateEventLifecycle",
  tags: ["Host"],
  summary: "Change when uploads close and when the event is deleted; un-archives it",
  security: HOST_SECURITY,
  request: {
    params: AdminEventParamSchema,
    body: { required: true, content: { "application/json": { schema: UpdateEventLifecycleBodySchema } } },
  },
  responses: {
    200: json(AdminEventDetailSchema, "The event as it is now"),
    400: json(ErrorSchema, "`invalid_request`: nothing to change, a bad date, a deletion date in the past, or uploads closing after deletion"),
    404: json(ErrorSchema, "`event_not_found`"),
    ...planGated,
    409: json(ErrorSchema, "`test_event_dates_fixed`: a test event's dates come from the plan"),
    ...hostErrors,
  },
});

const signOutRoute = createRoute({
  method: "delete",
  path: "/admin/session",
  operationId: "signOut",
  tags: ["Host"],
  summary: "Sign out: the token stops working",
  security: HOST_SECURITY,
  responses: {
    204: { description: "Signed out" },
    401: json(ErrorSchema, "`host_auth_required`: no live session for this token"),
    426: json(ErrorSchema, "This app build is too old; show the update screen"),
    default: json(ErrorSchema, "Any other error"),
  },
});

/** Exact match: `POST /admin/session/` or any other spelling stays gated. */
const SIGN_IN_PATH = `/api/v1${signInRoute.path}`;
const HOST_AUTH_REQUIRED = { error: "Sign in again.", code: "host_auth_required" };

/**
 * Every /admin route needs a live host session, except signing in. Sessions
 * are checked on each request (one indexed query), so signing out or
 * changing the admin password takes effect at once.
 */
const hostGate: MiddlewareHandler<V1Env> = async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method === "POST" && c.req.path === SIGN_IN_PATH) return next();
  const token = bearerToken(c.req.header("Authorization"));
  const session = token ? await resolveHostSession(c.env.DB, c.env, token) : null;
  if (!session) {
    c.header("WWW-Authenticate", 'Bearer realm="Moments"');
    return c.json(HOST_AUTH_REQUIRED, 401);
  }
  c.set("hostSession", session);
  return next();
};

const EVENT_NOT_FOUND = { error: "Event not found.", code: "event_not_found" } as const;
const MOMENT_NOT_FOUND = { error: "Moment not found.", code: "moment_not_found" } as const;

/** A host route on a plan event that the host's plan no longer covers. */
const HOST_PLAN_REQUIRED = { error: "Your hosting plan doesn't cover this any more.", code: "plan_required" } as const;

/** Which of the plan's host rights a request needs. */
type HostRight = "hostCanEdit" | "hostCanModerate" | "hostCanDownload";

/**
 * Another host's event or moment answers exactly like a missing one (404),
 * so ids can't be probed. Then, on an event a plan pays for, the host's plan
 * must still allow what the request does (402 otherwise): a lapsed host can
 * download until the read-only window ends but no longer edit. The operator
 * passes for every event.
 */
function ownerGate(
  find: (db: D1Database, session: HostSession, id: string) => Promise<HostEventRef | null>,
  notFound: typeof EVENT_NOT_FOUND | typeof MOMENT_NOT_FOUND,
  rightFor: (method: string) => HostRight
): MiddlewareHandler<V1Env> {
  return async (c, next) => {
    const id = c.req.param("id") ?? "";
    // A malformed id reaches no query: the route's validator answers 400.
    if (id.length === 0 || id.length > 100) return next();
    const session = c.get("hostSession");
    const event = await find(c.env.DB, session, id);
    if (!event) return c.json(notFound, 404);
    if (session.role !== "operator" && !(await eventPlanAccess(c.env.DB, event))[rightFor(c.req.method)]) {
      return c.json(HOST_PLAN_REQUIRED, 402);
    }
    return next();
  };
}

// Rights follow the HTTP method: reading an event or its moments is
// downloading, any other method changes it. A future read that isn't a GET
// would need the edit right: it fails closed, never open.
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const eventOwnerGate = ownerGate(findHostEvent, EVENT_NOT_FOUND, (method) =>
  READ_METHODS.has(method) ? "hostCanDownload" : "hostCanEdit"
);
// Moment routes hide, show or delete: moderation.
const momentOwnerGate = ownerGate(findHostMomentEvent, MOMENT_NOT_FOUND, () => "hostCanModerate");

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
  if (!(await canGuestsView(c.env.DB, event))) return c.json(EVENT_NOT_HOSTED, 410);
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
v1.use("/admin/*", hostGate);
// After hostGate: every route on one event or moment checks its owner first.
v1.use("/admin/events/:id", eventOwnerGate);
v1.use("/admin/events/:id/*", eventOwnerGate);
v1.use("/admin/moments/:id", momentOwnerGate);
v1.use("/admin/moments/:id/*", momentOwnerGate);

v1.openapi(signInRoute, async (c) => {
  // Counted before the password is checked, right or wrong: otherwise a
  // limited client could still tell a correct guess from a wrong one.
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await c.env.ADMIN_AUTH_LIMITER.limit({ key: `host-sign-in:${ip}` })).success) {
    return c.json({ error: "Too many attempts. Try again in a minute.", code: "rate_limited" }, 429, { "Retry-After": "60" });
  }
  if (!isHostSignInConfigured(c.env)) {
    console.error(JSON.stringify({ msg: "host_sign_in_unconfigured" }));
    return c.json({ error: "Sign-in is not available right now.", code: "sign_in_unavailable" }, 503);
  }
  const { username, password } = c.req.valid("json");
  // The same lockout as the web dashboard's login, checked before the password.
  const result = await attemptAdminLogin(c.env.DB, c.env, { username, password, clientIp: ip });
  if (result === "locked") {
    return c.json(
      { error: "Too many attempts. Try again later.", code: "rate_limited" },
      429,
      { "Retry-After": String(ADMIN_RETRY_AFTER_SECONDS) }
    );
  }
  if (result === "invalid") {
    // Never the username, the password or the IP.
    console.warn(JSON.stringify({ msg: "host_sign_in_failed" }));
    return c.json({ error: "Wrong username or password.", code: "invalid_credentials" }, 401);
  }
  const { token, session } = await createHostSession(c.env.DB, c.env);
  return c.json({ token, token_type: "Bearer", subject: session.subject, expires_at: session.expiresAt }, 201);
});

v1.openapi(getSessionRoute, (c) => {
  const session = c.get("hostSession");
  return c.json({ subject: session.subject, expires_at: session.expiresAt }, 200);
});

v1.openapi(listAdminEventsRoute, async (c) => {
  return c.json(await listAdminEvents(c.env.DB, c.env.EVENT_ACCESS_SECRET, ownerScope(c.get("hostSession"))), 200);
});

v1.openapi(getAdminEventRoute, async (c) => {
  const { id } = c.req.valid("param");
  const detail = await getAdminEventDetail(c.env.DB, c.env.EVENT_ACCESS_SECRET, id, new URL(c.req.url).origin);
  if (!detail) return c.json(EVENT_NOT_FOUND, 404);
  return c.json(detail, 200);
});

v1.openapi(listAdminMomentsRoute, async (c) => {
  const list = await listAdminMoments(c.env, c.req.valid("param").id);
  if (!list) return c.json(EVENT_NOT_FOUND, 404);
  return c.json(list, 200);
});

v1.openapi(moderateMomentRoute, async (c) => {
  const moment = await setMomentModeration(c.env, c.req.valid("param").id, c.req.valid("json").status);
  if (!moment) return c.json(MOMENT_NOT_FOUND, 404);
  return c.json({ moment }, 200);
});

v1.openapi(deleteMomentRoute, async (c) => {
  const id = c.req.valid("param").id;
  try {
    if ((await deleteAdminMoment(c.env, id)) === "not_found") {
      return c.json(MOMENT_NOT_FOUND, 404);
    }
  } catch (error) {
    // Only the error type: storage messages can name internal endpoints.
    console.error(JSON.stringify({ msg: "admin_moment_delete_failed", moment_id: id, reason: error instanceof Error ? error.name : "unknown" }));
    return c.json({ error: "The files couldn't be deleted. Try again.", code: "media_delete_failed" }, 502);
  }
  return c.body(null, 204);
});

/** Optional text as stored (already trimmed): empty means none; undefined leaves it. */
const storedText = (value: string | null | undefined): string | null | undefined =>
  value === undefined ? undefined : value || null;

/** A 400 that names the field, so the app can point at it. */
const invalidField = (field: string) => ({ error: `${field} is invalid`, code: "invalid_request" }) as const;

/** Each host may create a few events a minute: plenty by hand, not a flood. */
async function isCreateLimited(c: Context<V1Env>): Promise<boolean> {
  return !(await c.env.ADMIN_AUTH_LIMITER.limit({ key: `host-create:${c.get("hostSession").id}` })).success;
}

/**
 * A host's event, paid for by one of their plan's events: its id, or why
 * there is none. The operator's events need no plan.
 */
async function insertHostEvent(
  db: D1Database,
  event: NewEvent,
  kind: PlanEventSpec["kind"]
): Promise<string | "plan_required" | "no_events_left"> {
  const now = new Date();
  const stored = await loadLivePlan(db, event.ownerUserId);
  if (!stored || !planAccess(stored.plan, now).hostCanEdit) return "plan_required";
  let dates: PlanEventDates | null = null;
  if (kind === "test") {
    // The test event lives for the plan's first month, whenever it is created.
    const { closesAt, purgeAt } = testEventDates(stored.plan);
    if (now >= closesAt) return "no_events_left";
    dates = { uploadsCloseAt: sqlTimestamp(closesAt), purgeAfter: sqlTimestamp(purgeAt) };
  }
  return (await insertPlanEvent(db, event, { id: stored.id, kind, dates })) ?? "no_events_left";
}

v1.openapi(createAdminEventRoute, async (c) => {
  const body = c.req.valid("json");
  const startsAt = normalizeDate(body.starts_at ?? null);
  if (startsAt === undefined) return c.json(invalidField("starts_at"), 400);
  const expiresAt = normalizeDate(body.expires_at ?? null);
  // A past end would close and purge the new event on the next cleanup run.
  if (expiresAt === undefined || (expiresAt !== null && expiresAt <= sqlTimestamp(new Date()))) {
    return c.json(invalidField("expires_at"), 400);
  }
  if (expiresAt !== null && startsAt !== null && expiresAt < startsAt) return c.json(invalidField("expires_at"), 400);
  if (await isCreateLimited(c)) {
    return c.json({ error: "Too many new events; try again in a minute.", code: "rate_limited" }, 429, { "Retry-After": "60" });
  }
  const session = c.get("hostSession");
  const event: NewEvent = {
    title: body.title,
    type: body.type,
    mainCharacters: storedText(body.main_characters) ?? null,
    description: storedText(body.description) ?? null,
    coverImageUrl: null,
    startsAt,
    expiresAt,
    ownerUserId: session.userId,
  };
  const kind = body.kind ?? "main";
  if (kind === "test" && session.role === "operator") return c.json(invalidField("kind"), 400);
  if (kind === "test" && body.expires_at) return c.json(invalidField("expires_at"), 400);
  const created =
    session.role === "operator" ? await insertEvent(c.env.DB, event) : await insertHostEvent(c.env.DB, event, kind);
  if (created === "plan_required") {
    return c.json({ error: "A hosting plan is needed to create events.", code: "plan_required" }, 402);
  }
  if (created === "no_events_left") return c.json({ error: "Your plan has no events left.", code: "no_events_left" }, 409);
  const id = created;
  const detail = await getAdminEventDetail(c.env.DB, c.env.EVENT_ACCESS_SECRET, id, new URL(c.req.url).origin);
  if (!detail) throw new HTTPException(500, { message: "created event missing" });
  return c.json(detail, 201);
});

v1.openapi(updateAdminEventRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const startsAt = body.starts_at === undefined ? undefined : normalizeDate(body.starts_at);
  if (body.starts_at !== undefined && startsAt === undefined) return c.json(invalidField("starts_at"), 400);
  const found = await updateEventDetails(c.env.DB, id, {
    title: body.title,
    type: body.type,
    mainCharacters: storedText(body.main_characters),
    description: storedText(body.description),
    startsAt,
  });
  if (!found) return c.json(EVENT_NOT_FOUND, 404);
  const detail = await getAdminEventDetail(c.env.DB, c.env.EVENT_ACCESS_SECRET, id, new URL(c.req.url).origin);
  if (!detail) return c.json(EVENT_NOT_FOUND, 404);
  return c.json(detail, 200);
});

/** The event detail after a settings change, or the refusal as a v1 error. */
async function settingsAnswer(c: Context<V1Env>, id: string, result: SettingsResult) {
  if (result.kind === "not_found") return c.json(EVENT_NOT_FOUND, 404);
  if (result.kind === "invalid") return c.json({ error: result.error, code: "invalid_request" }, 400);
  // Only the dates route can answer this; the owner gate has already sent anyone else a 404.
  if (result.kind === "dates_fixed") return c.json({ error: result.error, code: "test_event_dates_fixed" }, 409);
  const detail = await getAdminEventDetail(c.env.DB, c.env.EVENT_ACCESS_SECRET, id, new URL(c.req.url).origin);
  if (!detail) return c.json(EVENT_NOT_FOUND, 404);
  return c.json(detail, 200);
}

v1.openapi(updateEventAccessRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { mode, pin } = c.req.valid("json");
  const result = await updateEventAccess(c.env, id, { mode, pin }, (work) => c.executionCtx.waitUntil(work));
  return settingsAnswer(c, id, result);
});

v1.openapi(updateEventLifecycleRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const parsed = lifecycleChangeFrom(body);
  if (parsed.kind === "invalid") return c.json(invalidField(parsed.field), 400);
  // A past deletion date would delete the event at the next cleanup run;
  // closing uploads now is fine. Both sides are "YYYY-MM-DD HH:MM:SS" UTC, so
  // text order is time order.
  const now = sqlTimestamp(new Date());
  const { expiresAt, purgeAfter } = parsed.change;
  if (purgeAfter && purgeAfter <= now) return c.json(invalidField("purge_after"), 400);
  if (expiresAt && expiresAt <= now) return c.json(invalidField("expires_at"), 400);
  return settingsAnswer(c, id, await updateEventLifecycle(c.env.DB, id, parsed.change));
});

v1.openapi(signOutRoute, async (c) => {
  await deleteHostSession(c.env.DB, c.get("hostSession").id);
  return c.body(null, 204);
});

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
    reactorId: await viewerReactorId(tokenOnly(c.env), {
      eventId: c.get("event").id,
      token: c.req.header(GUEST_TOKEN_HEADER),
      clientReactorId: null,
    }),
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
    reactorId: await viewerReactorId(tokenOnly(c.env), {
      eventId: c.get("event").id,
      token: c.req.header(GUEST_TOKEN_HEADER),
      clientReactorId: null,
    }),
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
    reactorId: await viewerReactorId(tokenOnly(c.env), {
      eventId: c.get("event").id,
      token: c.req.header(GUEST_TOKEN_HEADER),
      clientReactorId: null,
    }),
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
    // Always: on this API a claimed name is only ever its own device's.
    enforceClaims: true,
    isLimited: () => isJoinLimited(c.env.JOIN_LIMITER, eventId, c.req.header("CF-Connecting-IP")),
  });
  if (!result.ok && result.error === "rate_limited") {
    return c.json(JOIN_RATE_LIMITED, 429, { "Retry-After": String(JOIN_RETRY_AFTER_SECONDS) });
  }
  if (!result.ok && result.error === "guest_cap_reached") {
    return c.json({ error: "This event is full.", code: result.error }, 409);
  }
  if (!result.ok) {
    return c.json({ error: "This nickname is already taken in this event.", code: result.error }, 409);
  }
  const participant = toPublicParticipant(result.participant);
  return c.json(result.guestToken ? { participant, guest_token: result.guestToken } : { participant }, 200);
});

/**
 * This API is new and has no tokenless clients: its reads and hearts act as
 * if GUEST_TOKENS_ENFORCED were set, whatever the legacy web routes allow.
 */
function tokenOnly<T extends { GUEST_TOKENS_ENFORCED?: string }>(env: T): T {
  return { ...env, GUEST_TOKENS_ENFORCED: "true" };
}

type ReactionOutcome =
  | { ok: true; state: ReactionState }
  | { ok: false; status: 400 | 403 | 404 | 429; body: { error: string; code: string } };

/**
 * Shared by add and remove: guest check (the token is required), rate
 * limit, then the write. The limiter keys on the guest session and runs
 * before any moment query.
 */
async function applyReaction(c: Context<V1Env>, momentId: string, reacted: boolean): Promise<ReactionOutcome> {
  const event = c.get("event");
  const gate = await gateReaction(tokenOnly(c.env), {
    eventId: event.id,
    token: c.req.header(GUEST_TOKEN_HEADER),
    clientIp: c.req.header("CF-Connecting-IP"),
    reactorId: null,
  });
  if (!gate.ok) return { ok: false, status: gate.status, body: gate.body };
  const state = await setReaction(c.env.DB, { eventId: event.id, momentId, reactorId: gate.reactorId, reacted });
  if (!state) return { ok: false, status: 404, body: { error: "moment not found", code: "moment_not_found" } };
  return { ok: true, state };
}

v1.openapi(addReactionRoute, async (c) => {
  const outcome = await applyReaction(c, c.req.valid("param").id, true);
  return outcome.ok ? c.json(outcome.state, 200) : c.json(outcome.body, outcome.status);
});

v1.openapi(removeReactionRoute, async (c) => {
  const outcome = await applyReaction(c, c.req.valid("param").id, false);
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
    const result = await leaveEvent(c.env.DB, leaveStorage(c.env), {
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
          if (!areUploadsOpen(event) || !(await canGuestsShare(c.env.DB, event))) return "closed";
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

v1.openapi(thumbnailUrlRoute, async (c) => {
  const event = c.get("event");
  const guest = await uploadGuest(c);
  if (!guest) return c.json(GUEST_REQUIRED, 403);
  const session = await getOwnedUpload(c.env.DB, { eventId: event.id, participantId: guest.participant.id, uploadId: c.req.valid("param").id });
  if (!session) return c.json(UPLOAD_NOT_FOUND, 404);
  if (session.status !== "open") return c.json(UPLOAD_NOT_OPEN, 409);
  if (!canFinishUploads(event)) return c.json(UPLOADS_CLOSED, 403);
  if (!isR2Configured(c.env)) return c.json(UPLOADS_UNAVAILABLE, 501);
  if (await isUploadLimited(c, guest.sessionId)) return c.json(RATE_LIMITED, 429);
  try {
    const url = await presignBoundPutUrl(
      c.env, thumbnailUploadKey(session.key), THUMBNAIL_CONTENT_TYPE, c.req.valid("json").size, THUMBNAIL_URL_TTL_SECONDS
    );
    return c.json({ expires_at: sqlTimestamp(new Date(Date.now() + THUMBNAIL_URL_TTL_SECONDS * 1000)), url }, 200);
  } catch (err) {
    logUploadError("v1_upload_thumbnail_url_failed", { eventId: event.id, uploadRecordId: session.id }, err);
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
    try {
      await c.env.BUCKET.delete(thumbnailKeys(session.key));
    } catch (err) {
      // Not worth failing the cancel: the event's purge removes a leftover.
      logUploadError("v1_upload_thumbnail_delete_failed", { eventId: event.id, uploadRecordId: session.id }, err);
    }
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

v1.openAPIRegistry.registerComponent("securitySchemes", "hostSession", {
  type: "http",
  scheme: "bearer",
  description: "A host session token from `POST /admin/session`",
});

v1.doc31("/openapi.json", OPENAPI_CONFIG);

// Registered last. A mounted sub-app's notFound() is not used by the parent
// app, so unknown v1 paths get the JSON error shape from this catch-all.
v1.all("*", (c) => c.json({ error: "not found", code: "not_found" }, 404));
