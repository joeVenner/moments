import { describe, expect, it } from "vitest";
import { withRanks } from "./leaderboard";

const row = (nickname: string, points: number) => ({
  participant_id: nickname,
  nickname,
  avatar_seed: null,
  total_points: points,
  moment_count: 0,
});

describe("withRanks", () => {
  it("shares ranks on equal points and skips after ties", () => {
    expect(withRanks([row("a", 9), row("b", 9), row("c", 5), row("d", 5), row("e", 0)]).map((e) => e.rank)).toEqual([
      1, 1, 3, 3, 5,
    ]);
  });

  it("handles empty and all-zero boards", () => {
    expect(withRanks([])).toEqual([]);
    expect(withRanks([row("a", 0), row("b", 0)]).map((e) => e.rank)).toEqual([1, 1]);
  });
});
