# Changelog

All notable changes to `codesema` (the npm package in `packages/cli`) are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org).

## [0.6.0] - unreleased

### Added

- `@codesema/contract` package: the review contract (types + sanitizers) extracted from the CLI and published so codesema.com can validate synced reviews with the same code.
- `codesema sync`: push the latest review to a free anonymous codesema.com workspace (opt-in, explicit confirmation on first run).
- `codesema sync delete`: erase all synced data and local credentials.
- `codesema link <code>`: attach the workspace to a codesema.com account via a pairing code.
- Interactive menu: running `codesema` with no arguments now opens a navigable menu (review, show, sync, link, config) in interactive terminals.

### Changed

- More readable CLI output: dynamically aligned field blocks, clear section spacing, hotspot files on their own line.
- `codesema config` opens a submenu (agent & model, language) instead of one linear wizard; the language can now be changed on its own.
- The interactive menu keeps review/show/sync visible outside a git repository, with a hint saying where to run them.

## [0.5.0] - unreleased

### Added

- `language` config field (ISO 639-1: `en` or `fr`) driving the whole experience: the CLI, the embedded web UI and the language the agent writes the review in.
- Onboarding now starts with a language question (`English`, `Français`), preselected from the `LANG` environment. `codesema config` can change it later, with the same global/repo scopes.

### Changed

- Review prompt: when `language` is set, the agent writes the review in that language instead of inferring it from the commit messages (unchanged fallback when unset).

## [0.4.0] - unreleased

### Added

- CLI version displayed in the startup banner.
- Update notice at the end of `review` and `show` when a newer version is published (`current => latest`): a read-only npm dist-tags lookup, skipped when stdout is not a terminal, opt-out with `CODESEMA_NO_UPDATE_CHECK=1`.

## [0.3.0] - 2026-07-11

### Changed

- Review vocabulary: "chapters" are now **steps** (`narrative.steps` and `step_ref` in the agent contract). Legacy `chapters`/`chapter_ref` are still accepted when reading archives.
- Terminal experience: Ocean palette, ANSI Shadow banner, live progress in the spinner, final review summary, desktop notification.
- Web experience: Semaphore design system, step rail with passed/active states, traffic-light verdict, "Agent's take" banner.
- The CLI is shipped unminified so users can audit the code that reads their diff.

### Removed

- All runtime dependencies: `hono` and `@hono/node-server` replaced by a native `node:http` server. `npm install codesema` now installs a single package.

### Security

- Loopback Host guard extended to every route (DNS-rebinding defense, previously `/api/*` only).
- Static file serving hardened against path traversal (raw, percent-encoded, null bytes).
- `X-Content-Type-Options: nosniff` on every response; concurrent SSE connections capped.
- `.codesema/input.json` now goes through the same sanitizer as every other JSON boundary; file paths from agent output are length-capped.

### Fixed

- Review archives are pruned (5 kept per branch) and the previous-review lookup no longer parses unrelated archives.
- Forge detection only probes the CLI matching the origin remote (`glab` for GitLab, `gh` for GitHub), instead of both sequentially.

## [0.2.2] - 2026-07-11

### Fixed

- npm `bin` path normalized so installs expose the `codesema` binary reliably.

## [0.2.1] - 2026-07-11

### Added

- CLI version injected from `package.json` at build time (`--version`).

### Changed

- Very large diffs: files collapse in the web UI past a cumulative line budget.

### Security

- Repo-provided agent commands require explicit approval before running.
- API routes reject non-loopback `Host` headers (DNS-rebinding defense).
- Review records read back from disk are sanitized.

## [0.2.0] - 2026-07-11

### Added

- Interactive flow: first-run onboarding wizard (agent, model, effort) and branch picker.
- Live review: the web UI opens immediately and fills in while the agent writes.

## [0.1.0] - 2026-07-11

Initial release.

### Added

- `prep`: target-branch detection (glab/gh, origin/HEAD, merge-base heuristic), MR diff with lockfile exclusions, `.codesema/input.json` for the agent.
- `review`: one-shot flow driving a headless agent CLI (Claude Code, Codex, Gemini or a custom command), with incremental re-review of the same branch.
- `show`: embedded web UI served locally (guided step-by-step reading, annotated diff, file tree).
- `export`: Markdown export of a review.
- Agent skill (plain markdown) to drive the flow from inside an agent instead of the CLI.
