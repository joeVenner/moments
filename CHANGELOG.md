# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Abandoned multipart uploads are now cancelled in R2, so their parts stop costing storage. A daily job sweeps sessions still open after 7 days, or 30 minutes after an event's uploads close (up to 40 per run). Deleting an event (the daily purge or "archive now") now cancels its unfinished uploads before removing their records, which used to leave billed parts behind.

### Added
- Events can close uploads before they are deleted: `uploads_close_at` and `purge_after` (migration 0015) both default to `expires_at`, so existing events behave as before. Once uploads close the event stays viewable and joinable; new uploads get `403 uploads_closed`, and uploads already in progress have 30 minutes to finish. Event responses (web and `/api/v1`) carry an `uploads_open` flag, and the admin lifecycle endpoint accepts the two dates.
- `/api/v1` for the native app: `getEvent`, `getFeed`, `getFeedChanges` and `joinEvent` (JSON), validated with Zod. The OpenAPI 3.1 description is served at `/api/v1/openapi.json` and committed as `openapi/v1.json` (`npm run openapi:update` regenerates it). iOS builds below `MIN_IOS_BUILD` get `426`.
- Feed items carry a `media` object (kind, url, thumb/display/poster URLs, Stream `hls_url`, width, height, duration, blurhash). Migration `0013` adds the backing columns; filling them in counts as a change for `/feed/changes`.
- Cursor-based feed for native clients: `GET /api/events/:slug/feed?before=<seq>` pages newest-first, and `GET /api/events/:slug/feed/changes?since=<cursor>` returns new or edited moments plus the ids of hidden or deleted ones. Cursors are per event. The web feed is unchanged.
- Joining an event returns a per-device `guest_token` (send it back as `X-Guest-Token`). The first device to join under a nickname claims it; only the token's SHA-256 hash is stored. Tokens are accepted but not yet required (`GUEST_TOKENS_ENFORCED`).
- The web app stores its guest token per event and sends it when re-joining.
- Route tests can run against the real D1 migrations through a Node SQLite adapter (requires Node 22.13+).
- Private-event unlock now returns a signed access token (`access_token`, `expires_at`) that native clients can send as the `X-Event-Access` header.
- Admin privacy controls warn that saving a new PIN signs every guest out and replaces the invitation link.

### Changed
- Native feed responses report `reacted` as a boolean. The web moment list is unchanged.
- The web moment list and highlights return an explicit set of columns, so internal storage columns are never exposed to guests.
- Nicknames longer than 60 characters are rejected when joining.
- Participant responses no longer use `SELECT *`; they return only public fields.
- New event PINs must be 6 to 20 characters. Existing shorter PINs keep working.
- Setting a new PIN, or making a public event private again, revokes all previously issued access and rotates the invitation link.

### Security
- Hidden moments are no longer served by direct `/media` links: originals and their thumbnail, display and poster versions return 404. Public media is cached for 5 minutes and then revalidated (it was cached for a year), so a hide takes effect quickly. Admin moment responses carry short-lived signed view links (`?mv=`), so moderators can still see hidden and private-event media. Stream videos in public events are not covered by this check.
- Private-event Stream videos can require signed playback URLs. Set `STREAM_SIGNING_KEY_ID` and `STREAM_SIGNING_JWK` to turn it on. New uploads to private events are then locked, every Stream URL returned for a private event carries a 1–2 hour token, and saving an event's access settings locks or unlocks its existing videos. Upload metadata forwarded to Stream is now restricted to an allowlist. Tokens are bearer URLs shared by everyone viewing in the same hour; the only way to revoke them early is deleting the signing key.
- Private-event access uses HMAC-signed, version-bound grants instead of the raw, never-rotated invite token. Requires the `EVENT_ACCESS_SECRET` Worker secret; without it, unlocking fails closed with 503.
- PIN attempts are throttled per event and client (IPv6 grouped by /64, IPs stored only as keyed hashes), with an event-wide slowdown and then block. The invitation link is never throttled.
- Invite-token and PIN-hash comparisons are constant-time.
- Legacy raw-token cookies are accepted only until 2027-01-15, and only for events whose access was never revoked.
