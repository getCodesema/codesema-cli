// THE ANSWER TO D9, AND THE ONE PLACE IT IS WRITTEN.
//
// ── The rule ────────────────────────────────────────────────────────────────
//
// Without an `origin` remote, without `gh`/`glab`, or offline, codesema
// CONTINUES to create `title + prompt` tasks — the whole 0.12 path, unchanged
// and unconditional — and, in that state, it:
//
//   * binds NO issue        — a creation FROM an issue is refused, with its
//                             reason, leaving no record, no worktree and no
//                             queue entry (`admitIssue` runs before anything
//                             is written; `TaskManager.create`);
//   * posts NO recap        — the ship stops at the push when a forge CLI is
//                             there but cannot open the MR, and is refused
//                             outright when there is no remote to push to
//                             (`shipTask`, task-ship.ts);
//   * performs NO merge     — the four conditions of D12 cannot be met without
//                             a forge, and nothing here fakes them.
//
// A task ALREADY BOUND to an issue and already launched keeps going: it runs
// its whole cycle on the criteria and body frozen in its `issue_snapshot`,
// which is the ONLY local cache of the degraded mode and is used in READ-ONLY.
// No issue cache of any other kind is ever written, and no turn ever restarts
// by itself when the forge comes back (D7 — the choice stays human).
//
// Every capability lost this way is NAMED, never merely absent: the D2 code
// `forge_unreachable` (contract/src/reasons.ts, T1.1) rides BESIDE the
// readable message that was already produced — never instead of it — with the
// forge client's own motif propagated VERBATIM into the reason's `detail`:
// `no-remote`, `no-cli` or `cli-error`, told apart from each other all the way
// to the UI — plus `offline`, the third case D9's own title names, which no
// forge client can ever answer because the push dies before a forge is asked.
//
// This module exists so that rule has a single home. It is deliberately tiny:
// the degraded mode is not a second engine, it is the surface that remains
// when the capabilities J2 added are removed (design D-a). Everything below is
// the vocabulary that rule needs — the three motifs, how a detail is composed
// from one, and the boot probe that lets the workspace SAY which of them
// applies before anything is even attempted.
//
// Also authoritative for D37 (a repo with no remote at setup, J6/J7): a J6/J7
// ticket that answers differently is the one in the wrong.
//
// ── Why a probe at boot rather than a probe per request ─────────────────────
//
// `TaskManager.workspaceInfo()` is SYNCHRONOUS and `GET /api/projects` calls
// it once per registered project plus once for the workspace. Asking `gh` and
// `glab` whether they exist is an `execFile`; doing it there would put N+1
// subprocess spawns on a request that answers a registry. The precedent is
// `isolation_available`: the container runtime is probed ONCE at boot
// (`probeIsolation`), the result is injected into `createTaskManager`, and
// per-project facts are overlaid on top of it (`overlayIsolationProbe`). The
// forge follows the same shape, and for the same reason.

import type { ForgeCli, ForgeCliOutcome, ForgeIssueReason } from './forge-issues.js'
import { forgeHintOfUrl, git, type ForgeHint } from './git.js'

/**
 * The three motifs of D9's "forge unavailable", and only those. Declared as a
 * table rather than a bare union so the wire value can be whitelisted at the
 * boundary, and `satisfies` pins them as a SUBSET of the forge client's own
 * `ForgeIssueReason`: they are propagated verbatim from it, so a member that
 * stopped existing there must stop compiling here.
 *
 * The two members of `ForgeIssueReason` this list deliberately omits are
 * `invalid-input` and `unsupported`, and the omission is the same one
 * `forgeIssueReason` already makes: both mean a forge that ANSWERED (or was
 * never asked), which is not a reachability degradation and carries no D2
 * code. Adding them here would make the workspace announce an outage that did
 * not happen.
 *
 * `satisfies` only pins the members that ARE here as legal ones; it says
 * nothing about the ones missing, and a table amputated of `cli-error` still
 * compiles. What pins the COMPLETENESS is the test that walks
 * `ForgeIssueReason` and asserts this table holds exactly the motifs
 * `forgeIssueReason` maps to a D2 code (degraded-mode.test.ts).
 */
export const FORGE_DEGRADATIONS = [
  'no-remote',
  'no-cli',
  'cli-error',
] as const satisfies readonly ForgeIssueReason[]

