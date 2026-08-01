# Moments — Project Guide

React 19 + React Router 7 + Hono on Cloudflare Workers · Tailwind 4 · D1 + R2.
Event photo/video sharing with QR join, points, leaderboard, and AI banners.
Active branch: `feat/interactive-landing-page`.

> Follows the global North Star (`~/.claude/CLAUDE.md`) and git rules (`~/.claude/rules/git.md`).
> This file adds **project-specific** law. Address the user as **Yassir**.

---

## 🎨 Design System — Dark Theme (MANDATORY)

The app uses a **dark, neutral "black-and-white" theme** modeled on the OpenAI and Claude Code
platform consoles: **layered charcoal surfaces with a visibly stepped hierarchy** (page → raised
surface → hairline border) for depth, white/grey text, and a **single orange accent used
sparingly**. This is the standing visual language — **every new or edited screen/component must
follow it.** Do not reintroduce the old warm light theme (Pampas `#fcfaf6` backgrounds, `slate-*`
light text), and do not flatten back to pure-black — flat near-black reads as "too dark".

### Tokens — the only source of truth (defined in `src/client/index.css` `@theme`)

| Token | Value | Use |
|-------|-------|-----|
| `--color-bg` | `#1a1a1a` | page background (charcoal, clearly out of pure-black) |
| `--color-bg-alt` | `#262626` | cards, panels, raised surfaces (a step lighter than page) |
| `--color-border` | `#383838` | hairline borders / dividers (a visible step lighter again) |
| `--color-text` | `#ededed` | primary text (near-white) |
| `--color-text-muted` | `#a1a1a1` | secondary / hint text |
| `--color-accent` | `#d97757` | primary CTAs, links, active tabs, warning chrome — used sparingly |
| `--color-accent-dark` | `#c15f3c` | accent hover / pressed |

### Hard rules
1. **Use the CSS variables**, never raw hex or light Tailwind utilities. Backgrounds →
   `bg-[var(--color-bg)]` / `bg-[var(--color-bg-alt)]`; text → `text-[var(--color-text)]` /
   `text-[var(--color-text-muted)]`; borders → `border-[var(--color-border)]`.
2. **Forbidden:** `bg-white`, `bg-[var(--color-bg)]` used as if light, `text-slate-900`,
   `text-slate-600`, `border-slate-200/300`, and any other light-mode `slate-*`/white utility.
   When editing a file that still has them, convert it to tokens in the same change.
3. **Orange is the one accent.** Buttons, links, active states, and warning/alert chrome use
   `--color-accent`. No other brand hues. Keep contrast ≥ WCAG AA against `--color-bg`.
4. **Confetti / celebration colors** must be dark-theme legible — use accent + near-white
   (`#d97757`, `#ededed`), not the old cream `#fcfaf6`.
5. **Images/illustrations:** prefer transparent PNGs or dark-friendly art; flag any baked-in
   white-background asset (`src/client/assets/*`) that looks wrong on `#0d0d0d` for Yassir.
6. **Respect `prefers-reduced-motion`** (`lib/motion.ts`) for every animation.

> Migration status & per-file sweep live in `.agent/PLAN.md` (item **P0** — do first).

### Banner system
- **No-cover fallback = a live, type-aware CSS scene** (`lib/eventBanners.ts`):
  one dark-native preset per event type (Wedding/Gala/Birthday/Corporate/Other),
  rendered in the DOM with a slow motif animation (drift/sparkle/confetti/
  scan/rings). Used by the event hero and the admin `EventPreview`. All motif
  animation is gated by `prefers-reduced-motion`.
- **Prebuilt pickable banners** (`lib/sampleBanners.ts`) are the *static* cover
  override the admin can choose when AI generation fails. They're rasterized to
  a PNG and ride the real `cover` upload path (the backend only trusts real
  uploads / `/media/` URLs). Repainted dark-native (2026-06) to echo the live
  scenes; `sampleBannerIdForType(type)` pre-selects the matching swatch.
- Both follow the dark tokens above. No light candy gradients.

> Migration status & per-file sweep live in `.agent/PLAN.md` (item **P0** — do first).

---

## Stack & layout cheatsheet
- **Client:** `src/client/` — `pages/`, `components/`, `lib/` (i18n, api, points, motion,
  `multipartUpload`, `uploadStore`, `useUploadWakeLock`).
