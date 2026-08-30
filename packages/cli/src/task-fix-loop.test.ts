import { describe, expect, test } from 'bun:test'
import { sanitizeTaskRecord, type TaskEvent, type TaskRecord, type TaskStatus } from './contract.js'
import {
  applyFixLoopDecision,
  AUTO_FIX_NOT_QUEUED_NAME,
  AUTO_FIX_ROUND_NAME,
  autoFixRoundsUsed,
  decideFixLoop,
  JUDGMENT_ONLY_MAX_ROUNDS,
  type FixLoopInput,
} from './task-fix-loop.js'
import { taskReason } from './tasks-store.js'

// --- rig ------------------------------------------------------------------

let seq = 0
function event(type: TaskEvent['type'], data: TaskEvent['data'] = {}): TaskEvent {
  seq += 1
  return { seq, at: '2026-08-21T10:00:00.000Z', type, data }
}

/** The two lines an automatic round writes, in the order it writes them. */
const roundStart = (round: number) =>
  event('message', {
    text: `starting automatic fix round ${round} of 2`,
    name: AUTO_FIX_ROUND_NAME,
  })
const turnStart = (turn: number) => event('turn_started', { turn, prompt: 'whatever' })

function record(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    id: 'a1b2c3d4e5f6',
    title: 't',
    status: 'review_ko',
    base: 'main',
    branch: 'codesema/task-t',
    worktree: '/tmp/w',
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    work_on: false,
    isolation: 'policy',
    created_at: '2026-08-21T10:00:00.000Z',
    updated_at: '2026-08-21T10:00:00.000Z',
    ...over,
  }
}

function input(over: Partial<FixLoopInput> = {}): FixLoopInput {
  return {
    status: 'review_ko',
    reason: taskReason('review_blocked', 'one major finding'),
    roundsUsed: 0,
    max: 2,
    fixable: true,
    ...over,
  }
}

// --- autoFixRoundsUsed ----------------------------------------------------

