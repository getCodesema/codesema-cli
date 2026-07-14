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
npx -y codesema
```

That is the whole flow:

1. **First run only**: a short wizard asks which agent CLI to use (auto-detected on your PATH), the model and the reasoning effort. Saved globally, never asked again; change it anytime with `codesema config`.
2. **Pick a branch**: your local branches, sorted by last commit, arrow keys + type-to-filter.
3. **The web UI opens immediately**: the review runs in the background and the page fills in live, diff stats first, then verdict, summary and findings as the agent writes them (true token streaming with Claude Code, best-effort with other agents).

Re-running on the same branch reviews **incrementally**: the agent gets the previous review plus the diff since it, and updates it (pass `--full` to review from scratch).

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

## Privacy

Everything runs on your machine. The MR diff, the prompt and the review are written under `.codesema/` and never leave your computer: the review itself is produced by the agent CLI you run locally, not by a codesema.com service.

The one exception is `codesema sync`. That command uploads the review record (**including the diff**) to a codesema.com workspace, and only after you confirm on first run. After a successful sync it offers, once, to also push every future completed review automatically; nothing is pushed automatically unless you accept, and the `codesema config` menu turns it on or off anytime. Your absolute local repo path is stripped from the payload; only the review, diff, commit subjects and the origin remote URL are sent. `codesema sync delete` erases everything.

Before uploading, sync scans the diff for anything that looks like a committed secret (dotenv files, private keys, and AWS/GitHub/Slack/Google/Stripe/OpenAI/Anthropic credentials) and refuses to send it. Fix the diff, or pass `--force` once you have checked.

The review subprocess is locked down. The prompt already contains everything the agent needs (branch names, commit subjects, changed files, the diff), so `codesema review` runs the known agent CLIs with their tools switched off: `claude` gets `--tools "" --strict-mcp-config --setting-sources user` (no tools, no MCP servers, the repo's own `.claude/` settings ignored) and `codex` gets `--sandbox read-only --ask-for-approval never` with `AGENTS.md` loading disabled. Known agents also receive a minimal environment — `PATH`, `HOME`, locale, proxy settings and the provider's own variables — so your other credentials and tokens never reach the subprocess. Flags you set yourself and custom agent commands are left untouched, and "Run fixes" intentionally keeps the edit tools it needs.

## Requirements

- Node.js ≥ 20 and `git`
- An AI agent CLI: `claude` (Claude Code), `codex` (OpenAI) and `gemini` (Google) are auto-detected; anything else works via the "Custom command" wizard option or `--agent '<cmd>'` (e.g. `--agent 'opencode run "$(cat)"'`)
- Optional: `glab` or `gh` on the PATH, to auto-detect the target branch from the open MR/PR

## Configuration

```bash
npx -y codesema config
```

Interactive: language → agent → model → effort, then where to save. Two levels, field by field:

| Level  | File                             | When                                   |
| ------ | -------------------------------- | -------------------------------------- |
| Global | `~/.config/codesema/config.json` | Your default, every repo (onboarding)  |
| Repo   | `.codesema/config.json`          | Team/project override, wins over global |

CLI flags always win over both. `target`, `port`, `timeout` and `language` can also be set in either file.

### Language

Onboarding starts with a language question, stored as `language` (ISO 639-1: `en` or `fr`). It drives the CLI output, the web UI and the language the agent writes the review in. Without it, the interface stays in English and the review follows the language of the commit messages.

`review` and `show` check the npm registry once at startup (a read-only `dist-tags` lookup, nothing about you or your code is sent) to print a one-line notice when a newer version exists. Set `CODESEMA_NO_UPDATE_CHECK=1` to disable it; it is also skipped when stdout is not a terminal.

### Repo-provided agent approval

An `agent` command coming from a repo's `.codesema/config.json` runs on your machine, in your shell. codesema asks for a one-time approval per repo (remembered in your global config) and asks again whenever the command changes. Non-interactive runs refuse an unapproved repo agent: approve it once in a terminal, or pass `--agent '<cmd>'` explicitly.

## Commands

```bash
codesema                       # interactive terminal: opens a navigable menu (review, show, sync, link, config)
codesema review --branch feat/x --target develop   # non-interactive, CI-friendly
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
- `.codesema-ignore`: glob patterns excluded from the diff (lockfiles, minified files and sourcemaps are excluded by default).

## Troubleshooting

- `could not detect the target branch`: no MR/PR found and no develop/main/master to compare against; pass `--target <branch>`.
- `empty diff … nothing to review`: codesema reviews **committed** work, commit your changes first.
- `agent timed out`: raise the budget with `--timeout <seconds>` (default 900).
- `no supported agent CLI found`: install `claude`, or pick "Custom command" in `codesema config` (the command receives the prompt on stdin and must print the review JSON on stdout).
- Port busy: codesema scans 20 ports from the preferred one (default 4400); pick another base with `--port <n>`.
- The web page says the review failed: the terminal has the full error; the server stays up so you can read both.

## Environment variables

| Variable                   | Effect                                                                            |
| -------------------------- | --------------------------------------------------------------------------------- |
| `CODESEMA_CONFIG_DIR`      | Override the global config directory (default `~/.config/codesema`).               |
| `CODESEMA_NO_UPDATE_CHECK` | Set to `1` to skip the startup npm version check (also skipped when not a TTY).    |
| `CODESEMA_SYNC_URL`        | Point `sync`/`link` at a different codesema.com host (self-hosted or staging).     |

## Files

| Path                              | Contents                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `~/.config/codesema/config.json`  | Global config (language, agent, model, effort, sync credentials), mode `0600`. |
| `.codesema/config.json`           | Repo config, overrides the global one.                                       |
| `.codesema/input.json`            | The prepared MR diff handed to the agent (`prep`).                           |
| `.codesema/review.json`           | The latest review written by the agent.                                     |
| `.codesema/reviews/`              | Archived reviews (5 kept per branch, used for incremental re-review).         |
| `.codesema/PROMPT.md`             | Your team's extra review instructions, merged into the prompt.               |
| `.codesema-ignore`                | Glob patterns excluded from the diff.                                        |

## Exit codes

| Code  | Meaning                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------- |
| `0`   | Success (review completed; with `--fail-on`, nothing tripped the gate).                        |
| `1`   | Error (bad invocation, agent failure, unusable output, or a blocked secret sync).              |
| `2`   | `review --fail-on <level>` gate tripped (a finding at or above the level, or changes requested). |
| `130` | Interrupted with Ctrl-C.                                                                        |

## Development

```bash
bun install
bun run build        # builds the web UI, embeds it in the CLI, builds the CLI
node packages/cli/dist/index.mjs        # full interactive flow
node packages/cli/dist/index.mjs show
```

Monorepo layout (`codesema-tools`): `packages/cli` (Node CLI: review/prep/show, native `node:http` ephemeral server + SSE, zero runtime dependencies), `packages/web` (Vue 3 + Vite SPA embedded in the CLI tarball), `skills/codesema` (the agent skill).

## License

MIT
