export function pointsForContentType(contentType: string): number {
  return contentType.toLowerCase().startsWith("video/") ? 3 : 1;
}

/** Ascending point thresholds that trigger a one-time milestone celebration. */
export const MILESTONES = [5, 10, 25, 50, 100];

/**
 * Returns the highest milestone crossed by going from `pointsBefore` to
 * `pointsAfter`, or `null` if none was crossed. If a single upload batch
 * jumps over several thresholds at once, only the highest is returned —
 * callers should celebrate once, not once per threshold.
 */
export function highestMilestoneCrossed(
  pointsBefore: number,
  pointsAfter: number,
  milestones: number[] = MILESTONES
): number | null {
  let highest: number | null = null;
  for (const m of milestones) {
    if (pointsBefore < m && pointsAfter >= m) highest = m;
  }
  return highest;
}
