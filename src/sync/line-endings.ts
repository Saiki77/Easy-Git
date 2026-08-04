export type LineEnding = "\r\n" | "\n" | "\r";

export interface LineWithEnding {
  content: string;
  ending: LineEnding | "";
}

export function splitLinesPreservingEndings(text: string): LineWithEnding[] {
  const lines: LineWithEnding[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== "\r" && char !== "\n") continue;

    let ending: LineEnding;
    if (char === "\r" && text[index + 1] === "\n") {
      ending = "\r\n";
      lines.push({ content: text.slice(start, index), ending });
      index += 1;
    } else {
      ending = char;
      lines.push({ content: text.slice(start, index), ending });
    }
    start = index + 1;
  }

  if (start < text.length || lines.length === 0) {
    lines.push({ content: text.slice(start), ending: "" });
  }
  return lines;
}

export function splitLinesForMerge(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

export function preferredLineEnding(...texts: string[]): LineEnding {
  for (const text of texts) {
    const counts: Record<LineEnding, number> = { "\r\n": 0, "\n": 0, "\r": 0 };
    for (const line of splitLinesPreservingEndings(text)) {
      if (line.ending) counts[line.ending] += 1;
    }
    const best = (Object.entries(counts) as Array<[LineEnding, number]>)
      .sort((left, right) => right[1] - left[1])[0];
    if (best[1] > 0) return best[0];
  }
  return "\n";
}
