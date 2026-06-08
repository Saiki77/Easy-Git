/**
 * Reversible Obsidian ↔ GitHub markdown transforms.
 *
 * The push side converts Obsidian-flavoured syntax that GitHub doesn't
 * render (callouts beyond the five GitHub types, `==highlights==`,
 * KaTeX-blocked `\phantom`) into forms GitHub renders correctly. Each
 * transform embeds enough metadata (inline HTML comments for callouts,
 * a comment line above the math block for `\phantom`) that the pull
 * side can losslessly invert. Highlights round-trip by syntax alone
 * because `<mark>` essentially never appears in hand-written Obsidian
 * notes.
 *
 * All functions are pure, idempotent, region-aware (code fences are
 * never touched), and produce structured counters so the caller can
 * surface Notice counts.
 */

import { splitByCodeRegions } from "./wikilink-rewrite";

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface PushTransformResult {
  markdown: string;
  calloutsRewritten: number;
  highlightsRewritten: number;
  mathMacrosRewritten: number;
}

export interface RestoreResult {
  markdown: string;
  calloutsRestored: number;
  highlightsRestored: number;
  mathMacrosRestored: number;
}

// ---------------------------------------------------------------------------
// Orchestrators — what the engine calls
// ---------------------------------------------------------------------------

/**
 * Run every push-side rewrite on prose regions. Code fences are passed
 * through verbatim via `splitByCodeRegions`. Output is GitHub-renderable
 * markdown carrying inline markers that the pull side restores from.
 */
export function applyPushTransforms(markdown: string): PushTransformResult {
  let calloutsRewritten = 0;
  let highlightsRewritten = 0;
  let mathMacrosRewritten = 0;

  const regions = splitByCodeRegions(markdown);
  const out: string[] = [];
  for (const region of regions) {
    if (region.kind === "code") {
      out.push(region.text);
      continue;
    }
    // Order matters: math first (so we know where math regions are
    // BEFORE we touch highlights, which must skip math), then highlights,
    // then callouts (line-anchored — order with the others doesn't matter).
    let text = region.text;
    const mathRes = rewriteMathForPush(text);
    text = mathRes.markdown;
    mathMacrosRewritten += mathRes.count;

    const hiRes = rewriteHighlightsForPush(text);
    text = hiRes.markdown;
    highlightsRewritten += hiRes.count;

    const coRes = rewriteCalloutsForPush(text);
    text = coRes.markdown;
    calloutsRewritten += coRes.count;

    out.push(text);
  }

  return {
    markdown: out.join(""),
    calloutsRewritten,
    highlightsRewritten,
    mathMacrosRewritten,
  };
}

/**
 * Run every pull-side restore on prose regions. Inverse of
 * applyPushTransforms on any markdown that was produced by it; no-op on
 * markdown that was never push-processed (no markers → no changes).
 */
export function applyPullRestores(markdown: string): RestoreResult {
  let calloutsRestored = 0;
  let highlightsRestored = 0;
  let mathMacrosRestored = 0;

  const regions = splitByCodeRegions(markdown);
  const out: string[] = [];
  for (const region of regions) {
    if (region.kind === "code") {
      out.push(region.text);
      continue;
    }
    // Reverse order of push (so each inverse sees the same "world" the
    // forward saw): callouts → highlights → math.
    let text = region.text;
    const coRes = restoreCalloutsFromPush(text);
    text = coRes.markdown;
    calloutsRestored += coRes.count;

    const hiRes = restoreHighlightsFromPush(text);
    text = hiRes.markdown;
    highlightsRestored += hiRes.count;

    const mathRes = restoreMathFromPush(text);
    text = mathRes.markdown;
    mathMacrosRestored += mathRes.count;

    out.push(text);
  }

  return {
    markdown: out.join(""),
    calloutsRestored,
    highlightsRestored,
    mathMacrosRestored,
  };
}

// ---------------------------------------------------------------------------
// Transform 1: Callouts
// ---------------------------------------------------------------------------

/**
 * Obsidian callout type → GitHub callout type. Unknown types fall
 * through to NOTE with the original recorded in the marker so round-
 * trip is lossless.
 */
