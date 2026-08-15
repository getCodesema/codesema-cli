# Changelog

All notable changes to `codesema` (the npm package in `packages/cli`) are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org).

## [0.12.0] - unreleased

### Added

- **Local agentic workspace** (`codesema workspace`, now also what a bare interactive `codesema` opens): a web UI where you hand tasks in natural language to the agent CLI you already use. Each task lives in its own conversation and works in an isolated git worktree (`.codesema/worktrees/<task-id>/`) on the branch that conversation owns; up to 3 tasks run in parallel (`maxParallelTasks` config), extra ones queue FIFO. The agent never commits — the runner commits the worktree at the end of each turn. A turn ends in a result or in a question (`waiting_for_you`; your reply starts the next turn, resuming the Claude session via `--resume`, transcript replay for other providers). Every finished turn passes an automatic local review on the task's branch (`reviewing` → `review_ok`/`review_ko`), with the repo's checks running in a sandbox alongside it, before **Ship** pushes the branch and opens the MR via `gh`/`glab`; per-task auto-ship chains a green review into a ship without a click. Task records, append-only event journals and the latest checks run persist under `.codesema/tasks/<id>/` (`task.json`, `events.jsonl`, `checks.json`); one SSE stream (`/api/tasks/events`) carries every conversation. Ctrl-C shuts down gracefully (agents SIGTERMed, tasks persisted `interrupted`, worktrees kept for resume). There are no named agent roles: every task runs the same anonymous dev agent with a neutral prompt.
- **Multi-project workspace**: one workspace process drives several repos. Launched from inside a git repository, that repo is auto-registered and becomes the current project; launched elsewhere, the workspace opens on the registered projects (possibly none). The registry is a global `~/.config/codesema/projects.json` (stable 8-hex ids derived from the repo root path); each repo keeps its tasks and worktrees in its own `.codesema/` and unregistering a project never touches the disk. New endpoints: `GET /api/projects` (`{ projects, current, workspace }`, the last carrying the process-wide isolation facts), `GET /api/projects/discover` (the git repositories reachable from the launch directory — itself when it is a repo root, otherwise its direct children — offered as one-click additions), `POST /api/projects { path }` (must be a git repository root) and `DELETE /api/projects/:id`, both mutations under the tasks CSRF token. Every task route is scoped by a mandatory project id (`?project=` query param; `project_id` in the `POST /api/tasks` body) — missing id is a 400, unknown project a 404 — and SSE frames are enveloped `{ project_id, task_id, event }` with an initial replay of every project's tasks. `maxParallelTasks` is a GLOBAL cap across all projects, and the workspace lock moved from `.codesema/workspace.lock` (per repo) to a single `~/.config/codesema/workspace.lock` (one workspace process per machine).
- Repo settings page in the web UI: a "Repo settings" link switches the local server's view to edit `.codesema/RULES.md` (full content, one rule per line, optional `|`-separated grid segments) and toggle `syncAutoPush`. New endpoints `GET /api/config`, `PUT /api/config/rules` and `PUT /api/config/sync-auto-push`, protected by the same per-server CSRF token pattern as `POST /api/fix`.
- Read-only sidebar listing the repo's open merge requests in the web UI, backed by the forge CLI (`gh pr list` on GitHub, `glab mr list` on GitLab), sorted by last update. Selecting one opens a minimal detail panel (title, branches, author, link to the forge). New `GET /api/mrs` endpoint reporting `{ available: true, mrs }` or `{ available: false, reason }` (`no-remote`, `no-cli`, `cli-error`) when the forge CLI is missing, unauthenticated, or the repo has no remote.
- "Run review" and "Run dual review" buttons on the MR detail panel: fetches the MR's source branch, reviews it (simple or dual) in a disposable `git worktree` under the OS temp dir, archives the result in the main repo's `.codesema/reviews`, and always removes the worktree afterwards, success or failure. The run streams into the same live web UI as `codesema review` (status, partials, judge decisions). Only one review can run at a time; the sidebar marks which MR or branch is currently under review. `POST /api/mrs/review` (body `{ source: { kind: 'mr', number } | { kind: 'branch', name }, mode }`) and `GET /api/mrs/review/status`, protected by the same per-server CSRF token pattern as `POST /api/fix`.
- Local branches sidebar, under the MR sidebar: lists local branches (name, current/worktree markers, last commit subject and date) from a new `GET /api/branches` endpoint. Selecting a branch opens the same detail panel as an MR, with the same "Run review" / "Run dual review" buttons. Reviewing a branch already checked out elsewhere (the current branch included) uses a detached disposable worktree (`git worktree add --detach`) instead of failing on git's "already checked out" restriction.
- Deterministic (no agent) preview in the MR/branch detail panel: source and target branches, commit list, changed files with +/- and status, and a per-file diff on click, rendered with the same annotated diff view as a finished review. New `GET /api/preview?source=mr&number=N` (`?source=branch&name=X`) returning branch/target/commits/files/diffStats without the full diff, and `GET /api/preview/diff?source=...&path=<file>` returning one file's diff, capped in size and truncated past the cap. The pure git computation behind `codesema prep` (target detection, commits, files, diff) is extracted into `computePrepInput`/`computeDiffSummary` (no disk writes), reused by both `prep` and the preview endpoints.
- `GET /api/mrs`, `GET /api/branches`, `GET /api/preview` and `GET /api/preview/diff` accept an optional `?project=<id>` query param to operate on a registered project's repo (unknown project → 404); without it they keep reading the launch directory as before.
- **Per-task container isolation** (`isolation` config, `auto` by default): the whole task runs in its own box instead of on your machine. The base image is resolved from the repo's `.devcontainer/devcontainer.json` or `.devcontainer.json` (parsed as JSONC, ignored when it needs compose, features or a build context outside itself), else from the checks detection, else `node:26`; a derived image adding a non-root user matching your uid/gid, `git` (probed first, then installed with whichever of `apt-get`, `apk`, `microdnf`, `dnf`, `yum`, `zypper` or `pacman` the base ships — a base with none fails the build saying so, rather than caging an agent that cannot read its own worktree) and the Claude Code CLI is built once with an empty build context and cached under a `codesema-agent:<hash>` tag keyed by the base, the whole generated recipe and the agent version. A turn then runs with the worktree as its only writable host mount (`/work`), the repo's git directory mounted **read-only** at `/gitcommon` with a generated pointer over `/work/.git` — a task worktree is a linked `git worktree`, so without it every `git status`, `diff` or `log` inside the box dies on a host path it cannot see — and `safe.directory` passed as `GIT_CONFIG_*` (command scope, per run) so a uid mismatch never turns into `detected dubious ownership`, a per-task `codesema-home-<task-id>` volume as `$HOME` (credentials seeded once over stdin, never in argv, so the Claude session survives across turns), on an `--internal` network whose only way out is a squid proxy that accepts `CONNECT` to the allowlisted domains and nothing else (`api.anthropic.com` and `platform.claude.com` by default, replaceable with `isolationAllowedDomains`), plus `--cpus 2 --memory 4g --security-opt no-new-privileges` and provider variables forwarded by name only. Inside the cage the agent gets its full tool set (`--dangerously-skip-permissions`) — the box is the guarantee. Commits stay host-side (git credentials never enter the container, and the git directory the box sees is read-only: it can read every ref and object, it cannot write one), and the automatic review and the checks stay independent counter-verification outside it. The mode is probed once at boot and recorded per task as `container` or `policy`, and a fallback is never silent: the CLI prints which mode is active and why, the task journal carries an `isolation` event, `GET /api/projects` exposes `{ isolation_available, isolation_default, isolation_reason, isolation_configured }`, and the UI shows a shield badge plus an upgrade banner. `isolation: 'container'` makes the cage mandatory (task creation answers 409 when it is unavailable), `isolation: 'policy'` always runs on the host, and only `claude` is caged today (any other agent falls back to policy, with the reason stated). Docker and podman both work, rootless podman included (`--userns=keep-id`, dedicated egress bridge instead of the pasta default). Interrupting a task kills its container, not just the client.
- **Sandboxed checks**: after every turn that commits, the repo's typecheck/tests/lint run in an ephemeral container on the task's worktree — in parallel with the automatic review, never blocking it, never able to fail the task. Plan resolution is `checks` config > declarations > lockfile: an explicit `checks` key in `.codesema/config.json` (`image`, `install`, `commands`, `network`, `timeoutSeconds`) replaces detection outright; otherwise the stack comes from the lockfile (`bun.lock`/`bun.lockb` → `oven/bun:1`, `package-lock.json`/`yarn.lock` → `node:26`, a `pyproject.toml` mentioning pytest → `python:3.12`) with the `typecheck`/`test`/`lint` scripts the repo actually declares, and the command list is then replaced by what the repo already declares to its own tooling — lefthook's `pre-push` then `pre-commit` (`lefthook.yml`, `lefthook.yaml`, `.lefthook.yml`, `.lefthook.yaml`) first, else the `run:` lines of GitHub workflow jobs whose id or name matches test/lint/typecheck/check. Declared commands go through a strict allowlist (first binary among `bun npm npx pnpm yarn node pytest cargo go make just`, no shell metacharacter, no install-like command, deduplicated, typecheck-then-test-then-lint, capped at 6). Each step is one `docker`/`podman` `run --rm -v <worktree>:/work:rw -w /work --network none --cpus 2 --memory 2g <image> sh -lc <command>` killed at `timeoutSeconds` (300 by default), with the repo's git directory mounted read-only at `/gitcommon` the same way the isolation cage does it (check commands that shell out to git — hooks, version stamps, test rigs — otherwise hit a `.git` pointing outside the mount); only the optional install step may get the network, and only when `network: true`. The run lands in `.codesema/tasks/<id>/checks.json` (per-command status, exit code, duration and output tail, plus an optional `source` naming the level that produced the commands — `config`, `lefthook`, `ci` or `scripts` — which the Checks tab shows as a "detected: lefthook" chip), streams live on the SSE `task_checks` event and a `checks` journal entry, and surfaces in the conversation's **Checks** tab (the semaphore is the tab label itself, per-command detail with foldable output, manual re-run) and as a badge on ready-to-ship cards. New `POST /api/tasks/:id/checks?project=<id>` (202; 409 while a run is in flight or when the task has not committed yet) and `GET /api/tasks/:id/checks?project=<id>`.
- **Agent-assisted checks setup, validated by a human**: when nothing is detected — or the detection is wrong — "Configure with the agent" asks your own agent CLI to *propose* a checks configuration. It runs read-only hardened (`--tools "" --strict-mcp-config --setting-sources user` for `claude`, `--sandbox read-only --ask-for-approval never` for `codex`) and reads nothing itself: codesema collects and inlines the manifests (`package.json` and its workspace manifests, `Makefile`/`justfile`/`Taskfile.yml`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `.gitlab-ci.yml`, the lefthook files, the GitHub workflows, …), bounded to 4 000 characters per file and 30 000 in total, alongside a listing of the repo root. The reply must be one JSON object (`image`, `install`, `commands`, `network`, `timeoutSeconds`, `rationale`) and is sanitized before it is even displayed: an image reference that does not parse or zero surviving commands refuse the whole proposal, commands are screened against the same binary allowlist (`&&` chaining and `cd` tolerated, every other shell metacharacter refused, 8 max), the timeout is clamped to 30…3600 s and the rationale stripped of control characters. The proposal lives in memory only — a restart forgets it, and nothing reaches disk until a human clicks **Apply**, which writes the `checks` key of `.codesema/config.json` and leaves every other key of that file byte-for-byte in place. `POST /api/projects/:id/checks-setup` (202), `GET /api/projects/:id/checks-setup` (proposal state) and `POST /api/projects/:id/checks-apply` (200, 409 with nothing proposed), the two mutations under the tasks CSRF token; every state transition broadcasts on the SSE `checks_proposal` event.
- **Conversations own their branch**: `POST /api/tasks` now accepts `branch` — work *on* that existing branch directly, no derived ref, the worktree is a checkout of it — or `base`, which forks a new `codesema/task-<slug>` branch from it; the two are mutually exclusive (400), and with neither the task still forks from the detected trunk as before. Work-on tasks also take an optional `target`, the branch the MR will aim at. `origin/x` and `x` are one identity everywhere: records store the short name, existence is resolved against `refs/heads` then `refs/remotes/origin`, and a remote-only branch gets a local tracking head created for it (`git branch --track`, falling back to a plain branch). Only one active conversation may own a branch: a second one is a `409` carrying `existing_task_id`, so the UI opens the conversation that already has it instead of dead-ending, and a branch checked out in another worktree is refused with the path that holds it. Abandoning (`POST /api/tasks/:id/abandon`) removes the worktree and deletes the branch **only** when the conversation forked it — a branch you asked it to work on is never deleted — and a shipped task keeps its `shipped` status instead of being marked failed.
- Live token telemetry per turn: the agent stream's usage is accumulated as it arrives and pushed on a new `task_meta` SSE event (token meter in the conversation header, reset at each turn), then persisted on the turn record (`tokens`) when the turn ends, so a finished turn shows its own cost next to its duration and tool count.
- **Workspace project tree**: the sidebar lists the registered projects with their live counters, and the selected project expands into a tree of its open merge requests (`GET /api/mrs`) and active branches (`GET /api/branches`) with the conversations working on them nested underneath — a conversation attaches to the MR whose source branch it owns, otherwise to a node for its base branch, so derived `codesema/task-*` branches never become nodes and are filtered out of the flat "Branches (n)" list under the tree. Nodes are ordered by their most recent conversation activity and unfold by default while something is still moving. Clicking a branch opens the conversation that already owns it, or drafts a new work-on conversation on it with the MR's target prefilled — and warns, with a one-click switch to fork-from, when the branch is `main`, `master` or `develop`.
- **The agent names its own branch**: on its first turn a forked conversation is asked to open its reply with `BRANCH: <2-5 word kebab-case name>`, and the runner renames `codesema/task-<slugged title>` to `codesema/task-<that name>` before the commit, the review and the ship — so the MR source branch reads `codesema/task-update-workspace-docs` instead of `codesema/task-les-docs-sont-a-jours`. The proposal is slugged like any branch name and collisions take the usual `-2` suffix; a missing, unusable or refused proposal silently keeps the generated name. Never asked for and never applied on a work-on conversation (that branch is yours), and never on a branch already pushed.
- **Redesigned workspace UI**: one dark theme (`#0a0d10` ground, `#46b17b` green, `#d9a441` amber, a deliberately blue focus ring so focus is never read as a status) with Instrument Sans and JetBrains Mono vendored in the tarball — no CDN, nothing fetched at page load. The projects rail sits on the left, a **work queue** in the middle groups conversations into "Needs you" (`waiting_for_you`, `review_ko`), "In progress" (`running`, `reviewing`, `queued`), "Ready to ship" (`review_ok`) and a foldable "Done" pile (`shipped`, `failed`, `interrupted`), and the right side is a **focus deck** of up to 3 conversations side by side: pin one (📌) and the next conversation you open replaces the loose column instead of the ones you kept. Each conversation has **Conversation** / **Diff · n files** / **Checks** tabs, a header bell counting the agents waiting on you (click opens the one that has waited longest) next to a live count of running agents, ⌘K/Ctrl-K search over titles and branches, quick-reply buttons extracted from the agent's actual question (numbered or bulleted options, or an "A or B?" disjunction — at most 4, dropped entirely when any option looks unusable, plus an always-present "Something else…"), a reply field that parks your message while the agent runs and delivers it the moment the turn ends (a second message appends to the parked one — one turn, one message), and a folded tool feed showing live elapsed time and token count while the turn is in flight, then the turn's tool count, tokens and duration once it is done.

