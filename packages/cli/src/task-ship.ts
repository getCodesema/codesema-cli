// Ship (T5): the "Confirm complete" gesture of a task. Pushes the task branch
// to origin from the MAIN repo (branch refs are shared with the worktree, so
// the worktree can stay untouched — or already be gone) and opens the MR/PR
// through the forge CLI the user already has: gh or glab, picked with the same
// origin-hint rule as the MR list (forge-mrs.ts). A missing forge CLI degrades
// the ship to "push only" instead of failing it: the push DID succeed, the MR
// is one manual step away, and the note says so explicitly.
//
// The degraded outcomes below are D9's "no recap posted" half, and the rule
// they answer to is written once, in degraded-mode.ts. Each one carries
// `forge_unreachable` BESIDE the note it already produced (never instead of
// it) plus the motif verbatim in `detail` — `no-remote`, `no-cli`,
// `cli-error`, `offline` — so a reader can tell "install a CLI" from "the
// CLI failed" from "there is no remote at all" from "this machine never
// reached the host". Everything the remote ANSWERED (a rejected push, a
// declining hook, a refused credential) stays deliberately uncoded.
//
// T3.5 changed WHAT the merge request says, and added the one thing that makes
// it sayable: the ship is where the task's recap (T3.4) is generated and
// written to `.codesema/tasks/<id>/recap.json`, right before the description is
// composed from it. Not at the end of every turn (a full diff per turn is
// expensive for a document only the ship publishes) and not at merge time (too
// late — the description is built here). A task that never ships therefore
// never gets a recap, which is the honest consequence: there is nothing to
// recap about work that was not shipped.

import { execFile } from 'node:child_process'
import { type ReasonCode, type RecapRecord, type SecretMatch, type TaskRecord } from './contract.js'
import type { ForgeDegradation } from './degraded-mode.js'
import { detectForgeHint, forgeHintOfUrl, subprocessEnv, type ForgeHint } from './git.js'
import { t, type MessageKey } from './i18n.js'
import {
  sandboxName,
  type SandboxDriver,
  type SandboxExecResult,
  type SandboxHandle,
  type SandboxSecret,
  type SandboxSpec,
} from './microsandbox-driver.js'
import { scanRecapSecrets } from './task-recap-publish.js'
import { generateRecap, renderRecapMarkdown, writeTaskRecap } from './task-recap.js'

/** Pushes and MR creations talk to the network: much looser than forge-mrs's 8s list timeout. */
export const SHIP_EXEC_TIMEOUT_MS = 60_000
/**
 * Bound for the recap rendering embedded in the MR description, in CODE
 * POINTS. Unchanged in value and in mechanics since it bounded the last-turn
 * summary (T5): what it bounds moved from a chatty agent response to a
 * structured document (T3.5), the reason did not — nothing this machine
 * composes is sent unbounded to a forge. Exported so the bound can be asserted
 * from the outside instead of inferred from a magic number.
 */
export const MR_BODY_SUMMARY_MAX = 4000
/** Bound for CLI error messages surfaced in journal events. */
const SHIP_ERROR_MAX = 500

/**
 * Image the gitops sandbox (lot C9) boots for a 'microvm' task's push and MR
 * creation: no public image bundles git + gh + glab together, so this is
 * plain alpine with the three packages installed at sandbox start via `apk`.
 * That install is the one deliberate exception to "the sandbox reaches only
 * the forge": it needs `dl-cdn.alpinelinux.org` for the length of the
 * `apk add`, so that domain rides in the sandbox's (otherwise forge-only)
 * network policy for its whole lifetime — the policy is fixed at `create`
 * and cannot be narrowed mid-session (spike 2026-08-28, Critère 4).
 */
export const GITOPS_IMAGE = 'alpine:3.20'
const GITOPS_ALPINE_CDN_DOMAIN = 'dl-cdn.alpinelinux.org'
const GITOPS_INSTALL_TIMEOUT_MS = 120_000
const GITOPS_MAX_DURATION_SECONDS = 300
const GITOPS_ROOT_DISK_MIB = 2048
const GITOPS_CREDENTIAL_HELPER_PATH = '/usr/local/bin/codesema-git-credential'

/** gh reads `GH_TOKEN`, glab reads `GITLAB_TOKEN` — both natively, no flag needed. */
function gitopsSecretEnv(forge: ForgeHint): 'GH_TOKEN' | 'GITLAB_TOKEN' {
  return forge === 'gitlab' ? 'GITLAB_TOKEN' : 'GH_TOKEN'
}

/**
 * The forge token(s) to declare as sandbox secrets. `forgeCandidates`
 * (below, reusing git.ts's `forgeHintOfUrl` like this does) tries BOTH `gh`
 * and `glab` when the hint is 'unknown' — a self-hosted host whose name says
 * neither 'github' nor 'gitlab' — so declaring only one native token env
 * would leave whichever CLI runs second reading nothing.
 */
function gitopsSecretDeclarations(
  forge: ForgeHint,
  forgeToken: string,
  allowedHosts: readonly string[],
): SandboxSecret[] {
  const envs: readonly ('GH_TOKEN' | 'GITLAB_TOKEN')[] =
    forge === 'unknown' ? ['GH_TOKEN', 'GITLAB_TOKEN'] : [gitopsSecretEnv(forge)]
  return envs.map((env) => ({ env, value: forgeToken, allowedHosts }))
}

/** `forgeHost` plus its API host, when github.com's push host and API host differ. */
function gitopsAllowedHosts(forgeHost: string): string[] {
  return forgeHost === 'github.com' ? [forgeHost, 'api.github.com'] : [forgeHost]
}

/**
 * The sandbox's `push`/MR-create-only network policy: the forge host(s) plus
 * the alpine CDN the one-time package install needs (see `GITOPS_IMAGE`).
 */
