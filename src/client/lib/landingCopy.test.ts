import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dict } from "./i18n";

/** A missing French entry silently falls back to English, so check here. */
describe("landing copy", () => {
  const home = readFileSync(join(__dirname, "../pages/Home.tsx"), "utf8");

  it("has every landing text in English and French", () => {
    const landing = (lang: "en" | "fr") => Object.keys(dict[lang]).filter((key) => key.startsWith("landing")).sort();
    expect(landing("en").length).toBeGreaterThan(50);
    expect(landing("fr")).toEqual(landing("en"));
  });

  it("defines every key the landing uses, in both languages", () => {
    const literal = [...home.matchAll(/\bt\("([A-Za-z0-9]+)"/g)].map((match) => match[1]);
    // Numbered keys: t(`landingStep${step}Title`) over STEPS = [1, 2, 3] and so on.
    const numbered = [...home.matchAll(/\bt\(`(landing[A-Za-z]+)\$\{(\w+)(?: \+ 1)?\}([A-Za-z]*)`/g)].flatMap((match) => {
      const [, prefix, variable, suffix] = match;
      const list = { step: "STEPS", feature: "FEATURES", faq: "FAQS", item: "INCLUDES" }[variable];
      // `index + 1` walks the pricing tiers.
      const count = variable === "index" ? 4 : home.match(new RegExp(`const ${list} = \\[([\\d, ]+)\\]`))?.[1].split(",").length ?? 0;
      expect(count, `${prefix}…${suffix}`).toBeGreaterThan(0);
      return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}${suffix}`);
    });
    expect(numbered.length).toBeGreaterThan(20);
    for (const key of [...literal, ...numbered]) {
      expect(dict.en[key], key).toBeDefined();
      expect(dict.fr[key], key).toBeDefined();
    }
  });
});