describe('autoFixRoundsUsed — the counter is derived, and derived from the journal', () => {
  test('counts the automatic rounds a task has actually run', () => {
    expect(autoFixRoundsUsed([])).toBe(0)
    // A human's own turn: no marker in front of it.
    expect(autoFixRoundsUsed([turnStart(1)])).toBe(0)
    expect(autoFixRoundsUsed([turnStart(1), roundStart(1), turnStart(2)])).toBe(1)
    expect(
      autoFixRoundsUsed([turnStart(1), roundStart(1), turnStart(2), roundStart(2), turnStart(3)]),
    ).toBe(2)
  })

  test('an announced round only counts once the turn actually started', () => {
    // The marker is written BEFORE the turn is queued: between the two, the
    // round has not happened yet and must not be charged.
    expect(autoFixRoundsUsed([turnStart(1), roundStart(1)])).toBe(0)
  })

  test('a round the runner refused is retracted, not charged to the next reply', () => {
    const refused = [
      turnStart(1),
      roundStart(1),
      event('error', { message: 'shutting down', name: AUTO_FIX_NOT_QUEUED_NAME }),
      // The human comes back and replies by hand: their turn is theirs.
      turnStart(2),
    ]
    expect(autoFixRoundsUsed(refused)).toBe(0)
  })

  test('a human turn renews the budget — the bound caps CONSECUTIVE rounds', () => {
    const alternating = [
      turnStart(1),
      roundStart(1),
      turnStart(2),
      roundStart(2),
      turnStart(3),
      // The loop gave up here and a human replied by hand.
      turnStart(4),
    ]
    expect(autoFixRoundsUsed(alternating)).toBe(0)
    // ...and the machine may go again from there.
    expect(autoFixRoundsUsed([...alternating, roundStart(1), turnStart(5)])).toBe(1)
  })

  test('other journal lines never move the count', () => {
    const noisy = [
      turnStart(1),
      roundStart(1),
      event('tool_use', { tool: 'Edit' }),
      event('commit', { sha: 'abc' }),
      event('review_started', { turn: 1 }),
      event('review_done', { verdict: 'request_changes' }),
      event('checks', { status: 'passed' }),
      event('error', { message: 'review failed: boom' }),
      turnStart(2),
    ]
    expect(autoFixRoundsUsed(noisy)).toBe(1)
  })

  test('it carries NOTHING between calls: two journals, interleaved, never bleed', () => {
    // The property the loop actually depends on — no module state, so a
    // workspace restarted mid-loop resumes on the journal alone. Comparing a
    // list with a copy of itself could not fail even if this function held a
    // counter; interleaving two different journals and re-asking for the FIRST
    // one's answer can, and does the moment any state is carried over.
    const looped = [turnStart(1), roundStart(1), turnStart(2)]
    const human = [turnStart(1)]
    expect(autoFixRoundsUsed(looped)).toBe(1)
    expect(autoFixRoundsUsed(human)).toBe(0)
    expect(autoFixRoundsUsed(looped)).toBe(1)
    // ...and it does not consume its input either: the caller's array is a
    // read, never a queue this function drains.
    expect(looped).toHaveLength(3)
  })

  test('a journal it could NOT read is not a journal with nothing in it', () => {
    // The whole of MAJOR 2: `readTaskJournal` answers `unreadable` for EACCES,
    // EMFILE, EIO, and this function must pass that ignorance on rather than
    // rounding it down to "no round has been spent". A `0` here renews the
    // full budget on every single turn, which is a loop with no bound at all.
    expect(autoFixRoundsUsed(null)).toBeNull()
    expect(autoFixRoundsUsed([])).toBe(0)
  })

  test('an announced round whose turn never started is charged to the next one', () => {
    // The window: `reply()` accepted, then the process died before the turn
    // began, so neither `turn_started` nor the `auto_fix_not_queued`
    // retraction was ever written. The marker stays armed and the NEXT
    // turn_started — a human's included — is counted as that round.
    //
    // Conservative on purpose, and asymmetric with the retraction above by
    // design: charging a round that may not have run costs the human one round
    // of budget, while forgiving it would grant the machine a round it may
    // already have spent. Only one of those two errors can run an agent.
    expect(autoFixRoundsUsed([roundStart(1), turnStart(2)])).toBe(1)
  })

  test('a resumed fix turn re-arms the budget, and that is the doctrine', () => {
    // `resume()` re-runs the interrupted turn, so the runner emits a SECOND
    // `turn_started` with no marker in front of it — which reads exactly like
    // a human's own turn and resets the streak. Intended: resuming IS a human
    // gesture, and the bound caps how far the machine goes WITHOUT one.
    // Pinned here so the day it changes, it changes on purpose.
    const interrupted = [roundStart(1), turnStart(2)]
    expect(autoFixRoundsUsed(interrupted)).toBe(1)
    expect(autoFixRoundsUsed([...interrupted, turnStart(2)])).toBe(0)
  })
})

// --- decideFixLoop --------------------------------------------------------