export type ForgeDegradation = (typeof FORGE_DEGRADATIONS)[number]

/**
 * Everything a `forge_unreachable` detail is allowed to LEAD with, so that a
 * reader can always take the motif off the front of a detail and know which
 * kind of unreachable it was.
 *
 * The forge client's own five reasons are here verbatim — including the two
 * that carry no D2 code of their own (`invalid-input`, `unsupported`): they
 * never produce a `forge_unreachable` by themselves, but a caller can
 * deliberately pose one OVER them (`reconcileIssueSnapshot` does, because a
 * ticket it once read and can no longer read IS unreachable to it), and that
 * detail must still say which motif it is standing on.
 *
 * Two motifs are OURS, and neither belongs in `FORGE_DEGRADATIONS` — the wire
 * field the header renders carries only what the forge CLIENT can answer:
 *
 *  - `offline`: the transport to the remote failed. Not a forge that refused,
 *    a host we never reached (`task-ship.ts`).
 *  - `timed-out`: we stopped waiting inside our own budget. Nothing is known
 *    about the forge, which is precisely what the motif says.
 */
export type ForgeUnreachableMotif = ForgeIssueReason | 'offline' | 'timed-out'

/**
 * The `detail` of a `forge_unreachable` reason, composed the ONE way the whole
 * repo composes it: the motif first, VERBATIM and never reworded, then the
 * producer's own words when there are any. Two properties this shape buys, and
 * that the callers depend on:
 *
 *  - a reader can tell `no-cli` from `cli-error` by the prefix alone, which is
 *    the entire reason `runForgeCli` keeps 'missing' and 'error' apart in the
 *    first place (`tryExec`, git.ts, collapses both into `null`);
 *  - the readable half survives. Invariant 2: the code is ADDED to the message
 *    that was already produced, it never replaces it.
 *
 * `taskReason` applies `TASK_REASON_DETAIL_MAX` on the way to the record, and
 * the motif sits at the FRONT, so even a truncation cannot cost the name.
 */
export function forgeReasonDetail(motif: ForgeUnreachableMotif, words?: string | null): string {
  const said = typeof words === 'string' ? words.trim() : ''
  return said ? `${motif}: ${said}` : motif
}

/**
 * What ONE forge CLI answered when the boot asked it to name itself. The three
 * outcomes `runForgeCli` already tells apart, kept apart here for the same
 * reason: `missing` and `error` mean opposite things for what the user has to
 * do about it, and collapsing them is the mistake `tryExec` makes.
 */
export type ForgeCliStatus =
  { kind: 'ok' } | { kind: 'missing' } | { kind: 'error'; message: string }

/**
 * What the machine knows about the forge CLIs, once, at boot. Machine-wide by
 * construction: `gh`/`glab` are resolved off the PATH of THIS process, and the
 * answer is the same for every registered repo — unlike the repo's `origin`,
 * which is a fact about ONE repo and is overlaid per project
 * (`forgeWorkspaceFacts`).
 *
 * BOTH CLIs are recorded, never just the first one that answered (T2.7
 * round-2, majeur 3): "a forge CLI runs on this machine" is not the question
 * a repo needs answered. A GitLab origin is served by `glab` and by nothing
 * else — `candidatesFor` (forge-issues.ts) will not even launch `gh` there —
 * so a workspace that only knew "gh works" announced a forge it could not
 * actually reach.
 */
export type ForgeProbe =
  | { kind: 'probed'; gh: ForgeCliStatus; glab: ForgeCliStatus }
  /** Nothing was probed. NOT the same as "no forge": see UNPROBED_FORGE. */
  | { kind: 'unprobed' }

/**
 * The probe a workspace starts from when nothing probed yet (tests, plain
 * servers) — mirroring `UNPROBED_ISOLATION`. It answers "unknown", and
 * `forgeWorkspaceFacts` turns that into the ABSENCE of the fields rather than
 * into an optimistic `true`: a UI that is told nothing must say it does not
 * know, never that the forge is fine.
 */
export const UNPROBED_FORGE: ForgeProbe = { kind: 'unprobed' }