const CALLOUT_MAP: Record<string, "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION"> = {
  // → NOTE
  note: "NOTE",
  info: "NOTE",
  summary: "NOTE",
  tldr: "NOTE",
  abstract: "NOTE",
  todo: "NOTE",
  question: "NOTE",
  faq: "NOTE",
  help: "NOTE",
  // → TIP
  tip: "TIP",
  hint: "TIP",
  success: "TIP",
  done: "TIP",
  check: "TIP",
  example: "TIP",
  // → IMPORTANT
  important: "IMPORTANT",
  // → WARNING
  warning: "WARNING",
  attention: "WARNING",
  // → CAUTION
  caution: "CAUTION",
  danger: "CAUTION",
  error: "CAUTION",
  bug: "CAUTION",
  failure: "CAUTION",
  fail: "CAUTION",
  missing: "CAUTION",
};

/** Obsidian-specific types we deliberately leave as plain blockquotes. */
const PLAIN_BLOCKQUOTE_TYPES = new Set(["quote", "cite"]);

const CALLOUT_PUSH_RE = /^(\s*>\s*)\[!([a-zA-Z]+)\]([+-]?)(\s.*)?$/;
const CALLOUT_PULL_RE =
  /^(\s*>\s*)\[!([A-Z]+)\]\s*<!--easygit-callout:original=([a-zA-Z]+),collapse=([+-]?)-->(\s.*)?$/;
const GITHUB_TYPES = new Set(["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]);

export function rewriteCalloutsForPush(prose: string): {
  markdown: string;
  count: number;
} {
  let count = 0;
  const lines = prose.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Nested blockquote check: `>` count > 1. The first non-whitespace
    // char must be `>`, and after stripping it there can be at most one
    // more `>` separated by whitespace before the `[!`. We just count
    // leading `>` after trimming spaces.
    if (isNestedBlockquote(line)) continue;
    // Skip lines that already look like a push-rewritten callout (so
    // push(push(x)) === push(x)).
    if (CALLOUT_PULL_RE.test(line)) continue;

    const m = line.match(CALLOUT_PUSH_RE);
    if (!m) continue;
    const [, prefix, rawType, collapse, rest] = m;
    const lower = rawType.toLowerCase();
    if (PLAIN_BLOCKQUOTE_TYPES.has(lower)) continue;
    // Already uppercase AND a real GitHub type AND no marker? It's
    // already a GitHub callout the user wrote by hand. Don't touch it.
    if (rawType === rawType.toUpperCase() && GITHUB_TYPES.has(rawType)) continue;

    const target = CALLOUT_MAP[lower] ?? "NOTE";
    const marker = `<!--easygit-callout:original=${rawType},collapse=${collapse}-->`;
    // Reassemble: prefix + [!TYPE] + space + marker + (rest with leading
    // space preserved). `rest` already includes the leading space if any.
    const trailing = rest ?? "";
    lines[i] = `${prefix}[!${target}] ${marker}${trailing}`;
    count += 1;
  }
  return { markdown: lines.join("\n"), count };
}

export function restoreCalloutsFromPush(prose: string): {
  markdown: string;
  count: number;
} {
  let count = 0;
  const lines = prose.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(CALLOUT_PULL_RE);
    if (!m) continue;
    const [, prefix, , origType, collapse, rest] = m;
    const trailing = rest ?? "";
    lines[i] = `${prefix}[!${origType}]${collapse}${trailing}`;
    count += 1;
  }
  return { markdown: lines.join("\n"), count };
}

