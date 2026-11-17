/**
 * The copy of the v1 document the iOS client is generated from
 * (`ios/MomentsKit/Sources/MomentsAPI/openapi.json`).
 *
 * String enums are relaxed to plain strings: Swift's generated enums reject
 * unknown values, so one new value from a newer server would fail the whole
 * response. The iOS mapper validates them instead and skips only the row.
 */
export function toIosOpenApiDocument(document: unknown): unknown {
  if (Array.isArray(document)) return document.map(toIosOpenApiDocument);
  if (typeof document !== "object" || document === null) return document;
  const node = document as Record<string, unknown>;
  const isString = node.type === "string" || (Array.isArray(node.type) && node.type.includes("string"));
  const isStringEnum = isString && Array.isArray(node.enum);
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !(isStringEnum && key === "enum"))
      .map(([key, value]) => [key, toIosOpenApiDocument(value)])
  );
}
