import { describe, expect, it } from "vitest";
import { pointsForContentType, highestMilestoneCrossed, MILESTONES } from "./points";

describe("pointsForContentType", () => {
  it("awards 1 point for images", () => {
    expect(pointsForContentType("image/png")).toBe(1);
  });

  it("awards 3 points for videos", () => {
    expect(pointsForContentType("video/mp4")).toBe(3);
  });

  it("is case-insensitive", () => {
    expect(pointsForContentType("VIDEO/MP4")).toBe(3);
  });
});

describe("highestMilestoneCrossed", () => {
  it("returns null when no threshold is crossed", () => {
    expect(highestMilestoneCrossed(2, 4)).toBeNull();
  });

  it("returns the threshold when exactly crossed", () => {
    expect(highestMilestoneCrossed(4, 5)).toBe(5);
  });

  it("returns null when already at or above every threshold", () => {
    expect(highestMilestoneCrossed(100, 101)).toBeNull();
  });

  it("returns the highest threshold when a batch jumps over several at once", () => {
    expect(highestMilestoneCrossed(2, 12)).toBe(10);
  });

  it("returns null for a zero-point upload (no change)", () => {
    expect(highestMilestoneCrossed(5, 5)).toBeNull();
  });

  it("respects a custom thresholds array", () => {
    expect(highestMilestoneCrossed(0, 3, [1, 2, 3])).toBe(3);
  });

  it("uses the exported MILESTONES by default", () => {
    expect(highestMilestoneCrossed(0, 1000)).toBe(MILESTONES[MILESTONES.length - 1]);
  });
});
