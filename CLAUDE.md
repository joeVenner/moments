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
- **Client:** `src/client/` — `pages/`, `components/`, `lib/` (i18n, api, points, motion).
- **Worker:** `src/worker/` — Hono routes (`index.ts`), `storage.ts` (R2), `banner.ts` (AI),
  `auth.ts` (admin). D1 migrations in `migrations/`.
- **Upload ceiling:** `storage.ts` caps at 25 MB via `parseBody` (buffers in the 128 MB isolate).
  Raising it is an architecture change, NOT a cap bump — see `.agent/PLAN.md` P3.1.
- Tests: `vitest run`. Typecheck: `tsc -b --noEmit`.

## Working agreements
- Small, atomic, single-purpose commits on the feature branch. **Never push without Yassir's OK.**
- Never commit `.agent/`, `.dev.vars`, or scratch/planning markdown.
