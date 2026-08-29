export interface CommitContext {
  mappingName: string;
  vaultName: string;
  added: number;
  modified: number;
  deleted: number;
  files: string[];
  /** Add+delete pairs with identical content (a move or rename). Only
   * changes the output when the template contains {moved}: moves are then
   * counted once instead of as one add plus one delete, and {files} lists
   * them as "from → to". Templates without {moved} render byte-identically
   * to earlier releases. */
  moved?: Array<{ from: string; to: string }>;
}

export function formatCommitMessage(
  template: string,
  ctx: CommitContext,
): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const datetime = now.toISOString().slice(0, 16).replace("T", " ") + " UTC";

  const moves = ctx.moved ?? [];
  const moveAware = moves.length > 0 && template.includes("{moved}");
  const added = moveAware ? Math.max(0, ctx.added - moves.length) : ctx.added;
  const deleted = moveAware
    ? Math.max(0, ctx.deleted - moves.length)
    : ctx.deleted;
  let files = ctx.files;
  if (moveAware) {
    const movedPaths = new Set<string>();
    for (const m of moves) {
      movedPaths.add(m.from);
      movedPaths.add(m.to);
    }
    files = [
      ...ctx.files.filter((f) => !movedPaths.has(f)),
      ...moves.map((m) => `${m.from} → ${m.to}`),
    ];
  }
  const n = added + ctx.modified + deleted + (moveAware ? moves.length : 0);

  const shownFiles = files.slice(0, 5).join(", ");
  const filesStr =
    files.length > 5 ? `${shownFiles}, …+${files.length - 5} more` : shownFiles;

  const tokens: Record<string, string> = {
    "{date}": date,
    "{datetime}": datetime,
    "{n}": String(n),
    "{added}": String(added),
    "{modified}": String(ctx.modified),
    "{deleted}": String(deleted),
    "{moved}": String(moves.length),
    "{files}": filesStr,
    "{vault}": ctx.vaultName,
    "{mapping}": ctx.mappingName,
  };

  let out = template;
  for (const [k, v] of Object.entries(tokens)) {
    out = out.split(k).join(v);
  }
  return out;
}
