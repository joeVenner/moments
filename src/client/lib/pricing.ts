/**
 * Hosting prices shown on the website (Yassir, 2026-11-21). The App Store
 * sells the same products; in the iOS app prices come from StoreKit, which
 * localises them per storefront, so these are the US list prices.
 */
export interface HostingTier {
  /** Product id seeded in migrations/0025_plans.sql. */
  readonly productId: string;
  readonly guestCap: number;
  readonly monthlyUsd: number;
}

export const HOSTING_TIERS: readonly HostingTier[] = Object.freeze([
  { productId: "host_50", guestCap: 50, monthlyUsd: 7.99 },
  { productId: "host_150", guestCap: 150, monthlyUsd: 14.99 },
  { productId: "host_300", guestCap: 300, monthlyUsd: 24.99 },
  { productId: "host_600", guestCap: 600, monthlyUsd: 44.99 },
]);

/** The tier most weddings pick, highlighted on the landing. */
export const POPULAR_TIER_ID = "host_150";

/** One-time "Extra event" add-on (`extra_event`). */
export const EXTRA_EVENT_USD = 9.99;

/** "$14.99" in English, "14,99 $US" in French. */
export function formatUsd(amount: number, lang: "en" | "fr"): string {
  return new Intl.NumberFormat(lang === "fr" ? "fr-FR" : "en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

/**
 * The App Store page, only once the app is listed: `VITE_APP_STORE_ID` is
 * its numeric id. Never guessed.
 */
export function appStoreUrl(appStoreId: string | undefined): string | null {
  const id = appStoreId?.trim() ?? "";
  return /^\d{6,12}$/.test(id) ? `https://apps.apple.com/app/id${id}` : null;
}
