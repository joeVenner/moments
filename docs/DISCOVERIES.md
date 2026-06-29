# DISCOVERIES — hard-learned technical lessons

Append-only. Newest at the bottom. Follow the global CLAUDE.md format.

---

## [2026-06-26] Tailwind v4 individual transform properties + data-driven rotate
- **What changed:** Landing hero pivoted from a single centered AI image to an
  asymmetric scattered "polaroid pile" (`PolaroidCluster` in `pages/Home.tsx`)
  built from real `assets/moments/*.jpg` tiles — dark-native frames, per-card
  tilt, hover-lift, parallax depth.
- **Why:** A centered decorative illustration read as generic ("same image, just
  centered"). A multi-element asymmetric composition using real assets is stronger
  for a photo-sharing product AND removes the AI-image-generation dependency
  (which can't be visually QA'd by the agent — see lesson below).
- **Impact:** `pages/Home.tsx` (new `POLAROIDS` config + `PolaroidCluster`),
  removed `hero-illustration.jpg` / `hero-collage-*.png` from the hero.
- **Technique lesson (the reusable part):**
  1. **Tailwind v4 uses INDIVIDUAL transform CSS properties** — `rotate-*` sets
     `rotate:`, `scale-*` sets `scale:`, `translate-*` sets `translate:`. They are
     NOT composed into one `transform:` property. So a base `rotate-[-7deg]` +
     mount `translate-y-6` + `hover:scale-105` + `hover:rotate-0` all compose on
     the same element with no conflict. But an inline `style.transform` WILL
     override a Tailwind `translate/rotate/scale` utility only if they target the
     same property — inline `transform` does NOT clobber the independent
     `translate/rotate/scale` properties. Keep parallax on a WRAPPER
     (`style.transform: translateY(...)`) and tilt/hover on the inner figure to
     avoid any ambiguity.
  2. **JIT does not see dynamically-constructed class names.** `rotate-[${n}deg]`
     built from data is invisible to Tailwind's scanner → not generated. Two
     fixes: (a) hardcode the literal class per item (fine for ≤5 items), or
     (b) use a per-card CSS variable: inline `style={{ '--card-rot': \`${n}deg\` }}`
     plus the literal class `rotate-[var(--card-rot)]` (JIT-detectable), and
     `hover:rotate-0` overrides it via `:hover` specificity. Used (b) here.
  3. **`motion-safe:` prefix** cleanly gates hover transforms behind
     `prefers-reduced-motion: no-preference` — use it for any non-essential
     transform animation.
- **Reference:** commit pending (feat/interactive-landing-page).

## [2026-06-26] gpt-image-2 constraints + agent image-QA blindness
- **What changed:** Abandoned generating the hero as a single AI image.
- **Why / lessons:**
  1. **`gpt-image-2` rejects `background: "transparent"`** with a 400. Workaround
     was a near-black (`#0a0a0a`) field composited via `mix-blend-screen` — but
     near-black ≠ pure black, so `screen` leaves a faint lighter halo
     (`1-(1-a)(1-b)` lifts the page behind the art). `mix-blend-lighten` (per-
     channel max) vanishes a `#0a0a0a` base EXACTLY against `--color-bg #1a1a1a`
     with no halo — prefer `lighten` for near-black-source "transparency" fakes.
  2. **This agent model cannot ingest image files** (`400 this model does not
     support image input` on `Read` of a PNG). Consequence: the agent CANNOT
     visually compare/inspect generated images — any "pick the stronger variant"
     decision MUST be deferred to Yassir. Don't waste turns re-attempting image
     reads; inspect pixels programmatically (PIL) for objective facts (palette,
     alpha, dimensions) instead.
- **Impact:** `scripts/gen-hero-art.mjs` kept as a documented local-only tool;
  generated PNGs deleted (direction abandoned). Hero is now CSS, see entry above.
- **Reference:** commit pending (feat/interactive-landing-page).

## [2026-06-26] Event page redesign: type-aware animated banners
- **What changed:** Rebuilt the event page hero from a thin `h-28` strip into a
  full-bleed `40vh` hero. No-cover events now show a live, per-type CSS banner
  scene (`lib/eventBanners.ts`) instead of a static radial gradient. The light
  `sampleBanners.ts` swatches were repainted dark-native; the cover-image path
  gains damped scroll parallax + the home page's `hero-float`. Title/type/
  characters/**description** overlay the banner on a `.banner-scrim`; points
  moved into a sticky bar; feed widened to `max-w-3xl` / `lg:grid-cols-4` with
  staggered `MomentCard` pop-in and shimmer skeletons.
- **Why:** The old page was flat, the banner palette violated the dark-theme
  mandate, `description` was never rendered, and banners weren't adapted to
  the occasion. Live CSS scenes stay crisp/animatable at any size without the
  rasterization the AI-banner path needs.
- **Impact:** `lib/eventBanners.ts` (new), `lib/sampleBanners.ts` (rethemed),
  `index.css` (banner/hero/shimmer keyframes), `pages/EventPage.tsx`,
  `components/MomentCard.tsx`, `components/Skeleton.tsx`,
  `components/EventPreview.tsx`, `lib/i18n.tsx`. No schema change — the
  animated scene is the no-cover fallback derived from `event.type`; storing a
  pickable animated banner would need a `banner_preset` column (future work).
- **Reference:** commit pending (feat/interactive-landing-page).

## [2026-06-26] Event page UX: nickname modal, 3:2 hero, dark-native empty art
- **What changed:**
  1. **Nickname prompt is now a modal** over the event page, not a page
     replacement — the hero + feed render behind a dimmed/blurred backdrop so a
     first-time guest previews what they're joining. Sticky points bar +
     upload zone are hidden until a nickname is set (`components/NicknameGate.tsx`,
     `pages/EventPage.tsx`).
  2. **Hero is a centered 3:2 card** matching the AI banner's 1536x1024, so a
     generated/uploaded cover shows uncropped and fully visible from the top.
     The AI prompt in `worker/banner.ts` now states the 3:2 ratio + asks for a
     clear, darker bottom third (title/description overlay it). Default
     type-aware fallback scene still covers no-banner events. Scroll parallax
     was removed: it needed overscan that cropped the 3:2 banner, defeating the
     "fully visible" goal.
  3. **Empty-feed camera** replaced `assets/empty-feed.png` (baked-in white
     background) with a transparent line-art SVG (`components/EmptyCamera.tsx`)
     stroked in the muted text token + accent lens, so it blends into the page.
- **Why:** Modal reveals the event before commit; 3:2 hero stops the heavy
  center-crop of a 3:2 AI banner into a ~4:1 full-bleed strip; the white camera
  asset clashed with the dark theme.
- **Impact:** `components/NicknameGate.tsx`, `components/EmptyCamera.tsx` (new),
  `pages/EventPage.tsx`, `worker/banner.ts`. `empty-feed.png` now unused on disk
  (left in place, not deleted). No schema change.
- **Reference:** commit pending (feat/interactive-landing-page).
## [2026-06-26] Context Update
- **What changed:** (a) Avatar rendering centralized through `lib/avatar.ts`
  (`renderAvatarSvg` + curated `eyes`/`mouth` allowlists), used by both the
  nickname-gate picker and the participant strip. (b) Worker `upsertParticipant`
  no longer overwrites an existing `avatar_seed` on re-join — it only backfills
  a null seed. (c) `ParticipantStrip` takes a `version` prop; `EventPage` bumps
  it after `joinEvent` resolves so a newly joined guest (and their avatar)
  appears without a page refresh. (d) Event page shows the brand mark above the
  event-type chip on mobile (floating `Header` hidden on `/e/*` at `<sm`).
  (e) Inline `LanguageSwitcher` (`variant="inline"`) added to the admin header;
  the floating variant hides on `/admin` to avoid duplication.
- **Why:** Dicebear funEmoji is deterministic per **seed + options**, not per
  seed alone — restricting `eyes`/`mouth` in the picker but rendering the seed
  bare in the strip produced a *different* face than the one the guest picked,
  which read as "avatars change after join/refresh." Rendering through one
  shared allowlist path makes picker == strip. Re-join previously regenerated
  the seed, so a returning guest's face changed for everyone; preserving the
  first seed keeps identity stable. The strip only loaded on mount, so joins
  weren't reflected until refresh.
- **Impact:** `lib/avatar.ts` (new), `components/AvatarPicker.tsx`,
  `components/ParticipantStrip.tsx`, `components/Header.tsx`,
  `components/LanguageSwitcher.tsx`, `pages/EventPage.tsx`, `pages/Admin.tsx`,
  `worker/index.ts` (`upsertParticipant`). No schema change.
- **Reference:** commit pending (feat/interactive-landing-page).

## [2026-06-26] Context Update — Feed perf Stage 1 + 3-style flyer
- **What changed:** (1) Feed performance Stage 1 (no new deps): the moments list
  route is now offset-paginated (`limit` default 25, cap 100; returns
  `{moments, hasMore}`); `EventPage` does IntersectionObserver infinite scroll
  (refs back the observer so optimistic uploads never shift the server offset);
  `MomentCard` no longer mounts `<video>` on render — videos show a placeholder
  tile + size badge and only mount the real `<video autoPlay>` on click; new
  nullable `moments.size_bytes`/`mime_type` columns (migration 0003) are written
  by both the multipart and the presigned-register inserts; `/media/*` now
  advertises `Accept-Ranges: bytes` and serves byte-range `206`s (video seeking
  without re-downloading) + `304` on `If-None-Match` match, keeping the 1-year
  immutable cache for the fast path. (2) The printable flyer (`QRFlyer`) is now
  three pure-CSS selectable styles — Editorial (light), Poster (bold accent
  band), Dark-native (charcoal) — chosen via a swatch picker in `QRPanel`
  (persisted to `localStorage` `moments:flyer-style`); `flyer-frame.png` (baked
  cream) and `logo.png` (baked white tile) are no longer imported, the inline
  `BrandMark` is used instead, and the QR sits on a light tile in every style so
  it stays scannable. Print CSS uses `print-color-adjust: exact` + per-variant
  background + `@page { margin: 0.5cm }`.
- **Why:** Unbounded `SELECT *` + rendering every card at full original
  resolution + eager `<video>` made the feed slow as an event grew and with
  heavy files — the ask was "only load the last few, grouped; heavy files show
  info + a placeholder." Stage 1 (pagination + lazy video + size/mime + Range)
  realizes that without adding an image-processing dep; Stage 2 thumbnails
  (server-side WebP) deferred. The flyer was a single baked style that clashed
  with the dark theme; the ask was "make it cool + 3 styles."
- **Impact:** `migrations/0003_moment_meta.sql` (new), `worker/types.ts`,
  `worker/index.ts` (list route, both inserts, `/media/*`), `client/lib/types.ts`,
  `client/lib/api.ts` (`listMoments` opts), `pages/EventPage.tsx`,
  `components/MomentCard.tsx`, `components/QRFlyer.tsx` (rewritten),
  `components/QRPanel.tsx`, `lib/i18n.tsx` (flyerStyle* keys), `index.css` (print
  block + `@page`). `assets/flyer-frame.png` + `assets/logo.png` now unused —
  left on disk pending Yassir's call (flagged).
- **Reference:** commit pending (feat/interactive-landing-page). Stage 1 verified
  by `tsc -b --noEmit` + `vitest` (37/37); remote migration + deploy pending
  Yassir's OK.

## [2026-06-27] Context Update
- **What changed:** Flyer expanded to 5 styles (3 simple + 2 graphic-rich).
  Graphic-rich = **Leaves** (decorative botanical *frame* restored from the
  original `flyer-frame.png` in git history, commit 33d06cf — QR + text
  composited in its light center, no scrim, dark "paper inks") and **Celebration**
  (OpenAI `gpt-image-2` scene of guests raising phones to capture the moment —
  full-bleed photographic art + dark scrim + QR on a white tile, light ink). The
  first attempt used two polaroid-cascade backgrounds Yassir rejected; those were
  dropped. Removed the printed website URL from every flyer (QR is the only join
  path, per Yassir). Fixed the bottom-cropping bug by replacing the fixed
  `aspect-[2/3]` (locked height to 480px, clipped long titles via `overflow-hidden`)
  with `min-h-[480px]` so content defines height; kept `overflow-hidden` so
  full-bleed art rounds to the card corners. Header logo is now a `Link` to `/`
  and hides on mobile after 80px scroll (sticky greeting/points bar takes over
  the top; no impact on desktop). Made the flyer **print-ready at A6** (105×148mm
  postcard, full-bleed): `@page { size: 105mm 148mm; margin: 0 }` and the print
  rule stretches `.qr-flyer` + its child card to `width:100% / min-height:100vh`
  with rounded corners + border dropped, so the printed PDF is an exact A6 card
  a print center can run as-is — not the previous tiny ~3.3×5in card in the page
  corner. Bumped the QR source from 320→600px so it stays crisp on paper.
- **Why:** Two flyer-art lessons. (1) A *frame* image (decorative border, light
  center) is NOT a full-bleed background — it needs the frame layout (object-cover
  + centered content, no scrim, dark ink), distinct from a photographic scene
  (full-bleed + scrim + light ink). Reusing one component for both was wrong;
  split into `LeavesFlyer` + `CelebrationFlyer`. (2) Photographic AI art as PNG was
  ~1.9MB each; JPG at 900px max edge is ~80KB — ~19x smaller, no visible loss under
  the scrim / in the frame. The codebase's other PNGs are small illustrations
  where PNG is appropriate; photographic art → JPG. (3) The print path had no
  explicit page/size — it emitted a screen-sized card in the page corner; A6
  full-bleed makes it a real printable artifact. The visible styled card is a
  *child* of `.qr-flyer`, so the child must be forced to fill the page (not just
  the outer wrapper) or full-bleed fails.
- **Impact:** `components/QRFlyer.tsx` (5 styles, `LeavesFlyer`+`CelebrationFlyer`,
  dropped `guestUrl` prop), `components/QRPanel.tsx` (5-style wrapped picker,
  image-thumbnail swatches), `lib/i18n.tsx` (`flyerStyleLeaves`/`flyerStyleCelebration`
  en+fr), `index.css` (A6 `@page` + full-bleed print rule; print group:
  `dark`+`celebration` dark-ink, leaves stays light-ink), `lib/useQrDataUrl.ts`
  (QR 320→600px for print crispness), `scripts/gen-flyer-art.mjs` (regenerates
  only the Celebration JPG via `sips`; Leaves is restored-from-git, not
  generated), `assets/flyer/flyer-leaves.jpg` + `flyer-celebration.jpg`.
- **Reference:** commit pending (feat/interactive-landing-page). Verified by
  `tsc -b --noEmit`, `vitest` (37/37), and `vite build` (art bundles at ~75-82KB
  each). Remote deploy pending Yassir's OK.

## [2026-06-28] Context Update
- **What changed:** Fixed large-file (>25MB) uploads failing on the deployed
  site. Root cause: the R2 bucket's S3 CORS policy only allowed the local dev
  origins (localhost:5173 / 127.0.0.1:5173), so the browser's presigned PUT to
  R2 from `https://moments.ylafrimi.workers.dev` was blocked by CORS
  (`xhr.onerror` → generic "upload failed"). Small files (≤25MB) were
  unaffected because they go through the Worker (same-origin), which is why the
  bug surfaced only for large files (typically phone videos). Added the
  production origin to the R2 CORS policy (kept localhost for dev). Also added a
  client-side guard mirroring `presign.ts` MAX_DIRECT_UPLOAD_BYTES (512MB) so a
  file over the cap is rejected up front with a clear "too large (max 512MB)"
  message instead of starting the upload and failing generically.
- **Why:** Two lessons. (1) **R2 S3 CORS is a separate config from the Worker**
  and must list every browser origin that will PUT directly to R2 — the
  presigned path bypasses the Worker entirely, so the Worker's origin is
  irrelevant to that request; only the bucket's CORS policy gates it. The PUT
  URL is a signed short-lived credential, so opening the origin is safe (CORS
  is just a browser gate on top of the signature). (2) A server-side cap with no
  matching client pre-check produces a confusing generic error on mobile, where
  cameras routinely exceed it — mirror every server upload cap on the client.
- **Impact:** R2 bucket `moments-media` CORS policy (infra, applied via
  `wrangler r2 bucket cors set`, live immediately — no deploy), `client/lib/api.ts`
  (+`DIRECT_UPLOAD_MAX_BYTES`), `pages/EventPage.tsx` (up-front >512MB skip +
  composed error message), `lib/i18n.tsx` (`filesTooLarge` en+fr).
- **Reference:** commit dffc82a (feat/interactive-landing-page), deployed as
  Worker version b93a063e. Verified live at the edge (new bundle hash served +
  guard string present). Note: the earlier 2026-06-26 note saying migration
  0003 was "pending remote" was stale — `wrangler d1 migrations list --remote`
  showed all 3 already applied.

## [2026-06-28] Context Update — feed switched from infinite scroll to numbered pages
- **What changed:** Replaced the IntersectionObserver-based infinite scroll
  (`hasMore`/`offsetRef`/`hasMoreRef`/`loadingMoreRef`/`sentinelRef` + a "Load
  more" sentinel button) with explicit **numbered pagination** in
  `pages/EventPage.tsx`: a `page` state, a windowed `Pagination` component
  (first / last / current±1 / ellipses, all when ≤7 pages), and per-page fetch
  that REPLACES `moments` (offset = (page-1)*PAGE_SIZE). The moments list route
  (`worker/index.ts`) now also returns `total` (COUNT(*) for the event) and an
  optional `your_points` (SUM(points_awarded) for `?uploader_name=`). Page nav
  on page change scrolls the feed top into view (reduced-motion-aware). The
  list response still includes `hasMore` for backward-compat but the client no
  longer relies on it (it was off-by-one at the boundary: a full final page
  reports hasMore=true even with no next page).
- **Why:** Yassir reported >50-moment events weren't surfacing later pages —
  the silent IntersectionObserver auto-load path could get stuck after one
  page and there was no deterministic way to reach page 3+. Numbered pages are
  button-driven (no observer to silently misbehave) and each button fetches its
  own offset, so a large feed can't get stranded — and it's a better fit for a
  bounded event feed. Switching to replace-on-page-load also broke the old
  `myPoints = sum over loaded moments` (which now only holds one page), so the
  worker now returns the guest's true running total via `your_points` and the
  client keeps it in sync by bumping locally on each successful upload.
- **Impact:** `worker/index.ts` (list route: +`total`, +`your_points`),
  `client/lib/api.ts` (`listMoments` +`uploaderName` opt +`total`/`your_points`
  in the response type), `pages/EventPage.tsx` (page/total/loadingPage/myPoints
  state, `loadPage`, `Pagination` component, optimistic prepend gated to
  page 1, post-join refetch so a returning guest's prior-upload points show),
  `lib/i18n.tsx` (+`pagePrev`/`pageNext`; `loadMore`/`loadingMore` kept but now
  unused). No schema change — `total`/`your_points` are computed at query time.
- **Reference:** commit pending (feat/interactive-landing-page). Verified by
  `tsc -b --noEmit`, `vitest` (37/37), `vite build`. Deploy pending Yassir's OK.

## [2026-06-30] Context Update — resumable chunked uploads (background-safe large video)
- **What changed:** Replaced the monolithic presigned PUT large-upload path with a
  **resumable S3 multipart** path so a 100MB–512MB phone video no longer requires the
  user to babysit the phone. The file is split into 8 MiB parts the browser PUTs
  straight to R2 (Worker stays out of the data path, same Fork B decision); 3 parts
  concurrent with XHR per-part progress; on `visibilitychange→visible` the client
  reconciles against R2 `ListParts` (the resume source of truth) so iOS background
  suspension can't desync the local map and we never re-upload a part R2 already has;
  progress mirrored to IndexedDB for zero-round-trip same-session resume and
  cold-reload re-matching of a re-picked file; screen wake lock while foregrounded.
  An interruption now costs ONE ~8 MiB part, not the whole file.
- **Why:** No web API in 2026 keeps an upload alive after iOS fully backgrounds the
  app (Background Fetch is absent on iOS + download-only on Chrome; Background Sync
  is absent on iOS and can't carry large bodies; fetch streaming-upload progress is
  Chrome-only and inaccurate). True background uploads need a native app
  (`URLSessionConfiguration.background`). The realistic web answer is *resumable
  chunking*: bound the loss to one part and resume instantly on return, plus a wake
  lock so the foregrounded tab doesn't dim-throttle. XHR (not fetch) is required for
  real upload-acked progress.
- **Impact:** new `worker/multipartPresign.ts` (+tests: create/presign-part/
  complete/abort/list-parts via `aws4fetch`, no live network), `migrations/0004_uploads.sql`
  (accounting/cleanup only — R2 ListParts is the resume truth), worker
  `/api/events/:slug/moments/multipart/{init,part-url,status,complete,abort}` routes,
  client `lib/multipartUpload.ts` + `lib/uploadStore.ts` (IndexedDB) +
  `lib/useUploadWakeLock.ts`, `EventPage` routing >25MB files here with per-card
  progress (`MomentCard` `_progress`) + `findResumableUpload` resume, `i18n` (512MB
  hint + `uploadPaused` en+fr). The superseded single-PUT path (`directUploadMoment` +
  `putToR2` in `lib/api.ts`, worker `/presign` + `/register` routes, `presignPutUrl`
  in `presign.ts`) has since been removed; `presign.ts` now keeps only the constants
  + validation gates (`isR2Configured`, `registrationKeyBelongsToEvent`,
  `MAX_DIRECT_UPLOAD_BYTES`, `PRESIGN_EXPIRY_SECONDS`) the multipart flow reuses.
- **Prereq (infra, NOT code):** the `moments-media` bucket CORS MUST
  `ExposeHeaders: ["ETag"]` — the browser reads each part's ETag from the UploadPart
  PUT response to send to Complete; the old path never needed it (it `head()`-validated).
  Apply via `wrangler r2 bucket cors put moments-media --file scripts/r2-cors.json`.
  R2 S3 creds already set (presign path). Without `ETag` exposed, completes fail with
  "R2 returned no ETag (check bucket CORS ExposeHeaders)".
- **Reference:** commits pending (feat/interactive-landing-page). Verified by
  `tsc -b --noEmit`, `vitest` (47/47), `vite build`. Deploy + remote D1 migration
  `0004` + CORS update pending Yassir's OK.
