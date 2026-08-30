// T3.3 (D14): the BOUNDED review → fix → re-review loop, as a decision and
// nothing else.
//
// This module never writes a status and never starts a turn. It answers one
// question — "after this review, is there another automatic fix round, or is
// this task going back to a human?" — and hands the answer to the ONE place
// that already owns the final transition (task-server's `onTurnDone`, through
// the same gate mechanism T3.1 built for checks). That separation is the whole
// point: a second orchestrator watching verdicts and re-scheduling turns would
// be a second writer of the same record, which T3.1 forbids by name.
//
// Two things are worth stating up front, because they are what make the loop
// terminate and survive a reboot.
//
//  1. THE COUNTER IS DERIVED, AND IT IS DERIVED FROM THE DISK. There is no
//     field on `TaskRecord` for it (a critère d'acceptation, not a taste), and
//     no counter in memory either. It is read back out of the task's own
//     journal, so a workspace that restarts mid-loop resumes counting where it
//     left off without rehydrating anything.
//
//  2. IT DOES NOT MATCH ON THE SHAPE OF A PROMPT. `TaskTurn` carries no marker
//     of what kind of turn it was (`prompt`, `response`, `question`, timings,
//     cost — that is the whole type), so "count the fix turns in
//     `record.turns`" could only mean "count the turns whose prompt looks like
//     `buildAgentFixPrompt`'s output", which breaks silently the first time
//     that prompt is reworded. The loop journals its OWN decision instead,
//     before acting on it, and counts those lines.
//
// The design left the derivation open between two candidates — the turns in
// `record.turns`, or the `request_changes` reviews — and this module takes a
// third: a marker the loop writes itself. The argument is point 2 above, and
// it holds against both. `record.turns` cannot name a fix turn without
// matching prompt text. Counting `request_changes` reviews counts the wrong
// thing outright: it counts how many times a REVIEW blocked, which a human's
// own turns and a manually triggered review both inflate, so a task a human
// pushed back on three times would arrive at its first automatic round with
// its budget already spent.
//
// What the `record.turns` derivation DID have over this one is that
// `record.turns` is read by `loadTask`, which answers null — a refusal to act
// — when it cannot read. A journal read used to answer `[]` for both "no
// events" and "unreadable", which reads as an empty budget, i.e. a full one.
// That hole is closed at the source (`readTaskJournal` reports `unreadable`,
// `autoFixRoundsUsed` answers null for it, and `decideFixLoop` stands down),
// so the remaining trade-off is point 2 alone.
//
// The marker rides on the `message` event type — no new `TaskEventType` is
// introduced by this ticket (the contract is untouched, `TaskRecord.version`
// stays 1, the web mirror stays as it is). `message` is already this
// codebase's channel for a non-agent notice the human should read (the runner
// says "worktree rebuilt on a FRESH fork…" through it, the reviewer says "no
// changes"), and `data.name` distinguishes ours the way `cost`/`issue`/`prep`
// name their own incidents.

import type { ReasonCode, TaskEvent, TaskReason, TaskRecord, TaskStatus } from './contract.js'
import { taskReason } from './tasks-store.js'

/** `data.name` of the journal line the loop writes before it starts a round. */
export const AUTO_FIX_ROUND_NAME = 'auto_fix_round'

/**
 * `data.name` of the line the loop writes when the round it just announced
 * could NOT be queued (a drain in progress, a queue that refuses to write).
 * It exists for the counter's sake as much as the human's: without it, the
 * announced-but-never-run round would keep counting against the NEXT human
 * reply's budget.
 */
export const AUTO_FIX_NOT_QUEUED_NAME = 'auto_fix_not_queued'

/** `data.name` of the line the loop writes when it gives the task back. */
export const AUTO_FIX_EXHAUSTED_NAME = 'auto_fix_exhausted'

/**
 * `data.name` of the line the loop writes when it starts NO round and hands
 * the task back to nobody — the record stays exactly where the reviewer left
 * it (`review_ko`), and this line says why the machine did not try.
 *
 * It is a DIFFERENT line from `auto_fix_exhausted` because it reports a
 * different fact, and the difference is the one T3.6 will read: a task whose
 * budget is spent has had its two rounds, a task the loop never started on has
 * had none and may still be shipped by a human who assumes the KO. Merging the
 * two names would make "the loop gave up" and "the loop could not begin"
 * indistinguishable in the journal as well as on the board.
 */
export const AUTO_FIX_NOT_STARTED_NAME = 'auto_fix_not_started'

/**
 * `data.name` of the line the loop writes when the journal it counts rounds in
 * had lines it could not read. The count still stands (it is the best this
 * journal supports) but it may be SHORT, so the degradation is named rather
 * than acted on in silence — invariant n° 2.
 */
