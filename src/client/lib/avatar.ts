import { createAvatar } from "@dicebear/core";
import { funEmoji } from "@dicebear/collection";

// Curated allowlists for funEmoji's `eyes` and `mouth`. The style's defaults
// include sad/sick/pissed/crying/sleepy expressions — restricting the random
// pick to these cool / crazy / calm subsets keeps every avatar upbeat. The
// seed still drives the rest of the look (face, color, accessories).
//
// IMPORTANT: these allowlists must be applied EVERYWHERE a seed is rendered,
// not just in the picker. funEmoji is deterministic per seed+options, but the
// options change the result — so rendering a seed WITHOUT the allowlists
// yields a different face than the one the guest picked in the nickname gate.
// Keep this helper as the single render path so the avatar in the picker, the
// participant strip, and anywhere else all match.
export const AVATAR_EYES = [
  "cute",
  "wink",
  "wink2",
  "plain",
  "glasses",
  "closed",
  "love",
  "stars",
  "shades",
  "closed2",
] as const;

export const AVATAR_MOUTH = [
  "plain",
  "lilSmile",
  "shy",
  "cute",
  "wideSmile",
  "shout",
  "smileTeeth",
  "smileLol",
  "tongueOut",
  "kissHeart",
] as const;

// Render a deterministic avatar SVG string for a seed, applying the curated
// allowlists so the rendered face matches what the guest chose in the gate.
export function renderAvatarSvg(seed: string): string {
  return createAvatar(funEmoji, {
    seed,
    eyes: [...AVATAR_EYES],
    mouth: [...AVATAR_MOUTH],
  }).toString();
}