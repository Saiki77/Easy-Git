/**
 * Minimal glob matcher. Supports:
 *   *      → matches anything except "/"
 *   **     → matches anything including "/"
 *   ?      → matches one non-"/" character
 *   /      → literal path separator
 *
 * Patterns are matched against the full vault-relative path. A pattern
 * with no slashes also matches the basename. A pattern ending in `/` or
 * `/**` matches anything inside that directory.
 */
export function isExcluded(path: string, patterns: string[]): boolean {
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p || p.startsWith("#")) continue;
    if (matchesGlob(path, p)) return true;
    if (!p.includes("/") && matchesGlob(basename(path), p)) return true;
  }
  return false;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function matchesGlob(path: string, pattern: string): boolean {
  let pat = pattern;
  if (pat.endsWith("/")) pat += "**";
  const re = new RegExp("^" + globToRegex(pat) + "$");
  return re.test(path);
}

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+()|^$[]{}\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return out;
}
