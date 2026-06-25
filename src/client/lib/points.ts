export function pointsForContentType(contentType: string): number {
  return contentType.toLowerCase().startsWith("video/") ? 3 : 1;
}
