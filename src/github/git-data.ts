import { BranchSummary, RemoteFileEntry, RepoSummary } from "../types";
import { GitHubApiError, GitHubClient } from "./client";

export interface BranchHead {
  commitSha: string;
  treeSha: string;
}

export interface RepoInfo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface BlobContent {
  sha: string;
  size: number;
  /** GitHub returns "base64" or "utf-8"; typed as string to stay forward-compatible. */
  encoding: string;
  content: string;
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface NewTreeEntry {
  path: string;
  mode: "100644" | "100755" | "040000" | "160000" | "120000";
  type: "blob" | "tree" | "commit";
  sha?: string | null;
  content?: string;
}

export async function listUserRepos(client: GitHubClient): Promise<RepoSummary[]> {
  type Item = {
    name: string;
    full_name: string;
    private: boolean;
    default_branch: string;
    updated_at: string;
    owner: { login: string };
  };
  const items = await client.paginate<Item>(
    "/user/repos?sort=updated&affiliation=owner,collaborator,organization_member",
    { perPage: 100, maxPages: 5 },
  );
  return items.map((r) => ({
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at,
  }));
}

/** List repos via Forgejo/Gitea's /repos/search endpoint, which only
 * requires read:repository scope (unlike /user/repos which needs read:user). */
export async function listForgejoRepos(client: GitHubClient): Promise<RepoSummary[]> {
  type Item = {
    name: string;
    full_name: string;
    private: boolean;
    default_branch: string;
    updated_at: string;
    owner: { login: string };
  };
  const out: RepoSummary[] = [];
  const perPage = 50;
  for (let page = 1; page <= 5; page++) {
    const res = await client.request<{ ok: boolean; data: Item[] }>(
      "GET",
      `/repos/search?sort=updated&limit=${perPage}&page=${page}`,
    );
    if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) break;
    for (const r of res.data) {
      out.push({
        owner: r.owner.login,
        name: r.name,
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
        updatedAt: r.updated_at,
      });
    }
    if (res.data.length < perPage) break;
  }
  return out;
}