### Changed

- **Breaking (0.x)**: a bare interactive `codesema` now opens the agentic workspace instead of the menu; the menu stays reachable as `codesema menu`, and every explicit command (`review`, `show`, `sync`, ...) is unchanged. Non-interactive invocations keep behaving like `codesema review`, so CI pipelines are untouched.
- `isolation`, `isolationAllowedDomains` and `maxParallelTasks` are settable in both the global config and a repo's `.codesema/config.json` (repo wins), on purpose: the cage is a property of the project, and a repo can only ever narrow what the agent reaches, never widen its rights on your machine. `checks` stays repo-only, and the sync fields stay global-only.

### Fixed

- Agent messages render as markdown in the conversation — headings, bold, italics, inline code, fenced blocks, lists and `http(s)` links — through a dependency-free, escape-first renderer, instead of showing raw `##` and `**`. Message and question bubbles also read the full body from the turn record rather than the bounded journal preview, so a long answer is no longer cut off mid-sentence.
- The work queue's "Done" pile is visible by default (it used to open folded), and the whole ready-to-ship card opens the conversation instead of its title alone.
- The ready-to-ship card is reachable with the keyboard (Tab, then Enter or Space) like every other queue card, and its `[Diff]` button no longer opens the conversation twice per click.
- The automatic review no longer runs blind: its progress lines stay visible while the task is `reviewing` (they used to be dropped the moment the task left `running`), under a "review" block distinct from the agent's own stream and with a live elapsed timer, the journal line says which turn is under review and in which mode, and the **Stop** button no longer offers to interrupt a review it cannot actually stop.
- The review of a turn is readable where it happened: the `review_done` card shows the review's summary and its findings by severity, and **Open the review** now loads the task's own archive through a new `GET /api/tasks/:id/review?project=<id>` (optional `ref=` for a past turn's archive, refused outside the repo's `.codesema/reviews`) instead of the server's global review session — which never matched in workspace mode, or worse, opened another branch's review. The task's findings also annotate the **Diff** tab, and review archives are kept 20 deep per branch (was 5) so the conversation's history keeps resolving.

