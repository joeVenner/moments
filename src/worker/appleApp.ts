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
