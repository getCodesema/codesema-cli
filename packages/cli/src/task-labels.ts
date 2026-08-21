// T3.7 — the cycle of a task, mirrored onto the forge issue it is bound to,
// as `codesema:*` labels (decision D15). One channel, one direction: a status
// transition poses a label; a label posed by hand triggers nothing (the
// reverse synchronisation is out of scope, and there is no polling here).
//
// Three properties hold this module together, and each of them is a rule the
// rest of the file exists to keep:
//
//   1. OPT-IN, OFF BY DEFAULT, PER PROJECT (D15). The very first thing done is
//      reading the project's own configuration, and a project that has not
//      opted in leaves this module before a single forge argv is BUILT — not
//      built and discarded. A project without the opt-in behaves exactly as it
//      did before this ticket existed.
//
//   2. THE PREFIX IS THE OWNERSHIP BOUNDARY. `setLabels` (forge-issues.ts)
//      REPLACES an issue's whole label set — neither `gh issue edit` nor
//      `glab issue update` can replace one, so both go through `api` — which
//      makes a partial write a DESTRUCTION of somebody else's labels, not a
//      degradation. Every write here is therefore read-recompose-reemit: the
//      issue's current labels are read, only the `codesema:` subset is
//      recomputed, and every other label is re-emitted VERBATIM. `codesema-legacy`
//      (no colon) is not a cycle label and survives untouched.
//
//   3. THE LABEL IS AN EFFECT OF THE TRANSITION, NEVER A CONDITION OF IT. No
//      outcome of this module enters any decision, and none of them touches
//      the task record: an unreachable forge yields `forge_unreachable` on a
//      JOURNAL EVENT and nothing else, so the status transition ends exactly
//      where it would have ended with the labels off (design decision 2). The
//      degradation is still never silent (invariant 2): readable message,
//      journal event, and the API surfacing that journal.
//
// Same doctrine as task-issue.ts, its closest sibling: never throws by
// contract, every forge call goes through T2.1's injected `execFn`, and no
// test ever spawns gh/glab or touches the network — the argv IS the assertion.
//
// NOT WIRED FROM HERE. `syncCycleLabel` is a pure entry point: it writes to the
// forge and returns what happened, and its caller decides when to call it and
// appends the event it hands back — exactly the shape `reconcileIssueSnapshot`
// / `issueReconcileEvent` already have in task-issue.ts. The status
// transitions of `task-server.ts` and the end of merge of `task-merge.ts`
// (T3.6, `codesema:merged`) are the two call sites this is meant for; neither
// is called from this module.

import { resolveProjectConfig } from './config.js'
import type { TaskIssueRef, TaskReason, TaskStatus } from './contract.js'
import {
  createLabel,
  forgeIssueReason,
  getIssue,
  listLabels,
  setLabels,
  type ForgeCli,
  type ForgeIssuesExecFn,
  type ForgeUnavailable,
} from './forge-issues.js'
import type { AppendTaskEventInput } from './tasks-store.js'

/**
 * What this product owns on an issue, and the only thing it ever writes.
 *
 * A SIMPLE colon, deliberately, and not GitLab's scoped-label form
 * (`scope::value`). GitLab gives a scoped label forge-side mutual exclusion
 * for free — setting `codesema::running` would drop `codesema::queued` by
 * itself — but GitHub has no such notion at all, so half the users would get
 * an exclusion the other half would not, on a name the two forges do not read
 * the same way. The exclusion is therefore computed HERE, on both forges
 * alike, over a closed set this build knows; the consequence for GitLab is
 * that its `codesema:` labels are ordinary labels, with no scoped-label
 * behaviour, no forge-side exclusion and no scoped rendering in its UI. That
 * is a documented asymmetry, not an oversight (D8).
 */
export const CYCLE_LABEL_PREFIX = 'codesema:'

export const CYCLE_LABELS = [
  'codesema:queued',
  'codesema:in-progress',
  'codesema:reviewing',
  'codesema:blocked',
  'codesema:merged',
] as const

export type CycleLabel = (typeof CYCLE_LABELS)[number]

/** What a created `codesema:*` label says about itself, in the forge's own UI. */
export const CYCLE_LABEL_DESCRIPTION = 'Task cycle, driven by codesema'

