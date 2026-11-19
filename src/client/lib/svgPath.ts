/**
 * SVG path data reduced to four absolute commands — `M x y`, `L x y`,
 * `C x1 y1 x2 y2 x y` and `Z` — so the iOS app can draw DiceBear's avatar
 * parts with a few lines of Swift (see avatar.shapes.test.ts). Relative
 * commands become absolute, H/V become L, S/T and Q become C, and arcs
 * become cubic Béziers.
 */

export type PathCommand =
  | { kind: "M" | "L"; x: number; y: number }
  | { kind: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { kind: "Z" };

const ARGUMENT_COUNTS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Reads numbers (and arc flags, which may be written without separators). */
class Scanner {
  private index = 0;
  constructor(private readonly text: string) {}

  private skipSeparators(): void {
    while (this.index < this.text.length && /[\s,]/.test(this.text[this.index])) this.index++;
  }

  atEnd(): boolean {
    this.skipSeparators();
    return this.index >= this.text.length;
  }

  peekCommand(): string | null {
    this.skipSeparators();
    const char = this.text[this.index];
    return char !== undefined && /[A-Za-z]/.test(char) ? char : null;
  }

  readCommand(): string {
    const command = this.peekCommand();
    if (!command || !(command.toUpperCase() in ARGUMENT_COUNTS)) {
      throw new Error(`bad path command at ${this.index}: ${this.text.slice(this.index, this.index + 10)}`);
    }
    this.index++;
    return command;
  }

  readNumber(): number {
    this.skipSeparators();
    const match = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.text.slice(this.index));
    if (!match) throw new Error(`expected a number at ${this.index}: ${this.text.slice(this.index, this.index + 10)}`);
    this.index += match[0].length;
    return Number(match[0]);
  }

  readFlag(): boolean {
    this.skipSeparators();
    const char = this.text[this.index];
    if (char !== "0" && char !== "1") throw new Error(`expected an arc flag at ${this.index}`);
    this.index++;
    return char === "1";
  }
}