export const AUTO_FIX_JOURNAL_DAMAGED_NAME = 'auto_fix_journal_damaged'

/**
 * `data.name` of the line the loop writes when it stops retrying a
 * judgment-only block and ships the task instead (D26). A DIFFERENT line from
 * `auto_fix_exhausted`: that one hands the task to a human, this one does not
 * hand it anywhere — the task follows its ordinary ship path, exactly as a
 * gate D18 waived outright would have.
 */
export const AUTO_FIX_SHIP_NAME = 'auto_fix_ship_with_open_questions'

/**
 * D26: the tighter ceiling on CONSECUTIVE rounds when the review's only
 * blocker is a criteria gate that itself blocks on nothing but open judgment
 * calls (`criteriaBlockKind` — task-criteria-gate.ts — reading `'judgment_open'`,
 * never `'unmet'`). A backstop, not the primary mechanism: the primary one is
 * `criteriaWaived` in task-review.ts, which ships such a gate on the SAME
 * review that produced it, before the loop is ever consulted. This ceiling
 * only fires when that waiver could not (a demoted verdict, a dropped
 * anchor, an unindexable diff — see `criteriaGateWaivable`) YET the shape of
 * what blocks is still purely a judgment call, never a real `unmet`. Fixed at
 * two, independent of the configured `max`: the incident this decision
 * answers spent twelve rounds rewording a criterion that could never be
 * anchored in a diff, and no configured budget should be spent re-asking a
 * question code cannot answer.
 */
export const JUDGMENT_ONLY_MAX_ROUNDS = 2

/**
 * The two D2 codes the loop can hand back with. `checks_failed` is
 * deliberately NOT one of them: what a red check needs is a human reading the
 * output, not another agent turn, and T3.1 owns that path.
 */
export type FixLoopBlocker = Extract<ReasonCode, 'review_blocked' | 'criteria_unmet'>

const LOOP_BLOCKERS: ReadonlySet<string> = new Set(['review_blocked', 'criteria_unmet'])

export type FixLoopDecision =
  /** Nothing for the loop to do: the review did not block, or not on its terms. */
  | { kind: 'none' }
  /** Start round `round` of `max`. `text` is the journal line's readable half. */
  | { kind: 'retry'; round: number; max: number; text: string }
  /**
   * No round, and NO hand-back either: the loop did not start, so it has
   * nothing to hand back. The record keeps the status and the code the
   * reviewer settled it on — `review_ko`, which a human may still assume and
   * ship — and the only mutation is the loop's own sentence ADDED to the
   * reason, so the board says why no automatic round happened.
   *
   * This is the shape of "the machine abstained", as opposed to `exit`'s "the
   * machine tried its budget and gave up". Parking a task on
   * `waiting_for_you` for an abstention would spend a capability (the force
   * ship of a `review_ko`) on a round that was never spent, and would
   * contradict this ticket's own spec, which requires a review breakdown to
   * stay `review_ko` + an `error` event.
   */
  | { kind: 'stand'; code: FixLoopBlocker; detail: string; text: string }
  /**
   * Hand the task back. `code` is the D2 code it carries out, `detail` the
   * WHOLE readable reason (what the reviewer already said, plus why the loop
   * stopped) and `text` the loop's own half of it, for the journal line.
   */
  | { kind: 'exit'; code: FixLoopBlocker; detail: string; text: string }
  /**
   * D26: the judgment-only ceiling was reached. NOT a hand-back — the task
   * follows its ordinary ship path instead of `waiting_for_you`, same as a
   * gate D18 waived on the review that produced it. `text` is the journal
   * line's readable half; nothing here mutates `record.reason` (the caller
   * clears it, exactly like an ordinary review_ok).
   */
  | { kind: 'ship'; text: string }

export type FixLoopInput = {
  /** Status the record carries AFTER the reviewer and the checks gate settled it. */
  status: TaskStatus
  /** Reason the record carries at that same instant. */
  reason: TaskReason | undefined
  /**
   * Automatic rounds this task has already consumed, derived from its journal
   * — or NULL when the journal could not be read at all.
   *
   * Null is not zero and must never be coerced into it: "I could not find out
   * how much of the budget is spent" answered as "none of it is" renews the
   * full budget on every turn, which is a loop with no bound at all. `null`
   * here buys the loop nothing; it stops it.
   */
  roundsUsed: number | null
  /** The configured bound (`resolveMaxAutoFixRounds`). */
  max: number
  /**
   * Whether a fix turn could be given something concrete to do — i.e. whether
   * `buildAutoFixTurnPrompt` produced a prompt for THIS review. False when the
   * review never got as far as archiving anything (an agent crash, a timeout),
   * in which case a "fix the findings" turn would be sent to work from a
   * PREVIOUS turn's archive, which is a lie the loop must not tell.
   */
  fixable: boolean
  /**
   * D26: whether THIS `criteria_unmet` blocks on nothing but open judgment
   * calls — `criteriaBlockKind` (task-criteria-gate.ts) read `'judgment_open'`
   * on the archive the reviewer just wrote, never `'unmet'`. Ignored for a
   * `review_blocked` exit (a real finding is never a judgment call) and
   * defaulted to `false`: a caller that cannot compute it gets the ORDINARY
   * budget, never the tighter one — the safe default, since understating the
   * ceiling only costs a round, while overstating it would ship a task whose
   * criteria the model never actually settled.
   */
  judgmentOnly?: boolean
}