/**
 * Nine task statuses, four labels — and a `Record<TaskStatus, …>`, so the
 * exhaustiveness is STRUCTURAL: a tenth status added to the contract does not
 * compile until it is given a place here. The grouping is a choice this ticket
 * makes and the plan does not; it is documented in the README next to the
 * answer to D15, and it reads as "what is happening to this ticket, from the
 * outside":
 *
 *   - `queued` is the only thing that is genuinely waiting for a slot;
 *   - `running` is the only thing an agent is actively working on;
 *   - `reviewing`, `review_ok` and `shipped` are all "the work exists and is
 *     under review" — `review_ok` waits to be shipped, `shipped` waits for a
 *     human to merge its MR. Neither is merged, and calling either of them
 *     `codesema:merged` would be a claim about the target branch that nothing
 *     here has verified;
 *   - `waiting_for_you`, `review_ko`, `failed` and `interrupted` are the four
 *     ways a task stops needing the machine and starts needing a person. On
 *     the forge that difference is what matters, so they share
 *     `codesema:blocked`.
 *
 * `codesema:merged` is deliberately ABSENT from this table's range, and that
 * is the property `task-labels.test.ts` pins: no task STATUS means "merged" —
 * a task record stays `shipped` after its branch lands — so that label is
 * posed only by whoever actually performed the merge (T3.6), through
 * `syncCycleLabel` with the label named explicitly.
 */
export const CYCLE_LABEL_BY_STATUS: Record<TaskStatus, CycleLabel> = {
  queued: 'codesema:queued',
  running: 'codesema:in-progress',
  waiting_for_you: 'codesema:blocked',
  reviewing: 'codesema:reviewing',
  review_ok: 'codesema:reviewing',
  review_ko: 'codesema:blocked',
  shipped: 'codesema:reviewing',
  failed: 'codesema:blocked',
  interrupted: 'codesema:blocked',
}

export function cycleLabelForStatus(status: TaskStatus): CycleLabel {
  return CYCLE_LABEL_BY_STATUS[status]
}

/**
 * The PREFIX decides, never the closed five. Design decision 3 draws the
 * ownership boundary at `codesema:` — "everything outside it is re-emitted
 * without interpretation" — which cuts both ways: a `codesema:` label this
 * build does not know (an older one, a newer one, one typed by hand) is ours
 * and gets recomposed away, and a `codesema-legacy` is NOT ours, whatever it
 * looks like, and is re-emitted verbatim.
 */
export function isCodesemaLabel(name: string): boolean {
  // Case-INSENSITIVE on the prefix alone. A `Codesema:queued` typed by hand,
  // or re-emitted by a forge that normalised the casing of a name it already
  // held, is unmistakably one of ours to any human reading the issue; leaving
  // it outside the boundary made it survive the recomposition and COEXIST
  // with the label just posed, so the issue displayed two cycle labels at
  // once — precisely the state rule 2 exists to prevent. What decides is
  // still the prefix and nothing but the prefix: `codesema-legacy` has no
  // colon, is not ours in any casing, and is re-emitted verbatim.
  return name.slice(0, CYCLE_LABEL_PREFIX.length).toLowerCase() === CYCLE_LABEL_PREFIX
}

/**
 * The issue's next label set, or null when it already IS the target — the
 * comparison that makes the pose idempotent (no write on no difference).
 *
 * Foreign labels keep their order and their spelling; the cycle label is
 * appended last, so the argv a test asserts is deterministic. The "already
 * the target" test is the one that has to be exact: carrying the target is not
 * enough, since an issue holding BOTH `codesema:queued` and
 * `codesema:in-progress` is precisely the state this is supposed to repair.
 */
export function recomposeCycleLabels(
  current: readonly string[],
  target: CycleLabel,
): string[] | null {
  const foreign = current.filter((name) => !isCodesemaLabel(name))
  const ours = current.filter((name) => isCodesemaLabel(name))
  if (ours.length === 1 && ours[0] === target) {
    return null
  }
  return [...foreign, target]
}

/**
 * Whether THIS project drives cycle labels (T1.4's `resolveProjectConfig`, so
 * the documented precedence applies: a repo `.codesema/config.json` outranks
 * `~/.config/codesema/config.json`). Absent means NO — `=== true` and not a
 * truthiness test, so a project only ever writes to a forge because someone
 * wrote the word `true` in a file.
 *
 * Re-read at every transition rather than captured at boot: an opt-in is a
 * decision about someone's repository, and revoking it must not require
 * restarting the workspace.
 */
