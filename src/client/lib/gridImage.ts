import type { MomentData } from "./types";

type GridMoment = Pick<MomentData, "media_url" | "thumb_url">;

/**
 * Images a photo card can show, smallest first: the grid thumbnail, then
 * the original for when it is missing or fails to load. A pending upload's
 * local preview is shown as is.
 */
export function gridPhotoSources(moment: GridMoment): string[] {
  const thumb = moment.thumb_url || null;
  if (!thumb || thumb === moment.media_url) return [moment.media_url];
  return [thumb, moment.media_url];
}

/**
 * A still for a video's tap-to-play tile: its thumbnail (the first frame),
 * never the video file itself; null shows the plain placeholder.
 */
export function videoPoster(moment: GridMoment): string | null {
  return moment.thumb_url || null;
}