export async function getRepo(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<RepoInfo> {
  const data = await client.request<{
    name: string;
    full_name: string;
    default_branch: string;
    private: boolean;
    owner: { login: string };
  }>("GET", `/repos/${owner}/${repo}`);
  return {
    owner: data.owner.login,
    name: data.name,
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    private: data.private,
  };
}

export async function listBranches(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<BranchSummary[]> {
  type Item = { name: string; commit: { sha: string } };
  const items = await client.paginate<Item>(
    `/repos/${owner}/${repo}/branches`,
    { perPage: 100, maxPages: 3 },
  );
  return items.map((b) => ({ name: b.name, commitSha: b.commit.sha }));
}

export async function getBranchHead(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<BranchHead> {
  const data = await client.request<{
    // GitHub: commit.sha + nested commit.commit.tree.sha
    // Forgejo: commit.id (flat, no nested commit object)
    commit: { sha?: string; id?: string; commit?: { tree: { sha: string } } };
  }>("GET", `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);

  const commitSha = data.commit.sha ?? data.commit.id ?? "";

  // GitHub includes the tree SHA in the branch response; use it directly.
  if (data.commit.commit?.tree?.sha) {
    return { commitSha, treeSha: data.commit.commit.tree.sha };
  }

  // Forgejo omits the tree SHA from the branch response — fetch the git
  // commit object to get it.
  // GitHub: { tree: { sha } } at top level
  // Forgejo: { commit: { tree: { sha } } } nested under commit
  const gitCommit = await client.request<{
    tree?: { sha: string };
    commit?: { tree: { sha: string } };
  }>(
    "GET",
    `/repos/${owner}/${repo}/git/commits/${commitSha}`,
  );
  const treeSha = gitCommit.tree?.sha ?? gitCommit.commit?.tree?.sha ?? "";
  return { commitSha, treeSha };
}

export async function getTreeRecursive(
  client: GitHubClient,
  owner: string,
  repo: string,
  treeSha: string,
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const data = await client.request<{
    tree: TreeEntry[];
    truncated: boolean;
  }>("GET", `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
  return { entries: data.tree ?? [], truncated: !!data.truncated };
}

export async function getTreeShallow(
  client: GitHubClient,
  owner: string,
  repo: string,
  treeSha: string,
): Promise<TreeEntry[]> {
  const data = await client.request<{ tree: TreeEntry[] }>(
    "GET",
    `/repos/${owner}/${repo}/git/trees/${treeSha}`,
  );
  return data.tree ?? [];
}

/**
 * Result of resolving a remote folder path under a tree.
 *
 * - `subtreeSha`: the resolved subtree SHA (or null if folder doesn't exist).
 * - `correctedPath`: when the on-disk path differs in case from the requested
 *   path (case-insensitive match), this is the actual GitHub-side casing so
 *   the caller can persist a one-time fix. Undefined when the case matched.
 */
export interface SubtreeResolution {
  subtreeSha: string | null;
  correctedPath?: string;
}

/**
 * Walks the remote folder under {owner}/{repo}@{treeSha}/{remoteFolder}.
 * Returns entries keyed by path RELATIVE to remoteFolder (so a file at
 * "notes/work/foo.md" with remoteFolder="notes" becomes "work/foo.md").
 *
 * Returns empty object if the folder doesn't exist yet on the remote
 * (treated as a fresh first push).
 *
 * Falls back to a shallow-recursive walk when GitHub truncates the
 * recursive tree response (~7MB / 100k entries) so we never silently
 * miss new files in the truncated portion.
 *
 * Also returns a `correctedPath` when the remote folder is found via
 * case-insensitive match so the engine can persist the fix.
 */
export async function listRemoteFolderFiles(
  client: GitHubClient,
  owner: string,
  repo: string,
  rootTreeSha: string,
  remoteFolder: string,
): Promise<{
  files: Record<string, RemoteFileEntry>;
  correctedPath?: string;
  truncatedFallback: boolean;
}> {
  let subtreeSha: string;
  let correctedPath: string | undefined;
  if (remoteFolder) {
    const res = await resolveSubtreeSha(client, owner, repo, rootTreeSha, remoteFolder);
    if (!res.subtreeSha) {
      return { files: {}, truncatedFallback: false };
    }
    subtreeSha = res.subtreeSha;
    correctedPath = res.correctedPath;
  } else {
    subtreeSha = rootTreeSha;
  }

  // Try the fast path: one recursive tree call.
  const { entries, truncated } = await getTreeRecursive(client, owner, repo, subtreeSha);

  if (!truncated) {
    const files: Record<string, RemoteFileEntry> = {};
    for (const entry of entries) {
      if (entry.type !== "blob") continue;
      files[entry.path] = {
        path: entry.path,
        sha: entry.sha,
        size: entry.size ?? 0,
      };
    }
    return { files, correctedPath, truncatedFallback: false };
  }

  // Recursive call truncated. Fall back to walking shallow trees so we
  // see every blob. Each shallow call is much smaller than the recursive
  // one, so cumulative truncation is effectively impossible for any vault
  // a human would assemble.
  const files = await walkShallowRecursive(client, owner, repo, subtreeSha);
  return { files, correctedPath, truncatedFallback: true };
}

/**
 * Walk a tree by issuing one shallow `git/trees/{sha}` call per subtree
 * and recursing into children. Same final result as `?recursive=1` but
 * not subject to truncation. Used as a fallback when the recursive call
 * returns `truncated: true`.
 */
async function walkShallowRecursive(
  client: GitHubClient,
  owner: string,
  repo: string,
  rootTreeSha: string,
): Promise<Record<string, RemoteFileEntry>> {
  const files: Record<string, RemoteFileEntry> = {};
  // BFS — stack of (sha, prefix) pairs. Prefix is the path relative to
  // the root we started from.
  const stack: Array<{ sha: string; prefix: string }> = [
    { sha: rootTreeSha, prefix: "" },
  ];
  while (stack.length > 0) {
    const { sha, prefix } = stack.pop() as { sha: string; prefix: string };
    const entries = await getTreeShallow(client, owner, repo, sha);
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.path}` : entry.path;
      if (entry.type === "blob") {
        files[path] = { path, sha: entry.sha, size: entry.size ?? 0 };
      } else if (entry.type === "tree") {
        stack.push({ sha: entry.sha, prefix: path });
      }
    }
  }
  return files;
}

async function resolveSubtreeSha(
  client: GitHubClient,
  owner: string,
  repo: string,
  rootTreeSha: string,
  folderPath: string,
): Promise<SubtreeResolution> {
  const parts = folderPath.split("/").filter((p) => p.length > 0);
  let currentTreeSha = rootTreeSha;
  const corrected: string[] = [];
  let didCorrect = false;

  for (const part of parts) {
    let entries: TreeEntry[];
    try {
      entries = await getTreeShallow(client, owner, repo, currentTreeSha);
    } catch (e) {
      if (e instanceof GitHubApiError && e.status === 404) {
        return { subtreeSha: null };
      }
      throw e;
    }

    // Exact-case match first (the common path).
    let match = entries.find((e) => e.path === part && e.type === "tree");
    if (!match) {
      // Case-insensitive fallback. Common when a user renamed the folder
      // on GitHub (e.g. notes → Notes) but the mapping still stores the
      // old casing. Caller persists the correction.
      const lower = part.toLowerCase();
      match = entries.find(
        (e) => e.path.toLowerCase() === lower && e.type === "tree",
      );
      if (match) didCorrect = true;
    }

    if (!match) return { subtreeSha: null };
    corrected.push(match.path);
    currentTreeSha = match.sha;
  }
  return {
    subtreeSha: currentTreeSha,
    correctedPath: didCorrect ? corrected.join("/") : undefined,
  };
}

export async function getBlobContent(
  client: GitHubClient,
  owner: string,
  repo: string,
  sha: string,
): Promise<BlobContent> {
  return client.request<BlobContent>(
    "GET",
    `/repos/${owner}/${repo}/git/blobs/${sha}`,
  );
}

export async function createBlob(
  client: GitHubClient,
  owner: string,
  repo: string,
  base64Content: string,
): Promise<string> {
  const data = await client.request<{ sha: string }>(
    "POST",
    `/repos/${owner}/${repo}/git/blobs`,
    { content: base64Content, encoding: "base64" },
  );
  return data.sha;
}

export async function createTree(
  client: GitHubClient,
  owner: string,
  repo: string,
  baseTreeSha: string,
  entries: NewTreeEntry[],
): Promise<string> {
  const data = await client.request<{ sha: string }>(
    "POST",
    `/repos/${owner}/${repo}/git/trees`,
    { base_tree: baseTreeSha, tree: entries },
  );
  return data.sha;
}

export async function createCommit(
  client: GitHubClient,
  owner: string,
  repo: string,
  message: string,
  treeSha: string,
  parentShas: string[],
): Promise<string> {
  const data = await client.request<{ sha: string }>(
    "POST",
    `/repos/${owner}/${repo}/git/commits`,
    { message, tree: treeSha, parents: parentShas },
  );
  return data.sha;
}

/**
 * Updates the branch ref. Returns true on success, false if the update was
 * rejected as a non-fast-forward (HTTP 422). Re-throws other errors.
 */
/**
 * Create or update a single file via the contents API.
 * Used for Forgejo, which does not implement POST /git/blobs.
 * Each call produces one commit. Pass existingSha for updates; omit for creates.
 */
export async function putFileContents(
  client: GitHubClient,
  owner: string,
  repo: string,
  filePath: string,
  base64Content: string,
  commitMessage: string,
  branch: string,
  existingSha?: string,
): Promise<{ commitSha: string; fileSha: string }> {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const body: Record<string, string> = { message: commitMessage, content: base64Content, branch };
  if (existingSha) body.sha = existingSha;
  // Forgejo: POST = create (no SHA), PUT = update (SHA required).
  // GitHub uses PUT for both, but putFileContents is only called for Forgejo.
  const method = existingSha ? "PUT" : "POST";
  const data = await client.request<{
    commit: { sha: string };
    content: { sha: string };
  }>(method, `/repos/${owner}/${repo}/contents/${encodedPath}`, body);
  return { commitSha: data.commit.sha, fileSha: data.content.sha };
}

/** Delete a single file via the contents API. Returns the new commit SHA. */
export async function deleteFileContents(
  client: GitHubClient,
  owner: string,
  repo: string,
  filePath: string,
  commitMessage: string,
  branch: string,
  existingSha: string,
): Promise<string> {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const data = await client.request<{ commit: { sha: string } }>(
    "DELETE",
    `/repos/${owner}/${repo}/contents/${encodedPath}`,
    { message: commitMessage, sha: existingSha, branch },
  );
  return data.commit.sha;
}

export async function updateRef(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
  commitSha: string,
): Promise<boolean> {
  try {
    await client.request(
      "PATCH",
      `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
      { sha: commitSha, force: false },
    );
    return true;
  } catch (e) {
    if (e instanceof GitHubApiError && e.status === 422) return false;
    throw e;
  }
}