function gitopsAllowedDomains(forgeHost: string): string[] {
  return [...gitopsAllowedHosts(forgeHost), GITOPS_ALPINE_CDN_DOMAIN]
}

/**
 * `git` itself never reads an env var for HTTPS auth, so a credential helper
 * script is what puts the token in play: git invokes it with `get` on stdin
 * and reads `username=`/`password=` back from stdout. The password is the
 * env var's PLACEHOLDER value (the guest never sees the real token, spike
 * 2026-08-28 Critère 6) — it is substituted for the real one only when the
 * outbound HTTPS request lands on an `allowedHosts` domain, which is exactly
 * why the push URL must be https (see `toHttpsRemoteUrl`).
 */
function gitCredentialScript(forge: ForgeHint, secretEnv: string): string {
  const username = forge === 'gitlab' ? 'oauth2' : 'x-access-token'
  return `#!/bin/sh\nif [ "$1" = "get" ]; then\n  echo "username=${username}"\n  echo "password=$${secretEnv}"\nfi\n`
}

/**
 * `copyFromHost` copies the whole repo, `.git` included: any LOCAL (not just
 * `--global`) `credential.helper` or `http.<url>.extraheader` already sitting
 * in the host's `.git/config` — a per-repo helper, a bearer header a CI
 * checkout leaves behind — lands in the guest verbatim and OUTRANKS the
 * `--global credential.helper` set right after (local scope always wins).
 * Run once, right after the copy, before that placeholder helper is
 * installed. Best-effort on purpose: the ordinary case is that neither key
 * is present, so every line tolerates a no-op failure.
 */
function gitopsStripHostCredentialConfigScript(): string {
  return [
    'git config --local --unset-all credential.helper || true',
    "for key in $(git config --local --name-only --get-regexp '^http\\..*\\.extraheader$' 2>/dev/null); do",
    '  git config --local --unset-all "$key"',
    'done',
    'true',
  ].join('\n')
}

/** POSIX single-quoting for a value interpolated into a shell command run in the sandbox. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * ssh/scp-style remote -> https. The proxy substitution that stands in for
 * the real forge token only fires on an HTTPS request to an `allowedHosts`
 * domain (spike 2026-08-28 Critère 6): a push that keeps an `ssh://` or
 * `git@host:path` origin would authenticate with nothing. Null when the URL
 * cannot be read as either shape — the caller reports that as an error
 * rather than guessing a host.
 */
export function toHttpsRemoteUrl(url: string): string | null {
  const trimmed = url.trim()
  if (/^https:\/\//i.test(trimmed)) {
    return stripEmbeddedCredentials(trimmed)
  }
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed)
  if (ssh?.[1] !== undefined && ssh[2] !== undefined) {
    return `https://${ssh[1]}/${ssh[2]}`
  }
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed)
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    return `https://${scp[1]}/${scp[2].replace(/^\/+/, '')}`
  }
  return null
}

/**
 * Drops a `user[:token]@` prefix embedded in an https origin (a GitLab
 * CI-job-token remote, a PAT pasted into origin for automation). That value
 * is not the sandbox's declared placeholder secret — letting it ride into the
 * push command would put the real token in plain text on the wire into the
 * guest. The credential helper supplies auth from here on, so the userinfo
 * is dropped rather than trusted.
 */
function stripEmbeddedCredentials(httpsUrl: string): string {
  return httpsUrl.replace(/^(https:\/\/)[^/]*@/i, '$1')
}

/** `SandboxExecResult` -> `ShipCliOutcome`, so the sandbox path reuses every host-side outcome rule verbatim. */
function sandboxOutcome(result: SandboxExecResult): ShipCliOutcome {
  if (result.timedOut) {
    return { kind: 'error', message: 'gitops sandbox command timed out' }
  }
  if (result.code === 0) {
    return { kind: 'ok', stdout: result.stdout }
  }
  const message = (
    result.stderr.trim() ||
    result.stdout.trim() ||
    `exit code ${result.code}`
  ).slice(0, SHIP_ERROR_MAX)
  return {
    kind: 'error',
    message,
    ...(typeof result.code === 'number' ? { status: result.code } : {}),
  }
}

/**
 * Same three-way split as forge-mrs's runForgeCli — 'missing' (binary not
 * installed) must stay distinct from 'error' so a missing gh falls through to
 * glab silently while a real failure surfaces its message — plus the stderr
 * text, which forge-mrs discards but the ship's error events need.
 */
export type ShipCliOutcome =
  | { kind: 'ok'; stdout: string }
  | { kind: 'missing' }
  /**
   * The command RAN and failed. `status` is its exit code when there was one
   * (a spawn that never produced a process has none), and it is the only
   * dependable way to tell git's own failures apart: git LOCALISES its
   * messages — `git remote get-url origin` on a repo without one answers
   * "error: Pas de serveur remote 'origin'" on a French box (measured, git
   * 2.53.0) — while the exit code is the same everywhere. OPTIONAL: a caller
   * that does not care keeps working, and an outcome without it is read as
   * "which failure this was is unknown", never as a particular one.
   */
  | { kind: 'error'; message: string; status?: number }

export type ShipGitExecFn = (args: string[], cwd: string) => Promise<ShipCliOutcome>
export type ShipForgeExecFn = (
  cli: 'gh' | 'glab',
  args: string[],
  cwd: string,
) => Promise<ShipCliOutcome>

/**
 * The exec pattern of every forge call this workspace makes — argv only (no
 * host-side shell interpolation), `SHIP_EXEC_TIMEOUT_MS`, and
 * `GIT_TERMINAL_PROMPT=0` so a remote that wants credentials fails FAST with
 * a readable error instead of hanging until the timeout.
 *
 * EXPORTED (T3.6) rather than copied into the merge module: the merge has
 * exactly the same I/O profile as the ship — a forge CLI that talks to the
 * network, a need to fail fast on a credentials prompt, and a
 * `missing` / `error` distinction that must not blur. A second copy would be
 * two paths meant to behave identically, drifting the first time one is fixed.
 */
