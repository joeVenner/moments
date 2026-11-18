import { describe, expect, it } from "vitest";
import { CAPTION_FORBIDDEN, cleanWebCaption } from "./captionText";

const BIDI = ["‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩"];
// Neighbours of the ranges, plus joiners and direction marks that real text uses.
const ALLOWED = [" ", " ", "⁥", "⁪", "​", "‌", "‍", "‎", "‏"];

describe("caption characters", () => {
  it.each(BIDI)("refuses and strips bidi control %j", (char) => {
    expect(CAPTION_FORBIDDEN.test(`gift${char}txt.exe`)).toBe(true);
    expect(cleanWebCaption(` gift${char}txt.exe `)).toBe("gifttxt.exe");
  });

  it.each(ALLOWED)("keeps %j", (char) => {
    expect(CAPTION_FORBIDDEN.test(`a${char}b`)).toBe(false);
    expect(cleanWebCaption(`a${char}b`)).toBe(`a${char}b`);
  });

  it("refuses controls but line breaks", () => {
    expect(CAPTION_FORBIDDEN.test("tab\there")).toBe(true);
    expect(CAPTION_FORBIDDEN.test("del\u007F")).toBe(true);
    expect(CAPTION_FORBIDDEN.test("a\r\nb")).toBe(false);
    expect(CAPTION_FORBIDDEN.test("\u{1F469}‍\u{1F467}")).toBe(false);
  });
});
