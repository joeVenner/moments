/**
 * Checks a file's first bytes against its declared type, so an upload that
 * says image/jpeg is one. The declared type is what /media serves, and the
 * client picks it, so it is checked before the moment goes live.
 */

/** Bytes to read from the start of the object; covers every check below. */
export const SIGNATURE_BYTES = 16;

const ascii = (bytes: Uint8Array, offset: number, text: string) =>
  [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) => prefix.every((byte, index) => bytes[index] === byte);

/** ISO base media (MP4, MOV, HEIC): an `ftyp` box first. */
const isIsoMedia = (bytes: Uint8Array) => ascii(bytes, 4, "ftyp");

/** Older QuickTime files may open with another top-level atom. */
const QUICKTIME_ATOMS = ["moov", "mdat", "wide", "free", "skip", "pnot"];

export function matchesContentType(bytes: Uint8Array, contentType: string): boolean {
  switch (contentType.toLowerCase()) {
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/gif":
      return ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a");
    case "image/webp":
      return ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP");
    case "image/heic":
    case "image/heif":
    case "video/mp4":
      return isIsoMedia(bytes);
    case "video/quicktime":
      return isIsoMedia(bytes) || QUICKTIME_ATOMS.some((atom) => ascii(bytes, 4, atom));
    case "video/webm":
      return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    default:
      return false;
  }
}
