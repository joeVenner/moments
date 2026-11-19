/**
 * Apple app association: which iOS apps may open moments-hq.com links.
 * Served at /.well-known/apple-app-site-association; Apple's CDN fetches it
 * when the app (or its App Clip) is installed, so it must be JSON at that
 * exact path, over HTTPS, with no redirect.
 */

/** Apple Developer Team ID (public: it is part of every app's signature). */
export const APPLE_TEAM_ID = "7877JLKPRQ";
export const APP_BUNDLE_ID = "com.moments-hq.moments";
export const APP_CLIP_BUNDLE_ID = "com.moments-hq.moments.Clip";

export const APPLE_APP_SITE_ASSOCIATION_PATH = "/.well-known/apple-app-site-association";

interface LinkComponent {
  readonly "/": string;
  readonly exclude?: boolean;
  readonly caseSensitive?: boolean;
  readonly comment: string;
}

interface AppLinkDetail {
  readonly appIDs: readonly string[];
  readonly components: readonly LinkComponent[];
}

export interface AppleAppSiteAssociation {
  readonly applinks: { readonly details: readonly AppLinkDetail[] };
  readonly appclips: { readonly apps: readonly string[] };
}

/**
 * Event links open in the app; everything else stays on the web. The
 * slideshow is excluded: it is meant for a big screen in a browser, and the
 * app has no slideshow yet (any case, trailing slash included, as the web
 * router allows). No component names a query, so `?invite=` links match
 * by path and reach the app with their invite. Order matters: Apple uses
 * the first match.
 */
export function appleAppSiteAssociation(): AppleAppSiteAssociation {
  return {
    applinks: {
      details: [
        {
          appIDs: [`${APPLE_TEAM_ID}.${APP_BUNDLE_ID}`],
          components: [
            { "/": "/e/*/slideshow*", exclude: true, caseSensitive: false, comment: "The slideshow stays in the browser" },
            // `?*`: at least one character, so a bare /e/ stays on the web.
            { "/": "/e/?*", comment: "An event: join, feed, upload" },
          ],
        },
      ],
    },
    appclips: { apps: [`${APPLE_TEAM_ID}.${APP_CLIP_BUNDLE_ID}`] },
  };
}

// ---------------------------------------------------------------------------
// Smart App Banner: Safari's own "Open in the app / App Clip" bar on event
// pages. It needs the App Store id, which exists only once the app is
// listed, so it stays off until APP_STORE_ID is set.

const APP_STORE_ID_PATTERN = /^\d{6,12}$/;
/** The slideshow is for a big screen: no banner there, as in the association. */
const SLIDESHOW_PATH = /^\/e\/[^/]+\/slideshow/i;

/** True when event pages should carry the banner (a valid App Store id is set). */
export function isSmartAppBannerOn(appStoreId: string | undefined): boolean {
  return APP_STORE_ID_PATTERN.test(appStoreId?.trim() ?? "");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The `apple-itunes-app` meta content, or null without a valid App Store id.
 * `app-argument` is the page's own URL, so "Open" hands the app the event
 * (and its `?invite=`) the guest was looking at. Attribute-escaped.
 */
export function smartAppBannerContent(appStoreId: string | undefined, pageUrl: string): string | null {
  if (!isSmartAppBannerOn(appStoreId)) return null;
  const id = appStoreId?.trim() ?? "";
  return escapeAttribute(`app-id=${id}, app-clip-bundle-id=${APP_CLIP_BUNDLE_ID}, app-clip-display=card, app-argument=${pageUrl}`);
}

/** The slice of HTMLRewriter this needs (the real one exists only in Workers). */
export interface HeadRewriter {
  on(selector: "head", handlers: { element(element: { append(content: string, options: { html: boolean }): unknown }): void }): HeadRewriter;
  transform(response: Response): Response;
}

/**
 * The asset request for a bannered page, without conditional headers: the
 * asset's validators describe the file before the rewrite, so a 304 would
 * keep a page cached without (or with an old) banner.
 */
export function withoutValidators(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  return new Request(request, { headers });
}

/**
 * Adds the banner meta to an event page's HTML. Anything else (no App Store
 * id, the slideshow, a non-200 or non-HTML response) passes through as is.
 * The rewritten page drops the asset's validators and is per-URL (it holds
 * the URL, invite included), so it is private and always revalidated.
 */
export function withSmartAppBanner(
  response: Response,
  input: { pageUrl: URL; appStoreId: string | undefined; makeRewriter?: () => HeadRewriter }
): Response {
  const content = smartAppBannerContent(input.appStoreId, input.pageUrl.href);
  if (!content || SLIDESHOW_PATH.test(input.pageUrl.pathname) || response.status !== 200) return response;
  if (!(response.headers.get("Content-Type") ?? "").toLowerCase().startsWith("text/html")) return response;
  const makeRewriter = input.makeRewriter ?? (() => new HTMLRewriter());
  const rewritten = makeRewriter()
    .on("head", {
      element: (head) => {
        head.append(`<meta name="apple-itunes-app" content="${content}">`, { html: true });
      },
    })
    .transform(response);
  const headers = new Headers(rewritten.headers);
  headers.delete("ETag");
  headers.delete("Last-Modified");
  headers.set("Cache-Control", "private, no-cache");
  return new Response(rewritten.body, { status: rewritten.status, statusText: rewritten.statusText, headers });
}