/**
 * Signature the boot probe is injected through. Structurally the forge issue
 * client's own `ForgeIssuesExecFn`, so `runForgeCli` can be handed over as is
 * by the caller — the DEFAULT lives at the call site (workspace.ts) rather
 * than here, on purpose: this module must not import forge-issues at runtime,
 * which is what keeps the dependency one-way (forge-issues → degraded-mode).
 */
export type ForgeProbeExecFn = (
  cli: ForgeCli,
  args: string[],
  cwd: string,
) => Promise<ForgeCliOutcome>

/** The argv. `--version` costs nothing and reaches no network. */
const PROBE_ARGS: readonly string[] = ['--version']

function statusOf(outcome: ForgeCliOutcome): ForgeCliStatus {
  switch (outcome.kind) {
    case 'ok':
      return { kind: 'ok' }
    case 'missing':
      return { kind: 'missing' }
    // 'error' and 'invalid' both mean a binary that is THERE and did not
    // answer: its own words, verbatim, never reworded into a sentence of ours.
    default:
      return { kind: 'error', message: outcome.message }
  }
}

/**
 * Which forge CLIs are installed on this machine, and do they run?
 *
 * BOTH are asked, and asked AT ONCE. Both, because which one matters is a
 * question of the repo, not of the machine, and only `forgeWorkspaceFacts`
 * knows the repo. At once, because each probe carries its own budget
 * (`FORGE_ISSUE_TIMEOUT_MS`, 8s) and running them in a line made the worst
 * case the SUM of the two — 16s of a boot nobody is watching, before the
 * workspace lock is even acquired. Same shape as the isolation and agent
 * probes, which are already launched together for exactly that reason.
 *
 * `--version` deliberately reaches no network and reads no token: booting the
 * workspace must not phone a forge, and this probe answers "can a forge CLI
 * run at all", not "is it authenticated". A `gh` that runs but is refused by
 * the API surfaces as `cli-error` where it actually happens — on the task that
 * asked (`forgeIssueReason`, `shipTask`) — with the CLI's own words.
 */
export async function probeForgeCli(execFn: ForgeProbeExecFn, cwd: string): Promise<ForgeProbe> {
  const [gh, glab] = await Promise.all([
    execFn('gh', [...PROBE_ARGS], cwd),
    execFn('glab', [...PROBE_ARGS], cwd),
  ])
  return { kind: 'probed', gh: statusOf(gh), glab: statusOf(glab) }
}

/**
 * What this repo's `origin` is — and whether the question could be asked at
 * all. Tri-state on purpose: `none` only when git ANSWERED that there is no
 * usable origin, `unknown` when the question could not be asked — not a repo,
 * git missing, an unreadable path, a working tree on a dead mount. Announcing
 * `no-remote` for a repo we simply failed to read would be the "right
 * decision, wrong announcement" mistake: the honest answer there is "unknown".
 *
 * When there IS an origin, its URL comes back as a forge HINT rather than as
 * the URL itself: that is the only thing anyone here needs from it, and it
 * keeps a remote's credentials out of a payload the UI receives.
 */
export type ForgeOrigin =
  { kind: 'origin'; hint: ForgeHint } | { kind: 'none' } | { kind: 'unknown' }

export type ForgeRemoteProbeFn = (cwd: string) => ForgeOrigin

/** Nothing to ask (no project in scope): "unknown", never an optimistic answer. */
export const FORGE_ORIGIN_UNKNOWN: ForgeOrigin = { kind: 'unknown' }

/** Exit code git uses for "there is no remote by that name" (git 2.53.0). */
const GIT_NO_SUCH_REMOTE = 2

/**
 * Budget of this one git read. `git remote get-url` reads `.git/config` and
 * nothing else, so 2s is already two orders of magnitude more than it needs —
 * the number is not a performance tuning, it is the bound that keeps a repo
 * whose working tree sits on a SUSPENDED network mount from freezing the HTTP
 * server for good. `GET /api/projects` calls this once per registered project,
 * synchronously, on the request thread: without a timeout, one dead mount is
 * a permanently hung workspace (git.ts documents `timeoutMs` for exactly the
 * unattended callers this is one of).
 */
export const FORGE_REMOTE_PROBE_TIMEOUT_MS = 2000

/**
 * The probe with its budget spelled out. Exported only so a test can hand it
 * a budget short enough to prove the bound EXISTS — a timeout nothing
 * exercises is a comment. Production always goes through
 * `probeOriginRemote` below, on `FORGE_REMOTE_PROBE_TIMEOUT_MS`.
 */