/** Parses path data into absolute M/L/C/Z commands; throws on anything malformed. */
export function normalizePath(data: string): PathCommand[] {
  const scanner = new Scanner(data);
  const out: PathCommand[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // The last control point, for S (cubic) and T (quadratic) reflections.
  let lastCubic: [number, number] | null = null;
  let lastQuad: [number, number] | null = null;
  let command = "";

  const quadTo = (qx: number, qy: number, ex: number, ey: number) => {
    out.push({
      kind: "C",
      x1: x + (2 / 3) * (qx - x),
      y1: y + (2 / 3) * (qy - y),
      x2: ex + (2 / 3) * (qx - ex),
      y2: ey + (2 / 3) * (qy - ey),
      x: ex,
      y: ey,
    });
  };

  while (!scanner.atEnd()) {
    if (scanner.peekCommand() || !command) {
      command = scanner.readCommand();
    } else if (command === "Z" || command === "z") {
      throw new Error("numbers after Z");
    }
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    const dx = relative ? x : 0;
    const dy = relative ? y : 0;
    let cubic: [number, number] | null = null;
    let quad: [number, number] | null = null;

    switch (upper) {
      case "M": {
        x = scanner.readNumber() + dx;
        y = scanner.readNumber() + dy;
        startX = x;
        startY = y;
        out.push({ kind: "M", x, y });
        // Further pairs after a moveto are linetos.
        command = relative ? "l" : "L";
        break;
      }
      case "L": {
        x = scanner.readNumber() + dx;
        y = scanner.readNumber() + dy;
        out.push({ kind: "L", x, y });
        break;
      }
      case "H": {
        x = scanner.readNumber() + dx;
        out.push({ kind: "L", x, y });
        break;
      }
      case "V": {
        y = scanner.readNumber() + dy;
        out.push({ kind: "L", x, y });
        break;
      }
      case "C": {
        const [x1, y1, x2, y2, ex, ey] = [0, 1, 2, 3, 4, 5].map((i) => scanner.readNumber() + (i % 2 === 0 ? dx : dy));
        out.push({ kind: "C", x1, y1, x2, y2, x: ex, y: ey });
        cubic = [x2, y2];
        x = ex;
        y = ey;
        break;
      }
      case "S": {
        const [x1, y1]: [number, number] = lastCubic ? [2 * x - lastCubic[0], 2 * y - lastCubic[1]] : [x, y];
        const [x2, y2, ex, ey] = [0, 1, 2, 3].map((i) => scanner.readNumber() + (i % 2 === 0 ? dx : dy));
        out.push({ kind: "C", x1, y1, x2, y2, x: ex, y: ey });
        cubic = [x2, y2];
        x = ex;
        y = ey;
        break;
      }
      case "Q": {
        const [qx, qy, ex, ey] = [0, 1, 2, 3].map((i) => scanner.readNumber() + (i % 2 === 0 ? dx : dy));
        quadTo(qx, qy, ex, ey);
        quad = [qx, qy];
        x = ex;
        y = ey;
        break;
      }
      case "T": {
        const previous: [number, number] = lastQuad ?? [x, y];
        const qx: number = 2 * x - previous[0];
        const qy: number = 2 * y - previous[1];
        const ex = scanner.readNumber() + dx;
        const ey = scanner.readNumber() + dy;
        quadTo(qx, qy, ex, ey);
        quad = [qx, qy];
        x = ex;
        y = ey;
        break;
      }
      case "A": {
        const rx = scanner.readNumber();
        const ry = scanner.readNumber();
        const rotation = scanner.readNumber();
        const largeArc = scanner.readFlag();
        const sweep = scanner.readFlag();
        const ex = scanner.readNumber() + dx;
        const ey = scanner.readNumber() + dy;
        out.push(...arcToCubics(x, y, rx, ry, rotation, largeArc, sweep, ex, ey));
        x = ex;
        y = ey;
        break;
      }
      case "Z": {
        out.push({ kind: "Z" });
        x = startX;
        y = startY;
        break;
      }
    }
    lastCubic = cubic;
    lastQuad = quad;
  }
  return out;
}

/**
 * An SVG elliptical arc as cubic Béziers of at most 90° each, following the
 * SVG 1.1 implementation notes (F.6.5 endpoint → center, F.6.6 radii fix-up).
 */
export function arcToCubics(
  x1: number, y1: number, rxIn: number, ryIn: number, rotationDegrees: number,
  largeArc: boolean, sweep: boolean, x2: number, y2: number
): PathCommand[] {
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [{ kind: "L", x: x2, y: y2 }];

  const phi = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const hx = (x1 - x2) / 2;
  const hy = (y1 - y2) / 2;
  const x1p = cos * hx + sin * hy;
  const y1p = -sin * hx + cos * hy;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const factor = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = (factor * rx * y1p) / ry;
  const cyp = (-factor * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (t: number): [number, number] => [
    cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
    cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
  ];
  const derivative = (t: number): [number, number] => [
    -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
    -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos,
  ];

  const out: PathCommand[] = [];
  for (let i = 0; i < segments; i++) {
    const a = theta1 + i * step;
    const b = a + step;
    const [ax, ay] = point(a);
    const [bx, by] = i === segments - 1 ? [x2, y2] : point(b);
    const [dax, day] = derivative(a);
    const [dbx, dby] = derivative(b);
    out.push({ kind: "C", x1: ax + k * dax, y1: ay + k * day, x2: bx - k * dbx, y2: by - k * dby, x: bx, y: by });
  }
  return out;
}

/** A number with at most three decimals and no trailing zeros ("-0" as "0"). */
function format(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** Commands as compact path data: "M x y L x y C … Z", space-separated. */
export function formatPath(commands: readonly PathCommand[]): string {
  return commands
    .map((command) => {
      switch (command.kind) {
        case "M":
        case "L":
          return `${command.kind} ${format(command.x)} ${format(command.y)}`;
        case "C":
          return `C ${[command.x1, command.y1, command.x2, command.y2, command.x, command.y].map(format).join(" ")}`;
        case "Z":
          return "Z";
      }
    })
    .join(" ");
}
