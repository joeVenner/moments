import { describe, expect, it } from "vitest";
import { arcToCubics, formatPath, normalizePath, type PathCommand } from "./svgPath";

const path = (data: string) => formatPath(normalizePath(data));

/** The point of a cubic at t. */
function at(start: [number, number], c: Extract<PathCommand, { kind: "C" }>, t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * u * start[0] + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
    u * u * u * start[1] + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
  ];
}

describe("normalizePath", () => {
  it("makes relative commands absolute and H/V lines", () => {
    expect(path("M10 20l5 5h10v-3H0V1z")).toBe("M 10 20 L 15 25 L 25 25 L 25 22 L 0 22 L 0 1 Z");
  });

  it("reads compact numbers: signs, leading dots and chained decimals", () => {
    // ".5-.3" is 0.5 then -0.3; "1.2.3e1" is 1.2 then 0.3e1 (3).
    expect(path("M.5-.3l1.2.3e1-2 -2")).toBe("M 0.5 -0.3 L 1.7 2.7 L -0.3 0.7");
  });

  it("treats extra pairs after M as lines, relative after m", () => {
    expect(path("M1 1 2 2 3 3")).toBe("M 1 1 L 2 2 L 3 3");
    expect(path("m1 1 2 2")).toBe("M 1 1 L 3 3");
  });

  it("returns to the subpath start after Z", () => {
    expect(path("M5 5L10 5Zl1 1")).toBe("M 5 5 L 10 5 Z L 6 6");
  });

  it("keeps cubics and reflects S controls", () => {
    expect(path("M0 0C1 2 3 4 5 6s7 8 9 10")).toBe("M 0 0 C 1 2 3 4 5 6 C 7 8 12 14 14 16");
    // An S with no cubic before it uses the current point.
    expect(path("M0 0S1 1 2 2")).toBe("M 0 0 C 0 0 1 1 2 2");
  });

  it("turns quadratics into cubics and reflects T controls", () => {
    expect(path("M0 0Q3 3 6 0")).toBe("M 0 0 C 2 2 4 2 6 0");
    expect(path("M0 0Q3 3 6 0t6 0")).toBe("M 0 0 C 2 2 4 2 6 0 C 8 -2 10 -2 12 0");
  });

  it("reads arc flags written without separators", () => {
    const [, arc] = normalizePath("M0 0a5 5 0 016 0");
    expect(arc.kind).toBe("C");
  });

  it("rejects malformed data", () => {
    expect(() => normalizePath("M0")).toThrow();
    expect(() => normalizePath("X1 2")).toThrow();
    expect(() => normalizePath("M0 0 a1 1 0 2 1 2 2")).toThrow();
    expect(() => normalizePath("M0 0Z 1 1")).toThrow();
  });
});

describe("arcToCubics", () => {
  it("draws a half circle through its top", () => {
    const curves = arcToCubics(0, 0, 5, 5, 0, false, true, 10, 0);
    expect(curves).toHaveLength(2);
    const first = curves[0] as Extract<PathCommand, { kind: "C" }>;
    const top = at([0, 0], first, 1);
    expect(top[0]).toBeCloseTo(5, 6);
    expect(Math.abs(top[1])).toBeCloseTo(5, 6);
    // Every sampled point stays on the circle (within 0.01 for a radius of 5).
    let start: [number, number] = [0, 0];
    for (const curve of curves as Extract<PathCommand, { kind: "C" }>[]) {
      for (const t of [0.25, 0.5, 0.75]) {
        const [x, y] = at(start, curve, t);
        expect(Math.hypot(x - 5, y)).toBeCloseTo(5, 2);
      }
      start = [curve.x, curve.y];
    }
    expect(start).toEqual([10, 0]);
  });

  it("follows the sweep flag", () => {
    const clockwise = arcToCubics(0, 0, 5, 5, 0, false, true, 10, 0)[0] as Extract<PathCommand, { kind: "C" }>;
    const counter = arcToCubics(0, 0, 5, 5, 0, false, false, 10, 0)[0] as Extract<PathCommand, { kind: "C" }>;
    expect(Math.sign(at([0, 0], clockwise, 1)[1])).toBe(-Math.sign(at([0, 0], counter, 1)[1]));
  });

  it("scales radii that are too small, and handles degenerate arcs", () => {
    const curves = arcToCubics(0, 0, 1, 1, 0, false, true, 10, 0);
    expect(curves.at(-1)).toMatchObject({ x: 10, y: 0 });
    expect(arcToCubics(3, 3, 5, 5, 0, false, true, 3, 3)).toEqual([]);
    expect(arcToCubics(0, 0, 0, 5, 0, false, true, 4, 4)).toEqual([{ kind: "L", x: 4, y: 4 }]);
  });

  it("uses up to four segments for a large arc", () => {
    expect(arcToCubics(0, 0, 5, 5, 0, true, true, 0.01, 0)).toHaveLength(4);
  });
});
