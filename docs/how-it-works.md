# How Easy Git works

This page goes one level deeper than the README. If you just want to install and use the plugin, the README is enough. Read on if you're curious how a sync run actually executes, what guarantees you can rely on, or why a particular behaviour exists.

## One run, one mapping

Easy Git's unit of work is a single mapping (one vault folder ↔ one repo folder). A sync run touches exactly one mapping; if you have three mappings and trigger "Sync all," that's three independent runs in sequence, each with its own commit on its own branch.

Per run, the engine does the following in order:

1. **Pin the remote head.** Fetch the branch's current commit SHA and root tree SHA. Everything that follows reads from this snapshot. If someone else pushes mid-run, the snapshot won't shift under us — we'll find out at step 8.
2. **Walk the remote folder.** Resolve the mapping's remote folder inside the pinned tree, then fetch its subtree recursively. The result is a flat `{path → blob SHA}` map for the remote side.
3. **Walk the local folder.** Read every file under the mapping's vault folder, filtered by the global exclude list and the mapping's `.easygitignore`. For each file, compute its git blob SHA (more on that below). If wikilink rewriting is on and the direction isn't pull-only, rewrite `.md` files in memory and track any out-of-folder attachments that need to ride along.
4. **Load last-known state.** Each mapping persists the `{path → SHA}` map from the last successful sync. This is the three-way merge base.
5. **Classify.** For every path that appears in local, remote, or the last-known map, decide what action it implies (push-add, pull-modify, push-delete, conflict, …). The mapping's direction (push, pull, both) gates which actions actually run; the others become informational notices.
6. **Resolve conflicts.** If there are any, show the conflict modal and wait. Cancelling aborts the run cleanly — nothing is touched on either side.
7. **Apply pull actions.** Fetch and write blobs for pull-add / pull-modify; delete files for pull-delete. This happens locally only; no network writes yet.
8. **Build and push the commit.** If any push actions exist, create blobs, build a new tree, build a commit on top of the pinned head, then atomically update the branch ref with non-fast-forward protection. If the ref update is rejected because someone else pushed in the meantime, the whole run retries from step 1 with exponential backoff (1s, 3s, 9s, up to 3 attempts).
9. **Persist the new last-known state.** The mapping's `lastSyncState` is replaced wholesale with the final `{path → SHA}` map, and `lastSyncAt` is updated.

Everything pushed lands as **one commit** with one parent. There is no merge commit, no rebasing, no force push (against the protection in step 8).

## File identity is the git blob SHA-1

The same hash `git hash-object` computes: SHA-1 of `"blob <size>\0" || bytes`. Same algorithm, same input, same output — Easy Git's local hashes match the hashes GitHub stores for the same files.

That's load-bearing for two reasons:

- **Comparison without download.** We compare local and remote by SHA without fetching remote file contents. A 200-MB repo with 500 files costs one tree listing, not 500 GETs.
- **Conflict detection without timestamps.** Nothing in the algorithm looks at modification time. If two SHAs match, the bytes match. If they differ, the bytes differ. mtime is unreliable across syncs, syncs across machines, and across the OAuth Device Flow round-trip; SHA-1 is not.

Text files (`.md`, code, configs, README/LICENSE/CHANGELOG) are read as UTF-8 and re-encoded with `TextEncoder` before hashing so line-ending normalization doesn't change the SHA. Binary files use raw bytes.

## Classification

The classifier walks the union of local paths, remote paths, and last-known paths. For each, it cross-references three states:

| Last-known | Local | Remote | Action |
| --- | --- | --- | --- |
| absent | present | absent | push-add |
| absent | absent | present | pull-add |
| absent | present | present, SHAs match | noop |
| absent | present | present, SHAs differ | **conflict** (both-added-different) |
| present | present, SHA matches last | present, SHA changed | pull-modify |
| present | present, SHA changed | present, SHA matches last | push-modify |
| present | present, both SHAs changed and differ | present | **conflict** (both-edited) |
| present | absent | present, SHA matches last | push-delete |
| present | absent | present, SHA changed | **conflict** (remote-edited-local-deleted) |
| present | present, SHA matches last | absent | pull-delete |
| present | present, SHA changed | absent | **conflict** (local-edited-remote-deleted) |

Direction gates the output: a push-only mapping never emits pull actions (instead, it shows a one-line notice — "5 files changed on remote since the last sync"). A pull-only mapping mirrors that for the other side. "Both" emits everything.

## Conflict resolution

The conflict modal offers three choices per file:

- **Keep local.** The push-modify (or push-delete) wins; remote gets overwritten.
- **Keep remote.** The pull-modify (or pull-delete) wins; local gets overwritten.
- **Keep both.** Only available when both sides still exist. The local file is renamed in your vault immediately, with a `-conflict-local-<YYYY-MM-DDTHH-MM-SS>` suffix inserted before the extension. The renamed file is pushed as a new addition; the remote version is pulled onto the original path. Neither side is lost.

Cancelling the modal aborts the run with no side effects: no commit is built, no local files are written, the last-known state is not updated. Re-running the sync will surface the same conflicts again.

## The atomic commit pipeline

Pushes use GitHub's Git Data API, not the contents endpoint:

