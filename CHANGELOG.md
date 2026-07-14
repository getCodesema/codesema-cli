# Changelog

All notable changes to `codesema` (the npm package in `packages/cli`) are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org).

## [0.8.0] - unreleased

### Added

- Dual review (`codesema review --dual`, or "Dual review" in the menu): two independent reviewers run in parallel on the same agent CLI — the reviewer (full narrative review) and the prosecutor (adversarial, findings only) — then a judge on the provider's mid-tier model (sonnet / gpt-5.5 / gemini-2.5-pro) adjudicates every finding: kept, merged as duplicate, or rejected with a reason. Security findings can never be rejected by the judge. Findings raised by both reviewers carry a `consensus` badge; the record stores the deliberation stats (`meta.dual`). If one reviewer fails the review finishes with the survivor; if the judge fails the union of both reviews is kept. Dual reviews always run from scratch (no incremental update).
- The live web UI shows both dual phases, at no extra token cost (everything derives from the two streams and the judge stream): a face-à-face of the two reviewers with live severity counters, a per-file consensus map where files lit by both lanes pulse as hot zones, then the deliberation with each judge decision resolving live (kept / merged / rejected with the reason).
- Deterministic grounding of the agent review against the diff, before display and archive (`groundReview` in `@codesema/contract` 0.3.0): findings on files absent from the diff are dropped, line anchors outside every hunk are removed, duplicate findings (same file, line and kind) merge into one with the highest severity, and an `approve` verdict with a surviving critical finding is escalated to `request_changes`. `codesema review` prints what was corrected.
- `impact_candidates` in the prep input and the review prompt: when the MR modifies or removes an exported declaration (TypeScript/JavaScript exports, Python top-level `def`/`class`), `codesema prep` lists where that symbol is used elsewhere in the repository (`git grep`, word-matched, capped and deduplicated) and which files import the changed files, so the agent can flag call sites the diff does not update. Zero new dependencies; the block is explicitly labeled as best-effort text matches, and the review instructions require the agent to treat it as leads to verify, never as facts.
- Reviewer coverage tracking: both reviewers report the diff files they examined (`files_reviewed` in `@codesema/contract` 0.3.0) and `codesema review` warns about any diff file a reviewer skipped (full reviews only; incremental updates are exempt).
- Deterministic cross-lane consensus: findings raised by both dual reviewers on the same file, line and kind merge before the judge runs — fewer decisions to pay for, and the consensus badge survives even a judge failure.
- Auto-sync, strictly opt-in: after a successful `codesema sync`, the CLI offers once to also push every future completed review automatically (`syncAutoPush` in the global config; workspace credentials alone never auto-push), and the `codesema config` menu toggles it anytime. Best-effort and never blocking: a sync failure or a diff carrying potential secrets keeps the review local and says so (secrets still require a manual `codesema sync --force`).
- One automatic retry when the agent output holds no parseable JSON review (lanes, judge and simple review), with a short corrective instruction; agent crashes and timeouts are never retried.
- A prompt evaluation bench under `packages/cli/eval/` (labeled bug fixtures + recall/noise report) to measure reviewer prompts before and after changes; development tool, not shipped.

### Changed

- Hardened reviewer prompts: mandatory file-by-file sweep with no early stop and no implicit findings cap, severity definitions by consequence, mandatory concrete failure scenario per finding, strict line anchoring (omit the line rather than guess), a pre-output self-check, and systematic follow-up of `impact_candidates` usages. The judge must cite the exact diff lines when rejecting a finding and shares the same severity scale.
- The review diff now carries 10 context lines per hunk (git default is 3), so reviewers judge changes against the enclosing code.
- A `praise`/`why` finding is always severity `info`: a mis-scored praise can no longer escalate the verdict or trip `--fail-on`.

- The agent prompt no longer carries prep plumbing: the absolute repository path, commit SHAs and internal metadata are stripped; the agent receives only the branch names, commit subjects, changed files, custom instructions and the diff.
- Commit subjects are truncated to 120 characters in the prep input, and the review instructions now state that commit messages are intent context only, never evidence.

### Security

- The review subprocess runs the known agent CLIs with tools switched off: `claude -p` gets `--tools "" --strict-mcp-config --setting-sources user` (no tools, no MCP servers, repo-level `.claude/` settings ignored) and `codex exec` gets `--sandbox read-only --ask-for-approval never` plus `AGENTS.md` loading disabled. Flags already present in the command win; the fix runner keeps its edit tools. Gemini has no CLI flag for this; its non-interactive mode already denies shell and write tools.
- Known agent CLIs are spawned with a minimal environment (`PATH`, `HOME`, locale, proxy and the provider's own variables): other credentials and tokens in your environment no longer reach the review subprocess. Custom agent commands inherit the full environment as before.
- Diff marker line parsing in `@codesema/contract` (`--- ` / `+++ ` paths) no longer uses a polynomially backtracking regex (CodeQL: polynomial ReDoS): a crafted diff line packed with tabs and a stray carriage return could stall `detectDiffSecrets` and `groundReview` for seconds. The tab suffix is now stripped with a linear `indexOf` scan.

## [0.7.0] - 2026-07-13

### Added

- `repository` field in the published `package.json` files (`codesema`, `@codesema/contract`), pointing to the repo's new home at `github.com/getCodesema/codesema-cli`.
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
