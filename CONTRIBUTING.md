# Contributing

## Getting set up

```sh
bun install
bun run build   # do this once: part of the suite needs packages/cli/web-dist
```

`bun run build` is not optional before the first `bun run test` in a fresh
clone or worktree: `serve.test.ts` boots the real server, and the server
refuses to start without the embedded web UI that `build` produces.

## The scripts

| Script         | What it does                                     | Cost  |
| -------------- | ------------------------------------------------ | ----- |
| `lint`         | oxlint over the workspace                        | ~0.2s |
| `format:check` | prettier, with its cache                         | ~0.8s |
| `typecheck`    | builds the contract, then tsc ×2 + vue-tsc       | ~5.8s |
| `build`        | contract, then web, then cli                     | ~2.8s |
| `test`         | builds the contract, then the suite              | ~10s  |
| `verify`       | typecheck + test, building the contract **once** | ~15s  |

`typecheck:only` and `test:only` skip the contract build, for when you know it
is already current. `typecheck` and `test` keep it, so both stay usable on
their own.

Type-checking is incremental (`node_modules/.cache/tsc/`) and prettier is
cached (`node_modules/.cache/prettier/`). Both caches live under
`node_modules/`, so **each worktree has its own** — the first run in a new
worktree pays full price, every run after is fast.

The suite runs in parallel **locally only**, on half the cores, computed at run
time — about 8s instead of 30s. One worker per core sounds better and is not:
each worker spawns real `git` subprocesses, so the real load runs well past the
core count, and tests start failing on their timeout rather than on their
assertions.

On CI it runs sequentially, because `--parallel` implies `--isolate` — one
worker process per file — and a worker that keeps a handle open never gives the
runner back. It is intermittent: the same commit passed in a minute on its pull
request and then hung for twenty on the merge queue's branch. Locally a person
is watching and can interrupt; on CI nobody is, and a job that hangs costs far
more than the twenty seconds it saved.

## Hooks

Lefthook runs them; `bun run prepare` installs it.

- **pre-commit** — gitleaks on the staged diff, prettier on the staged files
  (restaged after), oxlint on the staged `.ts`/`.mjs`/`.vue`
- **pre-push** — `typecheck`, then `test`

The pre-push hook is the local gate. There is no need to run the battery by
hand before pushing; the hook runs it and refuses the push if it fails. Never
reach for `--no-verify` to get around it.

## Branches and merging

`develop` is the integration branch. `main` only ever receives `develop`.

Work happens on a branch, lands through a pull request, and PRs merge into
`develop` **through the merge queue**. Clicking Merge does not merge: it puts
the pull request in a queue, and GitHub then builds a temporary branch made of
the current `develop` plus your PR plus whatever is queued ahead of it, runs
the `quality` workflow on **that**, and merges only if it is green.

This is what keeps `develop` honest. A PR can be green on its own branch and
still break `develop` — not through a merge conflict, but because a signature,
a union or a default changed under it while it waited. Every such break this
repo has seen was invisible to the merge and caught only by the type-checker
afterwards.

So: no rebase-then-hope, and no merging a branch that is behind. Put it in the
queue.

## Housekeeping

```sh
scripts/clean-merged-worktrees.sh          # show what could go
scripts/clean-merged-worktrees.sh --yes    # remove it
```

Removes the worktrees and local branches already contained in `develop`. It
never touches the main worktree, the one you are standing in, or anything
holding uncommitted work — and it says why it skipped, rather than failing.

## Commits

Conventional Commits, `type(scope): description`. The title alone is enough.
