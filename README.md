<p align="center">
  <img src="docs/logo.png" alt="Easy Git logo" width="128" height="128">
</p>

<h1 align="center">Easy Git</h1>

<p align="center">
  A secure, plug-and-play way to sync individual Obsidian vault folders with GitHub.<br>
  Private repos, multiple folder mappings, push/pull/bidirectional, prompt-on-conflict.
</p>

<table>
  <tr>
    <td align="center" width="33%">
      <img src="docs/screenshots/settings.png" alt="Easy Git settings panel" width="100%"><br>
      <sub><b>Settings.</b> Sign in, list mappings, sync each one.</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/screenshots/repo-picker.png" alt="Repository picker" width="100%"><br>
      <sub><b>Pick a repo.</b> Any you have access to, public or private.</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/screenshots/mapping-modal.png" alt="Edit folder mapping" width="100%"><br>
      <sub><b>Configure.</b> Vault folder, branch, remote path, direction.</sub>
    </td>
  </tr>
</table>

## Why

Obsidian's built-in Sync covers your whole vault. Easy Git is for the case where you want to share only one or two folders with a repo: a notes folder you keep public, course material you collaborate on, a snippets section you want backed up under version control. You pick the folder, you pick the repo, you pick the direction. That's it.

## Install

**Via BRAT** (recommended while the community-plugin submission is in review)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. BRAT settings → **Add Beta Plugin** → paste `Saiki77/Easy-Git`.
3. Enable **Easy Git** under Settings → Community plugins.

**Manual:** download `main.js`, `manifest.json`, `styles.css` from the [latest release](../../releases) into `<your vault>/.obsidian/plugins/easy-git/`.

## Sign in

Either works for private repos.

- **Personal Access Token.** Create one at [github.com/settings/tokens](https://github.com/settings/tokens) with the `repo` scope (or a fine-grained token with `Contents: Read and write` + `Metadata: Read`), paste it in settings, hit **Test connection**.
- **Sign in with GitHub.** Click the button, enter the one-time code on github.com, the plugin picks up the token automatically.

## Add a folder mapping

Settings → Easy Git → **+ Add mapping**. Pick the vault folder, the repo, the branch, the path inside the repo, the direction (push only, pull only, or both), and how often to sync (manual, on interval, on startup, or on save). Save.

After that, sync from the ribbon menu, the command palette (`Easy Git: Sync mapping…`), or the **Sync** button next to each mapping.

## Conflicts

If the same file changed on both sides since the last sync, Easy Git pauses and lets you pick **keep local**, **keep remote**, or **keep both** (renames your local copy with a `-conflict-local-<timestamp>` suffix so neither side is lost). Cancelling the conflict modal aborts the entire run without touching anything.

## How sync works under the hood

Each run produces one atomic commit via GitHub's Git Data API: blob → tree (with `base_tree` so unrelated files in the repo are preserved) → commit → ref update. The branch's current HEAD is fetched right before the commit is built, and the ref update is non-fast-forward-protected, so if someone else pushes mid-run the sync retries from scratch (up to 3×, 1s/3s/9s backoff) instead of clobbering.

File identity is the git blob SHA-1 (matches `git hash-object`), so we compare local and remote without round-tripping content.

## Defaults

- Excluded: `.obsidian/**`, `.trash/**`, `.git/**`, `node_modules/**` (editable in settings).
- Files over 95 MB are skipped (GitHub's blob limit is 100 MB).
- Authenticated rate limit headroom is checked before each run.
- Mobile compatible: no shell access, no node-only modules.

## Build from source

```sh
npm install
npm run build
```

`main.js` is the bundled output. The release workflow at `.github/workflows/release.yml` builds and uploads `main.js` + `manifest.json` + `styles.css` on tag push.

## License

[MIT](./LICENSE)