describe('decideFixLoop', () => {
  test('nothing to do when the review did not block', () => {
    for (const status of ['review_ok', 'reviewing', 'waiting_for_you', 'shipped'] as TaskStatus[]) {
      expect(decideFixLoop(input({ status })).kind).toBe('none')
    }
  })

  test('a red checks run is not this loop’s business', () => {
    // T3.1 owns it: what a failing check needs is a human reading the output,
    // and an agent turn on it would be an expensive guess.
    const decision = decideFixLoop(
      input({ reason: taskReason('checks_failed', 'repository checks failed (bun test)') }),
    )
    expect(decision.kind).toBe('none')
  })

  test('a review_ko with no reason at all does not loop', () => {
    expect(decideFixLoop(input({ reason: undefined })).kind).toBe('none')
  })

  test('within the bound: one more round, numbered', () => {
    expect(decideFixLoop(input({ roundsUsed: 0, max: 2 }))).toMatchObject({
      kind: 'retry',
      round: 1,
      max: 2,
    })
    expect(decideFixLoop(input({ roundsUsed: 1, max: 2 }))).toMatchObject({
      kind: 'retry',
      round: 2,
      max: 2,
    })
  })

  test('at the bound: the loop exits, it never rounds up to one more', () => {
    const decision = decideFixLoop(input({ roundsUsed: 2, max: 2 }))
    expect(decision.kind).toBe('exit')
    // And past it too — a journal that somehow counted further still stops.
    expect(decideFixLoop(input({ roundsUsed: 9, max: 2 })).kind).toBe('exit')
  })

  test('a bound of 1 allows exactly one round', () => {
    expect(decideFixLoop(input({ roundsUsed: 0, max: 1 })).kind).toBe('retry')
    expect(decideFixLoop(input({ roundsUsed: 1, max: 1 })).kind).toBe('exit')
  })

  test('a bound of 3 allows exactly three', () => {
    expect(decideFixLoop(input({ roundsUsed: 2, max: 3 })).kind).toBe('retry')
    expect(decideFixLoop(input({ roundsUsed: 3, max: 3 })).kind).toBe('exit')
  })

  test('the exit carries the code of what BLOCKS, findings or criteria', () => {
    const findings = decideFixLoop(input({ roundsUsed: 2 }))
    expect(findings).toMatchObject({ kind: 'exit', code: 'review_blocked' })
    const criteria = decideFixLoop(
      input({ roundsUsed: 2, reason: taskReason('criteria_unmet', '2 of 3 criteria are not met') }),
    )
    expect(criteria).toMatchObject({ kind: 'exit', code: 'criteria_unmet' })
  })

  test('the exit reason ADDS to what the reviewer said, it never replaces it', () => {
    const decision = decideFixLoop(
      input({ roundsUsed: 2, reason: taskReason('review_blocked', 'a.ts:12 leaks a descriptor') }),
    )
    if (decision.kind !== 'exit') {
      throw new Error('expected an exit')
    }
    expect(decision.detail).toContain('a.ts:12 leaks a descriptor')
    expect(decision.detail).toContain('automatic fix loop stopped')
    // The loop's own half is what the journal line says on its own.
    expect(decision.text).not.toContain('a.ts:12')
  })

  test('nothing to work from: the loop STANDS, it does not hand the task back', () => {
    const decision = decideFixLoop(input({ roundsUsed: 0, fixable: false }))
    if (decision.kind !== 'stand') {
      throw new Error(`expected a stand, got ${decision.kind}`)
    }
    // Budget untouched, so this must not read as "the loop tried twice".
    expect(decision.text).not.toContain('stopped after')
    expect(decision.text).toContain('no automatic fix round was started')
    expect(decision.code).toBe('review_blocked')
    // ...and the reviewer's own sentence is still in front of it.
    expect(decision.detail).toContain('one major finding')
  })

  test('an unreadable journal STANDS too, and says so in its own words', () => {
    // MAJOR 2: "I could not count the budget" is never "the budget is full".
    const decision = decideFixLoop(input({ roundsUsed: null }))
    if (decision.kind !== 'stand') {
      throw new Error(`expected a stand, got ${decision.kind}`)
    }
    expect(decision.text).toContain('journal could not be read')
    expect(decision.text).toContain('unknown budget is never a full one')
    // Not the "nothing to work from" sentence: the review was fine here.
    expect(decision.text).not.toContain('no reviewed findings')
    expect(decision.code).toBe('review_blocked')
  })

  test('an unreadable journal outranks a spent bound: no round, and no hand-back', () => {
    // Even a count that WOULD have exited cannot be trusted when the journal
    // it came from could not be read — there is no count at all to compare.
    for (const max of [1, 2, 3]) {
      expect(decideFixLoop(input({ roundsUsed: null, max })).kind).toBe('stand')
    }
    // And the machine fault is named ahead of "nothing to work from", because
    // it is the one that says something is wrong with the workspace.
    const both = decideFixLoop(input({ roundsUsed: null, fixable: false }))
    if (both.kind !== 'stand') {
      throw new Error('expected a stand')
    }
    expect(both.text).toContain('journal could not be read')
  })

  test('a stand carries the criteria code when criteria are what block', () => {
    const decision = decideFixLoop(
      input({ roundsUsed: null, reason: taskReason('criteria_unmet', '1 of 2 not satisfied') }),
    )
    expect(decision).toMatchObject({ kind: 'stand', code: 'criteria_unmet' })
  })

  // --- D26: the judgment-only ceiling ---------------------------------------

  const judgmentInput = (over: Partial<FixLoopInput> = {}): FixLoopInput =>
    input({
      reason: taskReason('criteria_unmet', '1 of 3 not satisfied'),
      judgmentOnly: true,
      ...over,
    })

  test('a judgment-only block never gets more than JUDGMENT_ONLY_MAX_ROUNDS, whatever max allows', () => {
    for (const configuredMax of [JUDGMENT_ONLY_MAX_ROUNDS, JUDGMENT_ONLY_MAX_ROUNDS + 5, 100]) {
      expect(decideFixLoop(judgmentInput({ roundsUsed: 0, max: configuredMax })).kind).toBe('retry')
      expect(
        decideFixLoop(judgmentInput({ roundsUsed: JUDGMENT_ONLY_MAX_ROUNDS, max: configuredMax }))
          .kind,
      ).toBe('ship')
    }
  })

  test('reaching the ceiling SHIPS, it does not hand the task to a human', () => {
    const decision = decideFixLoop(judgmentInput({ roundsUsed: JUDGMENT_ONLY_MAX_ROUNDS }))
    if (decision.kind !== 'ship') {
      throw new Error(`expected a ship, got ${decision.kind}`)
    }
    expect(decision.text).toContain('open judgment calls')
  })

  test('a configured max BELOW the ceiling is respected, never rounded up', () => {
    expect(decideFixLoop(judgmentInput({ roundsUsed: 0, max: 1 })).kind).toBe('retry')
    expect(decideFixLoop(judgmentInput({ roundsUsed: 1, max: 1 })).kind).toBe('ship')
  })

  test('judgmentOnly is only read for a criteria_unmet exit — a review_blocked never ships early', () => {
    const decision = decideFixLoop(
      input({
        roundsUsed: JUDGMENT_ONLY_MAX_ROUNDS,
        max: 10,
        judgmentOnly: true,
        reason: taskReason('review_blocked', 'one major finding'),
      }),
    )
    expect(decision.kind).toBe('retry')
  })

  test('judgmentOnly defaults to false: the ordinary budget applies with no flag at all', () => {
    const decision = decideFixLoop(
      input({
        roundsUsed: JUDGMENT_ONLY_MAX_ROUNDS,
        max: 10,
        reason: taskReason('criteria_unmet', '1 of 3 not satisfied'),
      }),
    )
    expect(decision.kind).toBe('retry')
  })
})

