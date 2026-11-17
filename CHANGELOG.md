# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Cursor-based feed for native clients: `GET /api/events/:slug/feed?before=<seq>` pages newest-first, and `GET /api/events/:slug/feed/changes?since=<cursor>` returns new or edited moments plus the ids of hidden or deleted ones. Cursors are per event. The web feed is unchanged.
- Joining an event returns a per-device `guest_token` (send it back as `X-Guest-Token`). The first device to join under a nickname claims it; only the token's SHA-256 hash is stored. Tokens are accepted but not yet required (`GUEST_TOKENS_ENFORCED`).
- The web app stores its guest token per event and sends it when re-joining.
- Route tests can run against the real D1 migrations through a Node SQLite adapter (requires Node 22.13+).
- Private-event unlock now returns a signed access token (`access_token`, `expires_at`) that native clients can send as the `X-Event-Access` header.
- Admin privacy controls warn that saving a new PIN signs every guest out and replaces the invitation link.

### Changed
- Nicknames longer than 60 characters are rejected when joining.
- Participant responses no longer use `SELECT *`; they return only public fields.
- New event PINs must be 6 to 20 characters. Existing shorter PINs keep working.
- Setting a new PIN, or making a public event private again, revokes all previously issued access and rotates the invitation link.

### Security
- Private-event access uses HMAC-signed, version-bound grants instead of the raw, never-rotated invite token. Requires the `EVENT_ACCESS_SECRET` Worker secret; without it, unlocking fails closed with 503.
- PIN attempts are throttled per event and client (IPv6 grouped by /64, IPs stored only as keyed hashes), with an event-wide slowdown and then block. The invitation link is never throttled.
- Invite-token and PIN-hash comparisons are constant-time.
- Legacy raw-token cookies are accepted only until 2027-01-15, and only for events whose access was never revoked.
