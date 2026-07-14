# Changelog

All notable changes to `codesema` (the npm package in `packages/cli`) are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org).

## [0.7.0] - unreleased

### Added

- `repository` field in the published `package.json` files (`codesema`, `@codesema/contract`), pointing to the repo's new home at `github.com/getCodesema/cli`.
- `codesema link` without a code now links through the browser: the CLI opens a codesema.com confirmation page for the workspace and waits until you approve it there — no pairing code to copy. `codesema link <code>` keeps working as the no-browser fallback, and the menu's "Link account" entry uses the browser flow.

- Focus mode: a problems-first view of the review. Actionable findings on the left with checkboxes, the selected problem's note and its code excerpt on the right, previous/next stepping, and "Copy selection for agent" scoped to the checked findings.
- Run fixes: a button in focus mode asks the configured agent to apply the selected findings to the working tree (headless run with edit permissions, per-session token on the local endpoint, warning when the branch moved since the review). `codesema show` exposes it too when an agent is available.
- Guided reading: a floating Next/Previous pill walks the agent's notes one by one across steps, scrolling to each annotation in the diff and marking steps as read along the way.
- Step dots in the MR rail are colored by what the agent found there: red for critical/major findings, orange for minor ones, green when clean (falls back to the step risk); the read checkmark stays.
- `codesema review --fail-on <critical|major|minor|info|request_changes>`: a CI gate that runs the review once, stops the local server so the command exits, and returns exit code `2` when the review has a finding at or above the given severity, or requested changes. Without the flag, `review` keeps its server up for the live UI as before.
- `@codesema/contract` (0.2.0) exports a JSON Schema for the review record (`reviewRecordSchema`) and a diff secret scanner (`detectDiffSecrets`), both usable by codesema.com.

### Changed

- "Copy for Claude Code" is now "Copy for agent" (the CLI drives Claude, Codex, Gemini or a custom agent).
- `codesema sync delete` run directly from the CLI now asks the same confirmation as the menu when the terminal is interactive.
- README: added Privacy, Environment variables, Files and Exit codes sections.

### Fixed

- Review flags (`--branch`, `--target`, `--agent`, `--full`, `--no-open`, `--port`, `--timeout`) passed without a command run a review again instead of being silently dropped by the interactive menu.
- Sync API responses are validated before use: a malformed 2xx response now fails with a clear error instead of silently storing broken credentials.
- Root `typecheck` and `test` scripts build `@codesema/contract` first, so a fresh clone passes without a manual build.
- The `codesema config` menu no longer drifts down one line per cancelled navigation round-trip.

### Security

- Sync credentials are pinned to the base URL they were created against: changing `CODESEMA_SYNC_URL` later can no longer send the workspace secret to a different host.
- Synced reviews no longer embed the absolute local repository path (`repo_root` is blanked before upload).
- The global config file is written with owner-only permissions (0600) since it can hold the sync workspace secret.
- Sync fields (`syncUrl`, `syncWorkspaceId`, `syncSecret`) in a repo's `.codesema/config.json` are ignored: only the global config decides where reviews are sent.
- `codesema sync` scans the diff for material that looks like a committed secret (dotenv files, private keys, and AWS/GitHub/Slack/Google/Stripe/OpenAI/Anthropic credentials, on both added and removed lines) and refuses to upload it; pass `--force` to send anyway.

## [0.6.0] - 2026-07-13

### Added

- `@codesema/contract` package: the review contract (types + sanitizers) extracted from the CLI and published so codesema.com can validate synced reviews with the same code.
- `codesema sync`: push the latest review to a free anonymous codesema.com workspace (opt-in, explicit confirmation on first run).
- `codesema sync delete`: erase all synced data and local credentials.
- `codesema link <code>`: attach the workspace to a codesema.com account via a pairing code.
- Interactive menu: running `codesema` with no arguments now opens a navigable menu (review, show, sync, link, config) in interactive terminals.

### Changed

- More readable CLI output: dynamically aligned field blocks, clear section spacing, hotspot files on their own line.
- `codesema config` opens a submenu (agent & model, language) instead of one linear wizard; the language can now be changed on its own.
- Interactive menus redraw in place: selecting an entry no longer leaves a residual summary line behind, so the UI stays put while navigating.
- Select prompts breathe: a blank line under the question, answers indented deeper to make the question stand out, and back/quit entries visually detached below the list.
- The menu groups online actions (sync, link account, delete synced data) under a single Cloud entry with its own submenu; repo actions stay visible outside a git repository with a hint saying where to run them.

## [0.5.0] - 2026-07-11

### Added

- `language` config field (ISO 639-1: `en` or `fr`) driving the whole experience: the CLI, the embedded web UI and the language the agent writes the review in.
- Onboarding now starts with a language question (`English`, `Français`), preselected from the `LANG` environment. `codesema config` can change it later, with the same global/repo scopes.

### Changed

- Review prompt: when `language` is set, the agent writes the review in that language instead of inferring it from the commit messages (unchanged fallback when unset).

## [0.4.0] - 2026-07-11

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
