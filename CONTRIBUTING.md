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

## Adding a sync provider

Easy Git supports GitHub and self-hosted Forgejo / Gitea, and adding another host (GitLab, Bitbucket, a different self-hosted API) is welcome. The whole point of the plugin is that the provider stays invisible to the user, so two rules are non-negotiable:

1. **Connecting an account stays a seconds-long, paste-a-token-and-test flow.** No CLI, no SSH keys, no OAuth app the user has to register, no per-repo configuration. If a host can only be reached through a multi-step setup, it isn't a fit for the front of the plugin.
2. **Linking an individual folder stays identical across providers.** The mapping modal (pick folder, pick repo, branch, path, pick direction) must not grow provider-specific fields. Anything a provider needs lives in the Authentication section, never in the per-mapping flow.

Keep those true and the rest of the engine (the 3-way classifier, conflict handling, backups, wikilink and markdown transforms) comes along for free, because it operates on provider-agnostic data.

### Where provider differences live

Everything host-specific is concentrated in a few seams, each gated on `auth.provider`:

- **`types.ts`:** `GitHubAuth.provider` selects the host. `resolveApiBase(auth)` returns the API base URL, and `authConfigError(auth)` validates the config (for example, a self-hosted instance needs an Instance URL) before any request goes out.
- **`github/client.ts`:** `GitHubClient` takes a `baseUrl`, and `isGitHub()` lets request building branch on the host. The transport (`requestUrl`, auth header, rate-limit tracking) is shared.
- **`github/git-data.ts`:** the branch, tree, blob, commit, and ref calls. Where a host's REST shape differs (Forgejo's flat `commit.id`, its paginated `git/trees`, its contents-API writes), branch inside the relevant function and leave the GitHub path byte-identical.
- **`sync/engine.ts`:** `syncDestination` builds the client from `auth` and picks a write strategy by provider. The read path and the entire classifier are shared, and should stay shared.
- **`settings.ts` and `ui/pickers.ts`:** the repo picker chooses its listing call by provider, and the Authentication section renders any provider-specific fields. The mapping modal stays untouched.

### Ground rules for a provider PR

- **Never regress the GitHub path.** Gate new behavior on the provider or host so an existing GitHub user's outgoing requests are unchanged. A good self-check: the request Easy Git sends for a GitHub sync should be identical before and after your change.
- **Reuse the engine.** New code should be limited to auth, API-shape adapters, and the provider's write strategy. If you find yourself editing the classifier or conflict logic, stop and reconsider.
- **Map onto the existing shapes** (`RepoSummary`, `BranchSummary`, `RemoteFileEntry`, and the git blob SHA-1 file identity) rather than inventing new ones, so the rest of the pipeline never needs to know which host produced the data.
- **Test against a real instance.** Spin up a throwaway repo on the host and verify connect, repo pick, push, pull, and a concurrent-change retry. There is no automated test suite, so a replayable manual test plan is what a reviewer relies on.

## Sending a PR

1. Fork, create a branch off `main`.
2. Make your change, run `npm run build` to confirm types + build pass.
3. Test in a real vault.
4. Open a PR using the template. Reference the issue if there is one.

For small fixes (typo, single-line change) the test plan can be brief. For anything touching the engine or the schema, include enough detail in the PR description that a reviewer can replay your test.

## License

By contributing, you agree your contribution will be licensed under the project's [MIT license](./LICENSE).