export function cycleLabelsEnabled(projectPath: string | null): boolean {
  return resolveProjectConfig(projectPath).config.forgeCycleLabels === true
}

/**
 * Which forge step could not complete — forensic, never a decision.
 *
 * `internal` is the fourth and names something else entirely: not a step that
 * failed on a forge, but the injected seam itself throwing where its own
 * contract says it returns. It exists so `syncCycleLabel` can honour "never
 * throws" without having to claim a forge step it cannot know (see there).
 */
export type CycleLabelStep = 'read' | 'create' | 'write' | 'internal'

/**
 * A failed label pose, fully stated.
 *
 * `reason` is null exactly when `forgeIssueReason` maps the unavailability to
 * no D2 code — an `invalid-input`, which means the call NEVER REACHED a forge
 * (an issue label carrying a comma, which GitLab's one-string contract cannot
 * express, is the realistic case). Claiming `forge_unreachable` there would
 * journal an outage that did not happen, which is the "right decision, wrong
 * announcement" trap; `detail` carries the truth in both cases, and the
 * journal line says the same thing either way — the label was not posed —
 * because that IS the same thing either way.
 */
export type CycleLabelFailure = {
  kind: 'failed'
  label: CycleLabel
  at: CycleLabelStep
  reason: TaskReason | null
  detail: string
}

export type CycleLabelOutcome =
  /** No opt-in: nothing was read, nothing was built, nothing was asked. */
  | { kind: 'disabled' }
  /** The task carries no forge issue — there is nowhere to pose anything. */
  | { kind: 'no_issue' }
  /** The issue already carries exactly this cycle label: no write was emitted. */
  | { kind: 'unchanged'; label: CycleLabel }
  | { kind: 'posed'; label: CycleLabel; labels: string[]; created: boolean }
  | CycleLabelFailure

type ForgeCall = { cwd: string; execFn?: ForgeIssuesExecFn | undefined }

function failed(
  label: CycleLabel,
  at: CycleLabelStep,
  result: ForgeUnavailable,
): CycleLabelFailure {
  const detail = result.detail ? `${result.reason}: ${result.detail}` : result.reason
  return { kind: 'failed', label, at, reason: forgeIssueReason(result), detail }
}

/**
 * "The label already exists", in the words of each forge — the ONE creation
 * failure that is not a failure at all.
 *
 * `ensureCycleLabel` decides on a CATALOG, and a catalog can be wrong in ways
 * `truncated` does not cover: a human or a second process creating the label
 * between the `label list` and the `label create`, or a name already held in a
 * different casing (both REST APIs answer a duplicate rather than a second
 * label, and `catalog.labels.includes` is exact). Treating that answer as an
 * outage would break the spec's own sentence — "a label already created causes
 * neither an error nor a second creation, and the label is simply posed" —
 * and, in the casing case, break it PERMANENTLY: every later transition would
 * re-attempt the same creation, get the same refusal, and never pose anything.
 *
 * Matched on the forge's own words rather than on an exit code, because that
 * is all either CLI gives back: GitHub answers `422 … already_exists`, GitLab
 * `409 Label already exists`, and both porcelains echo the API's message. A
 * message this does NOT recognise stays a failure — the fallback widens on
 * evidence, never on a guess.
 */
const LABEL_ALREADY_EXISTS = /already[\s_-]?exists|has already been taken/i

function labelAlreadyExists(result: ForgeUnavailable): boolean {
  // `cli-error` only: an `invalid-input` never reached a forge, so nothing out
  // there can have told us the name was taken.
  return result.reason === 'cli-error' && LABEL_ALREADY_EXISTS.test(result.detail ?? '')
}

/**
 * Lazy creation, and the second of the two idempotences (design decision 4):
 * the label is created WHEN IT SERVES, and only if the catalog proves it
 * absent. A project whose tasks never reach a merge therefore never sees
 * `codesema:merged` appear in its repository.
 *
 * A TRUNCATED catalog proves nothing: past `LABEL_LIST_MAX` the name might be
 * there, unseen. Creating on that guess is exactly what "a label already
 * created causes neither an error nor a second creation" forbids, so the pose
 * goes ahead WITHOUT a creation instead. If the label really was missing, the
 * pose says so on its own, through the ordinary failure path.
 *
 * A catalog that could not be READ is the other way round, and stops here: an
 * unreadable catalog usually means the forge itself is not answering, and the
 * write that would follow is a TOTAL replacement of the issue's label set —
 * the one call in this module that must never be attempted on a forge whose
 * health is in doubt.
 *
 * `pin` is the forge the issue was read from (MAJEUR 2): the catalog of the
 * other one answers nothing about this one.
 */
