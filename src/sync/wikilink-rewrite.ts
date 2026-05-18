/**
 * Pure transform: Obsidian wikilink embeds → CommonMark image/link references.
 *
 * Runs at push time only. Does not touch the vault file. The vault keeps its
 * wikilink form (Obsidian renders it natively); GitHub gets the rewritten form.
 *
 * Scope: image-and-image-like embeds. Internal [[note]] links are left alone.
 * Inputs inside fenced code blocks or inline code are left alone.
 */

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
      }),
    );
  }

  return {
    markdown: out.join(""),
    extraBlobs,
    unresolvedCount,
    rewrittenCount,
  };
}

interface RewriteCallbacks {
  addBlob: (b: ExtraBlob) => void;
  onUnresolved: () => void;
  onRewritten: () => void;
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

    const aliasTrim = rawAlias.trim();
    const isWidthHint = aliasTrim.length > 0 && /^\d+$/.test(aliasTrim);
    const altText = aliasTrim && !isWidthHint ? aliasTrim : "";

    const resolvedPath = resolved.path;
    const ext = extensionOf(resolvedPath).toLowerCase();
    const isImage = IMAGE_EXTS.has(ext);

    let urlPath: string;
    const insideMapping = isUnder(resolvedPath, ctx.mappingVaultFolder);
    if (insideMapping) {
      urlPath = relativeFromTo(ctx.sourcePath, resolvedPath);
    } else {
      // Co-locate the attachment under the mapping's remote folder.
      const basename = pathBasename(resolvedPath);
      const remoteRelPath = `attachments/${basename}`;
      cb.addBlob({ vaultPath: resolvedPath, remoteRelPath });
      // URL is relative from the markdown file to attachments/<basename>.
      // Markdown file lives inside the mapping vault folder; on the remote it
      // sits at <remoteFolder>/<relativeToMapping>. The attachment lives at
      // <remoteFolder>/attachments/<basename>. So the relative URL is the
      // relative path from the md's relative dir to "attachments/<basename>".
      urlPath = relativeFromMdToAttachment(
        ctx.sourcePath,
        ctx.mappingVaultFolder,
        basename,
      );
    }

    const encodedUrl = encodeMarkdownUrl(urlPath);

    cb.onRewritten();
    if (isImage) {
      return `![${altText}](${encodedUrl})`;
    }
    // Non-image embeds → plain link.
    const linkText = altText || pathBasename(resolvedPath);
    return `[${linkText}](${encodedUrl})`;
  });
}

// ---------- code-region tokenizer ----------

type Region = { kind: "code" | "prose"; text: string };

export function splitByCodeRegions(md: string): Region[] {
  const lines = md.split(/\r?\n/);
  const out: Region[] = [];
  let buf: string[] = [];
  let mode: "prose" | "code" = "prose";
  let fence: string | null = null; // "```" or "~~~"

  const flush = () => {
    if (buf.length === 0) return;
    // Preserve line breaks faithfully — join with \n and the very last region
    // gets no trailing newline appended (the join already omits it).
    out.push({ kind: mode, text: buf.join("\n") });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^([ \t]*)(```+|~~~+)(.*)$/);
    if (mode === "prose" && fenceMatch) {
      flush();
      mode = "code";
      fence = fenceMatch[2][0] === "`" ? "```" : "~~~";
      buf.push(line);
    } else if (mode === "code" && fenceMatch && line.trim().startsWith(fence!)) {
      buf.push(line);
      flush();
      mode = "prose";
      fence = null;
    } else {
      buf.push(line);
    }
  }
  flush();

  // Re-join the regions losslessly: insert \n between regions so the round
  // trip via regions.map(r => r.text).join("\n") reconstructs the original.
  // But because we want each region to be substituted independently and
  // re-joined without an extra newline at the end, we'll splice them with
  // their original separators in the rewriter instead. Simpler: append "\n"
  // between regions so concatenation yields the original document.
  for (let i = 0; i < out.length - 1; i++) {
    out[i].text += "\n";
  }
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
