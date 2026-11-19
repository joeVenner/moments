import { formatPath, normalizePath } from "./svgPath";

/**
 * Reads one DiceBear funEmoji part (an SVG fragment) into plain layers the
 * iOS app can draw, and writes them as Swift. Only the SVG features these
 * parts use are understood; anything else throws, so a DiceBear update that
 * starts using something new fails the generator instead of drawing wrong.
 */

export type AvatarPaint =
  | { kind: "color"; hex: string; alpha: number }
  | { kind: "linear"; x1: number; y1: number; x2: number; y2: number; stops: AvatarStop[] };

export interface AvatarStop {
  offset: number;
  hex: string;
  alpha: number;
}

export interface AvatarStroke {
  hex: string;
  width: number;
  roundCap: boolean;
  roundJoin: boolean;
  miterLimit: number;
}

export interface AvatarPath {
  /** Absolute M/L/C/Z path data (svgPath.ts). */
  d: string;
  fill: AvatarPaint | null;
  evenOdd: boolean;
  stroke: AvatarStroke | null;
  opacity: number;
}

/** A top-level element: one path, or a group drawn as one layer. */
export interface AvatarLayer {
  opacity: number;
  softLight: boolean;
  paths: AvatarPath[];
}

type Attributes = Record<string, string>;

const PATH_ATTRIBUTES = new Set([
  "d", "fill", "fill-rule", "clip-rule", "opacity", "style",
  "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit",
]);
const GROUP_ATTRIBUTES = new Set(["fill", "fill-rule", "clip-rule", "opacity", "style"]);

function attributes(source: string, allowed: ReadonlySet<string>, tag: string): Attributes {
  const result: Attributes = {};
  const rest = source.replace(/\s*([\w:-]+)="([^"]*)"/g, (_, name: string, value: string) => {
    if (!allowed.has(name)) throw new Error(`unsupported attribute ${name} on <${tag}>`);
    result[name] = value;
    return "";
  });
  if (rest.trim() !== "") throw new Error(`unreadable attributes on <${tag}>: ${rest}`);
  return result;
}

