/**
 * Pins the lookbehind-free highlight regexes. WebKit before 16.4 throws a
 * parse-time SyntaxError on regex lookbehind, which killed the whole plugin
 * bundle on those iOS builds, so HIGHLIGHT_PUSH_RE / HIGHLIGHT_PUSH_SINGLE_RE
 * use a consumed `(^|[^=])` prefix group instead. These tests prove the
 * rewrite byte-identical to the old lookbehind form: exhaustively over every
 * short string, then on seeded fuzz and hand-picked tricky cases. Node
 * supports lookbehind, so the OLD regexes live here as the reference.
 */

import { describe, expect, test } from "vitest";
import {
  HIGHLIGHT_PUSH_RE,
  HIGHLIGHT_PUSH_SINGLE_RE,
  rewriteHighlightsForPush,
  restoreHighlightsFromPush,
} from "../src/sync/markdown-transforms";

// The pre-fix regexes, verbatim (reference implementation for equivalence).
const OLD_MULTI = /(?<!=)==(?=\S)([^\n=]+?[^=\s])==(?!=)/g;
const OLD_SINGLE = /(?<!=)==([^\n=\s])==(?!=)/g;

function oldApply(s: string): { markdown: string; count: number } {
  let count = 0;
  const markdown = s
    .replace(OLD_MULTI, (_, inner) => {
      count++;
      return `<mark>${inner}</mark>`;
    })
    .replace(OLD_SINGLE, (_, inner) => {
      count++;
      return `<mark>${inner}</mark>`;
    });
  return { markdown, count };
}

function newApply(s: string): { markdown: string; count: number } {
  let count = 0;
  const markdown = s
    .replace(HIGHLIGHT_PUSH_RE, (_, prefix: string, inner: string) => {
      count++;
      return `${prefix}<mark>${inner}</mark>`;
    })
    .replace(HIGHLIGHT_PUSH_SINGLE_RE, (_, prefix: string, inner: string) => {
      count++;
      return `${prefix}<mark>${inner}</mark>`;
    });
  return { markdown, count };
}

function expectEquivalent(input: string): void {
  const want = oldApply(input);
  const got = newApply(input);
  expect(got.markdown, JSON.stringify(input)).toBe(want.markdown);
  expect(got.count, JSON.stringify(input)).toBe(want.count);
  // The public function must agree too ($-free inputs: the math-region
  // split is the identity, so any difference would be a regex difference).
  if (!input.includes("$") && !input.includes("`")) {
    const pub = rewriteHighlightsForPush(input);
    expect(pub.markdown, JSON.stringify(input)).toBe(want.markdown);
    expect(pub.count, JSON.stringify(input)).toBe(want.count);
  }
}

describe("lookbehind removal", () => {
  test("the shipped regexes contain no lookbehind", () => {
    expect(HIGHLIGHT_PUSH_RE.source).not.toContain("(?<");
    expect(HIGHLIGHT_PUSH_SINGLE_RE.source).not.toContain("(?<");
  });

  test("exhaustive equivalence with the old lookbehind form, all strings up to length 6", () => {
    const alphabet = ["=", "a", "b", " ", "\n"];
    let prev = [""];
    expectEquivalent("");
    for (let len = 1; len <= 6; len++) {
      const next: string[] = [];
      for (const p of prev) {
        for (const c of alphabet) {
          const s = p + c;
          next.push(s);
          expectEquivalent(s);
        }
      }
      prev = next;
    }
  });

  test("equivalence on hand-picked tricky cases", () => {
    const cases = [
      "==hello== world",
      "x==ab==",
      "a ==x y== b",
      "==a== ==b==",
      "==ab== ==cd==",
      "==a====b==",
      "==aa====bb==",
      "===bold===",
      "== loose ==",
      "====",
      "=====",
      "=x==ab==",
      "==a==b==",
      "==a ==b==",
      "==ab==\n==cd==",
      "line one\n==start of line two== rest",
      "ends with ==highlight==",
      "==multi word highlight== and ==another one== here",
      "equation a == b stays",
      "a === b stays too",
      "<mark>already marked</mark> and ==new==",
    ];
    for (const c of cases) expectEquivalent(c);
  });

  test("equivalence on seeded fuzz (deterministic)", () => {
    const alphabet = ["=", "a", " ", "\n", "x", "<", ">", "b"];
    // Tiny LCG so failures reproduce exactly.
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 2000; i++) {
      const len = 8 + Math.floor(rand() * 13);
      let s = "";
      for (let j = 0; j < len; j++) {
        s += alphabet[Math.floor(rand() * alphabet.length)];
      }
      expectEquivalent(s);
    }
  });
});

describe("highlight push behavior", () => {
  test("marks highlights and counts them", () => {
    const { markdown, count } = rewriteHighlightsForPush(
      "a ==one== b ==two words== c ==x== d",
    );
    expect(markdown).toBe(
      "a <mark>one</mark> b <mark>two words</mark> c <mark>x</mark> d",
    );
    expect(count).toBe(3);
  });

  test("start of string and start of line both match", () => {
    expect(rewriteHighlightsForPush("==top==").markdown).toBe("<mark>top</mark>");
    expect(rewriteHighlightsForPush("x\n==line==").markdown).toBe(
      "x\n<mark>line</mark>",
    );
  });

  test("non-highlights stay untouched", () => {
    for (const s of ["===bold===", "== loose ==", "a == b", "====", "x=y"]) {
      const out = rewriteHighlightsForPush(s);
      expect(out.markdown).toBe(s);
      expect(out.count).toBe(0);
    }
  });

  test("push then restore round-trips", () => {
    const inputs = [
      "==hi== there",
      "note ==a== end",
      "==multi word== x\nand ==line two==",
    ];
    for (const input of inputs) {
      const pushed = rewriteHighlightsForPush(input);
      const restored = restoreHighlightsFromPush(pushed.markdown);
      expect(restored.markdown).toBe(input);
      expect(restored.count).toBe(pushed.count);
    }
  });
});