async function ensureCycleLabel(
  forge: ForgeCall,
  label: CycleLabel,
  pin: ForgeCli | null,
): Promise<{ ok: true; created: boolean } | CycleLabelFailure> {
  const catalog = await listLabels({ ...forge, pin })
  if (!catalog.available) {
    return failed(label, 'create', catalog)
  }
  if (catalog.truncated || catalog.labels.includes(label)) {
    return { ok: true, created: false }
  }
  const made = await createLabel({
    ...forge,
    pin,
    name: label,
    description: CYCLE_LABEL_DESCRIPTION,
  })
  if (made.available) {
    return { ok: true, created: true }
  }
  // The catalog was wrong, not the forge: the label is there, so the pose is
  // exactly as valid as if this call had created it.
  return labelAlreadyExists(made) ? { ok: true, created: false } : failed(label, 'create', made)
}

async function poseCycleLabel(
  forge: ForgeCall,
  iid: number,
  label: CycleLabel,
): Promise<CycleLabelOutcome> {
  const read = await getIssue({ ...forge, number: iid })
  if (!read.available) {
    // Rule 2's whole point: without the CURRENT set there is nothing to
    // re-emit, and `setLabels` replaces everything. A write here would erase
    // every label the issue carries. The read failing is the end of the
    // attempt, never the start of a blind write.
    return failed(label, 'read', read)
  }
  // MAJEUR 2, and the other half of rule 2. The read walks the ladder (both
  // CLIs are tried on a remote that names neither forge); the write must not.
  // `setLabels` REPLACES the whole set, so re-emitting GitLab's labels through
  // `gh` would not degrade the issue on GitHub, it would overwrite it with a
  // set that never belonged to it. Everything after the read is therefore
  // pinned to the forge that ANSWERED the read.
  const pin = read.answeredBy ?? null
  const next = recomposeCycleLabels(read.issue.labels, label)
  if (next === null) {
    return { kind: 'unchanged', label }
  }
  const ensured = await ensureCycleLabel(forge, label, pin)
  if ('kind' in ensured) {
    return ensured
  }
  const written = await setLabels({ ...forge, pin, number: iid, labels: next })
  return written.available
    ? { kind: 'posed', label, labels: next, created: ensured.created }
    : failed(label, 'write', written)
}

/**
 * In-flight poses, keyed by (project, issue). Two transitions closer together
 * than one forge round trip would otherwise interleave their
 * read-recompose-write triples and land on the issue in the WRONG ORDER — the
 * final label naming a status the task has already left (design.md, "closely
 * spaced transitions"). Serialising per issue makes the order of the writes
 * the order of the transitions, and it is per ISSUE precisely so two different
 * tasks never wait on each other.
 *
 * The map holds only what is in flight: each chain removes its own entry when
 * it settles, so nothing accumulates across a long-lived workspace.
 */
const inFlight = new Map<string, Promise<CycleLabelOutcome>>()

function serialize(key: string, run: () => Promise<CycleLabelOutcome>): Promise<CycleLabelOutcome> {
  const previous = inFlight.get(key)
  // `then(run, run)` and not `then(run)`: a chain that rejected must not take
  // every later transition on that issue down with it.
  const next = previous ? previous.then(run, run) : run()
  inFlight.set(key, next)
  const release = () => {
    if (inFlight.get(key) === next) {
      inFlight.delete(key)
    }
  }
  next.then(release, release)
  return next
}

/**
 * How many poses are in flight. Exported for ONE reason, and it is the reason
 * the purge above needed one: `release` is a promise about MEMORY, and memory
 * is the single thing no assertion on an outcome or an argv can see. Drop
 * `next.then(release, release)` and every test in this repo stays green while
 * the map grows by one entry per transition for the lifetime of the
 * workspace. This is the seam that makes that difference visible, and it is a
 * COUNT rather than the map itself so no caller can reach in and mutate it.
 */