// --- applyFixLoopDecision -------------------------------------------------

describe('applyFixLoopDecision', () => {
  test('an exit hands the task back on waiting_for_you, never on failed', () => {
    const task = record()
    applyFixLoopDecision(task, decideFixLoop(input({ roundsUsed: 2 })))
    expect(task.status).toBe('waiting_for_you')
    expect(task.reason?.code).toBe('review_blocked')
    expect(task.reason?.detail).toContain('one major finding')
  })

  test('a criteria exit carries criteria_unmet', () => {
    const task = record()
    applyFixLoopDecision(
      task,
      decideFixLoop(
        input({ roundsUsed: 2, reason: taskReason('criteria_unmet', '1 of 2 not satisfied') }),
      ),
    )
    expect(task.status).toBe('waiting_for_you')
    expect(task.reason?.code).toBe('criteria_unmet')
  })

  test('a retry mutates nothing: the record stays where the reviewer left it', () => {
    const task = record({ reason: taskReason('review_blocked', 'one major finding') })
    const before = JSON.stringify(task)
    applyFixLoopDecision(task, decideFixLoop(input({ roundsUsed: 0 })))
    expect(JSON.stringify(task)).toBe(before)
  })

  test('a STAND leaves the status alone — the task keeps the review_ko it earned', () => {
    // MAJOR 1: a review nobody could archive is not a review whose budget was
    // spent. Parking it on `waiting_for_you` would take away the one thing a
    // `review_ko` still offers — a human assuming the KO and shipping — for a
    // round that was never spent.
    const died = taskReason('review_blocked', 'the review agent died')
    for (const over of [{ fixable: false }, { roundsUsed: null }] as Partial<FixLoopInput>[]) {
      const task = record({ reason: died })
      applyFixLoopDecision(task, decideFixLoop(input({ roundsUsed: 0, reason: died, ...over })))
      expect(task.status).toBe('review_ko')
      expect(task.reason?.code).toBe('review_blocked')
      // The sentence GROWS — the loop adds why it did not try — it never
      // replaces what the reviewer said.
      expect(task.reason?.detail).toContain('the review agent died')
      expect(task.reason?.detail).toContain('no automatic fix round was started')
    }
  })

  test('a stand never says the loop "stopped after" anything', () => {
    const task = record({ reason: taskReason('review_blocked', 'boom') })
    applyFixLoopDecision(task, decideFixLoop(input({ roundsUsed: 0, fixable: false })))
    expect(task.reason?.detail).not.toContain('stopped after')
  })

  test('a none decision writes nothing at all', () => {
    const task = record({ status: 'review_ok' })
    const before = JSON.stringify(task)
    applyFixLoopDecision(task, decideFixLoop(input({ status: 'review_ok' })))
    expect(JSON.stringify(task)).toBe(before)
  })

  test('a ship decision (D26) lands on review_ok with the reason cleared', () => {
    const task = record({ reason: taskReason('criteria_unmet', '1 of 3 not satisfied') })
    applyFixLoopDecision(
      task,
      decideFixLoop(
        input({
          roundsUsed: JUDGMENT_ONLY_MAX_ROUNDS,
          reason: taskReason('criteria_unmet', '1 of 3 not satisfied'),
          judgmentOnly: true,
        }),
      ),
    )
    expect(task.status).toBe('review_ok')
    expect(task.reason).toBeUndefined()
  })
})

// --- the structural half of "no dedicated field" --------------------------

describe('the cycle counter has no home on the record', () => {
  test('the contract would ERASE a counter field, so none can ever be persisted', () => {
    // This is the acceptance criterion made structural rather than
    // conventional: `sanitizeTaskRecord` rebuilds a record from a whitelist,
    // so a future `auto_fix_rounds` field cannot survive a round-trip through
    // the store — and the day someone adds it to that whitelist, this goes red
    // and the derivation stops being the only source of truth.
    const persisted = sanitizeTaskRecord({
      ...record(),
      auto_fix_rounds: 2,
      fix_rounds_used: 2,
      auto_fix_round: 2,
    })
    expect(persisted).not.toBeNull()
    const keys = Object.keys(persisted as TaskRecord)
    expect(keys).not.toContain('auto_fix_rounds')
    expect(keys).not.toContain('fix_rounds_used')
    expect(keys).not.toContain('auto_fix_round')
    expect(keys.filter((key) => /round|cycle/i.test(key))).toEqual([])
    // And the record's own version does not move for this ticket.
    expect((persisted as TaskRecord).version).toBe(1)
  })
})
