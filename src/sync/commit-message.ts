export interface CommitContext {
  mappingName: string;
  vaultName: string;
  added: number;
  modified: number;
  deleted: number;
  files: string[];
}

export function formatCommitMessage(
  template: string,
  ctx: CommitContext,
): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const datetime = now.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const n = ctx.added + ctx.modified + ctx.deleted;
  const shownFiles = ctx.files.slice(0, 5).join(", ");
  const filesStr =
    ctx.files.length > 5
      ? `${shownFiles}, …+${ctx.files.length - 5} more`
      : shownFiles;

  const tokens: Record<string, string> = {
    "{date}": date,
    "{datetime}": datetime,
    "{n}": String(n),
    "{added}": String(ctx.added),
    "{modified}": String(ctx.modified),
    "{deleted}": String(ctx.deleted),
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
