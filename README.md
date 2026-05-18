<p align="center">
  <img src="docs/logo.png" alt="Easy Git logo" width="128" height="128">
</p>

# Easy Git

Sync vault folders with GitHub repositories — works with private repos, supports multiple folder mappings, bidirectional sync, and prompts you on conflicts.

## Features

- **Multiple folder mappings**. Pair any vault folder with any folder in any repo. Different local and remote names are fine.
- **Private repos**. Authenticate with a Personal Access Token or GitHub Device Flow OAuth.
- **Per-mapping direction**. Push only, pull only, or bidirectional.
- **Clean commits**. Each sync is one atomic commit via GitHub's Git Data API. The latest remote ref is always fetched before the commit is built, so non-fast-forward pushes are retried instead of clobbered.
- **Prompt on conflicts**. When the same file changed on both sides, you choose: keep local, keep remote, or keep both.
- **Auto modes**: off / on interval / on Obsidian startup / on file save (debounced).
- **Mobile compatible**. Uses only Obsidian's Vault API and `requestUrl` — no shell access needed.

## Install via BRAT

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. In BRAT settings, click **Add Beta Plugin**.
3. Paste this repository URL: `https://github.com/Saiki77/Easy-Git`
4. Enable **Easy Git** under Settings → Community plugins.

## Manual install

Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](../../releases) and drop them into `<your vault>/.obsidian/plugins/easy-git/`.

## Authentication

Two options. Both work for private repos.

### Personal Access Token (simplest)

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens) and create a token.
   - Classic: enable the `repo` scope.
   - Fine-grained: select your target repos, grant `Contents: Read and write` and `Metadata: Read`.
2. Paste it into **Easy Git → GitHub Authentication → Personal access token**.
3. Click **Test connection** to verify.

### GitHub Device Flow (no copy-paste)

Click **Sign in** under **Sign in with GitHub (Device Flow)**, then enter the code on the GitHub page that opens. The plugin polls until the token is issued.

## Adding a mapping

1. Open **Settings → Easy Git**.
2. Under **Folder mappings**, click **+ Add mapping**.
3. Fill in:
   - **Name** — display label.
   - **Vault folder** — folder in your vault.
   - **Repository** — your GitHub repo (loaded from your account).
   - **Branch** — the branch to commit to.
   - **Remote folder path** — folder inside the repo (empty = repo root).
   - **Direction** — push only, pull only, or bidirectional.
   - **Auto mode** — off (manual), interval, startup, or on-save.
   - **Commit message template** — optional override of the global default.
4. Click **Save**.

Trigger a sync via the ribbon icon (Git branch icon, opens a quick menu), the command palette (`Easy Git: Sync all mappings`, `Sync mapping…`, `Push mapping…`, `Pull mapping…`), or the **Sync** button next to each mapping in settings.

## Conflict resolution

When the same file changed on both sides since the last sync, Easy Git pauses and shows a modal listing each conflict. For each one you choose:

- **Keep local** — your version wins; the remote version is overwritten.
- **Keep remote** — the remote version wins; your local file is overwritten.
- **Keep both** — your local file is renamed (suffix `-conflict-local-<timestamp>`), and both versions end up on both sides.

If you cancel the modal, the entire sync run is aborted — nothing is committed and nothing is pulled. Your files stay where they are.

## Excluded paths

`.obsidian/**`, `.trash/**`, `.git/**`, and `node_modules/**` are excluded by default. You can edit the exclusion list in settings — one glob per line. Patterns are matched against the vault-relative path.

## Limits and edge cases

- **File size**. Files over 95 MB are skipped by default (GitHub's blob API caps at 100 MB). Adjustable in settings.
- **Folder size**. Up to ~10,000 files per mapping is comfortable. The GitHub tree API truncates beyond ~100k entries.
- **Renames**. Treated as delete-plus-add at the GitHub layer (the file's history won't follow). Git's own rename detection is a UI-layer thing; the underlying objects don't move.
- **Binary files**. Detected by extension; PNGs, PDFs, etc. round-trip cleanly via base64.
- **Rate limits**. 5,000 req/hour authenticated. A 50-file sync uses ~55 requests. The plugin reads `x-ratelimit-remaining` and surfaces a Notice when running low.
- **Race conditions**. If someone pushes to the same branch during your sync, the ref update is rejected as non-fast-forward and the sync retries from scratch up to 3 times.

## Build and release

```sh
npm install
npm run dev      # watch mode
npm run build    # production build, type-check + minify
```

Cutting a release:

```sh
npm version patch    # bumps manifest.json + versions.json + package.json
git push --follow-tags
```

The GitHub Actions workflow at `.github/workflows/release.yml` builds and uploads `main.js`, `manifest.json`, `styles.css` to the new release.

## License

[MIT](./LICENSE)
