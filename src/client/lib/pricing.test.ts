import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appStoreUrl, EXTRA_EVENT_USD, formatUsd, HOSTING_TIERS, POPULAR_TIER_ID } from "./pricing";

describe("pricing", () => {
  it("lists the subscription products the database sells, in order", () => {
    const sql = readFileSync(join(__dirname, "../../../migrations/0025_plans.sql"), "utf8");
    const seeded = [...sql.matchAll(/\('(host_\d+)', 'subscription', (\d+), (\d+)\)/g)].map((m) => ({
      productId: m[1],
      rank: Number(m[2]),
      guestCap: Number(m[3]),
    }));
    expect(seeded).toHaveLength(4);
    expect(HOSTING_TIERS.map(({ productId, guestCap }) => ({ productId, guestCap }))).toEqual(
      seeded.sort((a, b) => a.rank - b.rank).map(({ productId, guestCap }) => ({ productId, guestCap })),
    );
    expect(sql).toContain("('extra_event', 'consumable'");
  });

  it("charges more for more guests, and highlights a real tier", () => {
    const prices = HOSTING_TIERS.map((tier) => tier.monthlyUsd);
    expect(prices).toEqual([7.99, 14.99, 24.99, 44.99]);
    expect(EXTRA_EVENT_USD).toBe(9.99);
    expect(HOSTING_TIERS.some((tier) => tier.productId === POPULAR_TIER_ID)).toBe(true);
  });

  it("formats prices for each language", () => {
    expect(formatUsd(14.99, "en")).toBe("$14.99");
    expect(formatUsd(14.99, "fr").replace(/\s/g, " ")).toBe("14,99 $US");
  });

  it("links the App Store only for a real app id", () => {
    expect(appStoreUrl("1234567890")).toBe("https://apps.apple.com/app/id1234567890");
    expect(appStoreUrl(" 1234567 ")).toBe("https://apps.apple.com/app/id1234567");
    for (const id of [undefined, "", "abc", "12345", "1234567890123", "123/../4"]) {
      expect(appStoreUrl(id)).toBeNull();
    }
  });

  it("keeps the crawlable copy of the landing at the same prices", () => {
    const html = readFileSync(join(__dirname, "../../../index.html"), "utf8");
    for (const tier of HOSTING_TIERS) {
      expect(html).toContain(`${tier.guestCap} guests ${formatUsd(tier.monthlyUsd, "en")}`);
    }
    expect(html).toContain(`Extra events ${formatUsd(EXTRA_EVENT_USD, "en")} each`);
    expect(html).toContain(`from ${formatUsd(HOSTING_TIERS[0].monthlyUsd, "en")} a month`);
  });
});