/**
 * How many automatic fix rounds this task has consumed IN A ROW, read from its
 * journal.
 *
 * "In a row" is the arbitrage this function makes, and it is the answer to a
 * task that alternated human turns and automatic ones: the bound caps how far
 * the machine goes WITHOUT a human, so a human turn renews the budget. The
 * alternative — a lifetime count — makes the loop fire at most `max` times
 * ever, which means a conversation that once exhausted it never gets an
 * automatic round again, however many times a human later steers it back on
 * track. That is not a bound on runaway automation, it is a one-shot fuse.
 * The same doctrine the runner already applies to its own blocked ids
 * (`schedule()`'s `unblock`): a human gesture is a fresh attempt.
 *
 * The streak is read off two EXISTING event types and no new state: our own
 * `message` marker, written before a round is queued, and the `turn_started`
 * the runner emits when a turn actually begins. A `turn_started` with no
 * marker in front of it is a human's turn, and it resets the count.
 *
 * `null` in, `null` out: a journal that could NOT be read (see
 * `readTaskJournal`) yields no count at all, never the count zero. Everything
 * downstream then refuses to spend budget rather than renewing it, which is
 * the only safe reading of "I do not know".
 *
 * TWO known imprecisions, both conservative, both here rather than in a
 * comment nobody reads:
 *
 *  - a round ANNOUNCED whose turn never started, and whose `auto_fix_not_
 *    queued` retraction never got written either (the process died between
 *    `reply()` accepting and the turn starting), stays armed and is charged to
 *    the next `turn_started` — a human's included. It costs the human one
 *    round of budget; the alternative costs the machine a round it may
 *    already have spent, and only one of those two errors can run an agent.
 *  - `resume()` of an interrupted automatic round emits a SECOND
 *    `turn_started` with no marker in front of it, so it reads as a human's
 *    turn and resets the streak. That is the intended doctrine and not an
 *    accident: resuming is a human gesture, and the same `unblock` rule
 *    applies to it as to a reply.
 */
export function autoFixRoundsUsed(events: readonly TaskEvent[] | null): number | null {
  if (events === null) {
    return null
  }
  let streak = 0
  let announced = false
  for (const event of events) {
    if (event.type === 'message' && event.data.name === AUTO_FIX_ROUND_NAME) {
      announced = true
      continue
    }
    if (event.type === 'error' && event.data.name === AUTO_FIX_NOT_QUEUED_NAME) {
      // The round was announced and then refused: it never ran, so it must not
      // count against anyone.
      announced = false
      continue
    }
    if (event.type === 'turn_started') {
      streak = announced ? streak + 1 : 0
      announced = false
    }
  }
  return streak
}

/** Adds the loop's own sentence to whatever the reviewer already said. */
function addDetail(existing: string | undefined, added: string): string {
  const before = existing?.trim()
  return before ? `${before} — ${added}` : added
}

/**
 * D26's tightened budget: `JUDGMENT_ONLY_MAX_ROUNDS` when this block is a pure
 * judgment call, the configured `max` otherwise. Its own function so
 * `decideFixLoop`'s own complexity does not carry a branch that is really
 * about WHICH ceiling applies, not about the loop's four refusals.
 */
function effectiveMax(judgmentOnly: boolean, configuredMax: number): number {
  return judgmentOnly ? Math.min(configuredMax, JUDGMENT_ONLY_MAX_ROUNDS) : configuredMax
}

/** The decision at a spent budget: `ship` for a judgment-only block (D26), `exit` for a real one. */
function atCapDecision(
  blocker: FixLoopBlocker,
  judgmentOnly: boolean,
  max: number,
  existing: string | undefined,
): FixLoopDecision {
  if (judgmentOnly) {
    return {
      kind: 'ship',
      text: `no criterion is unmet — only open judgment calls remain after ${max} automatic round(s) — shipping with them left for a human to decide`,
    }
  }
  const text = `the automatic fix loop stopped after ${max} round(s) without clearing what blocks this task`
  return { kind: 'exit', code: blocker, detail: addDetail(existing, text), text }
}