- **Worker:** `src/worker/` — Hono routes (`index.ts`), `storage.ts` (R2), `banner.ts` (AI),
  `auth.ts` (admin), `presign.ts` + `multipartPresign.ts` (R2 S3 signing). D1 migrations in `migrations/`.
- **Moment upload paths:**
  - **Images and Stream-disabled fallback, up to 512 MB** → **resumable S3 multipart direct-to-R2** (`multipartUpload.ts` +
    worker `multipartPresign.ts` + `/moments/multipart/*` routes). The file is split into 8 MiB
    parts the browser PUTs straight to R2 (Worker never sees the bytes); 3 parts per file with
    large files globally serialized to avoid mobile network overload. Metadata is persisted in
    IndexedDB and the file bytes in OPFS. The queue resumes from R2 `ListParts` on app startup,
    reconnect, visibility return, or Background Sync where supported. A root-scoped service
    worker uploads staged files while the browser grants background execution; iOS resumes as
    soon as the page is runnable again. An interruption costs at most one ~8 MiB part. The
    screen wake lock remains a foreground optimization.
  - **Videos when Stream is configured** → Cloudflare Stream direct-creator `tus` upload
    (`streamUpload.ts` + `/moments/stream/{session,tus,complete,abort}`). The Worker proxies
    only the authenticated creation request; bytes go browser→Stream. The client persists
    its tus URL + file in the same upload queue, then renders the adaptive Stream iframe.
    Requires `STREAM_ACCOUNT_ID`, secret `STREAM_API_TOKEN` (Stream Edit), and
    `STREAM_CUSTOMER_CODE`; missing config is explicitly detected and falls back to R2.
  - The old native `POST /moments` 25 MB route remains for compatibility, but the guest UI
    sends every new moment through a durable path so the upload manager covers all items.
  - The experimental on-device WebCodecs video optimizer is intentionally not exposed in
    the UI. Even high-end iPhones can throttle or suspend a long transcode. Upload originals
    through the resumable multipart path; do any future video processing server-side.
- **R2 bucket CORS (load-bearing for multipart):** the browser must read each part's `ETag` from
  the UploadPart PUT response, so the `moments-media` bucket CORS MUST `ExposeHeaders: ["ETag"]`
  (the old single-PUT path never needed it — it `head()`-validated). Policy + apply command:
  `scripts/r2-cors.json` + `wrangler r2 bucket cors set moments-media --file scripts/r2-cors.json`.
  Without `ETag` exposed, multipart completes fail with "R2 returned no ETag".
- **R2 S3 creds prereq:** `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_S3_ENDPOINT` /
  `R2_BUCKET_NAME` in `.dev.vars` + `wrangler secret put`.
- **Local R2 must stay remote:** multipart bytes use the real R2 S3 API even during local
  development, so the `BUCKET` binding has `remote: true`. Otherwise final validation checks
  Miniflare's empty local bucket and every successful upload fails at 99% with a false 404.
- **Observability:** Workers Logs enabled at 10% head sampling. Upload logs are structured
  JSON and intentionally exclude filenames, captions, and uploader names.
- **Client bundles:** routes are lazy-loaded. Keep Stream/tus dynamically imported so guests
  do not download it until a Stream video upload/cancel is actually attempted.
- **Admin/event controls:** migrations 0005–0008 add moderation, event expiry/archive,
  PBKDF2-protected private events, reactions, and highlights. A daily 03:00 UTC cron removes
  expired event media and owned D1 rows. Private media checks an HttpOnly event-access cookie.
- **Exports & analytics:** admin galleries support selected/full streaming ZIP downloads
  (`fflate` is dynamically imported), moderation bulk actions, storage/activity analytics,
  and five reusable event templates with retention defaults.
- **Roadmap verifier:** with local dev running, `npm run verify:roadmap` creates a disposable
  private event and exercises PIN access, upload, reaction/highlight, analytics, moderation,
  deletion, and archive cleanup end to end.
- Tests: `vitest run`. Typecheck: `tsc -b --noEmit`.

## Working agreements
- Small, atomic, single-purpose commits on the feature branch. **Never push without Yassir's OK.**
- Never commit `.agent/`, `.dev.vars`, or scratch/planning markdown.
