# codesema

[![npm version](https://img.shields.io/npm/v/codesema)](https://www.npmjs.com/package/codesema)
[![npm downloads](https://img.shields.io/npm/dm/codesema)](https://www.npmjs.com/package/codesema)
[![node](https://img.shields.io/node/v/codesema)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/codesema)](LICENSE)

**Local merge request review and an agentic workspace, driven by the AI agent CLI you already use.**

codesema computes the diff of a branch, hands it to your agent CLI (Claude Code, Codex, Gemini, Grok, OpenCode), and opens a local web page where the review appears while it is being written. The same web UI can also give that agent work to do: each task runs in its own git worktree and branch, gets reviewed automatically when it finishes, and can be pushed as a merge request.

Everything runs on your machine. There is no account to create and no API key to provide: the review is produced by the agent CLI you already pay for. The npm package has zero runtime dependencies and is shipped unminified, so you can read the code that reads your diff.

Website: [codesema.com](https://codesema.com) · npm: [`codesema`](https://www.npmjs.com/package/codesema)

## Quick start

```bash
npx -y codesema            # opens the agentic workspace (web UI)
npx -y codesema review     # reviews a local branch
```

On the very first run, a short wizard asks for the language, the agent CLI (auto-detected on your `PATH`), the model and the reasoning effort. The answers are saved globally and never asked again; `codesema config` changes them.

## Reviewing a branch

`codesema review` picks a branch (interactive list, or `--branch`), detects the target branch, computes the diff and starts the agent. The web UI opens right away and fills in as the review is produced: diff stats first, then verdict, summary and findings.

The review is a guided reading of the merge request: an ordered walkthrough with a risk, a take and a check per step, findings typed by category (`security`, `perf`, `convention`, `design`, `praise`, `why`) and by severity (`critical`, `major`, `minor`, `info`), and a diff viewer with inline notes.

Running the review again on the same branch updates the previous one with the diff since then. `--full` reviews from scratch.

From the page you can also:

- work in **focus mode**: actionable findings on the left with checkboxes, the selected note and its code excerpt on the right, and a "copy selection for agent" button;
- **run fixes**: the configured agent applies the findings you selected to your working tree;
- browse the repository's open merge requests and local branches, with commits, changed files and per-file diffs computed by git alone;
- start a review from that panel, in a disposable worktree, one at a time;
- edit `.codesema/RULES.md` and toggle auto-sync.

### Dual review

`codesema review --dual` runs two reviewers in parallel with the same agent under two angles: one reads the merge request for the big picture and writes the walkthrough, the other hunts for bugs, regressions, security issues and edge cases and reports findings only. A judge, on the same provider's mid-tier model, then keeps, merges or rejects each finding; security findings are never rejected. Findings raised by both reviewers carry a consensus badge. It costs roughly two reviews plus a cheap judge pass.

### CI gate

`codesema review --fail-on <level>` runs the review once and exits `2` as soon as a finding sits at or above `<level>` (`critical`, `major`, `minor`, `info`), or when the reviewer requests changes (`--fail-on request_changes`). With this flag the browser is never opened, and the server stops as soon as the review ends. The branch picker is also skipped whenever stdin is not a terminal.

## Agentic workspace

`codesema` (or `codesema workspace`) opens a local web UI where you describe tasks in plain language and your agent does them.

**One task, one branch, one worktree.** A task either forks a fresh branch from a base or works on an existing branch. It runs in `.codesema/worktrees/<task-id>/`, so your own checkout and your uncommitted changes are never touched. The agent does not commit: codesema commits the worktree at the end of each turn.

**Several repositories, one workspace.** Launched inside a git repository, that repository is registered as a project. More can be added from the UI. Projects advance side by side, but a repository runs one active task at a time; the others wait in that repository's own queue (`.codesema/queue.json`), which survives a restart. Total machine load is capped separately by `maxConcurrentAgents` (default 4).

**Every finished turn is reviewed.** A turn that produced commits goes through the same review engine as `codesema review`, on the task's branch, before anything leaves your machine. A blocked review triggers an automatic fix turn, re-reviewed, up to `maxAutoFixRounds` times (default 2). Past that the task waits for you and says which of the findings or the acceptance criteria still blocks it. Replying gives it a fresh budget.

**Checks run in a sandbox.** Alongside the review, typecheck, tests and lint run in an ephemeral `docker` or `podman` container mounted on the task's worktree, with `--network none` and cpu/memory caps. The plan comes from your `checks` key, otherwise from what the repository already declares (lefthook hooks, CI workflow jobs, filtered through a command allowlist), otherwise from the lockfile and the `typecheck`/`test`/`lint` scripts of `package.json`. Checks never block a task: they are a second opinion next to the review.

**Tasks can be caged.** With a container runtime available, a task runs inside a container built from your `.devcontainer` (or `node:26`): the worktree is the only writable host mount, the git directory is mounted read-only, and the only network exit is a proxy restricted to the agent's own API domains (`isolationAllowedDomains`). Commits stay on the host, so your git credentials never enter the container. `isolation` picks the mode: `auto` (default, falls back to host hardening and says why), `container` (mandatory) or `policy` (always on the host). `claude` and `opencode` are cageable today.

**Statuses.** A task moves through `queued`, `running`, `waiting_for_you` (the agent ended its turn on a question), `reviewing`, then `review_ok` or `review_ko`, then `shipped` once the branch is pushed and the merge request opened via `gh`/`glab`. `interrupted` covers a turn cut short by Ctrl-C, a crash or the Stop button: the worktree and the agent session are kept, and a Resume button restarts that exact turn. Nothing restarts by itself at the next boot.

**Merging.** The workspace does not merge on its own unless you ask it to: `mergePolicy` defaults to `human`. Task state lives under `.codesema/tasks/<id>/` in the repository it belongs to.

## Runner mode

A runner is a background process that connects the workspace to the codesema hub (codesema.com, or your own instance) and works hands-off through its backlog of tickets for a repository: the hub publishes tickets, the runner codes them, ships them, reviews them and reports every transition back.

```bash
codesema runner connect --url http://localhost:3000 --token csk_<workspaceId>.<secret>
codesema runner status                            # hub, account, this repo, ready ticket count
codesema runner ticket --issue 42                 # draft and publish a ticket from a forge issue
codesema runner ticket --title "…" --prompt "…"   # same, from a free-form prompt
codesema workspace --runner                       # workspace plus the runner daemon, same process
codesema runner serve [--detach]                  # alias for the line above
codesema runner stop                              # stops a detached daemon for this repo
```

A runner and a sync workspace are the same account: `runner connect` stores its token next to the `codesema sync` credentials. `runner ticket` runs the configured agent once, outside the workspace, to write the ticket body in the grammar the hub requires; a body the lint rejects gets one retry with the lint's reasons folded into the prompt.

With `--runner`, the workspace polls the hub in the background, drafts the ticket requests waiting on this repository and, when no task is already running here, claims the next published ticket and hands it to the same task manager the UI drives. Reports the hub could not receive are queued and replayed. Auto-merging a hub ticket's task once it ships clean is controlled by `runnerAutoMerge` (on by default), independently of `mergePolicy`.

## Working without a forge

Without an `origin` remote, without `gh`/`glab`, or offline, codesema keeps working and names what it cannot do. Creating and running a conversation, its turns, checks, review and diff need no forge. Binding an issue, posting a recap and merging are refused with a reason (`no-remote`, `no-cli`, `cli-error`, `offline`) rather than faked, and nothing is queued to be replayed later. A conversation already bound to a ticket carries on from the copy of the issue frozen when it was created.

## Requirements

- Node.js ≥ 20 and `git`.
- An agent CLI: `claude`, `codex`, `gemini`, `grok` and `opencode` are auto-detected. Anything else works through the wizard's custom command option or `--agent '<cmd>'`: it receives the prompt on stdin and must print the review JSON on stdout. A CLI that cannot read stdin takes the prompt as a file, by naming `{promptFile}` in its command (that is how `grok` is run).
- Optional: `gh` or `glab`, to detect the target branch from an open merge request, list merge requests and ship from the workspace.
- Optional: `docker` or `podman`, for sandboxed checks and per-task containers. Without one, checks report they cannot run and tasks fall back to host hardening.

## Commands

| Command                                                               | What it does                                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `codesema`                                                            | Opens the workspace in an interactive terminal; behaves like `review` otherwise    |
| `codesema workspace [--runner]`                                       | The workspace, explicitly                                                          |
| `codesema review [--branch] [--target] [--full] [--dual] [--fail-on]` | Reviews a local branch                                                             |
| `codesema menu`                                                       | Terminal menu: workspace, review, dual review, show, cloud (sync and link), config |
| `codesema config`                                                     | Language, agent, model, effort, auto-sync and the other settings                   |
| `codesema prep [--target]`                                            | Only writes `.codesema/input.json`, for your own agent flow                        |
| `codesema show [--review]`                                            | Only displays a review in the local web UI                                         |
| `codesema export [--review] [--out]`                                  | Exports the review as Markdown (`--out -` for stdout)                              |
| `codesema sync` / `codesema sync delete`                              | Pushes the latest review to a codesema.com workspace, or erases everything synced  |
| `codesema link [code]`                                                | Links this workspace to a codesema.com account                                     |
| `codesema runner <action>`                                            | See [Runner mode](#runner-mode)                                                    |

Shared flags: `--agent <cmd>`, `--port <n>` (default 4400, 20 ports scanned from there), `--timeout <s>` (default 900), `--no-open`, `--force` (sync), `-h`, `-v`. `codesema --help` lists them all.

## Configuration

Settings live in two files, and CLI flags win over both:

| Level      | File                             | Purpose                                  |
| ---------- | -------------------------------- | ---------------------------------------- |
| Global     | `~/.config/codesema/config.json` | Your defaults, every repository          |
| Repository | `.codesema/config.json`          | Team override, wins over the global file |

Some keys are global only: they govern the machine (its load, its disk) or give a consent (merging, spending turns), so a cloned repository cannot set them on your behalf. A repository file that does is ignored, and says so at startup.

| Key                                                        | Default                             | Scope           |
| ---------------------------------------------------------- | ----------------------------------- | --------------- |
| `agent`, `agentId`, `model`, `effort`                      | from the wizard                     | both            |
| `language`                                                 | asked once (`en`, `fr`)             | both            |
| `target`                                                   | auto-detected                       | both            |
| `port`                                                     | `4400`                              | both            |
| `timeout`                                                  | `900` seconds                       | both            |
| `reviewMode`                                               | `simple` (or `dual`)                | both            |
| `maxAutoFixRounds`                                         | `2`                                 | both            |
| `isolation`                                                | `auto` (`container`, `policy`)      | both            |
| `isolationAllowedDomains`                                  | the agent's own API domains         | both            |
| `forgeCycleLabels`                                         | `false`                             | both            |
| `checks`                                                   | inferred from the repository        | repository file |
| `watchdogInactivitySeconds`                                | `1800`                              | both            |
| `watchdogToolBudgetSeconds`                                | `7200`                              | both            |
| `watchdogHeartbeatSeconds`                                 | `30`                                | both            |
| `maxConcurrentAgents`                                      | `4`                                 | global only     |
| `taskRetentionCount`                                       | `20` finished tasks per project     | global only     |
| `maxTaskTurns`                                             | `30`                                | global only     |
| `mergePolicy`                                              | `human` (or `auto`)                 | global only     |
| `mergeStrategy`                                            | unset (`merge`, `squash`, `rebase`) | global only     |
| `deleteBranchAfterMerge`                                   | `false`                             | global only     |
| `allowMergeWithoutChecks`                                  | `false`                             | global only     |
| `runnerAutoMerge`                                          | `true`                              | global only     |
| `syncUrl`, `syncWorkspaceId`, `syncSecret`, `syncAutoPush` | unset                               | global only     |

`maxParallelTasks` is the former name of `maxConcurrentAgents`. It is still honoured, with a warning at startup.

Every setting is reachable from `codesema config`; none of them requires editing a file by hand.

### Per-repository files

- `.codesema/PROMPT.md`: extra review instructions, merged into the agent prompt.
- `.codesema/RULES.md`: your team's rules, one per line, hunted first by the reviewer and cited as `[C1]`, `[C2]` in convention findings. A line may carry optional `|`-separated segments: `(category) rule | Scope: … | Where to look: … | Bad: … | Good: … | Exceptions: …`. Telling the reviewer where to look is what makes a rule catch anything.
- `.codesema-ignore`: glob patterns excluded from the diff. Lockfiles, minified files and sourcemaps are excluded by default.

### Repo-provided agent commands

An `agent` command coming from a repository's `.codesema/config.json` runs in your shell. codesema asks for a one-time approval per repository, remembered globally, and asks again when the command changes. Non-interactive runs refuse an unapproved command; approve it once in a terminal, or pass `--agent` explicitly.

## What leaves your machine

The diff, the prompt and the review are written under `.codesema/` and stay there. The review itself is produced by your local agent CLI, not by a codesema.com service.

Two features talk to codesema.com, both opt-in:

- `codesema sync` uploads the review record, **including the diff**, to a codesema.com workspace, after you confirm on first run. It then offers, once, to push future reviews automatically. Your absolute repository path is stripped; only the review, the diff, commit subjects and the `origin` URL are sent. Before uploading, the diff is scanned for committed secrets (dotenv files, private keys, AWS/GitHub/Slack/Google/Stripe/OpenAI/Anthropic credentials) and the upload is refused if one is found (`--force` to override). `codesema sync delete` erases everything.
- Once a workspace is linked, `codesema review` fetches that repository's server context (conventions, learned rules, facts) and gives it to the agent. It is a read-only `GET` sending only the `origin` URL, and any failure degrades silently to no context. `.codesema/RULES.md` stays local and always wins.

The review subprocess is locked down, because the prompt already contains everything the agent needs: `claude` runs with no tools and no MCP servers, `codex` read-only with no approvals, `grok` with a deny-all permission rule, and `opencode` with an injected config denying every permission. Known agents also get a minimal environment (`PATH`, `HOME`, locale, proxies and the provider's own variables), so your other credentials never reach them. Custom agent commands and the "run fixes" flow keep what they need, by design.

Workspace tasks are the opposite case, since they exist to edit code: they are contained instead, in a container when one is available, otherwise on the host with the repository's own agent settings ignored.

## Files

| Path                                        | Contents                                                        |
| ------------------------------------------- | --------------------------------------------------------------- |
| `~/.config/codesema/config.json`            | Global config and sync credentials, mode `0600`                 |
| `~/.config/codesema/projects.json`          | Registered workspace projects (id to repository root)           |
| `~/.config/codesema/trusted-agents.json`    | Repo-provided agent commands you approved                       |
| `~/.config/codesema/workspace.lock`         | Guards against two workspaces sharing a config directory        |
| `.codesema/config.json`                     | Repository config, including `checks`                           |
| `.codesema/.gitignore`                      | Written on first use, contains `*`                              |
| `.codesema/input.json`                      | The prepared diff handed to the agent                           |
| `.codesema/review.json`                     | The latest review                                               |
| `.codesema/review.md`                       | Default output of `codesema export`                             |
| `.codesema/reviews/`                        | Archived reviews, 20 per branch, used for incremental re-review |
| `.codesema/agent-output.txt`                | Raw agent output, written only when it held no parseable review |
| `.codesema/PROMPT.md`, `.codesema/RULES.md` | Your prompt additions and review rules                          |
| `.codesema/tasks/<id>/`                     | One task: record, event journal, latest checks run              |
| `.codesema/queue.json`                      | The repository's waiting line                                   |
| `.codesema/worktrees/<id>/`                 | One worktree per task                                           |
| `.codesema-ignore`                          | Glob patterns excluded from the diff                            |

## Environment variables

| Variable                        | Effect                                                   |
| ------------------------------- | -------------------------------------------------------- |
| `CODESEMA_CONFIG_DIR`           | Global config directory (default `~/.config/codesema`)   |
| `XDG_CONFIG_HOME`               | Base of that default when `CODESEMA_CONFIG_DIR` is unset |
| `CODESEMA_NO_UPDATE_CHECK`      | Any non-empty value skips the startup npm version check  |
| `CODESEMA_SYNC_URL`             | Points `sync`/`link` at another codesema.com host        |
| `CODESEMA_RUNNER_MODE`          | Set by `workspace --runner`; starts the runner daemon    |
| `NO_COLOR`, `TERM=dumb`         | Turn coloured terminal output off                        |
| `LC_ALL`, `LC_MESSAGES`, `LANG` | Preselect the wizard's language question                 |

Every command checks the npm registry once at startup (a `dist-tags` lookup, nothing about you or your code is sent) and offers the upgrade in an interactive terminal.

## Exit codes

| Code  | Meaning                                                                    |
| ----- | -------------------------------------------------------------------------- |
| `0`   | Success, and nothing tripped the `--fail-on` gate                          |
| `1`   | Error: bad invocation, agent failure, unusable output, blocked secret sync |
| `2`   | The `--fail-on` gate tripped                                               |
| `130` | Interrupted with Ctrl-C                                                    |

## Troubleshooting

| Message                              | What to do                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `could not detect the target branch` | No merge request found and no develop/main/master to compare against: pass `--target <branch>`                                       |
| `empty diff … nothing to review`     | codesema reviews committed work: commit first                                                                                        |
| `agent timed out`                    | The run hit its ceiling: raise `--timeout <seconds>`, or the `timeout` key for the workspace                                         |
| `agent said nothing for … min`       | The watchdog stopped a task it considers stuck. It stays resumable; raise `watchdogInactivitySeconds` or `watchdogToolBudgetSeconds` |
| `no supported agent CLI found`       | Install one, or pick "Custom command" in `codesema config`                                                                           |
| Port busy                            | 20 ports are scanned from the preferred one: pick another base with `--port <n>`                                                     |
| The page says the review failed      | The terminal has the full error, and the server stays up so you can read both                                                        |

## Agent skill

To drive the flow from inside your agent instead of the CLI, install the bundled skill (plain agent-agnostic Markdown). For Claude Code, from a clone of this repository:

```bash
cp -r skills/codesema ~/.claude/skills/codesema
```

Then, on a feature branch, ask your agent for `/codesema`. It uses `codesema prep` and `codesema show` underneath.

## Development

```bash
bun install
bun run build                             # web UI, embedded in the CLI, then the CLI
node packages/cli/dist/index.mjs          # the full interactive flow
```

The `codesema-tools` monorepo holds `packages/cli` (the Node CLI, a native `node:http` server with SSE, no runtime dependencies), `packages/contract` (`@codesema/contract`: review types, sanitizers and grounding, bundled into the CLI and published for codesema.com), `packages/web` (the Vue 3 SPA embedded in the tarball) and `skills/codesema`.

Implementation notes that used to live here (forge issue hierarchy, cycle labels, subprocess environments) are in [docs/internals.md](docs/internals.md).

## License

MIT