export function originProbe(cwd: string, timeoutMs: number): ForgeOrigin {
  let url: string
  try {
    url = git(['remote', 'get-url', 'origin'], cwd, { timeoutMs })
  } catch (err) {
    return (err as { status?: unknown }).status === GIT_NO_SUCH_REMOTE
      ? { kind: 'none' }
      : { kind: 'unknown' }
  }
  const said = url.trim()
  // A remote whose URL is blank (`git remote set-url origin "   "`, which git
  // accepts and reports with exit 0) is not something anything can push to or
  // read from: the same `none` the ship answers, so the header and the refusal
  // cannot contradict each other on the same repo.
  return said === '' ? { kind: 'none' } : { kind: 'origin', hint: forgeHintOfUrl(said) }
}

export const probeOriginRemote: ForgeRemoteProbeFn = (cwd) =>
  originProbe(cwd, FORGE_REMOTE_PROBE_TIMEOUT_MS)

/**
 * Which forge CLIs can serve a repo whose origin points THERE — the one rule,
 * shared with the ladder that actually launches them (`candidatesFor`,
 * forge-issues.ts, which calls this). A known forge admits exactly one CLI; an
 * unrecognized (self-hosted) remote admits both, gh first.
 */
export function forgeCandidates(hint: ForgeHint): readonly ForgeCli[] {
  const candidates: ForgeCli[] = []
  if (hint !== 'gitlab') {
    candidates.push('gh')
  }
  if (hint !== 'github') {
    candidates.push('glab')
  }
  return candidates
}

/**
 * The forge half of the `workspace` payload of `GET /api/projects`, shaped
 * exactly like its `isolation_*` neighbours: a fact, plus the reason for it.
 *
 * BOTH fields are OPTIONAL and their absence means "unknown" — never "the
 * forge is available". That is the doctrine `WorkspaceInfo` already documents
 * for `isolation_configured`, and it is the only honest default here: an
 * older CLI, a workspace that never probed, or a project whose repo could not
 * be read all answer "I cannot tell", and a UI that inferred availability from
 * silence would put the degradation back in the dark that D9 exists to end.
 */
export type ForgeWorkspaceFacts = {
  /** Absent = unknown. True only when a CLI THIS repo can use runs, and it has an origin. */
  forge_available?: boolean
  /** Present only alongside `forge_available: false`; the motif, verbatim. */
  forge_reason?: ForgeDegradation
}

/**
 * Binds the machine-wide probe to ONE repo — the forge's
 * `overlayIsolationProbe`.
 *
 * `no-remote` wins over everything else, because that is the order the forge
 * client itself decides in: `attempt()` checks `remote get-url origin` BEFORE
 * launching any candidate, so a repo with no origin never produces `no-cli`
 * even on a machine that has neither binary. The header must name the motif
 * the next real call would name, not a different one.
 *
 * And for the same reason it walks the repo's CANDIDATES rather than the
 * machine's inventory: on a GitLab origin `candidatesFor` never launches `gh`,
 * so a machine that only has `gh` is `no-cli` THERE, whatever it can do
 * elsewhere. Reporting the machine's answer instead is how the header came to
 * say "available" about a repo whose every real call answered `no-cli`.
 *
 * Pure: no I/O. Both probes are the injectable seams.
 */
export function forgeWorkspaceFacts(probe: ForgeProbe, origin: ForgeOrigin): ForgeWorkspaceFacts {
  if (origin.kind === 'none') {
    return { forge_available: false, forge_reason: 'no-remote' }
  }
  if (origin.kind === 'unknown' || probe.kind === 'unprobed') {
    return {}
  }
  const usable = forgeCandidates(origin.hint).map((cli) => probe[cli])
  if (usable.some((status) => status.kind === 'ok')) {
    return { forge_available: true }
  }
  // One that RAN and failed is `cli-error`, never `no-cli` — the same ladder
  // `attempt()` walks: only when every candidate was MISSING is it no-cli.
  return usable.some((status) => status.kind === 'error')
    ? { forge_available: false, forge_reason: 'cli-error' }
    : { forge_available: false, forge_reason: 'no-cli' }
}
