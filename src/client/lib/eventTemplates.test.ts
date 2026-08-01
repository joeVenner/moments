import { describe, expect, it } from "vitest";
import { EVENT_TEMPLATES } from "./eventTemplates";
import { bannerForType } from "./eventBanners";

describe("event templates", () => {
  it("provides a distinct visual preset and retention policy for every template", () => {
    expect(EVENT_TEMPLATES.map((template) => template.id)).toEqual([
      "wedding",
      "birthday",
      "graduation",
      "corporate",
      "party",
    ]);
    for (const template of EVENT_TEMPLATES) {
      expect(bannerForType(template.type).id).toBe(template.id);
      expect(template.retentionDays).toBeGreaterThan(0);
    }
  });
});