/** "#fff" or "#2B1607" as six lowercase hex digits. */
export function hexColor(value: string): string {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short) return `${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  const long = /^#([0-9a-f]{6})$/i.exec(value);
  if (long) return long[1].toLowerCase();
  throw new Error(`unsupported color ${value}`);
}

function number(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`bad number ${value}`);
  return parsed;
}

function readGradients(defs: string): Map<string, AvatarPaint> {
  const gradients = new Map<string, AvatarPaint>();
  const rest = defs.replace(
    /<linearGradient\s+([^>]*)>([\s\S]*?)<\/linearGradient>/g,
    (_, head: string, body: string) => {
      const attrs = attributes(head, new Set(["id", "x1", "y1", "x2", "y2", "gradientUnits"]), "linearGradient");
      if (attrs.gradientUnits !== "userSpaceOnUse" || !attrs.id) throw new Error("only userSpaceOnUse gradients with an id");
      const stops: AvatarStop[] = [];
      const leftover = body.replace(/<stop\s*([^>]*?)\s*\/>/g, (__, stopAttrs: string) => {
        const stop = attributes(stopAttrs, new Set(["offset", "stop-color", "stop-opacity"]), "stop");
        stops.push({
          offset: number(stop.offset, 0),
          hex: hexColor(stop["stop-color"] ?? "#000"),
          alpha: number(stop["stop-opacity"], 1),
        });
        return "";
      });
      if (leftover.trim() !== "" || stops.length === 0) throw new Error(`unsupported gradient body in ${attrs.id}`);
      gradients.set(attrs.id, {
        kind: "linear",
        x1: number(attrs.x1, 0),
        y1: number(attrs.y1, 0),
        x2: number(attrs.x2, 0),
        y2: number(attrs.y2, 0),
        stops,
      });
      return "";
    }
  );
  if (rest.trim() !== "") throw new Error(`unsupported defs: ${rest.slice(0, 40)}`);
  return gradients;
}

function paint(value: string, gradients: ReadonlyMap<string, AvatarPaint>): AvatarPaint | null {
  if (value === "none") return null;
  const reference = /^url\(#([^)]+)\)$/.exec(value);
  if (reference) {
    const gradient = gradients.get(reference[1]);
    if (!gradient) throw new Error(`unknown gradient ${reference[1]}`);
    return gradient;
  }
  return { kind: "color", hex: hexColor(value), alpha: 1 };
}

function isSoftLight(style: string | undefined): boolean {
  if (style === undefined) return false;
  if (style.trim() !== "mix-blend-mode:soft-light") throw new Error(`unsupported style ${style}`);
  return true;
}

/** Group attributes a path inherits (SVG's own defaults otherwise). */
interface Inherited {
  fill?: string;
  fillRule?: string;
}

function readPath(attrs: Attributes, inherited: Inherited, gradients: ReadonlyMap<string, AvatarPaint>): AvatarPath {
  if (!attrs.d) throw new Error("path without d");
  const fillRule = attrs["fill-rule"] ?? inherited.fillRule ?? "nonzero";
  if (fillRule !== "nonzero" && fillRule !== "evenodd") throw new Error(`unsupported fill-rule ${fillRule}`);
  const linecap = attrs["stroke-linecap"] ?? "butt";
  const linejoin = attrs["stroke-linejoin"] ?? "miter";
  if (!["butt", "round"].includes(linecap) || !["miter", "round"].includes(linejoin)) {
    throw new Error(`unsupported stroke style ${linecap}/${linejoin}`);
  }
  const strokeColor = attrs.stroke === undefined ? null : paint(attrs.stroke, gradients);
  // SVG composites a path's fill and stroke as one before its opacity; the
  // app applies opacity to each, which differs where they overlap.
  if (strokeColor && number(attrs.opacity, 1) !== 1) throw new Error("opacity on a stroked path");
  if (strokeColor && strokeColor.kind !== "color") throw new Error("only solid strokes");
  return {
    d: formatPath(normalizePath(attrs.d)),
    // SVG fills black unless told otherwise.
    fill: paint(attrs.fill ?? inherited.fill ?? "#000", gradients),
    evenOdd: fillRule === "evenodd",
    stroke: strokeColor && {
      hex: strokeColor.hex,
      width: number(attrs["stroke-width"], 1),
      roundCap: linecap === "round",
      roundJoin: linejoin === "round",
      miterLimit: number(attrs["stroke-miterlimit"], 4),
    },
    opacity: number(attrs.opacity, 1),
  };
}

/** One funEmoji part's SVG fragment as layers, in drawing order. */
export function readAvatarPart(svg: string): AvatarLayer[] {
  const defs = [...svg.matchAll(/<defs>([\s\S]*?)<\/defs>/g)].map((match) => match[1]).join("");
  const gradients = readGradients(defs);
  const body = svg.replace(/<defs>[\s\S]*?<\/defs>/g, "");

  const layers: AvatarLayer[] = [];
  let group: { layer: AvatarLayer; inherited: Inherited } | null = null;
  let consumed = 0;
  for (const match of body.matchAll(/<(\/?)(\w+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g)) {
    if (body.slice(consumed, match.index).trim() !== "") throw new Error("text between elements");
    consumed = match.index + match[0].length;
    const [, closing, tag, attrSource, selfClosing] = match;
    if (tag === "path" && !closing && selfClosing) {
      const attrs = attributes(attrSource, PATH_ATTRIBUTES, "path");
      if (group) {
        if (attrs.style !== undefined) throw new Error("blend modes inside a group");
        group.layer.paths.push(readPath(attrs, group.inherited, gradients));
      } else {
        // A lone path's opacity and blend apply to it as a layer.
        const path = readPath({ ...attrs, opacity: "1" }, {}, gradients);
        layers.push({ opacity: number(attrs.opacity, 1), softLight: isSoftLight(attrs.style), paths: [path] });
      }
    } else if (tag === "g" && !closing && !selfClosing) {
      if (group) throw new Error("nested groups");
      const attrs = attributes(attrSource, GROUP_ATTRIBUTES, "g");
      group = {
        layer: { opacity: number(attrs.opacity, 1), softLight: isSoftLight(attrs.style), paths: [] },
        inherited: { fill: attrs.fill, fillRule: attrs["fill-rule"] },
      };
    } else if (tag === "g" && closing) {
      if (!group) throw new Error("unbalanced </g>");
      layers.push(group.layer);
      group = null;
    } else {
      throw new Error(`unsupported element <${closing}${tag}>`);
    }
  }
  if (group || body.slice(consumed).trim() !== "") throw new Error("unbalanced or trailing markup");
  return layers;
}

// MARK: - Swift

function swiftNumber(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function swiftPaint(value: AvatarPaint): string {
  if (value.kind === "color") {
    return value.alpha === 1 ? `.color(0x${value.hex})` : `.color(0x${value.hex}, alpha: ${swiftNumber(value.alpha)})`;
  }
  const stops = value.stops
    .map((stop) => `AvatarStop(${swiftNumber(stop.offset)}, 0x${stop.hex}, alpha: ${swiftNumber(stop.alpha)})`)
    .join(", ");
  const points = [value.x1, value.y1, value.x2, value.y2].map(swiftNumber);
  return `.linear(x1: ${points[0]}, y1: ${points[1]}, x2: ${points[2]}, y2: ${points[3]}, stops: [${stops}])`;
}

function swiftPath(path: AvatarPath, indent: string): string {
  const parts = [`"${path.d}"`, `fill: ${path.fill ? swiftPaint(path.fill) : "nil"}`];
  if (path.evenOdd) parts.push("evenOdd: true");
  if (path.stroke) {
    const s = path.stroke;
    parts.push(
      `stroke: AvatarStroke(0x${s.hex}, width: ${swiftNumber(s.width)}, roundCap: ${s.roundCap}, roundJoin: ${s.roundJoin}, miterLimit: ${swiftNumber(s.miterLimit)})`
    );
  }
  if (path.opacity !== 1) parts.push(`opacity: ${swiftNumber(path.opacity)}`);
  return `${indent}AvatarShapePath(${parts.join(", ")}),`;
}

function swiftLayers(layers: readonly AvatarLayer[], indent: string): string {
  return layers
    .map((layer) => {
      const options = [
        ...(layer.opacity !== 1 ? [`opacity: ${swiftNumber(layer.opacity)}`] : []),
        ...(layer.softLight ? ["softLight: true"] : []),
      ];
      const paths = layer.paths.map((path) => swiftPath(path, `${indent}    `)).join("\n");
      return `${indent}AvatarLayer(${options.map((option) => `${option}, `).join("")}paths: [\n${paths}\n${indent}]),`;
    })
    .join("\n");
}

/** A Swift extension giving each case of `typeName` its layers. */
export function swiftPartsExtension(typeName: string, parts: ReadonlyArray<readonly [string, AvatarLayer[]]>): string {
  const cases = parts
    .map(([name, layers]) => `        case .${name}: [\n${swiftLayers(layers, "            ")}\n        ]`)
    .join("\n");
  return `extension ${typeName} {\n    var layers: [AvatarLayer] {\n        switch self {\n${cases}\n        }\n    }\n}\n`;
}