### Security

- Workspace task turns running on the host (the `policy` mode, and the fallback when the cage is unavailable) now get `--strict-mcp-config` and `--setting-sources user` on top of their edit permissions: a turn that writes a `.claude/settings.json` or `.mcp.json` into its own worktree can no longer have them loaded by the next resumed turn (the CVE-2026-25725 lesson). Flags you set yourself still win.
- The workspace warns once at boot when the configured agent is a custom command: no hardening applies to it — full environment, no read-only harness, repo-provided settings honored — so only use a command you fully trust.
- The checks container never receives your environment: no `-e`/`--env` flag at all, the worktree as its only host mount, `--network none` on every check command, and the network reachable only by an explicit `network: true` install step.

### Changed

- `codesema --help` lists `--fail-on`, `--out` and `--force`, shows `--dual` and `--fail-on` on the `review` usage line, and describes the startup update check as the upgrade prompt it became in 0.10.0 (it fires on every command, not just `review` and `show`). Both catalogs, English and French.
- Repo tooling: the root `prepare` script no longer aborts `bun install` when `lefthook install` fails (a checkout without `git` or without the lefthook binary, e.g. a minimal container). The failure is reported as an explicit warning saying the git hooks — gitleaks secret scan included — are not active, instead of being swallowed; nothing changes on a machine where lefthook installs fine.
- Documentation caught up with the code: the README gained a "In the web UI" section (focus mode, run fixes, MR and branch sidebars, preview, running a review from the page, repo settings), a Privacy paragraph on the server context download of 0.11.0, the corrected update-check description and `packages/contract` in the monorepo layout; the bundled agent skill emits `steps`/`step_ref` (renamed from `chapters`/`chapter_ref`) plus `files_reviewed`, and documents the `rules` and `impact_candidates` input fields; `@codesema/contract`'s README documents `groundReview`, `detectDiffSecrets` and `reviewRecordSchema`.