export function execCli(cmd: string, args: string[], cwd: string): Promise<ShipCliOutcome> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      // GIT_TERMINAL_PROMPT=0: a push against a remote that wants credentials
      // must fail fast with a readable error, not hang until the timeout.
      {
        cwd,
        encoding: 'utf8',
        timeout: SHIP_EXEC_TIMEOUT_MS,
        env: { ...subprocessEnv(), GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            resolve({ kind: 'missing' })
            return
          }
          const message = (stderr.trim() || err.message).slice(0, SHIP_ERROR_MAX)
          // execFile reports the exit code in `code` for a process that RAN,
          // and a string errno (ENOENT, E2BIG…) for one that never started.
          resolve({
            kind: 'error',
            message,
            ...(typeof err.code === 'number' ? { status: err.code } : {}),
          })
          return
        }
        resolve({ kind: 'ok', stdout })
      },
    )
  })
}

const defaultExecGit: ShipGitExecFn = (args, cwd) => execCli('git', args, cwd)
const defaultExecForge: ShipForgeExecFn = (cli, args, cwd) => execCli(cli, args, cwd)

type GitopsSession = {
  execGit: ShipGitExecFn
  execForge: ShipForgeExecFn
  /** No-op when no sandbox was ever created (e.g. the ship never got past the no-remote gate). */
  destroy: () => Promise<void>
}

/**
 * The 'microvm' path (lot C9): a `codesema-gitops-<taskId>` sandbox that
 * carries the forge token as a placeholder secret and reaches only the forge
 * (plus the alpine CDN for its one-time package install). `execGit`'s
 * `remote get-url origin` probe (D9's pre-push gate) still runs on the HOST —
 * it is a local, secret-free read, and running it needs the origin URL
 * before the sandbox's network policy can even be built. Only the `push`
 * itself, and every forge CLI call, cross into the sandbox.
 *
 * The sandbox is created lazily, on the first call that actually needs it,
 * and reused by every later call in the same ship — one `apk add` and one
 * worktree copy per ship, not one per forge candidate tried.
 */
