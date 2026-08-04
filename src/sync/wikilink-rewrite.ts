/**
 * Pure transform: Obsidian wikilink embeds → CommonMark image/link references.
 *
 * Runs at push time only. Does not touch the vault file. The vault keeps its
 * wikilink form (Obsidian renders it natively); GitHub gets the rewritten form.
 *
 * Scope: image-and-image-like embeds. Internal [[note]] links are left alone.
 * Inputs inside fenced code blocks or inline code are left alone.
 */

import { splitLinesPreservingEndings } from "./line-endings";

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico", "tiff",
]);

export interface ResolvedTarget {
  /** TFile-like — only the path is needed by the rewriter. */
  path: string;
}

export type WikilinkResolver = (
  linkpath: string,
  sourcePath: string,
) => ResolvedTarget | null;

export interface ExtraBlob {
  /** Full vault path (e.g. "Attachments/img.png"). */
  vaultPath: string;
  /** Path relative to the mapping's remote folder (e.g. "attachments/img.png"). */
  remoteRelPath: string;
}

export interface RewriteContext {
  /** Vault path of the markdown file being pushed. */
  sourcePath: string;
  /** Mapping's vault folder (no leading/trailing slash). */
  mappingVaultFolder: string;
  /** Mapping's remote folder (no leading/trailing slash). May be "". */
  mappingRemoteFolder: string;
  /** Resolver wrapping Obsidian's metadata cache. */
  resolve: WikilinkResolver;
}

export interface RewriteResult {
  markdown: string;
  extraBlobs: ExtraBlob[];
  unresolvedCount: number;
  /** Count of wikilinks that were actually rewritten. */
  rewrittenCount: number;
  /** Count of Excalidraw embeds successfully resolved to a companion image. */
  excalidrawResolved: number;
  /** Count of Excalidraw embeds with no .svg/.png companion (still rewritten as a plain link). */
  excalidrawMissingCompanion: number;
}

export function rewriteWikilinks(
  markdown: string,
  ctx: RewriteContext,
): RewriteResult {
  const out: string[] = [];
  const extraBlobs: ExtraBlob[] = [];
  const seenRemotePaths = new Set<string>();
  let unresolvedCount = 0;
  let rewrittenCount = 0;
  let excalidrawResolved = 0;
  let excalidrawMissingCompanion = 0;

  const regions = splitByCodeRegions(markdown);
  for (const region of regions) {
    if (region.kind === "code") {
      out.push(region.text);
      continue;
    }
    out.push(
      rewriteInProse(region.text, ctx, {
        addBlob: (b) => {
          if (seenRemotePaths.has(b.remoteRelPath)) return;
          seenRemotePaths.add(b.remoteRelPath);
          extraBlobs.push(b);
        },
        onUnresolved: () => {
          unresolvedCount += 1;
        },
        onRewritten: () => {
          rewrittenCount += 1;
        },
        onExcalidrawResolved: () => {
          excalidrawResolved += 1;
        },
        onExcalidrawMissingCompanion: () => {
          excalidrawMissingCompanion += 1;
        },
      }),
    );
  }

  return {
    markdown: out.join(""),
    extraBlobs,
    unresolvedCount,
    rewrittenCount,
    excalidrawResolved,
    excalidrawMissingCompanion,
  };
}

interface RewriteCallbacks {
  addBlob: (b: ExtraBlob) => void;
  onUnresolved: () => void;
  onRewritten: () => void;
  onExcalidrawResolved: () => void;
  onExcalidrawMissingCompanion: () => void;
}

// Matches Obsidian embeds: ![[anything but ] or newline]]
const EMBED_RE = /!\[\[([^\]\n]+)\]\]/g;