## [0.11.0] - 2026-08-02

### Added

- Server context download: `codesema review` fetches `GET /api/cli/context` (conventions, learned rules, facts, last-scan freshness) for the current repo and hands it to the agent alongside the diff. The origin remote (`git remote get-url origin`) is sent as the `remote_url` query param the route requires to resolve the repo. Strictly best-effort and never blocking, same contract as auto-sync: no stored workspace credentials, no origin remote, offline, an unlinked workspace (403) or any malformed response all silently degrade to no server context, and the local review runs unchanged. `.codesema/RULES.md` stays local and always takes precedence.
- Staleness warning: when the server's last scan commit is not an ancestor of the current `HEAD`, the context is prefixed with an explicit warning naming the scan date, so the agent treats the conventions, learned rules and facts as advisory rather than ground truth about the current diff.

## [0.10.0] - 2026-07-29

### Added

- Startup upgrade prompt: when a newer version is published on npm, the CLI announces it ("A new version x.y.z of codesema is available!") and asks whether to upgrade now (typed yes/no answer). On acceptance it runs the matching global install command, detecting how codesema was installed (npm, pnpm, yarn or bun); on refusal or failure the current invocation continues unchanged. Interactive terminals only, and still opt-out via `CODESEMA_NO_UPDATE_CHECK`.
- Team rules grid: `.codesema/RULES.md` holds one review rule per line, optionally extended with `|`-separated grid segments (`Scope`, `Where to look`, `Bad`, `Good`, `Exceptions`). Rules are injected as `[C1]`, `[C2]`, ... (file order) and the reviewer hunts them FIRST, jumping straight to the code each rule's `Where to look` targets, before the regular file-by-file sweep. Convention findings must cite the rule id; deviations must be introduced by the diff itself, and code covered by a rule's `Exceptions` is never flagged.
- Per-file coverage verdict: `files_reviewed` entries are now `{ path, status }` with `status` `clean` or `findings` (`@codesema/contract` 0.4.0), forcing the reviewer to settle every diff file explicitly instead of drifting past it. The persisted status is recomputed deterministically from the findings that survive grounding, never trusted from the agent; bare string entries from older agents and archives are still accepted. In dual mode the merged review carries the per-path union of both lanes, `findings` winning.

### Changed

- The passive "update available" one-liner printed after `codesema review` and `codesema show` is replaced by the startup upgrade prompt.
- The final self-check in every review prompt (simple, both dual lanes) became an adversarial refutation pass: the reviewer must actively try to REFUTE each finding (file in the diff, line inside a hunk, failure scenario named, the diff really produces the claimed outcome, cited rule really violated) and delete what it cannot defend: report boldly during the sweep, refute hard before emitting.
- The fix prompt now demands verification, mirroring the server-side fix agent: a regression test written red-first when a finding describes a reproducible bug, a run of the repo's cheap checks (typecheck, unit tests, lint) after the edits with a fallback note when the agent environment cannot run commands, and a summary that states how each fix was verified.
- The verdict is now scoped to what the reviewer can actually verify: a concern living outside the provided input (another repository, an external consumer of a published package, a deployment) never becomes a finding and never holds back an approve; the simple reviewer surfaces it as a step "check" question for the human, and the prosecutor carries the same verdict rule. Previously any contract-touching MR could never be approved because the reviewer withheld the verdict over code it cannot see.

## [0.8.0] - 2026-07-16

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
