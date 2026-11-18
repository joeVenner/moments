/**
 * Bidi embeddings, overrides and isolates (U+202A-202E, U+2066-2069) can
 * make a caption read differently than it is ("gift<RLO>txt.exe").
 * Joiners and direction marks (U+200B-200F) are not here: emoji sequences
 * and Arabic, Persian and Hebrew text need them.
 */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

/**
 * What the app API refuses in a caption: control characters other than line
 * breaks (LF, CR), and the bidi controls above. No `g` flag, so `test` is
 * stateless.
 */
export const CAPTION_FORBIDDEN = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/;

/**
 * The web upload routes never refused captions, so for compatibility they
 * drop the bidi controls instead (every client, the app included, reads
 * these captions back).
 */
export function cleanWebCaption(raw: string): string {
  return raw.replace(BIDI_CONTROLS, "").trim();
}
