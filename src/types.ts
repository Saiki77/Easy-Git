export type SyncDirection = "push" | "pull" | "both";

export type AutoMode =
  | { kind: "off" }
  | { kind: "interval"; minutes: number }
  | { kind: "startup" }
  | { kind: "onSave"; debounceMs: number };

export interface FileSyncRecord {
  sha: string;
  size: number;
  mtime?: number;
}

export interface LastSyncState {
  baseCommitSha: string;
  baseTreeSha: string;
  files: Record<string, FileSyncRecord>;
}

/**
 * One sync target inside a mapping. A mapping can have several of these to
 * push the same vault folder to multiple repos / branches / remote paths.
 * Each destination tracks its own last-sync state.
 */
export interface MappingDestination {
  id: string;
  repoOwner: string;
  repoName: string;
  branch: string;
  remoteFolder: string;
  lastSyncState?: LastSyncState;
  lastSyncAt?: number;
  lastSyncError?: string;
}

export interface FolderMapping {
  id: string;
  name: string;
  vaultFolder: string;
  direction: SyncDirection;
  autoMode: AutoMode;
  commitTemplate?: string;
  /**
   * If true, .md files are pushed with Obsidian wikilink embeds rewritten to
   * standard CommonMark image/link syntax so GitHub renders them. If
   * undefined on an existing mapping, the engine auto-enables on first
   * sync after the v0.2 upgrade.
   */
  rewriteWikilinks?: boolean;
  /** Set to true the first time the engine has auto-enabled rewriteWikilinks
   * (so the migration Notice fires once, not on every sync). */
  rewriteWikilinksMigrated?: boolean;
  /** One or more remote targets. v0.5+ schema. */
  destinations: MappingDestination[];
}

export interface GitHubAuth {
  method: "pat" | "oauth" | "none";
  token: string;
  username?: string;
  scopes?: string[];
}

export interface PluginSettings {
  auth: GitHubAuth;
  mappings: FolderMapping[];
  defaultCommitTemplate: string;
  excludedPaths: string[];
  maxFileSizeBytes: number;
  showNotifications: boolean;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  auth: { method: "none", token: "" },
  mappings: [],
  defaultCommitTemplate:
    "Sync from Obsidian ({mapping}): {datetime} — {added}+ {modified}~ {deleted}-",
  excludedPaths: [".obsidian/**", ".trash/**", ".git/**", "node_modules/**"],
  maxFileSizeBytes: 95 * 1024 * 1024,
  showNotifications: true,
  debugLogging: false,
};

export type ConflictKind =
  | "both-edited"
  | "both-added-different"
  | "local-edited-remote-deleted"
  | "remote-edited-local-deleted";

export type ConflictResolution = "keep-local" | "keep-remote" | "keep-both";

export interface ConflictEntry {
  path: string;
  kind: ConflictKind;
  localSha?: string;
  remoteSha?: string;
  resolution?: ConflictResolution;
}

export type FileOp =
  | "push-add"
  | "push-modify"
  | "push-delete"
  | "pull-add"
  | "pull-modify"
  | "pull-delete"
  | "noop";

export interface FileAction {
  path: string;
  op: FileOp;
  localSha?: string;
  remoteSha?: string;
}

export interface SyncResult {
  mappingId: string;
  destinationId: string;
  ok: boolean;
  added: number;
  modified: number;
  deleted: number;
  conflicts: ConflictEntry[];
  commitSha?: string;
  error?: string;
  durationMs: number;
  skippedLarge?: string[];
  noopReason?: string;
  /** Number of wikilinks that could not be resolved at push time. */
  unresolvedWikilinks?: number;
  /** Number of wikilinks actually rewritten across this run. */
  rewrittenWikilinks?: number;
}

export interface LocalFileEntry {
  path: string;
  sha: string;
  size: number;
  mtime: number;
}

export interface RemoteFileEntry {
  path: string;
  sha: string;
  size: number;
}

export interface RepoSummary {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
}

export interface BranchSummary {
  name: string;
  commitSha: string;
}

export const EASY_GIT_OAUTH_CLIENT_ID = "Ov23lihov6s6zVguusXe";

export const GITHUB_API_BASE = "https://api.github.com";

export function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