1. **Create blobs.** `POST /repos/{owner}/{repo}/git/blobs` for each new or modified file (base64-encoded payload). Returns the blob SHA.
2. **Create a tree.** `POST /repos/{owner}/{repo}/git/trees` with `base_tree` set to the pinned root tree and `tree` listing the new/modified/deleted entries. The API reuses subtrees from `base_tree` that we didn't touch, so unrelated files in the repo are preserved without us having to enumerate them.
3. **Create a commit.** `POST /repos/{owner}/{repo}/git/commits` with the new tree SHA and the pinned commit as the single parent.
4. **Update the ref.** `PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}` with `force: false`. If the branch has moved since step 1 (someone else pushed), GitHub returns 422 and we don't clobber. The engine catches the rejection, waits, and retries from step 1 of the larger flow.

The "non-fast-forward" guarantee is at the ref update, not at the commit. A commit with the wrong parent is fine to build — it just won't be accepted.

## Wikilink rewriting (push-only)

Obsidian's embed syntax (`![[image.png]]`) isn't part of CommonMark and doesn't render on github.com. When a push is about to leave your vault, Easy Git rewrites embeds in-flight (your vault is never modified):

| In the vault | On GitHub |
| --- | --- |
| `![[image.png]]` | `![](image.png)` |
| `![[image.png\|Caption]]` | `![Caption](image.png)` |
| `![[image.png\|400]]` | `![](image.png)` (numeric alias = width hint, dropped) |
| `![[note]]` | `[note](note.md)` (non-image embed → link) |
| `![[note#header]]` | unchanged (GitHub can't transclude) |
| `\![[image.png]]` | unchanged (escaped) |
| `[[wikilink]]` | unchanged (not an embed) |

Rewriting is scoped to prose: text inside fenced code blocks (triple backtick or tilde) passes through untouched, so examples in your notes stay as you wrote them.

**Attachments outside the mapping.** If an embed targets a file outside the mapping's vault folder (a vault-wide `Attachments/` directory, say), the file is copied to `attachments/<basename>` inside the mapping's remote folder and the rewritten link points there. The remote folder stays self-contained — you can browse it on GitHub without broken images.

URL encoding only escapes the characters that would break Markdown parsing (space, parens, angle brackets, `?`, `#`, `%`). Everything else passes through, so the URLs stay readable.

Toggle off per mapping if you want raw `![[wikilinks]]` pushed verbatim.

## Excludes

Two sources, additively combined:

- **Global** — `settings.excludedPaths`. Defaults: `.obsidian/**`, `.trash/**`, `.git/**`, `node_modules/**`. Editable in plugin settings.
- **Per-mapping** — `.easygitignore` at the root of the mapping's vault folder, one glob per line; `#` starts a comment; blank lines ignored. The file itself is never pushed.

Glob syntax: `*` matches a single path segment, `**` matches any number, `?` matches one non-`/` char. A pattern with no `/` also matches against the basename (so `*.pdf` excludes PDFs anywhere). A trailing `/` is treated as `/**` (so `build/` excludes everything under `build/`).

## OAuth Device Flow

The "Sign in with GitHub" button uses GitHub's Device Authorization Grant:

1. `POST https://github.com/login/device/code` with the plugin's `client_id` and `scope=repo`. Returns a `device_code` (secret), a `user_code` (the human-readable one you paste), a `verification_uri` (github.com/login/device), an `expires_in`, and a recommended polling `interval`.
2. The plugin shows the user code, copies it to your clipboard, and opens the verification URL in your browser.
3. Meanwhile, the plugin polls `POST https://github.com/login/oauth/access_token` with the device code at the server-recommended interval until you finish the device flow on github.com (or it expires).
4. Once you authorize the app, the next poll returns an access token. The plugin stores it and immediately validates with `GET /user` to capture the login name and granted scopes.

`scope=repo` grants full read/write to your repos (public and private). If you want narrower access, use a fine-grained Personal Access Token instead and paste it directly — the README has the exact permission list.

## Status bar

A single status-bar item summarizes the aggregate state across all mappings. It refreshes whenever a sync starts or ends, and a 30-second ticker updates the relative time on the "Synced Nm ago" label.

| State | Shown when |
| --- | --- |
| (hidden) | No mappings configured |
| `↻ Syncing…` | Any mapping is currently syncing |
| `! Easy Git error` | Any mapping has an unresolved error from its last run |
| `↻ Synced 5m ago` | All mappings ok; relative time is the most recent successful sync across mappings |
| `↻ Ready` | All mappings ok but none has ever synced |

Clicking the item opens the plugin settings.

## What Easy Git does not do

- **No partial commits.** Every change in a single run lands in one commit. If the push fails halfway, nothing partial is left on the remote.
- **No history rewriting.** Pushes are fast-forward only. No force pushes, no rebases, no amends.
- **No background daemon.** Syncs happen on the schedule you configure (manual, interval, on-startup, on-save) and only while Obsidian is open.
- **No third-party servers.** All network calls go to `api.github.com` and `github.com/login/...`. No telemetry, no proxy, no analytics.
- **No vault writes outside mappings.** The only files Easy Git creates outside a mapping's vault folder are the attachments it copies into `attachments/` to keep the remote self-contained — and that's still a write into the *vault*, not anywhere on disk.
