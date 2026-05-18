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
  encoding: "base64" | "utf-8" | string;
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
    commit: { sha: string; commit: { tree: { sha: string } } };
  }>("GET", `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
  return {
    commitSha: data.commit.sha,
    treeSha: data.commit.commit.tree.sha,
  };
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
 * Walks the remote folder under {owner}/{repo}@{treeSha}/{remoteFolder}.
 * Returns entries keyed by path RELATIVE to remoteFolder (so a file at
 * "notes/work/foo.md" with remoteFolder="notes" becomes "work/foo.md").
 *
 * Returns empty object if the folder doesn't exist yet on the remote
 * (treated as a fresh first push).
 */
export async function listRemoteFolderFiles(
  client: GitHubClient,
  owner: string,
  repo: string,
  rootTreeSha: string,
  remoteFolder: string,
): Promise<Record<string, RemoteFileEntry>> {
  const subtreeSha = remoteFolder
    ? await resolveSubtreeSha(client, owner, repo, rootTreeSha, remoteFolder)
    : rootTreeSha;
  if (!subtreeSha) return {};

  const { entries } = await getTreeRecursive(client, owner, repo, subtreeSha);
  const out: Record<string, RemoteFileEntry> = {};
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    out[entry.path] = {
      path: entry.path,
      sha: entry.sha,
      size: entry.size ?? 0,
    };
  }
  return out;
}

async function resolveSubtreeSha(
  client: GitHubClient,
  owner: string,
  repo: string,
  rootTreeSha: string,
  folderPath: string,
): Promise<string | null> {
  const parts = folderPath.split("/").filter((p) => p.length > 0);
  let currentTreeSha = rootTreeSha;
  for (const part of parts) {
    let entries: TreeEntry[];
    try {
      entries = await getTreeShallow(client, owner, repo, currentTreeSha);
    } catch (e) {
      if (e instanceof GitHubApiError && e.status === 404) return null;
      throw e;
    }
    const match = entries.find((entry) => entry.path === part && entry.type === "tree");
    if (!match) return null;
    currentTreeSha = match.sha;
  }
  return currentTreeSha;
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
