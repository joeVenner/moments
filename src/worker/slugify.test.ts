import { describe, expect, it } from "vitest";
import { slugify, randomSuffix } from "./slugify";

describe("slugify", () => {
  it("lowercases and dashes non-alphanumeric runs", () => {
    expect(slugify("Maya & Leo's Wedding")).toBe("maya-leo-s-wedding");
  });

  it("trims leading/trailing dashes", () => {
    expect(slugify("  -- Hello World! --  ")).toBe("hello-world");
  });

  it("caps length at 60 chars", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBe(60);
  });

  it("returns empty string for input with no alphanumerics", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("randomSuffix", () => {
  it("defaults to 4 lowercase alphanumeric characters", () => {
    const suffix = randomSuffix();
    expect(suffix).toMatch(/^[a-z0-9]{4}$/);
  });

  it("respects a custom length", () => {
    expect(randomSuffix(8)).toMatch(/^[a-z0-9]{8}$/);
  });
});