/**
 * What happens after a review that has just settled. Pure: it reads a status,
 * a reason, a count and a bound, and returns a decision. Nothing here writes.
 *
 * The four refusals to loop, in the order they are checked:
 *
 *  - the review did not block, or blocked on something this loop does not
 *    answer (a red `checks_failed` run) — nothing to do;
 *  - the BUDGET could not be counted, because the journal it lives in could
 *    not be read. A round granted on ignorance is a round granted every time,
 *    for as long as the fault lasts, which is exactly the unbounded loop this
 *    ticket exists to forbid — so the loop stands down and says why;
 *  - the review left nothing to work from — handing the agent a stale archive
 *    would spend a round on findings that may already be fixed;
 *  - the budget is spent — and this is the one that makes the loop terminate
 *    against an agent that changes nothing, since `roundsUsed` grows by one
 *    per round whether or not the diff moved.
 *
 * Only the LAST of the four hands the task to a human (`exit`). The two middle
 * ones `stand`: nothing was tried, so nothing was exhausted, and the record
 * keeps the `review_ko` a human may still assume and ship.
 */
export function decideFixLoop(input: FixLoopInput): FixLoopDecision {
  if (input.status !== 'review_ko') {
    return { kind: 'none' }
  }
  const code = input.reason?.code
  if (!code || !LOOP_BLOCKERS.has(code)) {
    return { kind: 'none' }
  }
  const blocker = code as FixLoopBlocker
  const existing = input.reason?.detail
  const stand = (text: string): FixLoopDecision => ({
    kind: 'stand',
    code: blocker,
    detail: addDetail(existing, text),
    text,
  })
  if (input.roundsUsed === null) {
    return stand(
      'no automatic fix round was started: this task’s journal could not be read, so how much of the fix budget it has already spent is unknown — and an unknown budget is never a full one',
    )
  }
  if (!input.fixable) {
    return stand(
      'no automatic fix round was started: this turn produced no reviewed findings and no unsatisfied criterion to work from',
    )
  }
  // D26: a judgment-only block never gets more than JUDGMENT_ONLY_MAX_ROUNDS,
  // whatever the configured budget allows — and reaching it SHIPS rather than
  // handing the task to a human, since nothing here is a real `unmet` for a
  // person to fix either.
  const judgmentOnly = blocker === 'criteria_unmet' && input.judgmentOnly === true
  const max = effectiveMax(judgmentOnly, input.max)
  if (input.roundsUsed >= max) {
    return atCapDecision(blocker, judgmentOnly, max, existing)
  }
  const round = input.roundsUsed + 1
  return {
    kind: 'retry',
    round,
    max,
    text: `starting automatic fix round ${round} of ${max} on what the review blocked`,
  }
}

/**
 * Applies a decision to the record — the only mutation this module performs,
 * and it is performed from inside the single owner's own persist (task-server
 * folds it into the write the reviewer triggers), never as a second write
 * after it. A `retry` mutates nothing: the record stays exactly where the
 * reviewer left it until the fix turn's own `reply()` moves it to 'queued',
 * which is the ordinary path of any next turn.
 *
 * Two decisions write, and the difference between them is the whole point:
 *
 *  - `exit` — the budget was spent. The task goes to `waiting_for_you`, never
 *    `failed`: nothing failed, the work is committed, the branch is intact and
 *    what the task needs is a person.
 *  - `stand` — the loop never began. The STATUS is not touched: the task keeps
 *    the `review_ko` the reviewer settled it on, which is what leaves a human
 *    free to assume the KO and ship it, exactly as before this ticket. Only
 *    the reason's sentence grows, so the board says why no round happened.
 *  - `ship` (D26) — the judgment-only ceiling was reached. The task goes to
 *    `review_ok`, its reason CLEARED exactly like an ordinary pass (`settle`'s
 *    own rule in task-review.ts): the open judgment calls are not this
 *    field's business, they live on the archived review's per-criterion
 *    verdicts and surface in the merge request's own "To decide" section.
 */
export function applyFixLoopDecision(record: TaskRecord, decision: FixLoopDecision): void {
  if (decision.kind === 'exit') {
    record.status = 'waiting_for_you'
    record.reason = taskReason(decision.code, decision.detail)
    return
  }
  if (decision.kind === 'ship') {
    record.status = 'review_ok'
    delete record.reason
    return
  }
  if (decision.kind === 'stand') {
    record.reason = taskReason(decision.code, decision.detail)
  }
}
