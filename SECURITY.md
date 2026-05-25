# Security Policy

## Reporting a vulnerability

If you find a security issue in Easy Git, please **do not** open a public issue. Instead:

- Use GitHub's [private vulnerability reporting](https://github.com/Saiki77/Easy-Git/security/advisories/new), or
- Email the maintainer at the address listed in the plugin's GitHub author profile.

I'll acknowledge receipt within a few days and aim to ship a fix in the next release cycle. For a critical issue (e.g. token exfiltration, arbitrary file write outside vault), I'll prioritise an out-of-band patch release.

## What's in scope

The things most worth scrutiny:

- **Authentication tokens.** PATs and OAuth Device Flow tokens are stored in Obsidian's plugin data (a JSON file in `<vault>/.obsidian/plugins/easy-git/data.json`). They're not encrypted at rest. The plugin sends them only to `api.github.com` and `github.com/login/...` via Obsidian's `requestUrl`. Reports of unintended exfiltration, logging, or storage-in-clear-where-it-shouldn't-be are all in scope.
- **Vault writes.** The engine writes to the vault only inside the configured mapping folders, minus the exclusion globs. Any path-traversal that escapes the mapping folder is a real bug.
- **Network requests.** Every HTTP call should go to `api.github.com` or the GitHub OAuth endpoints — no third-party services, no telemetry, no callbacks. If you spot a request going somewhere else, that's a finding.
- **Wikilink rewriter.** It reads vault files and rewrites markdown for upload. It shouldn't read files outside the mapping folder unless the markdown explicitly references them via `![[…]]`.

## What's out of scope

- Bugs in the plugin that don't have a security impact (those go in the regular bug tracker).
- Bugs in Obsidian itself.
- Bugs in the GitHub API.
- Issues that require the attacker to already control the user's GitHub account or vault.

## Build provenance

Release artifacts (`main.js`, `manifest.json`, `styles.css`) are signed with [GitHub artifact attestations](https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds) on every tag push. You can verify any release was built from this source via:

```sh
gh attestation verify main.js --owner Saiki77
```

## Disclosure

Once a fix ships, I'll publish a brief advisory on the GitHub Security tab describing the issue, affected versions, and the fix.
