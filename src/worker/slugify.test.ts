import { describe, expect, it } from "vitest";
import { slugify, randomSuffix } from "./slugify";

describe("slugify", () => {
  it("never ends in a dash when the 60-character cut lands on a separator", () => {
    const title = `${"a".repeat(59)} bcdef`;
    const slug = slugify(title);
    expect(slug).toBe("a".repeat(59));
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

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

  it("strips accents instead of dropping the whole character", () => {
    expect(slugify("Soirée Test")).toBe("soiree-test");
    expect(slugify("Café été")).toBe("cafe-ete");
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
