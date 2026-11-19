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

/** What a seed picks: the face parts and the solid background (hex, with #). */
export interface AvatarParts {
  eyes: (typeof AVATAR_EYES)[number];
  mouth: (typeof AVATAR_MOUTH)[number];
  background: string;
}

/**
 * The parts `renderAvatarSvg` draws for a seed. The iOS app picks the same
 * ones on device (DesignSystem `AvatarParts`), checked against fixtures
 * made from this function (avatar.fixtures.test.ts).
 */
export function avatarParts(seed: string): AvatarParts {
  const extra = createAvatar(funEmoji, {
    seed,
    eyes: [...AVATAR_EYES],
    mouth: [...AVATAR_MOUTH],
  }).toJson().extra as Partial<FunEmojiExtra>;
  // DiceBear's `extra` is untyped; fail loudly if its shape ever changes.
  if (!extra.eyes || !extra.mouth || !extra.primaryBackgroundColor) {
    throw new Error("DiceBear funEmoji no longer reports its parts");
  }
  return { eyes: extra.eyes, mouth: extra.mouth, background: extra.primaryBackgroundColor };
}

/** The fields of funEmoji's `toJson().extra` that `avatarParts` reads. */
interface FunEmojiExtra {
  eyes: AvatarParts["eyes"];
  mouth: AvatarParts["mouth"];
  primaryBackgroundColor: string;
}
