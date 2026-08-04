export function hasHiddenPathSegment(path: string): boolean {
  return path
    .split("/")
    .some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
}
