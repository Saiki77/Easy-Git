<p align="center">
  <img src="docs/screenshots/hero.png" alt="Easy Git — sync Obsidian folders to GitHub" width="100%">
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

<p align="center">
  <img src="docs/screenshots/demo.gif" alt="End-to-end: open Settings, add a mapping, pick the repo, save, sync" width="960">
</p>
<p align="center"><sub>End-to-end: open Settings, add a mapping, pick the repo, save, sync. <a href="docs/screenshots/demo.mp4">(MP4)</a></sub></p>

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

## Wikilinks and attachments

Obsidian uses wikilink embeds like `![[Pasted image …png]]`. GitHub's Markdown renderer doesn't understand them, so they'd show as literal text. Easy Git rewrites them to standard CommonMark at push time:

| In your vault | What lands on GitHub |
| --- | --- |
| `![[image.png]]` | `![](image.png)` |
| `![[image.png\|Caption]]` | `![Caption](image.png)` |
| `![[image.png\|400]]` | `![](image.png)` (width hint dropped) |
| `![[note#header]]` | unchanged (GitHub can't transclude) |

If a wikilink points to an attachment outside the mapping's vault folder, the file is copied to `attachments/<basename>` inside the mapping's remote folder and the rewritten link points there. That keeps each remote folder self-contained, you can browse it on GitHub without broken references.

Your vault is never modified. The rewrite only affects the bytes pushed to GitHub. Pulling those notes back into Obsidian renders fine because both wikilink and standard-Markdown forms work in Obsidian.

Toggle off per mapping if you want the raw wikilinks pushed verbatim (the mapping summary will show `(raw wikilinks)`).

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

## Permissions

- **Clipboard**: written to only by the **Sign in with GitHub** button, which copies the one-time device code so you can paste it on github.com. No clipboard reads anywhere.
- **Network**: every HTTP call goes to `api.github.com` (and `github.com/login/...` for Device Flow). No third-party servers.
- **Vault**: reads and writes only inside the folders you configure as mappings, minus your exclusion globs.

## Build from source

```sh
npm install
npm run build
```

`main.js` is the bundled output. The release workflow at `.github/workflows/release.yml` builds and uploads `main.js` + `manifest.json` + `styles.css` on tag push.

## License

[MIT](./LICENSE)
