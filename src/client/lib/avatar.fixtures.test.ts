import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AVATAR_EYES, AVATAR_MOUTH, avatarParts, renderAvatarSvg } from "./avatar";

// The iOS app draws avatars on device and must pick the same face as the web
// for every seed. Its tests read this file; regenerate it with
// `npm run avatar:fixtures` after changing avatar.ts or the DiceBear version.
const FIXTURES = fileURLToPath(
  new URL("../../../ios/MomentsKit/Tests/DesignSystemTests/Fixtures/avatar-seeds.json", import.meta.url)
);

/** Seeds like the apps make (8 base-36 characters), plus edge cases. */
function fixtureSeeds(): string[] {
  const seeds = ["", "a", "0", "-1", "Sara", "sara", "zzzzzzzz", "00000000", "é", "Zoë 🎉", "日本語", "👩‍👩‍👧", "a".repeat(1030)];
  // DiceBear reads only the first 1024 UTF-16 units: these differ only after.
  for (const tail of ["x", "y", "zz9"]) seeds.push("b".repeat(1024) + tail);
  let value = 1;
  for (let i = 0; i < 200; i++) {
    let seed = "";
    for (let j = 0; j < 8; j++) {
      value = (value * 1103515245 + 12345) % 2147483648;
      seed += (value % 36).toString(36);
    }
    seeds.push(seed);
  }
  return seeds;
}

function currentFixtures(): string {
  const cases = fixtureSeeds().map((seed) => ({ seed, ...avatarParts(seed) }));
  return `${JSON.stringify({ eyes: AVATAR_EYES, mouth: AVATAR_MOUTH, cases }, null, 2)}\n`;
}

describe("avatarParts", () => {
  it("names what renderAvatarSvg draws", () => {
    for (const seed of ["Sara", "k3j9x0aa"]) {
      const { background } = avatarParts(seed);
      expect(renderAvatarSvg(seed)).toContain(`fill="${background}"`);
    }
  });

  it("keeps the iOS fixtures up to date", () => {
    const current = currentFixtures();
    if (process.env.UPDATE_AVATAR_FIXTURES === "1") writeFileSync(FIXTURES, current);
    expect(readFileSync(FIXTURES, "utf8"), "avatar-seeds.json is stale: run npm run avatar:fixtures").toBe(current);
  });

  it("ignores everything after 1024 characters", () => {
    expect(avatarParts("b".repeat(1024) + "x")).toEqual(avatarParts("b".repeat(1024)));
    expect(avatarParts("b".repeat(1024) + "zz9")).toEqual(avatarParts("b".repeat(1024)));
  });

  it("covers every allowed eye, mouth and background", () => {
    const cases = fixtureSeeds().map(avatarParts);
    expect(new Set(cases.map((c) => c.eyes))).toEqual(new Set(AVATAR_EYES));
    expect(new Set(cases.map((c) => c.mouth))).toEqual(new Set(AVATAR_MOUTH));
    expect(new Set(cases.map((c) => c.background)).size).toBe(6);
  });
});