function createGitopsSession(opts: ShipTaskOptions, driver: SandboxDriver): GitopsSession {
  const name = sandboxName('gitops', opts.task.id)
  let handlePromise: Promise<SandboxHandle> | null = null

  const ensureHandle = (forgeHost: string, forge: ForgeHint): Promise<SandboxHandle> => {
    if (!handlePromise) {
      handlePromise = (async () => {
        const spec: SandboxSpec = {
          name,
          image: GITOPS_IMAGE,
          cpus: 1,
          memoryMib: 512,
          rootDisk: { kind: 'managed', sizeMib: GITOPS_ROOT_DISK_MIB },
          maxDurationSeconds: GITOPS_MAX_DURATION_SECONDS,
          network: { allowedDomains: gitopsAllowedDomains(forgeHost) },
          // No `workdir` here: the SDK refuses one that does not already exist
          // in the image, and `/work` is only created below by
          // `copyFromHost` (same reasoning as `task-review.ts`'s sandbox
          // create), `cwd` on every `shell`/`exec` call does the `cd` instead.
          ...(opts.forgeToken
            ? {
                secrets: gitopsSecretDeclarations(
                  forge,
                  opts.forgeToken,
                  gitopsAllowedHosts(forgeHost),
                ),
              }
            : {}),
        }
        const handle = await driver.create(spec)
        const install = await handle.shell('apk add --no-cache git github-cli glab', {
          cwd: '/',
          timeoutMs: GITOPS_INSTALL_TIMEOUT_MS,
        })
        if (install.code !== 0 || install.timedOut) {
          throw new Error(
            `gitops sandbox package install failed: ${`${install.stdout}\n${install.stderr}`.trim().slice(-2000)}`,
          )
        }
        await handle.copyFromHost(opts.cwd, '/work')
        // `copyFromHost` preserves the host's uid/gid, which never matches the
        // sandbox's own user — Git refuses to touch a repo it does not itself
        // own (CVE-2022-24765) unless the path is marked safe first. Global,
        // not local: this sandbox exists for exactly one push and is
        // destroyed right after, so there is no other repo to scope it away
        // from.
        await handle.shell(`git config --global --add safe.directory /work`, {
          cwd: '/work',
          timeoutMs: 10_000,
        })
        await handle.shell(gitopsStripHostCredentialConfigScript(), {
          cwd: '/work',
          timeoutMs: 10_000,
        })
        await handle.writeFile(
          GITOPS_CREDENTIAL_HELPER_PATH,
          gitCredentialScript(forge, gitopsSecretEnv(forge)),
        )
        await handle.shell(`chmod +x ${shellQuote(GITOPS_CREDENTIAL_HELPER_PATH)}`, {
          cwd: '/work',
          timeoutMs: 10_000,
        })
        await handle.shell(
          `git config --global credential.helper ${shellQuote(`!${GITOPS_CREDENTIAL_HELPER_PATH}`)}`,
          {
            cwd: '/work',
            timeoutMs: 10_000,
          },
        )
        return handle
      })()
    }
    return handlePromise
  }

  const execGit: ShipGitExecFn = async (args, cwd) => {
    if (args[0] !== 'push') {
      // The pre-push origin probe (and anything else that is not the push
      // itself) is a local, secret-free read: no reason to pay for a sandbox.
      return defaultExecGit(args, cwd)
    }
    try {
      const remote = await defaultExecGit(['remote', 'get-url', 'origin'], cwd)
      if (remote.kind !== 'ok') {
        return remote
      }
      const httpsUrl = toHttpsRemoteUrl(remote.stdout.trim())
      if (httpsUrl === null) {
        return {
          kind: 'error',
          message: `origin remote could not be read as an https URL for the gitops sandbox: ${remote.stdout.trim()}`,
        }
      }
      let forgeHost: string
      try {
        forgeHost = opts.forgeHost ?? new URL(httpsUrl).hostname
      } catch (err) {
        return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
      }
      const handle = await ensureHandle(forgeHost, forgeHintOfUrl(forgeHost))
      const result = await handle.shell(
        `git push -u ${shellQuote(httpsUrl)} ${shellQuote(opts.task.branch)}`,
        { cwd: '/work', timeoutMs: SHIP_EXEC_TIMEOUT_MS },
      )
      return sandboxOutcome(result)
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  const execForge: ShipForgeExecFn = async (cli, args) => {
    try {
      // By the time a forge candidate is tried, the push above has already
      // resolved and cached the sandbox — this call reuses it.
      if (!handlePromise) {
        return {
          kind: 'error',
          message: 'gitops sandbox was never created (no push ran before the forge call)',
        }
      }
      const handle = await handlePromise
      const result = await handle.exec(cli, args, { cwd: '/work', timeoutMs: SHIP_EXEC_TIMEOUT_MS })
      return sandboxOutcome(result)
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  const destroy = async (): Promise<void> => {
    if (handlePromise) {
      await driver.destroy(name)
    }
  }

  return { execGit, execForge, destroy }
}

/**
 * First https URL in the CLI output: both `gh pr create` and `glab mr create`
 * print the created MR/PR URL on stdout (verified gh 2.46.0 / glab 1.53.0).
 * Null when the tool succeeded but printed no URL — the ship still counts.
 */
export function extractMrUrl(raw: string): string | null {
  const match = /https:\/\/\S+/.exec(raw)
  return match ? match[0].replace(/[.,)\]]+$/, '') : null
}

/**
 * Best-effort detection of the "an MR already exists for this branch" failure
 * a second `gh pr create` / `glab mr create` run reports. Matched on the
 * common "already exists" wording both CLIs use (gh additionally prints the
 * existing PR's URL in that message, which extractMrUrl can then recover).
 * Deliberately loose: a phrasing this misses simply keeps the current
 * error-note behavior, it never turns a real failure into a success.
 */
export function isMrAlreadyExistsError(message: string): boolean {
  return /already exists/i.test(message)
}

/**
 * Truncation by CODE POINTS, never by UTF-16 units: a `.slice()` on a string
 * can cut a surrogate pair in half and put a lone half-character on the forge.
 * The last kept code point is given up to the ellipsis so the result is never
 * longer than `max` — the same mechanics the last-turn summary had, extracted
 * so the rule has one home.
 */
export function boundCodePoints(value: string, max: number): string {
  const codePoints = Array.from(value)
  return codePoints.length > max ? `${codePoints.slice(0, max - 1).join('')}…` : value
}

/**
 * What the merge-request description has to say about the recap. Three states,
 * because they are three different sentences to a human: there is one, there
 * is none, or there is one that must not leave this machine.
 */
export type MrRecapSource =
  | { kind: 'recap'; recap: RecapRecord }
  /** No recap could be produced — a generator that refused, or a write that did not land. */
  | { kind: 'missing' }
  /** A recap exists on disk but the secret scan held it back before anything was sent. */
  | { kind: 'blocked' }
  /**
   * A recap exists on disk and the secret scan itself could not run, so
   * NOTHING cleared it. Kept apart from `blocked` because the two are
   * different sentences to a human: one says a secret was seen, the other
   * says nobody looked — and claiming the first when only the second happened
   * would send a reader hunting for a leak that was never found.
   */
  | { kind: 'unscanned' }

/** What the description says in place of a recap it may not carry. One key per refusal. */
const NO_RECAP_KEY: Record<Exclude<MrRecapSource['kind'], 'recap'>, MessageKey> = {
  missing: 'ship.mrNoRecap',
  blocked: 'ship.mrRecapBlocked',
  unscanned: 'ship.mrRecapUnscanned',
}

/**
 * MR description: the recap's markdown rendering (T3.4,
 * `renderRecapMarkdown`), consumed WITHOUT reformatting, bounded at
 * `MR_BODY_SUMMARY_MAX`, and closed by the provenance note behind its `---`
 * separator.
 *
 * The note is appended AFTER the truncation, never before: it is the most
 * honest element of the whole body — the one line that tells a reviewer where
 * this text came from — and a bound applied to the assembled document would
 * make a long recap eat it.
 *
 * Never throws, and never leaves the description empty: a task with no recap
 * gets a description that SAYS there is no recap (invariant 2) and a ship that
 * completes regardless — the merge request is not the place to discover that a
 * generator degraded.
 */
export function buildMrDescription(source: MrRecapSource): string {
  const parts: string[] = []
  if (source.kind === 'recap') {
    parts.push(boundCodePoints(renderRecapMarkdown(source.recap), MR_BODY_SUMMARY_MAX))
  } else {
    parts.push(t(NO_RECAP_KEY[source.kind]))
  }
  parts.push(`---\n${t('ship.mrGeneratedNote')}`)
  return parts.join('\n\n')
}

export type ShipTaskOptions = {
  /** Set for a 'microvm' task: push and MR run in a dedicated sandbox, the forge token as a secret (lot C9). */
  driver?: SandboxDriver | undefined
  /** Forge token handed to the sandbox as a placeholder secret; never put in argv or env. */
  forgeToken?: string | null | undefined
  /** Forge API host the secret is allowed to reach (e.g. gitlab.com). */
  forgeHost?: string | undefined
  /** MAIN repo root: the push and the forge CLI both run here, never in the worktree. */
  cwd: string
  task: TaskRecord
  /** Test seams — the defaults run real git / gh / glab. */
  execGit?: ShipGitExecFn
  execForge?: ShipForgeExecFn
  /** Recap seams (T3.5): the defaults drive the real generator and the real store. */
  generateRecapFn?: typeof generateRecap
  writeTaskRecapFn?: typeof writeTaskRecap
  scanRecapSecretsFn?: typeof scanRecapSecrets
}

/**
 * The motif of a degradation, VERBATIM as the vocabulary names it
 * (degraded-mode.ts) — never a reworded sentence. It travels next to
 * `reasonCode`, and the caller composes the reason's `detail` from the two so
 * `no-cli` can never be read as `cli-error`. OPTIONAL everywhere: an outcome
 * that names no degradation carries neither field.
 */
type ShipDegradation = { reasonCode?: ReasonCode; detail?: ShipMotif }

/**
 * The motifs a ship can name. The three the forge client itself produces,
 * plus `offline` — the one D9's title lists that no forge client can ever
 * answer, because the push dies before any forge is asked (see
 * `transportFailure` below).
 */
type ShipMotif = ForgeDegradation | 'offline'

/**
 * What the ship has to say about the recap it was supposed to carry, in the
 * `data.name` vocabulary every other journal payload uses — raw wire tokens,
 * the UI translating from them (`shippedEventText`, useTaskBoard.ts).
 *
 * It exists because a ship whose recap was HELD BACK used to be
 * indistinguishable, in the workspace journal, from a nominal one: the event
 * carried the story in `data.note`, no component reads `note`,
 * `SUMMARY_KEYS.shipped` probes `url`/`branch` and matches neither, and
 * `outcome.reasonCode` being undefined on that path made `task-server.ts`
 * `delete record.reason`. Three green "Publiée" lines, one of which had
 * silently withheld a document for carrying a secret. The three messages
 * this module poses on `shipped` now get the same audit its seven `issue`
 * names already had.
 *
 * Only the refusals are named. A ship that carried its recap poses NOTHING,
 * so the nominal line keeps reading as the plain label — naming the happy
 * path would put a badge on every single ship.
 */
export type ShipRecapState = 'recap_missing' | 'recap_blocked_secrets' | 'recap_unscanned'

export type ShipOutcome =
  | ({
      pushed: true
      mrUrl: string | null
      note: string | null
      /**
       * Names the degradation when the ship landed short of an MR. OPTIONAL:
       * a ship that opened its merge request has nothing to name, and the
       * `note` stays the readable half of the story either way.
       */
      /**
       * Names the degradation when the ship landed short of its RECAP —
       * a different axis from `reasonCode`, which is about the merge request,
       * and both can be posed on the same ship. OPTIONAL: absent is "the
       * recap rode along", the ordinary case.
       */
      recapState?: ShipRecapState
    } & ShipDegradation)
  /**
   * Nothing shipped. `error` is the readable half and has always been there;
   * the two optional fields name it when the cause is a forge codesema could
   * not reach, and stay absent for every other push failure — a rejected
   * non-fast-forward, a hook, a credential prompt — which `forge_unreachable`
   * would misname.
   */
  | ({ pushed: false; error: string } & ShipDegradation)

type ForgeCandidate = { cli: 'gh' | 'glab'; args: string[] }

/**
 * MR-creation commands, in probe order. Same selection rule as
 * forge-mrs.listOpenMrs: the origin hint skips the obviously wrong CLI, an
 * unrecognized (self-hosted) remote tries both. Flags verified against
 * gh 2.46.0 and glab 1.53.0.
 */
function forgeCandidates(cwd: string, task: TaskRecord, description: string): ForgeCandidate[] {
  const hint = detectForgeHint(cwd)
  // The MR targets the base BRANCH on the forge: strip the remote-tracking
  // prefix a detected base like 'origin/develop' carries.
  const base = task.base.replace(/^origin\//, '')
  const candidates: ForgeCandidate[] = []
  if (hint !== 'gitlab') {
    // prettier-ignore
    candidates.push({
      cli: 'gh',
      args: ['pr', 'create', '--head', task.branch, '--base', base, '--title', task.title, '--body', description],
    })
  }
  if (hint !== 'github') {
    // prettier-ignore
    candidates.push({
      cli: 'glab',
      args: ['mr', 'create', '--source-branch', task.branch, '--target-branch', base, '--title', task.title, '--description', description, '--yes'],
    })
  }
  return candidates
}

/** Post-push MR creation: by construction always a pushed:true outcome. */
async function createMr(
  opts: ShipTaskOptions,
  execForge: ShipForgeExecFn,
  description: string,
): Promise<ShipOutcome> {
  // Journal note, not UI copy: raw English like every other event payload.
  let note: string | null = null
  for (const candidate of forgeCandidates(opts.cwd, opts.task, description)) {
    const outcome = await execForge(candidate.cli, candidate.args, opts.cwd)
    if (outcome.kind === 'missing') {
      continue
    }
    if (outcome.kind === 'error') {
      if (isMrAlreadyExistsError(outcome.message)) {
        // An MR already exists for this branch (a re-ship of a work-on task
        // whose branch had one open, typically): the push DID land the
        // commits on it, so this is a degraded success, not a failure. gh
        // prints the existing PR's URL inside the error message — recover it
        // when present.
        return {
          pushed: true,
          mrUrl: extractMrUrl(outcome.message),
          note: `${candidate.cli}: a merge request already exists for this branch — the push updated it`,
        }
      }
      // Keep trying (a dual-remote setup may have the other CLI working) but
      // remember the failure: it is the honest note if nothing else succeeds.
      note = `${candidate.cli} failed: ${outcome.message}`
      continue
    }
    const mrUrl = extractMrUrl(outcome.stdout)
    return {
      pushed: true,
      mrUrl,
      note: mrUrl ? null : `${candidate.cli} created the merge request but printed no URL`,
    }
  }
  if (note !== null) {
    // A forge CLI DID run and failed: its own message stays the honest note.
    //
    // This used to be left UNCODED, on the argument that "the forge answered,
    // so forge_unreachable would misname it". T2.7 overturns that: D2 defines
    // `forge_unreachable` as "the forge could not be reached: no gh/glab
    // available, no network, an API that refused" (contract/src/reasons.ts),
    // and a `gh` that exits non-zero on `pr create` IS an API that refused.
    // The three DP14 questions all answer yes — it qualifies a refusal (no MR
    // was opened), terminal-vs-retryable is meaningful (retryable: the same
    // call can succeed later), and a machine reads it (T3.6 will not merge
    // without an MR). Leaving it uncoded made the ONE forge degradation a
    // human is most likely to hit the only one no machine could see.
    //
    // `detail: 'cli-error'` is what keeps it distinguishable from the
    // `no-cli` case below, which shares the code and means the opposite
    // thing for what the user must do about it.
    return { pushed: true, mrUrl: null, note, reasonCode: 'forge_unreachable', detail: 'cli-error' }
  }
  return {
    pushed: true,
    mrUrl: null,
    note: 'no forge CLI (gh or glab) available — branch pushed, open the merge request manually',
    // The push DID land: the work is safe on origin and the MR is one manual
    // (or one retried) step away — a retryable degradation, not a failure.
    reasonCode: 'forge_unreachable',
    detail: 'no-cli',
  }
}

/**
 * Journal note, not UI copy: raw English like every other payload in this file.
 * Deliberately NOT exported: a test that imported it would compare the message
 * to the constant that produces it and prove nothing. What the tests pin is
 * the pair (readable message, coded motif) at the surface where a human and a
 * machine actually read it.
 */
const SHIP_NO_REMOTE_ERROR =
  'no origin remote is configured for this repo — there is nothing to push the branch to, and no merge request can be opened'

/** Exit code git uses for "there is no remote by that name" (git 2.53.0). */
const GIT_NO_SUCH_REMOTE = 2

/**
 * Is there an `origin` to push to? Asked through the SAME injected git seam as
 * the push itself, so a test that stubs git stubs this too and no test ever
 * needs a real remote.
 *
 * TRI-state, and that is the whole point (round-2 adversarial review, majeur
 * 1). `false` is claimed only when git ANSWERED that there is no such remote —
 * exit code 2, the same signal `probeOriginRemote` reads, and the only one
 * that survives a localised git. Everything else (git not installed, a `cwd`
 * that is not a repo or cannot be read, a timeout) is `null`: "I could not
 * ask". Collapsing those into `false` is how a repo that HAS an origin got
 * refused with "no origin remote is configured for this repo" the moment git
 * went missing — the exact "right decision, wrong announcement" mistake this
 * module writes down and then made.
 *
 * A remote whose URL is blank is `false`, not `null`: git answered, and the
 * answer is nothing to push to. `probeOriginRemote` says the same, so the
 * header and the refusal cannot disagree about one repo.
 */
async function originRemote(execGit: ShipGitExecFn, cwd: string): Promise<boolean | null> {
  const outcome = await execGit(['remote', 'get-url', 'origin'], cwd)
  if (outcome.kind === 'ok') {
    return outcome.stdout.trim() !== ''
  }
  return outcome.kind === 'error' && outcome.status === GIT_NO_SUCH_REMOTE ? false : null
}

/**
 * Does this push failure mean the remote host was never reached?
 *
 * The list is SHORT on purpose, and every entry is a phrase libcurl or
 * OpenSSH prints — never one of git's own. That is what makes them usable:
 * git translates its own wrapper (`fatal: unable to access …` comes out
 * `fatal: impossible d'accéder à …` on a French box, measured on git 2.53.0)
 * while the library's half stays in English whatever the locale is. A rule
 * written on git's wrapper would code a failure in one language and nothing
 * at all in another.
 *
 * Deliberately NOT in the list, each for a measured reason:
 *
 *  - `unable to access` — the wrapper libcurl's message hangs off. It also
 *    wraps `The requested URL returned error: 403` (measured against a local
 *    403), and a forge that ANSWERED 403 refused us, it was not unreachable.
 *    `forge_unreachable` is a RETRYABLE code: pinning it on a permission
 *    problem tells a machine to keep trying something that will never work.
 *  - `Could not read from remote repository` — ssh's epilogue, printed just
 *    as much for a rejected key as for a dead network.
 *  - a rejected push (non-fast-forward, a hook, a protected branch) carries
 *    none of these and stays UNCODED, which is the point of a short list: a
 *    wrong code is worse than no code, because D2 is what a resume decision
 *    is made on.
 */
const TRANSPORT_FAILURES: readonly string[] = [
  // libcurl "Could not resolve host: <h>", and ssh's "Could not resolve
  // hostname <h>: <why>" by the same prefix. Both measured.
  'could not resolve host',
  // libcurl "Failed to connect to <h> port <p> after <n> ms: <why>" — which
  // is also where an ENETUNREACH surfaces on the https transport. Measured.
  'failed to connect to',
  // ssh "connect to host <h> port <p>: Connection refused". Measured.
  'connection refused',
  // Both transports print exactly this. Measured on ssh.
  'connection timed out',
]

function transportFailure(message: string): boolean {
  const said = message.toLowerCase()
  return TRANSPORT_FAILURES.some((phrase) => said.includes(phrase))
}

/**
 * The agent's own last summary — the ONE prose source the ship path can read
 * today, and the same one the description carried before T3.5. It reaches the
 * recap as `summary`, which the renderer quotes; `changes[]`/`decisions[]` stay
 * empty until something produces them, and an empty section is omitted rather
 * than filled with an invented placeholder.
 *
 * `Array.isArray` and not a bare `.findLast`: a hand-edited or truncated
 * task.json can carry a record without `turns`, and this must degrade, not
 * throw, on the path that ships.
 */
function lastTurnContribution(task: TaskRecord): { summary: string } | null {
  const turns = Array.isArray(task.turns) ? task.turns : []
  const summary = turns.findLast((turn) => turn?.response)?.response
  return summary ? { summary } : null
}

type PreparedRecap = {
  source: MrRecapSource
  /** Exactly what landed in recap.json, or null when nothing did. */
  persisted: RecapRecord | null
  /** Degradation to add to the ship's note; null on the nominal path. */
  note: string | null
  /** The same degradation as a wire token for the journal; null on the nominal path. */
  state: ShipRecapState | null
}

/**
 * Generates the task's recap and persists it (tmp+rename, invariant 5), then
 * decides what the merge-request description may carry.
 *
 * The order matters and is not the obvious one: the recap is WRITTEN before
 * the secret scan runs. `recap.json` is a local file — writing it sends
 * nothing anywhere — and the ticket requires a blocked recap to SURVIVE on
 * disk, secret included, for the human who has to act on it. Scanning first
 * and skipping the write on a match would destroy the very artefact the block
 * is supposed to preserve.
 *
 * What survives is the CONTENT, not the byte-for-byte file: `attachMrUrl`
 * still back-writes `mr_url` afterwards on a ship that opened a merge
 * request, blocked or not. That is deliberate — the link belongs on the
 * record whatever became of the publication, and a later manual publication
 * would want it — and it is said here because the first version of this
 * ticket's CHANGELOG entry claimed the file stayed "intact", which is
 * literally false and would send a reader looking for a bug that is a
 * decision.
 *
 * Never throws: `writeTaskRecap` does (an unusable id or record are hard
 * invariants there), and an injected generator can, and neither may take down
 * a push that already succeeded.
 */
/** Either the recap that landed on disk, or the readable reason none did. */
type PersistedRecap = { recap: RecapRecord } | { reason: string }

function generateAndPersist(opts: ShipTaskOptions): PersistedRecap {
  const generate = opts.generateRecapFn ?? generateRecap
  const write = opts.writeTaskRecapFn ?? writeTaskRecap
  try {
    const contribution = lastTurnContribution(opts.task)
    // `criteriaVerdicts` is deliberately NOT passed: T3.2 is the ticket that
    // makes per-criterion verdicts readable off a review, and inventing a
    // source for them here would put a figure in the recap that nothing
    // measured. Until then the recap's "Acceptance criteria" section is
    // absent — omitted, per renderRecapMarkdown, not rendered empty.
    const result = generate({
      cwd: opts.cwd,
      task: opts.task,
      ...(contribution ? { modelOutput: contribution } : {}),
    })
    if (result.recap === null) {
      // The generator refuses only when the record has no usable branch: there
      // is nothing to identify a recap by, so there is nothing to publish.
      const reason = result.degradations.find((d) => d.field === 'branch')?.reason
      return { reason: reason ?? 'the generator produced none' }
    }
    return { recap: write(opts.cwd, opts.task.id, result.recap) }
  } catch (err) {
    // Generation or persistence blew up. The push already landed; say what
    // broke and ship anyway.
    return { reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Either the rendering may be published, or the readable reason it may not. */
type ScanVerdict = { clear: true } | { clear: false; kind: 'blocked' | 'unscanned'; note: string }

/**
 * The secret gate over what the description would carry, INSIDE a guard of
 * its own.
 *
 * The guard is the point, and it was the one seam of the three that did not
 * have one: `generateRecapFn` and `writeTaskRecapFn` are both called under
 * `generateAndPersist`'s `try`, `scanRecapSecretsFn` was called outside it —
 * so a throw here escaped a `prepareRecap` documented "Never throws", and
 * `task-server.ts` (the `catch` around `run(...)`) would have turned it into
 * `pushed: false` for a push that had ALREADY succeeded: the commits on
 * origin, the task left un-shipped, and a "git push failed" the user can
 * neither reproduce nor act on.
 *
 * A scan that did not run FAILS CLOSED, and says so in its own words rather
 * than borrowing `blocked`'s: nothing cleared the document, and the whole
 * reason this gate sits before the description is composed is that nothing
 * uncleared reaches a forge.
 */
function scanForSecrets(opts: ShipTaskOptions, persisted: RecapRecord): ScanVerdict {
  let secrets: SecretMatch[]
  try {
    secrets = (opts.scanRecapSecretsFn ?? scanRecapSecrets)(renderRecapMarkdown(persisted))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      clear: false,
      kind: 'unscanned',
      note: `recap withheld from the merge request: its secret scan could not run (${detail})`,
    }
  }
  if (secrets.length === 0) {
    return { clear: true }
  }
  // Blocked BEFORE the description is composed, so nothing derived from the
  // recap reaches the forge — while recap.json, written above, keeps the
  // secret on disk for a human. Same blocking scan as the sync's (sync.ts),
  // and with no --force escape hatch: the sync's exists because a human typed
  // the command and can answer for it; nothing here is typed by anyone.
  const detail = secrets.map((match) => `${match.file}: ${match.detail}`).join('; ')
  return {
    clear: false,
    kind: 'blocked',
    note: `recap withheld from the merge request: it looks like it carries a secret (${detail})`,
  }
}

/** The wire token each refusal is journaled under. */
const RECAP_STATE: Record<Exclude<MrRecapSource['kind'], 'recap'>, ShipRecapState> = {
  missing: 'recap_missing',
  blocked: 'recap_blocked_secrets',
  unscanned: 'recap_unscanned',
}

function prepareRecap(opts: ShipTaskOptions): PreparedRecap {
  const built = generateAndPersist(opts)
  if (!('recap' in built)) {
    return {
      source: { kind: 'missing' },
      persisted: null,
      note: `no recap: ${built.reason}`,
      state: RECAP_STATE.missing,
    }
  }
  const persisted = built.recap
  const verdict = scanForSecrets(opts, persisted)
  if (!verdict.clear) {
    return {
      source: { kind: verdict.kind },
      persisted,
      note: verdict.note,
      state: RECAP_STATE[verdict.kind],
    }
  }
  return { source: { kind: 'recap', recap: persisted }, persisted, note: null, state: null }
}

/** Joins the sentences a ship has to say, in the order they happened; null when it has none. */
function joinNotes(...notes: readonly (string | null)[]): string | null {
  const said = notes.filter((note): note is string => note !== null && note !== '')
  return said.length > 0 ? said.join('; ') : null
}

/**
 * Adds `recapNote` to whatever the MR creation already had to say, never
 * replacing it (invariant 2: a new reason is ADDED to the existing message).
 */
function withRecapNote(outcome: ShipOutcome, recapNote: string | null): ShipOutcome {
  if (!outcome.pushed || recapNote === null) {
    return outcome
  }
  return { ...outcome, note: joinNotes(recapNote, outcome.note) }
}

/**
 * Back-writes the merge request's URL onto the recap once the MR exists, and
 * returns the sentence to add to the ship's note when it could not.
 *
 * `generateRecap` reads `mr_url` off the LAST 'shipped' journal event, which
 * on a first ship is written by the caller only after this function returns —
 * so at generation time that URL is structurally unknowable. Without this
 * second write the recap published on the issue would never link the merge
 * request it describes, on exactly the ships that opened one. Atomic like the
 * first write.
 *
 * A failure here is NOT a violation of invariant 2 — the URL survives on the
 * `shipped` event and in the merge request itself, so nothing about the ship
 * becomes unknowable — which is why it never degrades the outcome. But it
 * used to be swallowed in total silence, and "silent by design" is not a
 * shape this repo has anywhere else: a clause costs nothing and tells the one
 * reader who would otherwise wonder why `recap.json` has no `mr_url` on a
 * task that plainly opened an MR.
 */
function attachMrUrl(
  opts: ShipTaskOptions,
  prepared: PreparedRecap,
  mrUrl: string | null,
): string | null {
  if (prepared.persisted === null || mrUrl === null || prepared.persisted.mr_url === mrUrl) {
    return null
  }
  try {
    ;(opts.writeTaskRecapFn ?? writeTaskRecap)(opts.cwd, opts.task.id, {
      ...prepared.persisted,
      mr_url: mrUrl,
    })
    return null
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return `the merge request URL could not be written back onto the recap (${detail}) — the recap on disk keeps its previous contents`
  }
}

/**
 * Push + recap + MR creation. The push is the gate: if it fails, nothing
 * shipped, no recap is produced and the caller keeps the task status
 * unchanged. Past the push, every outcome is a successful ship — mrUrl null
 * with an explanatory note when no forge CLI could open the MR (not installed,
 * no matching remote, tool error).
 */
/**
 * Entry point. When `opts.driver` is set (a 'microvm' task, lot C9) and
 * neither exec seam was overridden, the push and every forge call are routed
 * through a dedicated gitops sandbox instead of running on the host — see
 * `createGitopsSession`. The sandbox is torn down in `finally` regardless of
 * how the ship ends, and it is a no-op when none was ever created (the ship
 * never got past the pre-push no-remote gate, or the push itself failed
 * before any forge candidate was tried).
 *
 * `opts.execGit`/`opts.execForge` — the test seams — always win over the
 * driver: a caller that supplies its own exec functions is explicitly
 * choosing not to run in a sandbox.
 */
export async function shipTask(opts: ShipTaskOptions): Promise<ShipOutcome> {
  if (opts.driver && opts.execGit === undefined && opts.execForge === undefined) {
    const session = createGitopsSession(opts, opts.driver)
    try {
      return await shipTaskCore(opts, session.execGit, session.execForge)
    } finally {
      await session.destroy()
    }
  }
  return shipTaskCore(opts, opts.execGit ?? defaultExecGit, opts.execForge ?? defaultExecForge)
}

async function shipTaskCore(
  opts: ShipTaskOptions,
  execGit: ShipGitExecFn,
  execForge: ShipForgeExecFn,
): Promise<ShipOutcome> {
  // D9 (degraded-mode.ts): no remote, no ship — REFUSED, and named. Without
  // this gate the push still failed, but with git's own words and no
  // `reason_code` at all: the one degradation D9 is most about ("a repo with
  // no remote") was the one the product could not name. Checked before the
  // push rather than after, so the refusal is not a network error message.
  //
  // `null` — could not ask — deliberately falls THROUGH to the push instead
  // of refusing: we have nothing honest to announce, so we let the push
  // happen and git's own words be the answer. That is also what keeps the
  // "git not found" branch below reachable.
  if ((await originRemote(execGit, opts.cwd)) === false) {
    return {
      pushed: false,
      error: SHIP_NO_REMOTE_ERROR,
      reasonCode: 'forge_unreachable',
      detail: 'no-remote',
    }
  }
  const push = await execGit(['push', '-u', 'origin', opts.task.branch], opts.cwd)
  if (push.kind === 'missing') {
    return { pushed: false, error: 'git push failed: git not found' }
  }
  if (push.kind === 'error') {
    const error = `git push failed: ${push.message}`
    // D9's third motif, and the most common of the three: the repo has a
    // remote and a forge CLI, and the machine simply cannot reach the host.
    // The push dies before any forge is asked anything, so nothing else in
    // this file would ever have named it. Everything the short list above
    // does not recognise stays uncoded, on purpose.
    return transportFailure(push.message)
      ? { pushed: false, error, reasonCode: 'forge_unreachable', detail: 'offline' }
      : { pushed: false, error }
  }
  const prepared = prepareRecap(opts)
  const outcome = await createMr(opts, execForge, buildMrDescription(prepared.source))
  if (!outcome.pushed) {
    return outcome
  }
  const attachNote = attachMrUrl(opts, prepared, outcome.mrUrl)
  // The recap state rides the outcome so the caller can journal it BY NAME:
  // a note nothing renders is a note nobody reads (majeur 2).
  const named = prepared.state ? { ...outcome, recapState: prepared.state } : outcome
  return withRecapNote(named, joinNotes(prepared.note, attachNote))
}