function isNestedBlockquote(line: string): boolean {
  // Count the leading `>` markers (ignoring spaces between them).
  let depth = 0;
  let j = 0;
  while (j < line.length) {
    if (line[j] === " " || line[j] === "\t") {
      j++;
      continue;
    }
    if (line[j] === ">") {
      depth++;
      if (depth > 1) return true;
      j++;
      continue;
    }
    break;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Transform 2: Highlights
// ---------------------------------------------------------------------------

// Push: ==X== → <mark>X</mark>. Requires non-`=` neighbours (so we don't
// match inside `===`), non-whitespace at the inner edges (so `== loose ==`
// doesn't match), and no newline in the content.
const HIGHLIGHT_PUSH_RE = /(?<!=)==(?=\S)([^\n=]+?[^=\s])==(?!=)/g;

// Single-edge content version (matches `==a==` where content is one
// non-whitespace, non-= char).
const HIGHLIGHT_PUSH_SINGLE_RE = /(?<!=)==([^\n=\s])==(?!=)/g;

const HIGHLIGHT_PULL_RE = /<mark>([^\n]+?)<\/mark>/g;

export function rewriteHighlightsForPush(prose: string): {
  markdown: string;
  count: number;
} {
  let count = 0;
  // Skip math regions: `==` inside math has meaning to KaTeX.
  const regions = splitByMathRegions(prose);
  const out: string[] = [];
  for (const r of regions) {
    if (r.kind === "math") {
      out.push(r.text);
      continue;
    }
    const after = r.text
      .replace(HIGHLIGHT_PUSH_RE, (_, inner) => {
        count++;
        return `<mark>${inner}</mark>`;
      })
      .replace(HIGHLIGHT_PUSH_SINGLE_RE, (_, inner) => {
        count++;
        return `<mark>${inner}</mark>`;
      });
    out.push(after);
  }
  return { markdown: out.join(""), count };
}

export function restoreHighlightsFromPush(prose: string): {
  markdown: string;
  count: number;
} {
  let count = 0;
  const regions = splitByMathRegions(prose);
  const out: string[] = [];
  for (const r of regions) {
    if (r.kind === "math") {
      out.push(r.text);
      continue;
    }
    const after = r.text.replace(HIGHLIGHT_PULL_RE, (_, inner) => {
      count++;
      return `==${inner}==`;
    });
    out.push(after);
  }
  return { markdown: out.join(""), count };
}

// ---------------------------------------------------------------------------
// Transform 3: Math `\phantom`
// ---------------------------------------------------------------------------

type PhantomKind = "phantom" | "hphantom" | "vphantom";
interface PhantomRecord {
  kind: PhantomKind;
  args: string;
}

const MATH_REWRITE_PLACEHOLDER = "\\hspace{0.5em}";
/** Inline HTML comment that lives at the end of the preceding prose
 * region, immediately before the math opener. Same shape regardless of
 * whether the math is inline (`text $$...$$ text`) or on its own line
 * — that uniformity is what makes the round-trip lossless. */
const MATH_MARKER_AT_END_RE = /<!--easygit-math:phantoms=(\[.*?\])-->$/;

/**
 * Push: find every `\phantom{X}` / `\hphantom{X}` / `\vphantom{X}` inside
 * each `$$…$$` or `$…$` math block. Replace each with `\hspace{0.5em}`.
 * Append a marker as an inline HTML comment to the end of the prose
 * region immediately before the math token. NO newlines added — the
 * original line structure of the input is preserved exactly so the
 * round-trip is byte-identical.
 */
export function rewriteMathForPush(prose: string): {
  markdown: string;
  count: number;
} {
  let totalCount = 0;
  const regions = splitByMathRegions(prose);
  const out: string[] = [];

  for (const r of regions) {
    if (r.kind !== "math") {
      out.push(r.text);
      continue;
    }
    const { transformed, records } = extractPhantoms(r.text);
    if (records.length === 0) {
      out.push(r.text);
      continue;
    }
    totalCount += records.length;
    const marker = `<!--easygit-math:phantoms=${JSON.stringify(records)}-->`;
    // Append marker to the end of the preceding prose region. If there
    // is no preceding region (math at start of input), prepend the
    // marker as its own region.
    if (out.length > 0) {
      out[out.length - 1] = out[out.length - 1] + marker;
    } else {
      out.push(marker);
    }
    out.push(transformed);
  }

  return { markdown: out.join(""), count: totalCount };
}

/**
 * Pull: walk the prose/math regions; when a prose region ends with a
 * push marker, strip it and apply the recorded phantoms to the next
 * math region. Preserves all whitespace.
 */
export function restoreMathFromPush(prose: string): {
  markdown: string;
  count: number;
} {
  let total = 0;
  const regions = splitByMathRegions(prose);
  const out: string[] = [];
  let pendingRecords: PhantomRecord[] | null = null;

  for (const r of regions) {
    if (r.kind === "prose") {
      const m = r.text.match(MATH_MARKER_AT_END_RE);
      if (m) {
        try {
          pendingRecords = JSON.parse(m[1]) as PhantomRecord[];
          // Strip the marker (and only the marker) from the prose end.
          out.push(r.text.slice(0, r.text.length - m[0].length));
        } catch {
          // Corrupted marker — keep the prose as-is, ignore the marker.
          out.push(r.text);
          pendingRecords = null;
        }
      } else {
        out.push(r.text);
      }
    } else {
      // Math region.
      if (pendingRecords) {
        const { restored, restoredCount } = applyPhantomsToMath(r.text, pendingRecords);
        total += restoredCount;
        out.push(restored);
        pendingRecords = null;
      } else {
        out.push(r.text);
      }
    }
  }

  return { markdown: out.join(""), count: total };
}

/** Find each phantom-family macro in a math text and return the
 * rewritten text plus the list of original records. */
function extractPhantoms(mathText: string): {
  transformed: string;
  records: PhantomRecord[];
} {
  const records: PhantomRecord[] = [];
  let out = "";
  let i = 0;
  while (i < mathText.length) {
    // Look for \phantom / \hphantom / \vphantom followed by {…} with
    // balanced braces.
    if (mathText[i] === "\\") {
      const m = mathText.slice(i).match(/^\\(h|v)?phantom\s*\{/);
      if (m) {
        const start = i + m[0].length;
        const end = findClosingBrace(mathText, start);
        if (end !== -1) {
          const kindLetter = m[1] ?? "";
          const kind: PhantomKind =
            kindLetter === "h" ? "hphantom" : kindLetter === "v" ? "vphantom" : "phantom";
          const args = mathText.slice(start, end);
          records.push({ kind, args });
          out += MATH_REWRITE_PLACEHOLDER;
          i = end + 1;
          continue;
        }
      }
    }
    out += mathText[i];
    i++;
  }
  return { transformed: out, records };
}

function applyPhantomsToMath(
  mathText: string,
  records: PhantomRecord[],
): { restored: string; restoredCount: number } {
  let out = "";
  let i = 0;
  let recordIdx = 0;
  while (i < mathText.length) {
    if (mathText.slice(i, i + MATH_REWRITE_PLACEHOLDER.length) === MATH_REWRITE_PLACEHOLDER) {
      if (recordIdx < records.length) {
        const r = records[recordIdx];
        out += `\\${r.kind}{${r.args}}`;
        recordIdx++;
        i += MATH_REWRITE_PLACEHOLDER.length;
        continue;
      }
    }
    out += mathText[i];
    i++;
  }
  return { restored: out, restoredCount: recordIdx };
}

function findClosingBrace(text: string, start: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++; // skip the next char (escaped)
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Math-region splitter
// ---------------------------------------------------------------------------

type MathRegion = { kind: "math" | "prose"; text: string };

/**
 * Split a prose-only string (already free of fenced code) into math and
 * non-math regions. Recognises `$$…$$` blocks (potentially multi-line)
 * and `$…$` inline math (single line, no whitespace immediately inside
 * the dollars per GitHub's GFM rule).
 *
 * Round-trip: concatenating `regions.map(r => r.text).join("")` returns
 * the input verbatim.
 */
export function splitByMathRegions(text: string): MathRegion[] {
  const out: MathRegion[] = [];
  let i = 0;
  let buf = "";

  const flushProse = () => {
    if (buf.length === 0) return;
    out.push({ kind: "prose", text: buf });
    buf = "";
  };

  while (i < text.length) {
    if (text[i] === "$") {
      // Display math: `$$` ... `$$`
      if (text[i + 1] === "$") {
        const close = findUnescapedToken(text, i + 2, "$$");
        if (close !== -1) {
          flushProse();
          out.push({ kind: "math", text: text.slice(i, close + 2) });
          i = close + 2;
          continue;
        }
      } else {
        // Inline math: `$X$` where neither edge is whitespace and `X`
        // doesn't contain a newline.
        const close = findInlineMathClose(text, i);
        if (close !== -1) {
          flushProse();
          out.push({ kind: "math", text: text.slice(i, close + 1) });
          i = close + 1;
          continue;
        }
      }
    }
    buf += text[i];
    i++;
  }
  flushProse();
  return out;
}

function findUnescapedToken(text: string, from: number, token: string): number {
  let i = from;
  while (i <= text.length - token.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text.slice(i, i + token.length) === token) return i;
    i++;
  }
  return -1;
}

function findInlineMathClose(text: string, openIdx: number): number {
  // Must have a non-whitespace char immediately after `$` for GFM.
  if (openIdx + 1 >= text.length) return -1;
  if (/\s/.test(text[openIdx + 1])) return -1;
  let i = openIdx + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") return -1; // single-line only
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "$") {
      // Closing `$` must be preceded by non-whitespace.
      if (!/\s/.test(text[i - 1])) {
        return i;
      }
    }
    i++;
  }
  return -1;
}
