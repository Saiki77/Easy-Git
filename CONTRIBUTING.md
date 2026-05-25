# Contributing to Easy Git

Thanks for taking the time to look. Issues, suggestions, and PRs are all welcome.

## Filing an issue

Use the templates: **Bug report** for things that aren't working, **Feature request** for new ideas. Most useful field on a bug report is the **Sync log entry** — open it in Obsidian via `Easy Git: Show sync log` and paste the failed run's error text plus the file list. That's usually enough to diagnose.

For general "is this how it's supposed to work?" questions, the Obsidian forum or Discord is a better fit than an issue — see the links surfaced in the new-issue picker.

## Setting up the dev environment

You need Node 20+ and npm. Clone the repo, install, and build:

```sh
git clone https://github.com/Saiki77/Easy-Git.git
cd Easy-Git
npm install
npm run dev
```

`npm run dev` runs esbuild in watch mode, producing `main.js` at the repo root. `npm run build` does a one-shot type-check + production bundle.

## Testing in a real vault

Symlink the repo into a test vault's `.obsidian/plugins/` folder so each rebuild is picked up:

```sh
ln -s /absolute/path/to/Easy-Git /absolute/path/to/TestVault/.obsidian/plugins/easy-git
```

Toggle the plugin off and on in Obsidian's Community plugins settings to load a new build. The hot-reload plugin (search "hot reload" in BRAT or community plugins) makes this faster.

For end-to-end tests, create a throwaway GitHub repo (e.g. `easy-git-dev-test`) and a fine-grained PAT scoped to it. Don't use your real PAT against a real repo while testing.

## Code style

- TypeScript strict mode. The project already enforces it via `tsconfig.json`.
- No `innerHTML`, `outerHTML`, `insertAdjacentHTML` — use `createDiv`, `createEl`, `setText`. Required by the Obsidian community plugin guidelines.
- No native `alert`, `prompt`, or `confirm` — use Obsidian `Modal` (there's a `ConfirmModal` in `src/ui/confirm-modal.ts` you can reuse).
- Pure logic goes in `src/sync/` (no Obsidian imports there). UI code goes in `src/ui/`. The split keeps `src/sync/classifier.ts`, `src/sync/blob-sha.ts`, `src/sync/wikilink-rewrite.ts` testable in isolation.

## Architecture in 60 seconds

```
src/
├── main.ts              Plugin entry: lifecycle, ribbon, commands, auto-mode wiring
├── settings.ts          Settings tab + per-mapping rows + sync log button
├── types.ts             Shared interfaces, DEFAULT_SETTINGS
├── github/
│   ├── client.ts        requestUrl wrapper, auth header, rate-limit tracking
│   ├── git-data.ts      Branch/tree/blob/commit/ref operations
│   └── auth.ts          PAT validation + Device Flow start/poll
├── sync/
│   ├── engine.ts        Per-destination sync; classifier output → vault + remote
│   ├── classifier.ts    PURE: 3-way classification (last ↔ local ↔ remote)
│   ├── blob-sha.ts      PURE: git blob SHA-1 + chunked base64
│   ├── wikilink-rewrite.ts  PURE: Obsidian wikilinks → CommonMark
│   ├── exclusion.ts     PURE: gitignore-style glob matcher
│   └── commit-message.ts    PURE: template token substitution
└── ui/
    ├── mapping-modal.ts     Edit mapping (with destinations list)
    ├── conflict-modal.ts    Per-conflict resolution
    ├── device-flow-modal.ts OAuth code display + polling
    ├── status-bar.ts        Bottom-bar indicator
    ├── sync-log-modal.ts    Sync log viewer
    └── pickers.ts           FuzzySuggestModal for folders/repos/branches
```

The sync engine is the heart. Read `src/sync/engine.ts:runOnce` for the full sync algorithm; the steps are numbered with comments.

## Sending a PR

1. Fork, create a branch off `main`.
2. Make your change, run `npm run build` to confirm types + build pass.
3. Test in a real vault.
4. Open a PR using the template. Reference the issue if there is one.

For small fixes (typo, single-line change) the test plan can be brief. For anything touching the engine or the schema, include enough detail in the PR description that a reviewer can replay your test.

## License

By contributing, you agree your contribution will be licensed under the project's [MIT license](./LICENSE).
