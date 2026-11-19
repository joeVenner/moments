import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eyes } from "../../../node_modules/@dicebear/fun-emoji/lib/components/eyes.js";
import { mouth } from "../../../node_modules/@dicebear/fun-emoji/lib/components/mouth.js";
import { describe, expect, it } from "vitest";
import { AVATAR_EYES, AVATAR_MOUTH } from "./avatar";
import { readAvatarPart, swiftPartsExtension } from "./avatarShapes";

// The iOS app draws the same parts as the web from this generated Swift.
// Regenerate with `npm run avatar:fixtures` after a DiceBear update.
const GENERATED = fileURLToPath(
  new URL("../../../ios/MomentsKit/Sources/DesignSystem/AvatarShapes.generated.swift", import.meta.url)
);
const FUN_EMOJI_VERSION = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../node_modules/@dicebear/fun-emoji/package.json", import.meta.url)), "utf8")) as {
    version: string;
  }
).version;

type PartFunction = (components: unknown, colors: unknown) => string;
const eyeParts = eyes as Record<string, PartFunction>;
const mouthParts = mouth as Record<string, PartFunction>;

function currentSwift(): string {
  const eyeLayers = AVATAR_EYES.map((name) => [name, readAvatarPart(eyeParts[name]({}, {}))] as const);
  const mouthLayers = AVATAR_MOUTH.map((name) => [name, readAvatarPart(mouthParts[name]({}, {}))] as const);
  return [
    `// Generated from @dicebear/fun-emoji ${FUN_EMOJI_VERSION} by src/client/lib/avatar.shapes.test.ts.`,
    "// Do not edit: run `npm run avatar:fixtures`.",
    "",
    swiftPartsExtension("AvatarEyes", eyeLayers),
    swiftPartsExtension("AvatarMouth", mouthLayers),
  ].join("\n");
}

describe("readAvatarPart", () => {
  it("reads fills, groups, gradients, strokes and blends", () => {
    const layers = readAvatarPart(
      '<path d="M0 0h1" fill="#fff" opacity=".4" style="mix-blend-mode:soft-light"/>' +
        '<g fill-rule="evenodd" fill="#2B1607" opacity=".5"><path d="M0 0h2"/><path d="M0 0h3" stroke="#000" stroke-width="1.5" stroke-linecap="round" fill="none"/></g>' +
        '<path d="M0 0h4" fill="url(#a)"/>' +
        '<defs><linearGradient id="a" x1="1" y1="2" x2="3" y2="4" gradientUnits="userSpaceOnUse"><stop stop-color="#EF0A0A"/><stop offset="1" stop-color="#fff" stop-opacity=".3"/></linearGradient></defs>'
    );
    expect(layers).toEqual([
      { opacity: 0.4, softLight: true, paths: [{ d: "M 0 0 L 1 0", fill: { kind: "color", hex: "ffffff", alpha: 1 }, evenOdd: false, stroke: null, opacity: 1 }] },
      {
        opacity: 0.5,
        softLight: false,
        paths: [
          { d: "M 0 0 L 2 0", fill: { kind: "color", hex: "2b1607", alpha: 1 }, evenOdd: true, stroke: null, opacity: 1 },
          {
            d: "M 0 0 L 3 0",
            fill: null,
            evenOdd: true,
            stroke: { hex: "000000", width: 1.5, roundCap: true, roundJoin: false, miterLimit: 4 },
            opacity: 1,
          },
        ],
      },
      {
        opacity: 1,
        softLight: false,
        paths: [
          {
            d: "M 0 0 L 4 0",
            fill: { kind: "linear", x1: 1, y1: 2, x2: 3, y2: 4, stops: [{ offset: 0, hex: "ef0a0a", alpha: 1 }, { offset: 1, hex: "ffffff", alpha: 0.3 }] },
            evenOdd: false,
            stroke: null,
            opacity: 1,
          },
        ],
      },
    ]);
  });

  it("fills black by default, as SVG does", () => {
    expect(readAvatarPart('<path d="M0 0h1" stroke="#000"/>')[0].paths[0].fill).toEqual({ kind: "color", hex: "000000", alpha: 1 });
  });

  it("refuses SVG it doesn't understand", () => {
    expect(() => readAvatarPart('<circle r="1"/>')).toThrow();
    expect(() => readAvatarPart('<path d="M0 0" transform="scale(2)"/>')).toThrow();
    expect(() => readAvatarPart('<path d="M0 0" style="mix-blend-mode:multiply"/>')).toThrow();
    expect(() => readAvatarPart('<path d="M0 0" fill="url(#missing)"/>')).toThrow();
    expect(() => readAvatarPart('<g><g><path d="M0 0"/></g></g>')).toThrow();
    expect(() => readAvatarPart('<g><path d="M0 0"/>')).toThrow();
    expect(() => readAvatarPart('<path d="M0 0" fill="red"/>')).toThrow();
    expect(() => readAvatarPart('<g><path d="M0 0h1" stroke="#000" opacity=".5"/></g>')).toThrow();
  });
});

describe("AvatarShapes.generated.swift", () => {
  it("matches the web's parts", () => {
    const current = currentSwift();
    if (process.env.UPDATE_AVATAR_FIXTURES === "1") writeFileSync(GENERATED, current);
    expect(readFileSync(GENERATED, "utf8"), "AvatarShapes.generated.swift is stale: run npm run avatar:fixtures").toBe(current);
  });
});
