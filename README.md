# codesema

[![npm version](https://img.shields.io/npm/v/codesema)](https://www.npmjs.com/package/codesema)
[![npm downloads](https://img.shields.io/npm/dm/codesema)](https://www.npmjs.com/package/codesema)
[![node](https://img.shields.io/node/v/codesema)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/codesema)](LICENSE)

**Review your merge requests locally, with the AI agent you already use.**

Run one command on a branch: `codesema` computes the MR diff, hands it to **your** AI agent (Claude Code, Codex, Gemini, …), and opens a local web UI where the review appears live. You then read it like a guided tour: what to look at first, step by step, with findings pinned to the diff.

- **Your agent, your subscription.** The review runs through the agent CLI you already pay for. No account, no API key, no cloud: everything happens on your machine.
- **Zero runtime dependencies.** `npm install codesema` installs exactly one package, shipped unminified so you can audit the code that reads your diff.

🌐 Website: **[codesema.com](https://codesema.com)** · 📦 npm: [`codesema`](https://www.npmjs.com/package/codesema)

## Quick start

```bash
npx -y codesema            # opens the agentic workspace (web UI, see below)
npx -y codesema review     # guided review of a local branch
```

The review flow:

1. **First run only**: a short wizard asks which agent CLI to use (auto-detected on your PATH), the model and the reasoning effort. Saved globally, never asked again; change it anytime with `codesema config`.
2. **Pick a branch**: your local branches, sorted by last commit, arrow keys + type-to-filter.
3. **The web UI opens immediately**: the review runs in the background and the page fills in live, diff stats first, then verdict, summary and findings as the agent writes them (true token streaming with Claude Code, best-effort with other agents).

Re-running on the same branch reviews **incrementally**: the agent gets the previous review plus the diff since it, and updates it (pass `--full` to review from scratch).

## Workspace

`codesema` (or `codesema workspace`) opens a **local agentic workspace**: a web UI where you hand tasks to your AI agent in natural language. Each task is a conversation that **owns a git branch** and works in its own worktree (`.codesema/worktrees/<task-id>/`), so several tasks run in parallel without touching your checkout. The agent never commits: the runner commits the worktree at the end of each turn.

**Fork, or work on.** A conversation either **forks** a fresh branch (`codesema/task-<slug>`) from a base — the default — or **works on** an existing branch directly, keeping its name and its history. A forked branch starts from your prompt's slug, then the agent renames it on its first turn with a short descriptive name of its own (`codesema/task-update-workspace-docs`) — that name is what the merge request will show. `origin/x` and `x` are the same branch (a remote-only branch gets a local tracking head), and a branch can only be owned by one active conversation at a time: starting a second one on it opens the existing conversation instead. Abandoning a conversation removes its worktree and deletes the branch only when it forked it — a branch you asked it to work on is never deleted.

**One workspace drives several repos.** Launched from inside a git repository, that repo is auto-registered as a project and becomes the current one; launched from anywhere else, the workspace opens on the projects you already registered (add more from the UI, by path, or pick one of the repos it finds next to your launch directory). The registry is a small global file (`~/.config/codesema/projects.json`) mapping stable ids to repo roots — each repo keeps its own tasks and worktrees under its own `.codesema/`, so removing a project only unregisters it and never touches the repo. The concurrency cap is **global**: 3 running tasks at a time by default across all projects (`maxParallelTasks` in the config), extra ones queue FIFO.

**The UI is a work queue, not a dashboard.** The sidebar is a tree, per project, of the open merge requests (via `gh`/`glab`) and the active branches, with the conversations working on them nested underneath — derived `codesema/task-*` branches stay out of it, since the conversation already carries them. The middle column groups every conversation into **Needs you**, **In progress**, **Ready to ship** and a **Done** pile; the right side is a focus deck of up to **3** conversations side by side, pinnable (📌) so opening a new one replaces the loose column instead of the ones you kept. Each conversation has **Conversation**, **Diff** and **Checks** tabs, quick-reply buttons extracted from the agent's own question, and a reply field that parks your message while the agent runs and sends it the moment the turn ends.

A task moves through explicit statuses: `queued` → `running`, then `waiting_for_you` when the agent ends its turn on a question (reply to start the next turn), or — when a turn finishes with changes — `reviewing`: every finished turn passes an **automatic local review** (the same review engine as `codesema review`, on the task's branch) before anything leaves your machine, landing on `review_ok` or `review_ko`. **Ship** then pushes the branch and opens the MR via `gh`/`glab` (status `shipped`); per-task **auto-ship** chains it without a click on a green review. `failed` and `interrupted` round out the lifecycle: an interrupted task (Ctrl-C, crash) keeps its worktree and session, and resumes when you reply to it.

**Checks run in a sandbox.** Alongside the review, every turn that commits runs the repo's typecheck, tests and lint in an ephemeral `docker`/`podman` container mounted on the task's worktree, with `--network none` and cpu/memory caps. The plan comes from your `checks` key in `.codesema/config.json` if you wrote one, otherwise from what the repo already declares — lefthook's `pre-push`/`pre-commit` hooks or its CI workflow jobs, filtered through a strict command allowlist — otherwise from the lockfile and the `typecheck`/`test`/`lint` scripts of `package.json`. If none of that fits, the Checks tab can ask your agent to _propose_ a configuration: it runs read-only on files codesema hands it, its JSON answer is sanitized, and nothing is written until you click Apply. Checks never block a task; they are a second opinion next to the review, visible in the tab and on the ready-to-ship card.

**Each task can run in its own container.** With `docker` or `podman` installed, the workspace cages every task by default: the turn runs inside a container built from your `.devcontainer` (or `node:26`), with the worktree as its only writable host mount, the repo's git directory mounted read-only so the agent can read its diff, log and status without being able to rewrite a single ref, its own `$HOME` volume so the agent session survives across turns, and an internal network whose only exit is a proxy allowing the agent's own API domains. Inside that box the agent keeps its full tool set — the container is the boundary, not a permission prompt. Commits stay on the host, so your git credentials never enter it, and the review and the checks remain independent counter-verification. The mode is decided once at startup and printed: `isolation` set to `container` makes the cage mandatory (a task refuses to start without it), `policy` always runs on your machine with the host hardening, and `auto` (the default) falls back to `policy` while telling you why. Only `claude` is caged today; the allowed domains are yours to change with `isolationAllowedDomains`.

There are no named agent roles: every task gets the same anonymous dev agent with a neutral prompt — you define your workflow in the tasks you write, the tool stays out of the way.

Tasks live as long as the process runs (no detached daemon). The first Ctrl-C shuts down cleanly — agents stopped, tasks persisted as `interrupted`, worktrees kept for resume — and a second one force-quits. Task state (record, append-only event journal, latest checks run) is stored under `.codesema/tasks/<id>/` of the task's repo.

## Dual review

`codesema review --dual` (or "Dual review" in the menu) runs the review twice in parallel with the agent you already use, under two different angles: the **reviewer** reads the MR for the big picture and writes the guided narrative, while the **prosecutor** hunts for what breaks — bugs, regressions, security, edge cases — and reports findings only. A **judge** on the same provider's mid-tier model then adjudicates every finding: kept, merged as a duplicate, or rejected with a one-line reason. Security findings can never be rejected.

The live UI shows both phases: the two reviewers face to face with a per-file consensus map (files both lanes flag light up as hot zones), then the deliberation where each decision resolves in real time. In the final review, findings raised by both reviewers carry a **consensus** badge — the strongest signal a finding deserves your attention. Cost: roughly two reviews plus one cheap judge pass; the display itself consumes zero extra tokens.

## How it works

```
┌──────────────┐  prep   ┌───────────────────────┐  review   ┌───────────────────────┐  live SSE
│ local branch │ ──────► │ .codesema/input.json  │ ────────► │ .codesema/review.json │ ─────────► local web UI
└──────────────┘  (CLI)  └───────────────────────┘ (your AI  └───────────────────────┘ (opened before
                                                     agent)                             the review ends)
```

1. **prep** detects the target branch (via `glab`/`gh` if an MR/PR exists, else `origin/HEAD`, else nearest merge-base among develop/main/master) and computes the MR diff.
2. **Your agent** reviews the diff like a senior reviewer and writes a structured review: prologue, ordered steps with risk/take/check, typed findings (security/perf/convention/design/praise/why), and what to review first.
3. **The local web UI** shows the review in progress, then switches to the full experience: guided step-by-step reading, split/unified diff with inline notes, file tree, read/checked progress.

## In the web UI

Beyond the review itself, the local page drives the whole loop:

- **Focus mode**: a problems-first view — actionable findings with checkboxes on the left, the selected note and its code excerpt on the right, previous/next stepping, and "Copy selection for agent" scoped to what you checked.
- **Run fixes**: asks the configured agent to apply the selected findings to your working tree (headless run with edit tools, warning when the branch moved since the review).
- **Merge requests and branches sidebars**: the repo's open MRs (via `gh`/`glab`) and your local branches, each opening a detail panel with title, branches, commits and changed files.
- **Preview**: the detail panel shows commits, changed files with +/- and a per-file diff, computed by git alone — no agent, no tokens.
- **Run review / Run dual review** from that panel: the review runs in a disposable `git worktree` (removed afterwards, success or failure), archives into the main repo's `.codesema/reviews/` and streams into the same live UI. One review at a time; the sidebar marks which MR or branch is running.
- **Repo settings**: edit `.codesema/RULES.md` and toggle auto-sync without leaving the page.

## Privacy

Everything runs on your machine. The MR diff, the prompt and the review are written under `.codesema/` and never leave your computer: the review itself is produced by the agent CLI you run locally, not by a codesema.com service.

Two things do talk to codesema.com, both gated. The first is `codesema sync`: that command uploads the review record (**including the diff**) to a codesema.com workspace, and only after you confirm on first run. After a successful sync it offers, once, to also push every future completed review automatically; nothing is pushed automatically unless you accept, and the `codesema config` menu turns it on or off anytime. Your absolute local repo path is stripped from the payload; only the review, diff, commit subjects and the origin remote URL are sent. `codesema sync delete` erases everything.

The second only exists once a workspace is linked: `codesema review` then asks that workspace for the repo's server context (conventions, learned rules, facts) and hands it to the agent alongside the diff. It is a read-only `GET`, authenticated with the stored workspace credentials, sending only the `origin` remote URL to resolve the repo — no diff, no code. Without stored credentials or an `origin` remote there is no request at all, and any failure (offline, unlinked workspace, malformed answer) silently degrades to no context: the review runs unchanged. `.codesema/RULES.md` stays local and always wins.

Before uploading, sync scans the diff for anything that looks like a committed secret (dotenv files, private keys, and AWS/GitHub/Slack/Google/Stripe/OpenAI/Anthropic credentials) and refuses to send it. Fix the diff, or pass `--force` once you have checked.

The review subprocess is locked down. The prompt already contains everything the agent needs (branch names, commit subjects, changed files, the diff), so `codesema review` runs the known agent CLIs with their tools switched off: `claude` gets `--tools "" --strict-mcp-config --setting-sources user` (no tools, no MCP servers, the repo's own `.claude/` settings ignored) and `codex` gets `--sandbox read-only --ask-for-approval never` with `AGENTS.md` loading disabled. Known agents also receive a minimal environment — `PATH`, `HOME`, locale, proxy settings and the provider's own variables — so your other credentials and tokens never reach the subprocess. Flags you set yourself and custom agent commands are left untouched, and "Run fixes" intentionally keeps the edit tools it needs.

Workspace tasks are the opposite case — they exist to edit code — so they are contained instead: in a container when one is available, and otherwise on the host with `--strict-mcp-config --setting-sources user`, so a turn that writes a `.claude/settings.json` or `.mcp.json` into its own worktree cannot have it loaded by the next turn. A custom agent command gets none of this and says so at startup.

## Requirements

- Node.js ≥ 20 and `git`
- An AI agent CLI: `claude` (Claude Code), `codex` (OpenAI) and `gemini` (Google) are auto-detected; anything else works via the "Custom command" wizard option or `--agent '<cmd>'` (e.g. `--agent 'opencode run "$(cat)"'`)
- Optional: `glab` or `gh` on the PATH, to auto-detect the target branch from the open MR/PR (and to list MRs and ship from the workspace)
- Optional: `docker` or `podman`, for the workspace's sandboxed checks and per-task container isolation (without one, checks report they cannot run and tasks fall back to the host hardening)

## Configuration

```bash
npx -y codesema config
```

Interactive: language → agent → model → effort, then where to save. Two levels, field by field:

| Level  | File                             | When                                    |
| ------ | -------------------------------- | --------------------------------------- |
| Global | `~/.config/codesema/config.json` | Your default, every repo (onboarding)   |
| Repo   | `.codesema/config.json`          | Team/project override, wins over global |

CLI flags always win over both. `target`, `port`, `timeout` and `language` can also be set in either file.

### Workspace keys

| Key                       | File           | Effect                                                                                                                |
| ------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| `maxParallelTasks`        | global or repo | Tasks running at once, **across all projects** (default `3`); the rest queue FIFO.                                    |
| `isolation`               | global or repo | `auto` (default), `container` (required, a task refuses to start without it) or `policy` (always run on the host).    |
| `isolationAllowedDomains` | global or repo | Domains the caged agent may reach (default `api.anthropic.com`, `platform.claude.com`); max 32, plain hostnames only. |
| `checks`                  | repo only      | `{ image, install, commands, network, timeoutSeconds }` — replaces the automatic detection of the sandboxed checks.   |

`isolation` and `checks` are repo-settable on purpose: the container and the checks are properties of the project, and a repo can only narrow what the agent reaches, never widen its rights on your machine. Sync fields stay global-only.

### Language

Onboarding starts with a language question, stored as `language` (ISO 639-1: `en` or `fr`). It drives the CLI output, the web UI and the language the agent writes the review in. Without it, the interface stays in English and the review follows the language of the commit messages.

### Update check

Every command checks the npm registry once at startup (a read-only `dist-tags` lookup, nothing about you or your code is sent). When a newer version exists, codesema says so and asks whether to upgrade now; accept and it runs the matching global install command (npm, pnpm, yarn or bun, detected from where codesema is installed), refuse and the current run continues unchanged. Interactive terminals only. Set `CODESEMA_NO_UPDATE_CHECK=1` to disable it; it is also skipped when stdout is not a terminal.

### Repo-provided agent approval

An `agent` command coming from a repo's `.codesema/config.json` runs on your machine, in your shell. codesema asks for a one-time approval per repo (remembered in your global config) and asks again whenever the command changes. Non-interactive runs refuse an unapproved repo agent: approve it once in a terminal, or pass `--agent '<cmd>'` explicitly.

## Commands

```bash
codesema                       # interactive terminal: opens the agentic workspace (web UI)
codesema workspace             # same, explicit (accepts --port <n> and --no-open)
codesema menu                  # navigable menu (workspace, review, show, sync, link, config)
codesema review --branch feat/x --target develop   # non-interactive, CI-friendly
codesema review --dual            # two reviewers in parallel + a judge (see above)
codesema review --fail-on major   # CI gate: exit 2 if a finding is >= major (or use 'request_changes')
codesema config                # change language / agent / model / effort
codesema prep                  # only write .codesema/input.json for your own agent flow
codesema show                  # only display .codesema/review.json (or the last archived review)
codesema export --out review.md   # Markdown export (--out - for stdout)
codesema sync                  # push the latest review to a free anonymous codesema.com workspace
codesema sync delete           # erase all synced data and local credentials
codesema link <code>           # attach the workspace to a codesema.com account via a pairing code
```

Sync is opt-in and free; your review record (including the diff) is only sent when you run `codesema sync`, or automatically after a review if you enabled auto-sync (offered after the first sync, toggleable in `codesema config`). Workspace credentials are stored in the global config file (`~/.config/codesema/config.json`), written with owner-only permissions (`0600`); sync settings in a repo's `.codesema/config.json` are ignored.

`codesema --help` lists every flag.

## Agent skill (optional)

To drive the flow from inside your agent instead of the CLI, install the bundled skill (plain agent-agnostic markdown):

```bash
# Claude Code, from a clone of this repo (global install):
cp -r skills/codesema ~/.claude/skills/codesema
```

Then, in any repo, on your feature branch, ask your agent: `/codesema`. It uses `codesema prep` + `codesema show` underneath.

## Customize

- `.codesema/PROMPT.md`: your team's review instructions, merged into the agent prompt.
- `.codesema/RULES.md`: your team's review rules, one per line, hunted first by the reviewer. Put the highest-yield rules on top; each line may extend the rule with optional `|`-separated segments the reviewer knows how to use: `(category) rule | Scope: where in the repo it applies | Where to look: files, imports or code shapes to inspect | Bad: literal rejected form | Good: literal expected form | Exceptions: tolerated legacy, never flagged`. Rules are cited as `[C1]`, `[C2]`, ... (file order) in convention findings. Telling the reviewer _where to look_ is what makes a rule catch violations.
- `.codesema-ignore`: glob patterns excluded from the diff (lockfiles, minified files and sourcemaps are excluded by default).

## Troubleshooting

- `could not detect the target branch`: no MR/PR found and no develop/main/master to compare against; pass `--target <branch>`.
- `empty diff … nothing to review`: codesema reviews **committed** work, commit your changes first.
- `agent timed out`: raise the budget with `--timeout <seconds>` (default 900).
- `no supported agent CLI found`: install `claude`, or pick "Custom command" in `codesema config` (the command receives the prompt on stdin and must print the review JSON on stdout).
- Port busy: codesema scans 20 ports from the preferred one (default 4400); pick another base with `--port <n>`.
- The web page says the review failed: the terminal has the full error; the server stays up so you can read both.

## Environment variables

| Variable                   | Effect                                                                          |
| -------------------------- | ------------------------------------------------------------------------------- |
| `CODESEMA_CONFIG_DIR`      | Override the global config directory (default `~/.config/codesema`).            |
| `CODESEMA_NO_UPDATE_CHECK` | Set to `1` to skip the startup npm version check (also skipped when not a TTY). |
| `CODESEMA_SYNC_URL`        | Point `sync`/`link` at a different codesema.com host (self-hosted or staging).  |

## Files

| Path                                | Contents                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `~/.config/codesema/config.json`    | Global config (language, agent, model, effort, sync credentials), mode `0600`. |
| `~/.config/codesema/projects.json`  | Global registry of workspace projects (id → git repo root).                    |
| `~/.config/codesema/workspace.lock` | Guards against two workspace processes on the same machine.                    |
| `.codesema/config.json`             | Repo config, overrides the global one (also holds `checks`).                   |
| `.codesema/input.json`              | The prepared MR diff handed to the agent (`prep`).                             |
| `.codesema/review.json`             | The latest review written by the agent.                                        |
| `.codesema/reviews/`                | Archived reviews (5 kept per branch, used for incremental re-review).          |
| `.codesema/agent-output.txt`        | Raw agent output, written only when it held no parseable JSON review.          |
| `.codesema/PROMPT.md`               | Your team's extra review instructions, merged into the prompt.                 |
| `.codesema/RULES.md`                | Your team's review rules (one `[Cn]` grid line each), hunted first.            |
| `.codesema/tasks/<id>/task.json`    | One workspace task record (status, branch, turns, isolation mode).             |
| `.codesema/tasks/<id>/events.jsonl` | That task's append-only event journal (one JSON line per event).               |
| `.codesema/tasks/<id>/checks.json`  | That task's latest sandboxed checks run (per-command status and output tail).  |
| `.codesema/worktrees/<id>/`         | One isolated git worktree per workspace task.                                  |
| `.codesema-ignore`                  | Glob patterns excluded from the diff.                                          |

## Exit codes

| Code  | Meaning                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------ |
| `0`   | Success (review completed; with `--fail-on`, nothing tripped the gate).                          |
| `1`   | Error (bad invocation, agent failure, unusable output, or a blocked secret sync).                |
| `2`   | `review --fail-on <level>` gate tripped (a finding at or above the level, or changes requested). |
| `130` | Interrupted with Ctrl-C.                                                                         |

## Development

```bash
bun install
bun run build        # builds the web UI, embeds it in the CLI, builds the CLI
node packages/cli/dist/index.mjs        # full interactive flow
node packages/cli/dist/index.mjs show
```

Monorepo layout (`codesema-tools`): `packages/cli` (Node CLI: review/prep/show, native `node:http` ephemeral server + SSE, zero runtime dependencies), `packages/contract` (`@codesema/contract`: review types, sanitizers and grounding, bundled into the CLI and published for codesema.com), `packages/web` (Vue 3 + Vite SPA embedded in the CLI tarball), `skills/codesema` (the agent skill).

## License

MIT
