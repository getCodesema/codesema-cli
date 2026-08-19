# codesema

[![npm version](https://img.shields.io/npm/v/codesema)](https://www.npmjs.com/package/codesema)
[![npm downloads](https://img.shields.io/npm/dm/codesema)](https://www.npmjs.com/package/codesema)
[![node](https://img.shields.io/node/v/codesema)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/codesema)](LICENSE)

**Review your merge requests locally, with the AI agent you already use.**

Run one command on a branch: `codesema` computes the MR diff, hands it to **your** AI agent (Claude Code, Codex, Gemini, Grok, …), and opens a local web UI where the review appears live. You then read it like a guided tour: what to look at first, step by step, with findings pinned to the diff.

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

**Your uncommitted work stays yours.** A conversation starts from a **committed point** — the base branch it forks, or the tip of the branch it works on — recorded as its `baseline`. Your working tree is read, never touched: nothing is stashed, moved, copied or committed, and your uncommitted changes do **not** travel into the task's worktree. If you had any when the task started, the conversation says so on its first turn (how many files, and which commit the agent is starting from) rather than letting you assume otherwise. The end-of-turn review then measures `baseline..HEAD`: exactly what the agent did, and — on a conversation working on an existing branch — none of the commits that predate it. The anchor is set once, at the **first** materialization — the one where the conversation still has no worktree, so nothing can yet be on its branch — and rebuilding a worktree never moves it: a conversation whose worktree disappeared takes its **own branch** back — that is where its commits are — so the turns already committed stay inside the measured range. If that branch cannot be had (someone checked it out elsewhere, or it is gone), the conversation is re-forked on a new branch; it then says so out loud — naming the branch it left behind, and how many commits stay there when that branch still exists — and re-anchors on the new fork point, otherwise the base's own commits would be credited to the agent. The reverse is stated too: if somebody pushed to the conversation's branch while its worktree was gone, the rebuild counts those commits and names them, because they land _after_ the anchor and would otherwise be measured — and shipped — as the agent's own work.

**One workspace drives several repos.** Launched from inside a git repository, that repo is auto-registered as a project and becomes the current one; launched from anywhere else, the workspace opens on the projects you already registered (add more from the UI, by path, or pick one of the repos it finds next to your launch directory). The registry is a small global file (`~/.config/codesema/projects.json`) mapping stable ids to repo roots — each repo keeps its own tasks and worktrees under its own `.codesema/`, so removing a project only unregisters it and never touches the repo. Concurrency follows one rule: **one active task per repo**. Projects advance side by side (three registered repos can each be working), while a second conversation on the same repo waits its turn in that repo's own queue — `<repo>/.codesema/queue.json`, ordered, on disk, so it survives a Ctrl-C and picks back up at the next boot. Each waiting card shows its rank in the line, refreshed as the line moves. A repo stays busy until the turn's **automatic review** has given its verdict, not just until the agent stops talking: the review is another agent on the same branch, so the next conversation starts after `review_ok`/`review_ko`. The rule counts **tasks, not machine load**: the checks container of a finished turn runs outside it, and so does every other repo.

**The UI is a work queue, not a dashboard.** The sidebar is a tree, per project, of the open merge requests (via `gh`/`glab`) and the active branches, with the conversations working on them nested underneath — derived `codesema/task-*` branches stay out of it, since the conversation already carries them. The middle column groups every conversation into **Needs you** (a question to answer, a blocked review, a conversation stopped mid-turn), **In progress**, **Ready to ship** and a **Done** pile; the right side is a focus deck of up to **3** conversations side by side, pinnable (📌) so opening a new one replaces the loose column instead of the ones you kept. Each conversation has **Conversation**, **Diff** and **Checks** tabs, quick-reply buttons extracted from the agent's own question, and a reply field that parks your message while the agent runs and sends it the moment the turn ends.

A task moves through explicit statuses: `queued` → `running`, then `waiting_for_you` when the agent ends its turn on a question (reply to start the next turn), or — when a turn finishes with changes — `reviewing`: every finished turn passes an **automatic local review** (the same review engine as `codesema review`, on the task's branch) before anything leaves your machine, landing on `review_ok` or `review_ko`. **Ship** then pushes the branch and opens the MR via `gh`/`glab` (status `shipped`); per-task **auto-ship** chains it without a click on a green review. `failed` and `interrupted` round out the lifecycle: a task whose turn was cut short (Ctrl-C, crash, **Stop**) keeps its worktree and its session, and sits in **Needs you** with a **Resume** button that restarts the very turn it died on — same instruction, no extra turn, the Claude session picked back up with `--resume` when there is one. Nothing that already ran restarts on its own: an agent that writes code and commits does not come back to life just because you started the workspace. A task that was only _waiting_ is untouched by a shutdown — it stays `queued`, keeps its place in the repo's queue, and the next boot simply resumes the line. When the last turn had already answered there is nothing to redo, so the conversation says so instead of offering a button. A task whose worktree disappeared behind codesema's back is rebuilt rather than refused: the rebuild checks the conversation's **own branch** back out, so its commits, its anchor and its review range are all where they were. Only a branch that is gone too — or taken by another checkout — leaves nothing to come back to, and that case is said out loud rather than papered over.

**Checks run in a sandbox.** Alongside the review, every turn that commits runs the repo's typecheck, tests and lint in an ephemeral `docker`/`podman` container mounted on the task's worktree, with `--network none` and cpu/memory caps. The plan comes from your `checks` key in `.codesema/config.json` if you wrote one, otherwise from what the repo already declares — lefthook's `pre-push`/`pre-commit` hooks or its CI workflow jobs, filtered through a strict command allowlist — otherwise from the lockfile and the `typecheck`/`test`/`lint` scripts of `package.json`. If none of that fits, the Checks tab can ask your agent to _propose_ a configuration: it runs read-only on files codesema hands it, its JSON answer is sanitized, and nothing is written until you click Apply. Checks never block a task; they are a second opinion next to the review, visible in the tab and on the ready-to-ship card.

**Each task can run in its own container.** With `docker` or `podman` installed, the workspace cages every task by default: the turn runs inside a container built from your `.devcontainer` (or `node:26`), with the worktree as its only writable host mount, the repo's git directory mounted read-only so the agent can read its diff, log and status without being able to rewrite a single ref, its own `$HOME` volume so the agent session survives across turns, and an internal network whose only exit is a proxy allowing the agent's own API domains. Inside that box the agent keeps its full tool set — the container is the boundary, not a permission prompt. Commits stay on the host, so your git credentials never enter it, and the review and the checks remain independent counter-verification. The mode is decided once at startup and printed: `isolation` set to `container` makes the cage mandatory (a task refuses to start without it), `policy` always runs on your machine with the host hardening, and `auto` (the default) falls back to `policy` while telling you why. Only `claude` is caged today; the allowed domains are yours to change with `isolationAllowedDomains`.

There are no named agent roles: every task gets the same anonymous dev agent with a neutral prompt — you define your workflow in the tasks you write, the tool stays out of the way.

Tasks live as long as the process runs (no detached daemon). The first Ctrl-C shuts down cleanly — agents stopped, the turns that were in flight persisted as `interrupted`, worktrees kept for resume, and a review already under way stopped like any other agent (its conversation lands in **Needs you** as `interrupted`, never on a verdict nobody produced) — and a second one force-quits. A shutdown that takes more than a moment says on the terminal what it is still waiting for, and it never waits forever: past 30 seconds it stops waiting, says which conversations it left as they stand on disk, and exits. The next start names those on the terminal and shows them in **Needs you**, one click away from resuming; the tasks that were merely _waiting_ stay `queued`, and the queue restarts as the last, announced step of the boot — once the server is listening and Ctrl-C is armed, so a resumed turn can be watched and stopped. Coming from a version older than the queue file, a `queued` task has no queue to prove it was ever scheduled: it becomes `interrupted` and waits for you in **Needs you** instead of an agent starting by surprise on your first boot. Task state (record, append-only event journal, latest checks run) is stored under `.codesema/tasks/<id>/` of the task's repo, and the waiting line in `.codesema/queue.json` next to it.

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

## In the review UI

Beyond the review itself, the page opened by `codesema review` drives the whole loop:

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

The review subprocess is locked down. The prompt already contains everything the agent needs (branch names, commit subjects, changed files, the diff), so `codesema review` runs the known agent CLIs with their tools switched off: `claude` gets `--tools "" --strict-mcp-config --setting-sources user` (no tools, no MCP servers, the repo's own `.claude/` settings ignored), `codex` gets `--sandbox read-only --ask-for-approval never` with `AGENTS.md` loading disabled, and `grok` gets `--deny '*'` — a permission rule rather than a tool list, because an empty or unknown `--tools` value leaves every tool reachable while the rule refuses the shell and the file tools alike. Grok still reads the repo's `AGENTS.md`/`CLAUDE.md` and offers no flag to stop it, so there the hardening buys the absence of execution, not the absence of injected instructions. Known agents also receive a minimal environment — `PATH`, `HOME`, locale, proxy settings and the provider's own variables — so your other credentials and tokens never reach the subprocess. Flags you set yourself and custom agent commands are left untouched, and "Run fixes" intentionally keeps the edit tools it needs.

Workspace tasks are the opposite case — they exist to edit code — so they are contained instead: in a container when one is available, and otherwise on the host with `--strict-mcp-config --setting-sources user`, so a turn that writes a `.claude/settings.json` or `.mcp.json` into its own worktree cannot have it loaded by the next turn. A custom agent command gets none of this and says so at startup.

## Requirements

- Node.js ≥ 20 and `git`
- An AI agent CLI: `claude` (Claude Code), `codex` (OpenAI), `gemini` (Google) and `grok` (xAI) are auto-detected; anything else works via the "Custom command" wizard option or `--agent '<cmd>'` (e.g. `--agent 'opencode run "$(cat)"'`). A CLI that cannot read its prompt from stdin at all takes it as a **file**: put `{promptFile}` where the path goes and codesema writes the prompt to a private temp file, substitutes its quoted path and deletes it when the run ends — that is how `grok` is run (`grok --prompt-file {promptFile}`)
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

| Key                         | File           | Effect                                                                                                                                                                                                                                                                                     |
| --------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxParallelTasks`          | global or repo | **Currently inert**: the workspace runs one active task per repo and queues the rest in `<repo>/.codesema/queue.json`, whatever this says. Still read and still parsed, pending its rework into a machine-load cap — and a boot that finds the key set says out loud that it does nothing. |
| `isolation`                 | global or repo | `auto` (default), `container` (required, a task refuses to start without it) or `policy` (always run on the host).                                                                                                                                                                         |
| `isolationAllowedDomains`   | global or repo | Domains the caged agent may reach (default `api.anthropic.com`, `platform.claude.com`); max 32, plain hostnames only.                                                                                                                                                                      |
| `checks`                    | repo only      | `{ image, install, commands, network, timeoutSeconds }` — replaces the automatic detection of the sandboxed checks.                                                                                                                                                                        |
| `watchdogInactivitySeconds` | workspace-wide | Silence, **tools aside**, past which a task's agent is considered dead and killed (default `1800`, 30 min).                                                                                                                                                                                |
| `watchdogToolBudgetSeconds` | workspace-wide | How long a tool may stay in flight before the agent is considered stuck (default `7200`, 2 h). The inactivity count is suspended while a tool runs.                                                                                                                                        |
| `watchdogHeartbeatSeconds`  | workspace-wide | Period of the liveness beat that tells a long task from a dead one (default `30`).                                                                                                                                                                                                         |

`isolation` and `checks` are repo-settable on purpose: the container and the checks are properties of the project, and a repo can only narrow what the agent reaches, never widen its rights on your machine. Sync fields stay global-only.

The three `watchdog*` keys are **workspace-wide today**, and that is a limitation, not a design: they are read once at startup — from your global config, or from the `.codesema/config.json` of the repository you launched the workspace in — and the same three budgets then apply to every registered project. A second project's own config is not consulted for them. Per-project resolution is coming with the per-project configuration work; until then, set them globally (`~/.config/codesema/config.json`) unless you drive a single repository.

The watchdog measures **life, not duration**: the last frame the agent's stream produced, and whether a tool is still out. It watches both paths a turn can take — on the host and inside the container cage. `timeout` stays as the last-resort absolute ceiling under it, never as the thing that detects a dead task; on task turns that ceiling is automatically raised above the watchdog budgets, because a ceiling below them would fire first and cancel the watchdog outright (it is a config key for the workspace — the `--timeout` **flag** applies to `codesema review`, which `codesema workspace` does not accept).

A task the watchdog kills is left **`interrupted`, not `failed`**: `inactivity_timeout` says the _run_ has to change, not the work on the branch, so the conversation stays resumable — its worktree, its branch and its commits are kept, and **Resume** re-runs the very turn that was cut. While a turn runs, its record carries a `heartbeat_at` stamp refreshed every heartbeat period: that is what tells a task deep inside a forty-minute tool call from one whose agent has died.

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
codesema link [code]           # attach to a codesema.com account (no code: confirm in the browser)
```

Sync is opt-in and free; your review record (including the diff) is only sent when you run `codesema sync`, or automatically after a review if you enabled auto-sync (offered after the first sync, toggleable in `codesema config`). Workspace credentials are stored in the global config file (`~/.config/codesema/config.json`), written with owner-only permissions (`0600`); sync settings in a repo's `.codesema/config.json` are ignored.

`codesema --help` lists every flag.

### The `--fail-on` gate

`codesema review --fail-on <level>` runs the review once and exits `2` as soon as a finding sits at or above `<level>` (`critical`, `major`, `minor`, `info`) or when the reviewer requests changes — see [Exit codes](#exit-codes).

Because that gate is meant to run unattended, `--fail-on` **never opens the browser**, even from an interactive terminal and even without `--no-open`: the local web UI is served while the review runs and its URL is printed, but codesema does not open it for you, and the server shuts down as soon as the review ends instead of staying up. A run without `--fail-on` keeps its historical behaviour (browser opened unless `--no-open`, server left up).

`--fail-on` is also a review flag: `codesema --fail-on major` in a terminal runs the gated review, it does not open the workspace.

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
- `agent timed out`: the run hit its absolute ceiling — raise it with `--timeout <seconds>` on `codesema review` (default 900), or with the `timeout` config key for the workspace.
- `agent said nothing for … min` / `agent tool has been running for … min`: the semantic watchdog stopped a task it considers dead or stuck. The conversation stays `interrupted` and resumable, worktree intact; raise `watchdogInactivitySeconds` / `watchdogToolBudgetSeconds` if your agent legitimately goes quiet that long.
- `no supported agent CLI found`: install `claude`, or pick "Custom command" in `codesema config` (the command receives the prompt on stdin — or on a file path, if it names `{promptFile}` — and must print the review JSON on stdout).
- Port busy: codesema scans 20 ports from the preferred one (default 4400); pick another base with `--port <n>`.
- The web page says the review failed: the terminal has the full error; the server stays up so you can read both.

## Environment variables

Nine variables change how the CLI behaves. Each row names the file that reads
it, under `packages/cli/src/`.

| Variable                   | Read in      | Effect                                                                                                                      |
| -------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `CODESEMA_CONFIG_DIR`      | `config.ts`  | Override the global config directory (default `~/.config/codesema`).                                                        |
| `XDG_CONFIG_HOME`          | `config.ts`  | Base of that default directory when `CODESEMA_CONFIG_DIR` is unset: `$XDG_CONFIG_HOME/codesema`, else `~/.config/codesema`. |
| `CODESEMA_NO_UPDATE_CHECK` | `version.ts` | Any non-empty value skips the startup npm version check (also skipped when stdout is not a TTY).                            |
| `CODESEMA_SYNC_URL`        | `sync.ts`    | Point `sync`/`link` at a different codesema.com host (self-hosted or staging); wins over the stored `syncUrl`.              |
| `NO_COLOR`                 | `ui.ts`      | Any non-empty value turns the coloured terminal output off.                                                                 |
| `TERM`                     | `ui.ts`      | `dumb` turns the coloured terminal output off.                                                                              |
| `LC_ALL`                   | `wizard.ts`  | Preselects the onboarding language: a locale starting with `fr` preselects French, anything else English.                   |
| `LC_MESSAGES`              | `wizard.ts`  | Same, consulted when `LC_ALL` is unset.                                                                                     |
| `LANG`                     | `wizard.ts`  | Same, consulted when `LC_ALL` and `LC_MESSAGES` are unset.                                                                  |

The three locale variables only preselect an answer in the wizard: the choice
you confirm is stored as `language` in the config and wins from then on.

### What the subprocesses inherit

These are not knobs to turn: they are what codesema keeps in — and strips from —
the environment of the processes it spawns.

- **A known review agent gets a minimal environment.** `agentEnv` (`agent.ts`)
  keeps the 27 names of `BASE_ENV_VARS` — `PATH`, `HOME`, `USER`, `LOGNAME`,
  `SHELL`, `TERM`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TZ`, the 8 proxy
  variables, the 4 `XDG_*` ones and the 4 CA-bundle ones — plus the provider's
  own prefixes (`ANTHROPIC_`/`CLAUDE_`, `OPENAI_`/`CODEX_`,
  `GEMINI_`/`GOOGLE_`, `XAI_`/`GROK_`), widened to `AWS_` or `GOOGLE_`/`GCP_` only when
  `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` is set. Everything else
  in your environment — cloud keys, tokens, database URLs — never reaches the
  subprocess. A custom agent command inherits the full environment (its needs
  are unknowable, and you chose it explicitly), and so does Windows, where
  narrowing the environment can break the spawn itself.
- **A caged task agent gets 6 provider variables, by name.**
  `CAGE_FORWARDED_ENV` (`task-isolation.ts`) forwards
  `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL`, and
  only those. They are passed as `-e NAME`, never as `-e NAME=value`: a value in
  argv would be readable in `ps` on the whole host. `CLAUDE_CODE_OAUTH_TOKEN`
  also decides how the cage bootstraps its credentials — when it is set, nothing
  is copied out of `~/.claude`.
- **Git subprocesses lose the repo-location variables.** `subprocessEnv`
  (`git.ts`) strips the 8 variables git sets on the hooks it invokes —
  `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_COMMON_DIR`, `GIT_PREFIX`, `GIT_ALTERNATE_OBJECT_DIRECTORIES` and
  `GIT_QUARANTINE_PATH` — so codesema invoked from inside a hook still reads the
  repo it was pointed at, not the one that set them. This is deliberately not a
  blanket `GIT_*`: `GIT_SSH_COMMAND`, `GIT_AUTHOR_*`/`GIT_COMMITTER_*` and
  `GIT_CONFIG_GLOBAL` are legitimate settings and reach git unchanged.

## Files

| Path                                     | Contents                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `~/.config/codesema/config.json`         | Global config (language, agent, model, effort, sync credentials), mode `0600`.                |
| `~/.config/codesema/projects.json`       | Global registry of workspace projects (id → git repo root).                                   |
| `~/.config/codesema/trusted-agents.json` | Repo-provided `agent` commands you approved, one entry per repo root.                         |
| `~/.config/codesema/workspace.lock`      | Guards against two workspace processes sharing this config directory.                         |
| `.codesema/config.json`                  | Repo config, overrides the global one (also holds `checks`).                                  |
| `.codesema/.gitignore`                   | Written on first use, contains `*`: everything codesema writes stays out of your repo's git.  |
| `.codesema/input.json`                   | The prepared MR diff handed to the agent (`prep`).                                            |
| `.codesema/review.json`                  | The latest review written by the agent.                                                       |
| `.codesema/review.md`                    | Default output of `codesema export` (`--out <path>` to change, `--out -` for stdout).         |
| `.codesema/reviews/`                     | Archived reviews (20 kept per branch, used for incremental re-review).                        |
| `.codesema/agent-output.txt`             | Raw agent output, written only when it held no parseable JSON review.                         |
| `.codesema/PROMPT.md`                    | Your team's extra review instructions, merged into the prompt.                                |
| `.codesema/RULES.md`                     | Your team's review rules (one `[Cn]` grid line each), hunted first.                           |
| `.codesema/tasks/<id>/task.json`         | One workspace task record (status, branch, turns, isolation mode).                            |
| `.codesema/tasks/<id>/events.jsonl`      | That task's append-only event journal (one JSON line per event).                              |
| `.codesema/tasks/<id>/checks.json`       | That task's latest sandboxed checks run (per-command status and output tail).                 |
| `.codesema/queue.json`                   | That repo's task queue: the ids waiting their turn, in order, with when they joined the line. |
| `.codesema/queue.json.corrupt`           | The last unreadable `queue.json`, kept aside before the queue was rebuilt from the records.   |
| `.codesema/worktrees/<id>/`              | One isolated git worktree per workspace task.                                                 |
| `.codesema/worktrees/.lock`              | Serializes worktree creation/removal on this repo (self-healed when its holder is gone).      |
| `.codesema-ignore`                       | Glob patterns excluded from the diff.                                                         |

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