export function cycleLabelPosesInFlight(): number {
  return inFlight.size
}

/**
 * Poses ONE cycle label on the issue a task is bound to, and says what
 * happened. Never throws, never touches the task record, never decides
 * anything.
 *
 * "Never throws" is meant literally, including for what the seam contract does
 * not allow: `runForgeCli` answers a typed `ForgeCliOutcome` and never
 * rejects, but an INJECTED `execFn` is somebody else's code, and a caller
 * wiring this up as `void syncCycleLabel(…)` — the shape a fire-and-forget
 * effect naturally takes — would turn one rejection into an unhandled
 * rejection that takes a workspace down over a label. That rejection is
 * therefore caught here and stated as an ordinary failure, `at: 'internal'`
 * and with NO reason code: nothing out there was proven unreachable, so
 * journalling a forge outage would be the wrong announcement.
 *
 * `label` is passed explicitly rather than derived from a status, so the two
 * call sites this is written for read the same way and neither owns a table:
 * a status transition passes `cycleLabelForStatus(record.status)`, and the end
 * of a merge (T3.6) passes `'codesema:merged'`, which no status maps to.
 */
export async function syncCycleLabel(opts: {
  /** The project: both the configuration scope and the cwd forge calls run in. */
  cwd: string
  issue: TaskIssueRef | null | undefined
  label: CycleLabel
  execFn?: ForgeIssuesExecFn | undefined
}): Promise<CycleLabelOutcome> {
  // Rule 1. Before the issue is even looked at: a project that has not opted
  // in must not be distinguishable, from the outside, from one running a build
  // that predates this module.
  if (!cycleLabelsEnabled(opts.cwd)) {
    return { kind: 'disabled' }
  }
  const issue = opts.issue
  if (!issue) {
    return { kind: 'no_issue' }
  }
  const forge: ForgeCall = { cwd: opts.cwd, ...(opts.execFn ? { execFn: opts.execFn } : {}) }
  // The catch is HERE and not inside `serialize`'s `run`, deliberately: the
  // chain kept in `inFlight` stays rejectable, which is what gives
  // `then(run, run)` above something to actually protect the next transition
  // from. Swallowing it one level down would turn that arm into dead code.
  return serialize(`${opts.cwd} ${String(issue.iid)}`, () =>
    poseCycleLabel(forge, issue.iid, opts.label),
  ).catch((error: unknown): CycleLabelOutcome => ({
    kind: 'failed',
    label: opts.label,
    at: 'internal',
    reason: null,
    detail: `the forge seam threw instead of answering: ${error instanceof Error ? error.message : String(error)}`,
  }))
}

/**
 * The journal line for a cycle label that could not be posed — null for every
 * other outcome, because there is nothing to say: a successful pose is not
 * news, and one line per transition would drown the journal it is meant to
 * inform.
 *
 * `type: 'issue'` and not a new `TaskEventType`: DP9's grammar says the type
 * names the DOMAIN and `data.name` names the incident, and the domain here is
 * exactly the one `issue` already covers — "a fact about the forge issue this
 * task is bound to". A tenth cause on an existing domain costs one `data.name`
 * and one catalog key; a new type would have cost eight obligations to say the
 * same thing.
 *
 * `data.message` is the English sentence for the API and CLI readers that
 * carry no catalog; the web renders the translated line from `data.name`
 * instead (`issueEventText`, useTaskBoard.ts), which is why nothing here is
 * pre-worded for a human.
 *
 * NEUTRAL by intent, through `ISSUE_EVENT_TONE`'s routine fallback: a stale
 * label refuses nothing, asks nothing of anyone and will be corrected by the
 * next transition. Painting it amber would put a task on the "waiting for a
 * person" pile over a cosmetic detail of the forge (DP9's cry-wolf).
 */
export function cycleLabelEvent(outcome: CycleLabelOutcome): AppendTaskEventInput | null {
  if (outcome.kind !== 'failed') {
    return null
  }
  return {
    type: 'issue',
    data: {
      name: 'label_not_posed',
      label: outcome.label,
      step: outcome.at,
      message: `the ${outcome.label} cycle label could not be posed on the forge (${outcome.detail}); the task's status is unaffected and the label is left as it was, to be corrected at the next transition`,
    },
    ...(outcome.reason ? { reason_code: outcome.reason.code } : {}),
  }
}