function rewriteInProse(
  text: string,
  ctx: RewriteContext,
  cb: RewriteCallbacks,
): string {
  return text.replace(EMBED_RE, (match, inside: string, offset: number) => {
    // Honour escape: \![[...]]
    if (offset > 0 && text.charAt(offset - 1) === "\\") return match;

    // Split target | alias on the first unescaped pipe.
    const pipeIdx = inside.indexOf("|");
    const rawTarget = pipeIdx < 0 ? inside : inside.slice(0, pipeIdx);
    const rawAlias = pipeIdx < 0 ? "" : inside.slice(pipeIdx + 1);

    // Leave section/block embeds (![[note#header]] or ![[note^block]]) alone.
    if (/[#^]/.test(rawTarget)) return match;

    const targetTrim = rawTarget.trim();
    if (!targetTrim) return match;

    const resolved = ctx.resolve(targetTrim, ctx.sourcePath);
    if (!resolved) {
      cb.onUnresolved();
      return match;
    }

    // Excalidraw integration: if the resolved target is an Excalidraw source
    // file, look for a sibling .svg or .png companion (which the Excalidraw
    // plugin auto-exports when "Auto-export SVG/PNG" is enabled) and rewrite
    // to point at that. GitHub can't render the raw .excalidraw JSON.
    let effectiveTarget = resolved;
    if (isExcalidrawPath(resolved.path)) {
      let companion: ResolvedTarget | null = null;
      for (const candidate of excalidrawCompanionCandidates(resolved.path)) {
        companion = ctx.resolve(candidate, ctx.sourcePath);
        if (companion) break;
      }
      if (companion) {
        effectiveTarget = companion;
        cb.onExcalidrawResolved();
      } else {
        cb.onExcalidrawMissingCompanion();
        // fall through with the original .excalidraw target → emits a link
      }
    }

    const aliasTrim = rawAlias.trim();
    const isWidthHint = aliasTrim.length > 0 && /^\d+$/.test(aliasTrim);
    const altText = aliasTrim && !isWidthHint ? aliasTrim : "";

    const effectivePath = effectiveTarget.path;
    const ext = extensionOf(effectivePath).toLowerCase();
    const isImage = IMAGE_EXTS.has(ext);

    let urlPath: string;
    const insideMapping = isUnder(effectivePath, ctx.mappingVaultFolder);
    if (insideMapping) {
      urlPath = relativeFromTo(ctx.sourcePath, effectivePath);
    } else {
      // Co-locate the attachment under the mapping's remote folder.
      const basename = pathBasename(effectivePath);
      const remoteRelPath = `attachments/${basename}`;
      cb.addBlob({ vaultPath: effectivePath, remoteRelPath });
      urlPath = relativeFromMdToAttachment(
        ctx.sourcePath,
        ctx.mappingVaultFolder,
        basename,
      );
    }

    const encodedUrl = encodeMarkdownUrl(urlPath);

    cb.onRewritten();
    if (isImage && isWidthHint) {
      // Width hint + image: use HTML img to preserve the width (CommonMark
      // has no width syntax; GitHub renders inline HTML <img> reliably).
      return `<img src="${encodedUrl}" width="${aliasTrim}" alt="">`;
    }
    if (isImage) {
      return `![${altText}](${encodedUrl})`;
    }
    // Non-image embeds → plain link.
    const linkText = altText || pathBasename(effectivePath);
    return `[${linkText}](${encodedUrl})`;
  });
}

// ---------- Excalidraw helpers ----------

function isExcalidrawPath(p: string): boolean {
  const base = pathBasename(p).toLowerCase();
  return base.endsWith(".excalidraw") || base.endsWith(".excalidraw.md");
}

/**
 * Candidate companion paths for an Excalidraw source file. Returns the list in
 * priority order: SVG before PNG (vector scales better), short form before the
 * `.excalidraw.svg` form (matches the Excalidraw plugin's default output).
 */
function excalidrawCompanionCandidates(p: string): string[] {
  const dir = parentDir(p);
  const base = pathBasename(p);
  const stem = base.replace(/\.excalidraw(\.md)?$/i, "");
  const prefix = dir ? `${dir}/` : "";
  return [
    `${prefix}${stem}.svg`,
    `${prefix}${stem}.png`,
    `${prefix}${stem}.excalidraw.svg`,
    `${prefix}${stem}.excalidraw.png`,
  ];
}

// ---------- code-region tokenizer ----------

type Region = { kind: "code" | "prose"; text: string };

export function splitByCodeRegions(md: string): Region[] {
  const lines = splitLinesPreservingEndings(md);
  const out: Region[] = [];
  let buf: string[] = [];
  let mode: "prose" | "code" = "prose";
  let fence: string | null = null; // "```" or "~~~"

  const flush = () => {
    if (buf.length === 0) return;
    out.push({ kind: mode, text: buf.join("") });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.content.match(/^([ \t]*)(```+|~~~+)(.*)$/);
    if (mode === "prose" && fenceMatch) {
      flush();
      mode = "code";
      fence = fenceMatch[2][0] === "`" ? "```" : "~~~";
      buf.push(line.content + line.ending);
    } else if (
      mode === "code" &&
      fenceMatch &&
      line.content.trim().startsWith(fence!)
    ) {
      buf.push(line.content + line.ending);
      flush();
      mode = "prose";
      fence = null;
    } else {
      buf.push(line.content + line.ending);
    }
  }
  flush();
  return out;
}

// ---------- path helpers ----------

function pathBasename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function extensionOf(p: string): string {
  const base = pathBasename(p);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1);
}

function isUnder(filePath: string, folder: string): boolean {
  const f = folder.replace(/^\/+|\/+$/g, "");
  if (!f) return true;
  return filePath === f || filePath.startsWith(f + "/");
}

/**
 * Relative URL from `fromPath` (vault path of the markdown file) to `toPath`
 * (vault path of the target file). Both are slash-separated vault paths.
 */
export function relativeFromTo(fromPath: string, toPath: string): string {
  const fromDir = parentDir(fromPath);
  return relativeDirToPath(fromDir, toPath);
}

function relativeFromMdToAttachment(
  mdSourcePath: string,
  mappingVaultFolder: string,
  basename: string,
): string {
  const fromDir = parentDir(mdSourcePath);
  const mappingFolder = mappingVaultFolder.replace(/^\/+|\/+$/g, "");
  // The attachment on the remote sits at <mappingFolder>/attachments/<basename>
  // in terms of vault-relative paths (for the purpose of computing relative URLs).
  const attachmentVaultPath = mappingFolder
    ? `${mappingFolder}/attachments/${basename}`
    : `attachments/${basename}`;
  return relativeDirToPath(fromDir, attachmentVaultPath);
}

function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function relativeDirToPath(fromDir: string, toPath: string): string {
  const fromParts = fromDir ? fromDir.split("/") : [];
  const toParts = toPath.split("/");
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length - 1 &&
    fromParts[common] === toParts[common]
  ) {
    common += 1;
  }
  const ups = fromParts.length - common;
  const downs = toParts.slice(common).join("/");
  const rel = (ups > 0 ? "../".repeat(ups) : "") + downs;
  return rel || pathBasename(toPath);
}

/** URL-encode only the characters that break Markdown link parsing. */
export function encodeMarkdownUrl(url: string): string {
  return url
    .split("/")
    .map((seg) =>
      seg
        .replace(/%/g, "%25")
        .replace(/ /g, "%20")
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29")
        .replace(/</g, "%3C")
        .replace(/>/g, "%3E")
        .replace(/\?/g, "%3F")
        .replace(/#/g, "%23"),
    )
    .join("/");
}
