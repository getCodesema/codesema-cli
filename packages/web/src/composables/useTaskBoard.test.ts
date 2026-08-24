import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { EXECUTION_STATUS } from '../execution-status'
import type { TaskEvent, TaskEventType, TaskRecord, TaskStatus } from '../types'
import {
  agentCounts,
  applyLiveText,
  clockTime,
  compareByActivity,
  eventSummary,
  eventTone,
  findingsCount,
  firstString,
  focusTabs,
  formatDuration,
  formatTokens,
  groupQueue,
  groupThreadEvents,
  keepsLiveMessages,
  lastQuestion,
  matchesQuery,
  mergeEvent,
  mergeLiveMessage,
  oldestWaiting,
  queuePhraseKey,
  queueRankHintKey,
  queueSectionOf,
  reasonDetailText,
  replyModeOf,
  resumeStateOf,
  reviewRefOf,
  sectionOf,
  settlesLiveMessages,
  severityBreakdown,
  splitInlineCode,
  statusLabelKey,
  statusPhraseKey,
  streamsLiveText,
  timeAgo,
  titleFromPrompt,
  verdictLabelKey,
  waitingSince,
  type LiveMessage,
} from './useTaskBoard'

function record(partial: Partial<TaskRecord>): TaskRecord {
  return {
    version: 1,
    id: 'a1b2c3d4e5f6',
    title: 'task',
    status: 'queued',
    base: 'main',
    branch: 'codesema/task-x',
    worktree: '/tmp/w',
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    created_at: '2026-08-13T10:00:00.000Z',
    updated_at: '2026-08-13T10:00:00.000Z',
    ...partial,
  }
}

function event(partial: Partial<TaskEvent>): TaskEvent {
  return { seq: 0, at: '2026-08-13T10:00:00.000Z', type: 'message', data: {}, ...partial }
}

/**
 * The machine-cap `reason.detail` READ OUT OF THE CLI, not copied here.
 *
 * `MACHINE_LOAD_DETAIL` (packages/cli/src/task-runner.ts) is hand-mirrored as
 * `MACHINE_LOAD_WAIT_DETAIL` in this file, the only discriminant between the
 * two `resource_busy` motifs on a record that carries no events. A test that
 * merely copy-pasted the CLI's English sentence would stay green even if the
 * CLI's constant changed and the mirror did not: both sides would simply be
 * wrong in the same way. Extracting the literal from the CLI source makes the
 * coupling real, in the only way a hand-mirror allows: the web bundle must not
 * import CLI code, and the constant is private on both sides. This is a
 * test-time file read, not a dependency.
 */
const MACHINE_DETAIL = (() => {
  const cliSource = readFileSync(
    join(import.meta.dir, '..', '..', '..', 'cli', 'src', 'task-runner.ts'),
    'utf8',
  )
  const match = cliSource.match(/const MACHINE_LOAD_DETAIL\s*=\s*'([^']*)'/)
  if (!match?.[1]) {
    throw new Error('MACHINE_LOAD_DETAIL not found in packages/cli/src/task-runner.ts')
  }
  return match[1]
})()

// T1.2 re-review, MINOR 9: the badge's tooltip is a claim about the project,
// and it must not make it when nothing is running there.
describe('queueRankHintKey', () => {
  test('"N conversations ahead" only when the project really IS busy', () => {
    expect(
      queueRankHintKey(record({ reason: { code: 'resource_busy', detail: 'another task' } })),
    ).toBe('workspace.queuePositionHint')
  })

  test('a line that is stopped rather than busy gets the honest hint instead', () => {
    // A conversation whose worktree would not materialize: it holds a rank,
    // but there is no agent ahead of it to wait for.
    expect(
      queueRankHintKey(record({ reason: { code: 'agent_error', detail: 'no such branch' } })),
    ).toBe('workspace.queuePositionHintIdle')
    // And a record that says nothing claims nothing.
    expect(queueRankHintKey(record({}))).toBe('workspace.queuePositionHintIdle')
  })

  // Adversarial review round 3, MAJEUR 3: T1.3 made `resource_busy` cover a
  // task alone in an idle project (held back by the MACHINE cap), which this
  // pill used to tell as "N conversations ahead in this project" — a promise
  // about agents that do not exist.
  //
  // The mutation this kills (round 5, mineur F): `MACHINE_LOAD_WAIT_DETAIL`
  // drifting from the CLI's own `MACHINE_LOAD_DETAIL` while a test still
  // compared against a copy-pasted literal would stay green: the two copies
  // agreeing with each other proves nothing about the CLI. Comparing against
  // `MACHINE_DETAIL`, read from the CLI source itself, is what actually
  // exercises the mirror.
  test('a machine-cap wait gets its own hint, distinct from a project wait', () => {
    expect(
      queueRankHintKey(record({ reason: { code: 'resource_busy', detail: MACHINE_DETAIL } })),
    ).toBe('workspace.queuePositionHintMachine')
  })
})

describe('queuePhraseKey', () => {
  test('a queued task waiting on the machine cap gets the machine-specific phrase', () => {
    expect(queuePhraseKey('queued', true)).toBe('workspace.phaseQueuedMachine')
  })

  test('a queued task NOT waiting on the machine cap falls back to the generic phrase', () => {
    expect(queuePhraseKey('queued', false)).toBeNull()
  })

  test('any other status never gets the machine phrase, even if waitingForSlot lingers true', () => {
    expect(queuePhraseKey('running', true)).toBeNull()
  })
})

describe('statusPhraseKey / statusLabelKey (T3.1 checks_failed)', () => {
  test('review_ko from checks does not reuse the findings phrasing', () => {
    const blocked = record({
      status: 'review_ko',
      reason: { code: 'checks_failed', detail: 'repository checks failed (bun test)' },
    })
    expect(statusPhraseKey(blocked, false)).toBe('workspace.phaseChecksFailed')
    expect(statusLabelKey(blocked)).toBe('workspace.statusChecksFailed')
  })

  test('review_ko from the review itself keeps the findings phrasing', () => {
    const blocked = record({
      status: 'review_ko',
      reason: { code: 'review_blocked', detail: 'review failed: agent timed out' },
    })
    expect(statusPhraseKey(blocked, false)).toBe('workspace.phaseReviewKo')
    expect(statusLabelKey(blocked)).toBe('workspace.statusReviewKo')
  })

  // T3.2: the criteria gate blocks a review the reviewer APPROVED, so
  // "findings to fix" is exactly as false here as it was for red checks.
  test('review_ko from the criteria gate gets its own phrase AND its own label', () => {
    const blocked = record({
      status: 'review_ko',
      reason: {
        code: 'criteria_unmet',
        detail: '1 of 3 acceptance criteria are not satisfied (1 unmet) — ac-000000000001: unmet',
      },
    })
    expect(statusPhraseKey(blocked, false)).toBe('workspace.phaseCriteriaUnmet')
    expect(statusLabelKey(blocked)).toBe('workspace.statusCriteriaUnmet')
    // The three review_ko phrasings stay pairwise distinct: a code wired into
    // one helper and not the other reads "Review blocked · criteria not met".
    const fromChecks = record({ status: 'review_ko', reason: { code: 'checks_failed' } })
    const fromReview = record({ status: 'review_ko', reason: { code: 'review_blocked' } })
    expect(new Set([blocked, fromChecks, fromReview].map((r) => statusLabelKey(r))).size).toBe(3)
    expect(
      new Set([blocked, fromChecks, fromReview].map((r) => statusPhraseKey(r, false))).size,
    ).toBe(3)
  })

  test('a review_ko whose reason code this build does not know keeps the default', () => {
    const blocked = record({
      status: 'review_ko',
      reason: { code: 'something_future' as never },
    })
    expect(statusPhraseKey(blocked, false)).toBe('workspace.phaseReviewKo')
    expect(statusLabelKey(blocked)).toBe('workspace.statusReviewKo')
  })

  // T3.3: the bounded fix loop hands a task back on `waiting_for_you` carrying
  // the very same codes. The default phrase for that status is "paused —
  // waiting for your answer", and nobody asked a question: the card would be
  // wrong, not merely vague.
  test('a waiting_for_you the fix loop gave up on reads DIFFERENTLY from a review_ko', () => {
    const findings = record({
      status: 'waiting_for_you',
      reason: {
        code: 'review_blocked',
        detail:
          'a.ts:3 leaks a descriptor — the automatic fix loop stopped after 2 round(s) without clearing what blocks this task',
      },
    })
    expect(statusPhraseKey(findings, false)).toBe('workspace.phaseFixLoopStopped')
    expect(statusLabelKey(findings)).toBe('workspace.statusFixLoopStopped')
    const criteria = record({
      status: 'waiting_for_you',
      reason: {
        code: 'criteria_unmet',
        detail: '1 of 3 acceptance criteria are not satisfied — the automatic fix loop stopped',
      },
    })
    expect(statusPhraseKey(criteria, false)).toBe('workspace.phaseFixLoopStoppedCriteria')
    expect(statusLabelKey(criteria)).toBe('workspace.statusFixLoopStopped')
    // ...and none of them is the generic "waiting for your answer".
    expect([findings, criteria].map((r) => statusPhraseKey(r, false))).not.toContain(
      'workspace.phaseWaiting',
    )
    // The point of the split: the SAME code on `review_ko` is a verdict a
    // human can still assume and ship, while this one is a parked task whose
    // ship refuses. Rendering them alike showed a capability that is gone.
    const blockedReview = record({
      status: 'review_ko',
      reason: { code: 'review_blocked', detail: 'a.ts:3 leaks a descriptor' },
    })
    expect(statusLabelKey(blockedReview)).not.toBe(statusLabelKey(findings))
    expect(statusPhraseKey(blockedReview, false)).not.toBe(statusPhraseKey(findings, false))
  })

  test('an ordinary waiting_for_you — a question, no reason — is untouched', () => {
    const asking = record({ status: 'waiting_for_you' })
    expect(statusPhraseKey(asking, false)).toBe('workspace.phaseWaiting')
    expect(statusLabelKey(asking)).toBe('workspace.statusWaiting')
  })

  test('a code neither table knows falls through to the status default', () => {
    // The clause the comment on these tables claims and nothing asserted: a
    // reason code from a NEWER server must not blank the card or throw, on
    // either of the two statuses that carry a per-reason sentence.
    for (const status of ['review_ko', 'waiting_for_you'] as const) {
      const unknown = record({
        status,
        reason: { code: 'from_a_newer_server', detail: 'something new' },
      })
      expect(statusPhraseKey(unknown, false)).toBe(EXECUTION_STATUS[status].phraseKey)
      expect(statusLabelKey(unknown)).toBe(EXECUTION_STATUS[status].labelKey)
    }
  })

  // T3.6 adversarial review, MAJEUR 1. `runMergeStep` can park a task on
  // `waiting_for_you` with any of SIX codes; the ticket wired two. The four
  // below all read "Needs you · paused — waiting for your answer" while
  // nobody had asked anything — and `branch_diverged` is, per the ticket's own
  // design note, the most frequent refusal on an active repository.
  //
  // The mutation each of these kills: deleting its entry from
  // `WAITING_FIX_LOOP_KEYS`. Nothing else in the suite would notice.
  test('every exit of the merge gate names itself on waiting_for_you', () => {
    const cases = [
      {
        code: 'merge_conflict',
        phrase: 'workspace.phaseMergeConflict',
        label: 'workspace.statusMergeConflict',
      },
      {
        code: 'forge_unreachable',
        phrase: 'workspace.phaseForgeUnreachable',
        label: 'workspace.statusForgeUnreachable',
      },
      {
        code: 'branch_diverged',
        phrase: 'workspace.phaseBranchDiverged',
        label: 'workspace.statusBranchDiverged',
      },
      {
        code: 'checks_failed',
        phrase: 'workspace.phaseMergeChecksFailed',
        label: 'workspace.statusMergeHeld',
      },
    ] as const
    for (const one of cases) {
      const parked = record({
        status: 'waiting_for_you',
        reason: { code: one.code, detail: 'the sentence the server wrote' },
      })
      expect(statusPhraseKey(parked, false)).toBe(one.phrase)
      expect(statusLabelKey(parked)).toBe(one.label)
      // The defect itself, stated once per code: none of them is the generic
      // "paused — waiting for your answer" / "Needs you" pair.
      expect(statusPhraseKey(parked, false)).not.toBe('workspace.phaseWaiting')
      expect(statusLabelKey(parked)).not.toBe('workspace.statusWaiting')
    }
    // All six merge-gate exits stay pairwise distinct by PHRASE: a card that
    // said "the checks could not be run" for a merge conflict would be as
    // false as saying nothing.
    const phrases = [...cases.map((one) => one.code), 'checks_unavailable', 'criteria_missing'].map(
      (code) => statusPhraseKey(record({ status: 'waiting_for_you', reason: { code } }), false),
    )
    expect(new Set(phrases).size).toBe(6)
  })

  // The half of MAJEUR 1 the two tables cannot carry: `checks_failed` on
  // `waiting_for_you` is the merge gate holding a merge, NOT the reviewer
  // blocking a branch, and "review blocked — checks failed" would name the
  // wrong gate. Same code, two statuses, two sentences.
  test('checks_failed reads as a held MERGE on waiting_for_you and as a blocked REVIEW on review_ko', () => {
    const held = record({
      status: 'waiting_for_you',
      reason: { code: 'checks_failed', detail: 'repository checks failed (bun test)' },
    })
    const blocked = record({
      status: 'review_ko',
      reason: { code: 'checks_failed', detail: 'repository checks failed (bun test)' },
    })
    expect(statusPhraseKey(held, false)).not.toBe(statusPhraseKey(blocked, false))
    expect(statusLabelKey(held)).not.toBe(statusLabelKey(blocked))
    expect(statusPhraseKey(blocked, false)).toBe('workspace.phaseChecksFailed')
  })
})

// T3.6 adversarial review, MAJEUR 1, second half. The i18n phrase names the
// blocker; only `reason.detail` names the way OUT (DP1) — and nothing in the
// web rendered that field at all, on any component, for any status.
describe('reasonDetailText (the refusal says how to get out of it)', () => {
  test('a merge-gate park carries the server sentence', () => {
    const conflict = record({
      status: 'waiting_for_you',
      reason: {
        code: 'merge_conflict',
        detail: 'gh: not mergeable — resolve the overlap on the branch',
      },
    })
    expect(reasonDetailText(conflict)).toBe('gh: not mergeable — resolve the overlap on the branch')
  })

  test('a code with no per-reason phrase never leaks raw server English', () => {
    // The gate is the TABLE, not the presence of a detail: a machine-cap wait
    // and an unknown code from a newer server both carry a detail, and neither
    // has a translated sentence beside it to make it readable.
    const busy = record({
      status: 'queued',
      reason: { code: 'resource_busy', detail: 'the machine-wide load cap has no free slot' },
    })
    expect(reasonDetailText(busy)).toBeNull()
    const future = record({
      status: 'waiting_for_you',
      reason: { code: 'from_a_newer_server', detail: 'something new' },
    })
    expect(reasonDetailText(future)).toBeNull()
  })

  test('a question, a missing detail and an empty one all read as nothing to add', () => {
    expect(reasonDetailText(record({ status: 'waiting_for_you' }))).toBeNull()
    expect(
      reasonDetailText(record({ status: 'waiting_for_you', reason: { code: 'merge_conflict' } })),
    ).toBeNull()
    expect(
      reasonDetailText(
        record({ status: 'waiting_for_you', reason: { code: 'merge_conflict', detail: '   ' } }),
      ),
    ).toBeNull()
  })
})

describe('sectionOf', () => {
  test('waiting_for_you and review_ko demand the human', () => {
    expect(sectionOf('waiting_for_you')).toBe('waiting')
    expect(sectionOf('review_ko')).toBe('waiting')
  })

  // T8: nothing re-enqueues a stopped conversation — only a human gesture
  // does. That is the definition of the waiting zone, not of the done pile.
  test('interrupted waits for the human, it is not done', () => {
    expect(sectionOf('interrupted')).toBe('waiting')
  })

  test('running, reviewing and queued are in progress', () => {
    expect(sectionOf('running')).toBe('active')
    expect(sectionOf('reviewing')).toBe('active')
    expect(sectionOf('queued')).toBe('active')
  })

  test('terminal states are done', () => {
    expect(sectionOf('review_ok')).toBe('done')
    expect(sectionOf('shipped')).toBe('done')
    expect(sectionOf('failed')).toBe('done')
  })

  test('every status maps to a section', () => {
    const statuses: TaskStatus[] = [
      'queued',
      'running',
      'waiting_for_you',
      'reviewing',
      'review_ok',
      'review_ko',
      'shipped',
      'failed',
      'interrupted',
    ]
    for (const status of statuses) {
      expect(['waiting', 'active', 'done']).toContain(sectionOf(status))
    }
  })
})

describe('compareByActivity', () => {
  test('most recently updated first', () => {
    const older = record({ id: 'aaaaaaaaaaaa', updated_at: '2026-08-13T09:00:00.000Z' })
    const newer = record({ id: 'bbbbbbbbbbbb', updated_at: '2026-08-13T11:00:00.000Z' })
    expect([older, newer].toSorted(compareByActivity).map((r) => r.id)).toEqual([
      'bbbbbbbbbbbb',
      'aaaaaaaaaaaa',
    ])
  })

  test('id breaks ties for a stable order', () => {
    const a = record({ id: 'aaaaaaaaaaaa' })
    const b = record({ id: 'bbbbbbbbbbbb' })
    expect([b, a].toSorted(compareByActivity).map((r) => r.id)).toEqual([
      'aaaaaaaaaaaa',
      'bbbbbbbbbbbb',
    ])
  })

  test('unparsable dates fall back to the id order instead of NaN chaos', () => {
    const a = record({ id: 'aaaaaaaaaaaa', updated_at: 'garbage' })
    const b = record({ id: 'bbbbbbbbbbbb', updated_at: 'garbage' })
    expect(compareByActivity(a, b)).toBeLessThan(0)
  })
})

describe('formatDuration', () => {
  test('seconds below a minute', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(45_000)).toBe('45s')
  })

  test('minutes below an hour', () => {
    expect(formatDuration(5 * 60_000)).toBe('5min')
    expect(formatDuration(59 * 60_000)).toBe('59min')
  })

  test('hours and minutes above an hour', () => {
    expect(formatDuration(3_600_000 + 12 * 60_000)).toBe('1h 12min')
  })

  test('negative input clamps to zero', () => {
    expect(formatDuration(-500)).toBe('0s')
  })
})

describe('clockTime', () => {
  test('renders a zero-padded wall clock', () => {
    expect(clockTime('2026-08-13T09:05:00.000Z')).toMatch(/^\d{2}:\d{2}$/)
  })

  test('empty on garbage instead of NaN:NaN', () => {
    expect(clockTime('not-a-date')).toBe('')
  })
})

describe('titleFromPrompt', () => {
  test('first non-empty line, whitespace collapsed', () => {
    expect(titleFromPrompt('\n\n  Fix the   login bug\ndetails follow')).toBe('Fix the login bug')
  })

  test('clipped to 80 characters', () => {
    expect(titleFromPrompt('x'.repeat(200)).length).toBe(80)
  })

  test('empty prompt gives an empty title', () => {
    expect(titleFromPrompt('   \n  ')).toBe('')
  })
})

describe('firstString', () => {
  test('first non-empty string in key order', () => {
    expect(firstString({ a: '', b: '  hit  ', c: 'later' }, ['a', 'b', 'c'])).toBe('hit')
  })

  test('ignores non-string values', () => {
    expect(firstString({ a: 42, b: true, c: null }, ['a', 'b', 'c'])).toBeNull()
  })
})

describe('eventSummary', () => {
  test('tool_use combines tool name and input summary', () => {
    expect(
      eventSummary(event({ type: 'tool_use', data: { tool: 'Edit', summary: 'src/a.ts' } })),
    ).toBe('Edit · src/a.ts')
  })

  test('tool_use with a name only', () => {
    expect(eventSummary(event({ type: 'tool_use', data: { tool: 'Bash' } }))).toBe('Bash')
  })

  test('prep lines use the localized name, never a raw server sentence', () => {
    expect(
      eventSummary(event({ type: 'prep', data: { name: 'install_started', command: 'npm ci' } })),
    ).toBe('Installing dependencies · npm ci')
    expect(
      eventSummary(
        event({ type: 'prep', data: { name: 'install_failed', detail: 'ENOENT: failed to link' } }),
      ),
    ).toBe('Could not install dependencies · ENOENT: failed to link')
  })

  test('message uses its text', () => {
    expect(eventSummary(event({ type: 'message', data: { text: 'done reading' } }))).toBe(
      'done reading',
    )
  })

  test('review_started names the turn under review and the flow', () => {
    expect(eventSummary(event({ type: 'review_started', data: { turn: 2, mode: 'simple' } }))).toBe(
      'Review started · turn 2 · simple',
    )
    // A journal written before the payload existed keeps the plain label.
    expect(eventSummary(event({ type: 'review_started', data: {} }))).toBe('Review started')
    // A nonsense turn is dropped rather than rendered.
    expect(eventSummary(event({ type: 'review_started', data: { turn: 0, mode: 'dual' } }))).toBe(
      'Review started · dual',
    )
  })

  test('review_done appends the verdict', () => {
    expect(eventSummary(event({ type: 'review_done', data: { verdict: 'approve' } }))).toContain(
      'approve',
    )
  })

  test('unknown data falls back to the localized label, never crashes', () => {
    expect(eventSummary(event({ type: 'commit', data: {} }))).toBe('Commit')
    expect(eventSummary(event({ type: 'error', data: {} }))).toBe('Error')
  })

  // T1.6: the branch facts (rename declined, branch preserved, anchor
  // fallback) all read their text the same way message events do, but
  // through their own type — never mistaken for the agent's own words.
  test('branch uses its text, like message but through its own type', () => {
    expect(
      eventSummary(
        event({
          type: 'branch',
          data: { name: 'branch_preserved', text: 'kept codesema/task-x: it carries a commit' },
        }),
      ),
    ).toBe('kept codesema/task-x: it carries a commit')
    expect(eventSummary(event({ type: 'branch', data: {} }))).toBe('Branch')
  })

  test('long payloads are clipped', () => {
    const long = eventSummary(event({ type: 'message', data: { text: 'x'.repeat(500) } }))
    expect(long.length).toBeLessThanOrEqual(140)
    expect(long.endsWith('…')).toBe(true)
  })

  // T1.9 review round 3, MAJEUR 5 / §6 quater piège n°1: every `resource`
  // event T1.9 actually emits carries `data.message` — the server's own
  // English sentence — which is exactly the key `message` SUMMARY_KEYS uses
  // for most other types. If eventSummary ever fell back to the generic
  // firstString(data, SUMMARY_KEYS.resource) path, this would render that
  // raw English text in a French UI; the localized `workspace.evResource*`
  // keys would be dead code no test would ever catch (round 3's audit found
  // exactly that: 0 red tests on four separate mutations of this chain).
  test('resource: a recognized name renders its OWN translated line, never the raw server message', () => {
    expect(
      eventSummary(
        event({
          type: 'resource',
          data: { name: 'home_volume_released', message: 'HOME volume codesema-home-abc released' },
        }),
      ),
    ).toBe('HOME volume released')
    expect(
      eventSummary(
        event({
          type: 'resource',
          data: {
            name: 'home_volume_not_released',
            message: 'HOME volume codesema-home-abc could not be released: busy',
          },
        }),
      ),
    ).toBe('HOME volume could not be released')
    expect(
      eventSummary(
        event({
          type: 'resource',
          data: {
            name: 'container_runtime_absent',
            message:
              'no container runtime detected — HOME volume codesema-home-abc could not be released',
          },
        }),
      ),
    ).toBe('No container runtime — HOME volume could not be released')
  })

  test('resource: an unrecognized (or absent) name falls back to the localized type label, never to data.message', () => {
    expect(
      eventSummary(
        event({ type: 'resource', data: { name: 'not_a_real_name', message: 'raw english' } }),
      ),
    ).toBe('Resource')
    expect(
      eventSummary(event({ type: 'resource', data: { message: 'raw english, no name at all' } })),
    ).toBe('Resource')
  })

  // Adversarial review round 3, MAJEUR 4 ("workspace.evQueue est mort-né"):
  // `data.message` the server writes is a raw ENGLISH sentence
  // (MACHINE_LOAD_DETAIL/QUEUED_BEHIND_DETAIL) and was ALWAYS present, so the
  // `?? label` fallback that would have shown the translated label was
  // structurally unreachable. The summary must come from `data.name`, not
  // from the wire's raw message — and each of the two motifs gets its OWN
  // translated text, never the server's English sentence verbatim.
  test('queue renders a translated detail from data.name, never the raw server message', () => {
    const raw = 'the machine-wide load cap (maxConcurrentAgents) has no free slot for a turn'
    const summary = eventSummary(
      event({ type: 'queue', data: { name: 'machine_busy', message: raw } }),
    )
    expect(summary).toBe('Waiting for a machine slot')
    expect(summary).not.toContain(raw)
    expect(summary).not.toContain('maxConcurrentAgents')
  })

  test('queue distinguishes project_busy from machine_busy', () => {
    expect(
      eventSummary(
        event({
          type: 'queue',
          data: { name: 'project_busy', message: 'another task of this project is already active' },
        }),
      ),
    ).toBe('Waiting: another task of this project is already active')
  })

  test('queue with an unrecognized data.name degrades to the plain label, not a raw token', () => {
    expect(
      eventSummary(event({ type: 'queue', data: { name: 'something_future', message: 'x' } })),
    ).toBe('Waiting')
    // No data.name at all (an older journal line): same honest fallback.
    expect(eventSummary(event({ type: 'queue', data: {} }))).toBe('Waiting')
  })

  // Round-4 adversarial review, MAJEUR 1 ("the announce half is untested, and
  // the translated label is structurally unreachable"): ALL SIX 'issue'
  // constructors in task-issue.ts pose `data.message`, an English sentence
  // built server-side. While SUMMARY_KEYS.issue probed ['message','summary'],
  // that sentence won every time, the `?? label` fallback was dead code, and
  // the French journal showed six English sentences. The summary must come
  // from `data.name`, and NEVER from the wire's raw message.
  describe("'issue' (T2.4)", () => {
    const serverMessage =
      'task created from a forge issue: its ticket body and acceptance criteria are frozen in issue_snapshot'

    test('bound renders its own translated text, never the raw server message', () => {
      const summary = eventSummary(
        event({ type: 'issue', data: { name: 'bound', message: serverMessage } }),
      )
      expect(summary).toBe('Conversation created from a forge ticket')
      expect(summary).not.toContain(serverMessage)
      expect(summary).not.toContain('issue_snapshot')
    })

    test('each of the eight data.names gets its OWN text, never the shared label', () => {
      const summaries = (
        [
          'bound',
          'coverage_gap',
          'cosmetic',
          'edited',
          'not_ticket',
          'snapshot_unreadable',
          // Round-5 review, MAJEUR 1: this one used to travel on
          // `type: 'error'`, whose SUMMARY_KEYS probe `data.message` — so the
          // French journal read the server's English sentence, on every
          // ticketed task, at every boot without gh/glab.
          'unreachable',
          // T3.7: a cycle label that could not be written on the forge. Same
          // trap, same guard — task-labels.ts poses an English `data.message`
          // for the API, and the journal must not be the one showing it.
          'label_not_posed',
        ] as const
      ).map((name) => eventSummary(event({ type: 'issue', data: { name, message: 'ENGLISH' } })))
      // Eight distinct lines: routing them all to the same key (or to the
      // plain 'Ticket' label) collapses this set — and pointing any ONE of
      // them at a sibling's key collapses it by one.
      expect(new Set(summaries).size).toBe(8)
      for (const summary of summaries) {
        expect(summary).not.toBe('Ticket')
        expect(summary).not.toContain('ENGLISH')
      }
    })

    // DP13 requires the edited line to carry "the criteria diff by stable id".
    // Swapping the two fields — in reconcileIssueSnapshot or here — must not
    // be able to pass: the ADDED ids and the REMOVED ids are a non-empty,
    // DISJOINT pair, and each has to land on its own side of the sentence.
    test('edited names which sections moved and which criteria were added vs removed', () => {
      const summary = eventSummary(
        event({
          type: 'issue',
          data: {
            name: 'edited',
            sections: 'goal,out_of_scope',
            criteria_added: 'AC-4,AC-5',
            criteria_removed: 'AC-1',
            message: 'ENGLISH',
          },
        }),
      )
      expect(summary).toBe(
        'Ticket edited on the forge — sections: goal, out of scope; criteria added: AC-4, AC-5; removed: AC-1',
      )
      // Belt and braces on the swap specifically: the added ids come BEFORE
      // the removed one, and neither list leaks into the other's slot.
      expect(summary.indexOf('AC-4')).toBeLessThan(summary.indexOf('AC-1'))
      expect(summary).not.toContain('added: AC-1')
      expect(summary).not.toContain('removed: AC-4')
    })

    test('edited says "none" per empty axis, and never "none" for an unknown breakdown', () => {
      expect(
        eventSummary(
          event({
            type: 'issue',
            data: { name: 'edited', sections: 'context', criteria_added: '', criteria_removed: '' },
          }),
        ),
      ).toBe('Ticket edited on the forge — sections: context; criteria added: none; removed: none')
      // A snapshot with no per-section breakdown: the body hash PROVED
      // something moved, so "none" here would state the opposite of the truth.
      const unknown = eventSummary(
        event({
          type: 'issue',
          data: {
            name: 'edited',
            sections: '',
            sections_unknown: true,
            criteria_added: '',
            criteria_removed: '',
          },
        }),
      )
      expect(unknown).toContain('unknown (this snapshot has no per-section breakdown)')
      expect(unknown).not.toContain('sections: none')
    })

    test('an unrecognized data.name degrades to the plain label, not a raw token', () => {
      expect(
        eventSummary(event({ type: 'issue', data: { name: 'something_future', message: 'x' } })),
      ).toBe('Ticket')
      expect(eventSummary(event({ type: 'issue', data: {} }))).toBe('Ticket')
    })

    // T3.5 posts the recap on the ticket and journals seven more causes here.
    // Same trap as the six above: `issueEventText` reads `data.name` only, so
    // a name nobody wired shows the bare 'Ticket' label with the server's
    // English sentence nowhere in sight — and nothing else would notice.
    describe('recap publication (T3.5)', () => {
      const publishMessage =
        'the recap could not be posted on issue #42 (no-cli: no forge CLI) — it stays in .codesema'
      const publishNames = [
        'recap_posted',
        'recap_already_posted',
        'recap_missing',
        'recap_blocked_secrets',
        'recap_unreachable',
        'closed',
        'close_unreachable',
      ] as const

      test('each of the seven gets its OWN text, never the shared label', () => {
        const summaries = publishNames.map((name) =>
          eventSummary(event({ type: 'issue', data: { name, message: publishMessage } })),
        )
        expect(new Set(summaries).size).toBe(publishNames.length)
        for (const summary of summaries) {
          expect(summary).not.toBe('Ticket')
          expect(summary).not.toContain('.codesema')
          expect(summary).not.toContain('no forge CLI')
        }
      })

      test('a publication failure never reuses the ticket-freshness line of T2.4', () => {
        const publish = eventSummary(
          event({ type: 'issue', data: { name: 'recap_unreachable', message: publishMessage } }),
        )
        const compare = eventSummary(
          event({ type: 'issue', data: { name: 'unreachable', message: publishMessage } }),
        )
        expect(publish).not.toBe(compare)
        expect(publish).not.toContain('compared')
      })

      test('a held-back recap says both halves: what was found and where it now is', () => {
        const blocked = eventSummary(
          event({ type: 'issue', data: { name: 'recap_blocked_secrets' } }),
        )
        expect(blocked).toContain('secret')
        expect(blocked).toContain('machine')
      })
    })
  })

  describe("'shipped' (T3.5, round 2)", () => {
    const shipNote =
      'recap withheld from the merge request: it looks like it carries a secret (recap.md: an AWS access key id)'
    const shipNames = ['recap_missing', 'recap_blocked_secrets', 'recap_unscanned'] as const

    test('each of the three gets its OWN text, never the shared label', () => {
      const summaries = shipNames.map((name) =>
        eventSummary(
          event({ type: 'shipped', data: { mr_url: 'https://x/1', note: shipNote, name } }),
        ),
      )
      expect(new Set(summaries).size).toBe(shipNames.length)
      for (const summary of summaries) {
        expect(summary).not.toBe('Shipped')
        // The server's own English sentence never reaches the screen.
        expect(summary).not.toContain('withheld from the merge request')
        expect(summary).not.toContain('recap.md')
      }
    })

    test('a held-back recap says both halves: what happened and where the recap is', () => {
      const blocked = eventSummary(
        event({ type: 'shipped', data: { name: 'recap_blocked_secrets' } }),
      )
      expect(blocked).toContain('secret')
      expect(blocked).toContain('machine')
      // Distinguishable from the nominal ship, which is the whole point.
      expect(blocked).not.toBe(eventSummary(event({ type: 'shipped', data: {} })))
    })

    // The §6-quater trap, one type over: `data.note` is an ENGLISH sentence
    // the server builds (task-ship.ts), and it is present on EVERY degraded
    // ship — the push-only one, the one whose forge CLI failed. Probing it
    // would put that sentence, verbatim, in a French journal.
    test('a note without a name renders the label, never the server sentence', () => {
      const note =
        'no forge CLI (gh or glab) available — branch pushed, open the merge request manually'
      expect(eventSummary(event({ type: 'shipped', data: { mr_url: null, note } }))).toBe('Shipped')
      expect(
        eventSummary(
          event({ type: 'shipped', data: { note: 'gh failed: API rate limit exceeded' } }),
        ),
      ).toBe('Shipped')
    })

    test('the ordinary ship is untouched: the plain label, or its probed keys', () => {
      expect(eventSummary(event({ type: 'shipped', data: { mr_url: 'https://x/1' } }))).toBe(
        'Shipped',
      )
      expect(eventSummary(event({ type: 'shipped', data: { url: 'https://x/1' } }))).toBe(
        'https://x/1',
      )
      // An unknown name degrades the same way, never to a raw wire token.
      expect(eventSummary(event({ type: 'shipped', data: { name: 'something_future' } }))).toBe(
        'Shipped',
      )
    })
  })

  describe("'criteria' (T2.5)", () => {
    const serverMessage =
      'the agent reply did not carry a criteria draft protocol, so the task continues without acceptance criteria'

    test('draft_unparsed renders its own translated text, never the raw server message', () => {
      const summary = eventSummary(
        event({ type: 'criteria', data: { name: 'draft_unparsed', message: serverMessage } }),
      )
      expect(summary).toBe('The criteria draft was unreadable: the task continues without criteria')
      expect(summary).not.toContain(serverMessage)
      expect(summary).not.toContain('draft protocol')
    })

    test('validated renders its own translated text, never the raw server message', () => {
      const summary = eventSummary(
        event({
          type: 'criteria',
          data: { name: 'validated', message: 'acceptance criteria validated', count: 3 },
        }),
      )
      expect(summary).toBe('Acceptance criteria validated')
      expect(summary).not.toContain('acceptance criteria validated')
    })

    test('each data.name gets its OWN text, never the shared label', () => {
      const unparsed = eventSummary(
        event({ type: 'criteria', data: { name: 'draft_unparsed', message: 'ENGLISH' } }),
      )
      const validated = eventSummary(
        event({ type: 'criteria', data: { name: 'validated', message: 'ENGLISH' } }),
      )
      expect(unparsed).not.toBe(validated)
      expect(unparsed).not.toBe('Criteria')
      expect(validated).not.toBe('Criteria')
      expect(unparsed).not.toContain('ENGLISH')
      expect(validated).not.toContain('ENGLISH')
    })

    test('an unrecognized data.name degrades to the plain label, not a raw token', () => {
      expect(
        eventSummary(event({ type: 'criteria', data: { name: 'something_future', message: 'x' } })),
      ).toBe('Criteria')
      expect(eventSummary(event({ type: 'criteria', data: {} }))).toBe('Criteria')
    })

    // T3.2. The three names added by the criteria gate go through the SAME
    // `data.name` branch — `eventSummary` never reads `data.message` for a
    // 'criteria' event, which is exactly why the server stops putting a
    // sentence in there for these.
    test('the gate and the draft proposal each render their own text, never the label', () => {
      const blocked = eventSummary(
        event({
          type: 'criteria',
          data: { name: 'gate_blocked', met: 2, unmet: 1, unclear: 0 },
        }),
      )
      const passed = eventSummary(
        event({ type: 'criteria', data: { name: 'gate_passed', met: 3, unmet: 0, unclear: 0 } }),
      )
      const proposed = eventSummary(
        event({ type: 'criteria', data: { name: 'draft_proposed', count: 3 } }),
      )
      for (const line of [blocked, passed, proposed]) {
        expect(line).not.toBe('Criteria')
      }
      expect(new Set([blocked, passed, proposed]).size).toBe(3)
      expect(blocked).toContain('not satisfied')
      expect(passed).toContain('satisfied')
      expect(proposed).toContain('validate')
    })
  })
})

describe('eventTone', () => {
  test('semaphore: commits and ships go green, errors go red', () => {
    expect(eventTone(event({ type: 'commit' }))).toBe('go')
    expect(eventTone(event({ type: 'shipped' }))).toBe('go')
    expect(eventTone(event({ type: 'error' }))).toBe('stop')
  })

  test('turns and reviews in flight are amber, tools neutral', () => {
    expect(eventTone(event({ type: 'turn_started' }))).toBe('check')
    expect(eventTone(event({ type: 'review_started' }))).toBe('check')
    expect(eventTone(event({ type: 'tool_use' }))).toBe('idle')
  })

  test("'issue' events read their tone from data.name (DP9): edited/not_ticket are amber, the rest neutral", () => {
    expect(eventTone(event({ type: 'issue', data: { name: 'edited' } }))).toBe('check')
    expect(eventTone(event({ type: 'issue', data: { name: 'not_ticket' } }))).toBe('check')
    // A snapshot that cannot be read back retires edit detection for this
    // task until a human re-binds it: amber, like the other two.
    expect(eventTone(event({ type: 'issue', data: { name: 'snapshot_unreadable' } }))).toBe('check')
    // A forge this session could not read: amber, because the comparison did
    // not conclude — and above all NEVER 'stop', which is where it used to
    // land by travelling on `type: 'error'` while the task carried on
    // unmodified on its snapshot (DP9's cry-wolf).
    expect(eventTone(event({ type: 'issue', data: { name: 'unreachable' } }))).toBe('check')
    expect(eventTone(event({ type: 'issue', data: { name: 'unreachable' } }))).not.toBe('stop')
    expect(eventTone(event({ type: 'issue', data: { name: 'cosmetic' } }))).toBe('idle')
    expect(eventTone(event({ type: 'issue', data: { name: 'bound' } }))).toBe('idle')
    // An unknown name (a newer server) defaults to the routine tone, never amber.
    expect(eventTone(event({ type: 'issue', data: { name: 'something_future' } }))).toBe('idle')
  })

  // MAJEUR 2 (round 2). A ship whose recap was held back for carrying a
  // secret used to be a GREEN 'Shipped' line, byte-identical to a nominal
  // one: the story lived in `data.note`, which nothing renders.
  test('a ship that landed short of its recap is amber, a nominal one stays green', () => {
    for (const name of ['recap_missing', 'recap_blocked_secrets', 'recap_unscanned']) {
      expect(eventTone(event({ type: 'shipped', data: { name } }))).toBe('check')
    }
    // The push landed and the MR is open: amber, never red.
    for (const name of ['recap_missing', 'recap_blocked_secrets', 'recap_unscanned']) {
      expect(eventTone(event({ type: 'shipped', data: { name } }))).not.toBe('stop')
    }
    expect(eventTone(event({ type: 'shipped', data: { mr_url: 'https://x/1' } }))).toBe('go')
    // A name this bundle does not know keeps the ROUTINE tone: a future
    // addition must not be painted amber before anyone decided it should be.
    expect(eventTone(event({ type: 'shipped', data: { name: 'something_future' } }))).toBe('go')
  })

  test("T3.5's publication names split the same way: landed is neutral, held back is amber", () => {
    for (const name of ['recap_posted', 'recap_already_posted', 'closed']) {
      expect(eventTone(event({ type: 'issue', data: { name } }))).toBe('idle')
    }
    for (const name of [
      'recap_missing',
      'recap_blocked_secrets',
      'recap_unreachable',
      'close_unreachable',
    ]) {
      // Amber, never red: the task shipped and its recap is safe on disk.
      expect(eventTone(event({ type: 'issue', data: { name } }))).toBe('check')
    }
  })

  test("'criteria' events are neutral, never red — an unreadable draft does not fail the task", () => {
    expect(eventTone(event({ type: 'criteria', data: { name: 'draft_unparsed' } }))).toBe('idle')
    expect(eventTone(event({ type: 'criteria', data: { name: 'validated' } }))).toBe('idle')
    expect(eventTone(event({ type: 'criteria', data: { name: 'draft_unparsed' } }))).not.toBe(
      'stop',
    )
  })

  test("'criteria' reads its tone from data.name too: only a blocked gate is amber (T3.2)", () => {
    // The task is waiting on a person — meet the criteria or assume the KO —
    // which is the same amber as an edited ticket, and never the red of a
    // failure: the review itself worked and the work is committed.
    expect(eventTone(event({ type: 'criteria', data: { name: 'gate_blocked' } }))).toBe('check')
    expect(eventTone(event({ type: 'criteria', data: { name: 'gate_blocked' } }))).not.toBe('stop')
    // Everything else stays routine, including a name a newer server invents.
    expect(eventTone(event({ type: 'criteria', data: { name: 'gate_passed' } }))).toBe('idle')
    expect(eventTone(event({ type: 'criteria', data: { name: 'draft_proposed' } }))).toBe('idle')
    expect(eventTone(event({ type: 'criteria', data: { name: 'something_future' } }))).toBe('idle')
  })

  test('branch facts are neutral: none of them is a failure of the work', () => {
    expect(eventTone(event({ type: 'branch' }))).toBe('idle')
  })

  // T1.9 review round 3, MAJEUR 5: a released/leaked HOME volume never paints
  // the journal red (DP9) — the boot sweep is the backstop, not a task
  // failure. Round 3's audit mutated this to 'error' and found 0 red tests.
  test('resource stays neutral even on a release failure (DP9: the boot sweep is the backstop, not a task failure)', () => {
    expect(eventTone(event({ type: 'resource' }))).toBe('idle')
  })

  // Adversarial review round 3, MAJEUR 4 mutation table: an ordinary wait for
  // a resource is NOT a degradation (DP8(b)/DP9) — 'queue' must never paint
  // red like 'error' does, on the machine-cap wait as much as on the project
  // one. Explicit so the mutation `EVENT_TONE.queue: 'idle' -> 'stop'` (which
  // 2065 tests previously let through unnoticed) turns this test red.
  test('queue is a neutral wait, never a degradation', () => {
    expect(eventTone(event({ type: 'queue' }))).toBe('idle')
  })
})

describe('verdictLabelKey', () => {
  test('maps the three review verdicts to the shared labels', () => {
    expect(verdictLabelKey('approve')).toBe('verdict.approve')
    expect(verdictLabelKey('request_changes')).toBe('verdict.request_changes')
    expect(verdictLabelKey('comment')).toBe('verdict.comment')
  })

  test('null on anything else', () => {
    expect(verdictLabelKey('ok')).toBeNull()
    expect(verdictLabelKey(42)).toBeNull()
    expect(verdictLabelKey(undefined)).toBeNull()
  })
})

describe('findingsCount', () => {
  test('reads the first plausible numeric key', () => {
    expect(findingsCount({ findings: 3 })).toBe(3)
    expect(findingsCount({ findings_count: 0 })).toBe(0)
  })

  test('rejects negatives, floats and strings', () => {
    expect(findingsCount({ findings: -1 })).toBeNull()
    expect(findingsCount({ findings: 1.5 })).toBeNull()
    expect(findingsCount({ findings: '3' })).toBeNull()
    expect(findingsCount({})).toBeNull()
  })
})

describe('severityBreakdown', () => {
  test('worst first, absent severities simply missing', () => {
    expect(
      severityBreakdown({ severity_major: 2, severity_critical: 1, severity_info: 4 }),
    ).toEqual([
      { severity: 'critical', n: 1 },
      { severity: 'major', n: 2 },
      { severity: 'info', n: 4 },
    ])
  })

  test('an event without a spread yields nothing, junk is ignored', () => {
    expect(severityBreakdown({ verdict: 'approve' })).toEqual([])
    expect(
      severityBreakdown({ severity_major: 0, severity_minor: '3', severity_info: 1.5 }),
    ).toEqual([])
  })
})

describe('reviewRefOf', () => {
  test('the archive path when the event carries one', () => {
    expect(reviewRefOf({ ref: '/repo/.codesema/reviews/x-20260814-100000.json' })).toBe(
      '/repo/.codesema/reviews/x-20260814-100000.json',
    )
    expect(reviewRefOf({ ref: '  ' })).toBeNull()
    expect(reviewRefOf({})).toBeNull()
  })
})

describe('streamsLiveText', () => {
  test('the agent turn AND its review stream on the task_text channel', () => {
    expect(streamsLiveText('running')).toBe(true)
    expect(streamsLiveText('reviewing')).toBe(true)
  })

  test('every settled status drops the volatile text', () => {
    const settled: TaskStatus[] = [
      'queued',
      'waiting_for_you',
      'review_ok',
      'review_ko',
      'shipped',
      'failed',
      'interrupted',
    ]
    for (const status of settled) {
      expect(streamsLiveText(status)).toBe(false)
    }
  })
})

describe('mergeEvent', () => {
  test('plain append keeps order', () => {
    const events: TaskEvent[] = []
    mergeEvent(events, event({ seq: 1 }))
    mergeEvent(events, event({ seq: 2 }))
    expect(events.map((e) => e.seq)).toEqual([1, 2])
  })

  test('duplicate seq replaces instead of duplicating', () => {
    const events: TaskEvent[] = [event({ seq: 1, data: { text: 'live' } })]
    mergeEvent(events, event({ seq: 1, data: { text: 'hydrated' } }))
    expect(events).toHaveLength(1)
    expect(events[0]?.data.text).toBe('hydrated')
  })

  test('out-of-order arrival is inserted in place', () => {
    const events: TaskEvent[] = [event({ seq: 1 }), event({ seq: 3 })]
    mergeEvent(events, event({ seq: 2 }))
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
  })
})

describe('mergeLiveMessage', () => {
  test('a new index appends a bubble, the same index rewrites the one in flight', () => {
    const messages: LiveMessage[] = []
    mergeLiveMessage(messages, { seq: 0, text: 'let me' })
    mergeLiveMessage(messages, { seq: 0, text: 'let me look' })
    mergeLiveMessage(messages, { seq: 1, text: 'found it' })
    expect(messages).toEqual([
      { seq: 0, text: 'let me look' },
      { seq: 1, text: 'found it' },
    ])
  })

  test('blank text never opens a bubble', () => {
    const messages: LiveMessage[] = []
    mergeLiveMessage(messages, { seq: 0, text: '   \n' })
    expect(messages).toEqual([])
  })

  test('a mid-turn reconnect starting at a late index shows one bubble, not phantoms', () => {
    const messages: LiveMessage[] = []
    mergeLiveMessage(messages, { seq: 4, text: 'still here' })
    expect(messages).toEqual([{ seq: 4, text: 'still here' }])
  })

  test('an out-of-order frame lands at its place', () => {
    const messages: LiveMessage[] = [
      { seq: 1, text: 'one' },
      { seq: 3, text: 'three' },
    ]
    mergeLiveMessage(messages, { seq: 2, text: 'two' })
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3])
  })
})

describe('applyLiveText', () => {
  test('an indexed frame accumulates as a message, leaving the progress line alone', () => {
    const target = { liveText: 'reading the diff', liveMessages: [] as LiveMessage[] }
    applyLiveText(target, { text: 'first', seq: 0 })
    applyLiveText(target, { text: 'second', seq: 1 })
    expect(target.liveMessages).toEqual([
      { seq: 0, text: 'first' },
      { seq: 1, text: 'second' },
    ])
    expect(target.liveText).toBe('reading the diff')
  })

  test('a frame without an index is a status line: it replaces, it never piles up', () => {
    const target = { liveText: '', liveMessages: [] as LiveMessage[] }
    applyLiveText(target, { text: 'reading the diff' })
    applyLiveText(target, { text: 'writing the verdict' })
    expect(target.liveText).toBe('writing the verdict')
    expect(target.liveMessages).toEqual([])
  })
})

describe('keepsLiveMessages', () => {
  test('only the agent turn owns bubbles; the review and every settled state drop them', () => {
    expect(keepsLiveMessages('running')).toBe(true)
    const dropped: TaskStatus[] = [
      'queued',
      'reviewing',
      'waiting_for_you',
      'review_ok',
      'review_ko',
      'shipped',
      'failed',
      'interrupted',
    ]
    for (const status of dropped) {
      expect(keepsLiveMessages(status)).toBe(false)
    }
  })
})

describe('settlesLiveMessages', () => {
  test('the turn reply, its question and a new turn hand the bubbles over', () => {
    for (const type of ['turn_started', 'message', 'question'] as TaskEventType[]) {
      expect(settlesLiveMessages(type)).toBe(true)
    }
  })

  test('everything else leaves the live bubbles alone', () => {
    for (const type of ['tool_use', 'tool_result', 'commit', 'checks'] as TaskEventType[]) {
      expect(settlesLiveMessages(type)).toBe(false)
    }
  })
})

describe('replyModeOf', () => {
  test('server-replyable states send now', () => {
    for (const s of ['waiting_for_you', 'interrupted', 'review_ok', 'review_ko'] as TaskStatus[]) {
      expect(replyModeOf(s)).toBe('now')
    }
  })
  test('agent-held states queue', () => {
    for (const s of ['queued', 'running', 'reviewing'] as TaskStatus[]) {
      expect(replyModeOf(s)).toBe('queue')
    }
  })
  test('terminal states are dead', () => {
    for (const s of ['shipped', 'failed'] as TaskStatus[]) {
      expect(replyModeOf(s)).toBe('dead')
    }
  })
})

describe('groupThreadEvents', () => {
  test('consecutive tool events fold into one block, others stay single', () => {
    const events = [
      event({ seq: 1, type: 'turn_started' }),
      event({ seq: 2, type: 'tool_use' }),
      event({ seq: 3, type: 'tool_result' }),
      event({ seq: 4, type: 'tool_use' }),
      event({ seq: 5, type: 'message' }),
      event({ seq: 6, type: 'commit' }),
    ]
    const blocks = groupThreadEvents(events)
    expect(blocks.map((b) => b.kind)).toEqual(['single', 'tools', 'single', 'single'])
    const tools = blocks[1]
    if (tools?.kind !== 'tools') {
      throw new Error('expected tools block')
    }
    expect(tools.events.map((e) => e.seq)).toEqual([2, 3, 4])
    expect(tools.turnIndex).toBe(0)
  })

  test('a new turn opens a NEW tools block even with adjacent tool events', () => {
    const events = [
      event({ seq: 1, type: 'turn_started' }),
      event({ seq: 2, type: 'tool_use' }),
      event({ seq: 3, type: 'turn_started' }),
      event({ seq: 4, type: 'tool_use' }),
    ]
    const blocks = groupThreadEvents(events)
    expect(blocks.map((b) => b.kind)).toEqual(['single', 'tools', 'single', 'tools'])
    const second = blocks[3]
    if (second?.kind !== 'tools') {
      throw new Error('expected tools block')
    }
    expect(second.turnIndex).toBe(1)
  })

  test('empty journal: no blocks', () => {
    expect(groupThreadEvents([])).toEqual([])
  })
})

describe('formatTokens', () => {
  test('compact scales', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(843)).toBe('843')
    expect(formatTokens(1200)).toBe('1.2k')
    expect(formatTokens(12400)).toBe('12k')
    expect(formatTokens(1_240_000)).toBe('1.2M')
  })
})

// ── T4 work queue grammar ──────────────────────────────────────────────────

describe('queueSectionOf', () => {
  test('waiting_for_you and review_ko block on the human', () => {
    expect(queueSectionOf('waiting_for_you')).toBe('attention')
    expect(queueSectionOf('review_ko')).toBe('attention')
  })

  // T8: a stopped conversation belongs in the work queue with a [Resume] on
  // its card, never folded away with the shipped and the failed.
  test('interrupted blocks on the human too, never in the done pile', () => {
    expect(queueSectionOf('interrupted')).toBe('attention')
  })

  test('running, reviewing and queued are the machine at work', () => {
    expect(queueSectionOf('running')).toBe('active')
    expect(queueSectionOf('reviewing')).toBe('active')
    expect(queueSectionOf('queued')).toBe('active')
  })

  test('review_ok alone is ready to ship', () => {
    expect(queueSectionOf('review_ok')).toBe('ready')
  })

  test('terminal states are done', () => {
    expect(queueSectionOf('shipped')).toBe('done')
    expect(queueSectionOf('failed')).toBe('done')
  })

  test('every status lands in exactly one queue section', () => {
    const statuses: TaskStatus[] = [
      'queued',
      'running',
      'waiting_for_you',
      'reviewing',
      'review_ok',
      'review_ko',
      'shipped',
      'failed',
      'interrupted',
    ]
    for (const status of statuses) {
      expect(['attention', 'active', 'ready', 'done']).toContain(queueSectionOf(status))
    }
  })
})

describe('groupQueue', () => {
  test('splits by section and sorts by activity within each', () => {
    const states = [
      { record: record({ id: 'a', status: 'running', updated_at: '2026-08-13T10:00:00Z' }) },
      {
        record: record({ id: 'b', status: 'waiting_for_you', updated_at: '2026-08-13T11:00:00Z' }),
      },
      { record: record({ id: 'c', status: 'running', updated_at: '2026-08-13T12:00:00Z' }) },
      { record: record({ id: 'd', status: 'review_ok', updated_at: '2026-08-13T09:00:00Z' }) },
      { record: record({ id: 'e', status: 'shipped', updated_at: '2026-08-13T08:00:00Z' }) },
    ]
    const groups = groupQueue(states)
    expect(groups.attention.map((s) => s.record.id)).toEqual(['b'])
    expect(groups.active.map((s) => s.record.id)).toEqual(['c', 'a'])
    expect(groups.ready.map((s) => s.record.id)).toEqual(['d'])
    expect(groups.done.map((s) => s.record.id)).toEqual(['e'])
  })

  test('empty input yields four empty sections', () => {
    expect(groupQueue([])).toEqual({ attention: [], active: [], ready: [], done: [] })
  })
})

describe('lastQuestion', () => {
  test('returns the text of the LAST question event', () => {
    const events = [
      event({ seq: 1, type: 'question', data: { question: 'first?' } }),
      event({ seq: 2, type: 'message', data: { text: 'noise' } }),
      event({ seq: 3, type: 'question', data: { question: 'second?' } }),
    ]
    expect(lastQuestion(events)).toBe('second?')
  })

  test('probes the fallback data keys', () => {
    expect(lastQuestion([event({ type: 'question', data: { text: 'via text' } })])).toBe('via text')
  })

  test('null without any question event', () => {
    expect(lastQuestion([event({ type: 'message', data: { text: 'hi' } })])).toBeNull()
  })
})

describe('waitingSince', () => {
  test('the last question timestamp wins', () => {
    const events = [
      event({ seq: 1, type: 'question', at: '2026-08-13T10:00:00.000Z' }),
      event({ seq: 2, type: 'question', at: '2026-08-13T11:00:00.000Z' }),
    ]
    expect(waitingSince(events, '2026-08-13T12:00:00.000Z')).toBe(
      Date.parse('2026-08-13T11:00:00.000Z'),
    )
  })

  test('falls back to the record update time without questions', () => {
    expect(waitingSince([], '2026-08-13T12:00:00.000Z')).toBe(
      Date.parse('2026-08-13T12:00:00.000Z'),
    )
  })

  test('null when nothing parses', () => {
    expect(waitingSince([], 'not-a-date')).toBeNull()
  })
})

describe('matchesQuery', () => {
  test('blank query matches everything', () => {
    expect(matchesQuery(record({}), '')).toBe(true)
    expect(matchesQuery(record({}), '   ')).toBe(true)
  })

  test('case-insensitive on title and branch', () => {
    const r = record({ title: 'Fix API pagination', branch: 'codesema/task-42' })
    expect(matchesQuery(r, 'api PAG')).toBe(true)
    expect(matchesQuery(r, 'api pag')).toBe(true)
    expect(matchesQuery(r, 'PAGINATION')).toBe(true)
    expect(matchesQuery(r, 'task-42')).toBe(true)
    expect(matchesQuery(r, 'nope')).toBe(false)
  })
})

describe('agentCounts', () => {
  test('needsYou counts waiting_for_you; agents counts running + reviewing', () => {
    const states = [
      { record: record({ status: 'waiting_for_you' }) },
      { record: record({ status: 'waiting_for_you' }) },
      { record: record({ status: 'running' }) },
      { record: record({ status: 'reviewing' }) },
      { record: record({ status: 'queued' }) },
      { record: record({ status: 'review_ok' }) },
      { record: record({ status: 'shipped' }) },
    ]
    expect(agentCounts(states)).toEqual({ needsYou: 2, agents: 2 })
  })

  // T8: the badge is how a stopped conversation gets noticed at all after a
  // restart — the terminal line scrolls away, the bell does not.
  test('needsYou counts interrupted conversations too', () => {
    const states = [
      { record: record({ status: 'interrupted' }) },
      { record: record({ status: 'waiting_for_you' }) },
      { record: record({ status: 'failed' }) },
    ]
    expect(agentCounts(states)).toEqual({ needsYou: 2, agents: 0 })
  })

  test('zeroes on an empty workspace', () => {
    expect(agentCounts([])).toEqual({ needsYou: 0, agents: 0 })
  })
})

describe('oldestWaiting', () => {
  test('picks the waiting conversation that has waited the longest', () => {
    const states = [
      {
        record: record({ id: 'a', status: 'waiting_for_you', updated_at: '2026-08-13T11:00:00Z' }),
      },
      {
        record: record({ id: 'b', status: 'waiting_for_you', updated_at: '2026-08-13T09:00:00Z' }),
      },
      { record: record({ id: 'c', status: 'running', updated_at: '2026-08-13T08:00:00Z' }) },
    ]
    expect(oldestWaiting(states)?.record.id).toBe('b')
  })

  // The bell's count and the bell's click must never disagree: both read the
  // same "blocked on the human" set.
  test('an interrupted conversation is a valid bell target', () => {
    const states = [
      {
        record: record({ id: 'a', status: 'waiting_for_you', updated_at: '2026-08-13T11:00:00Z' }),
      },
      { record: record({ id: 'b', status: 'interrupted', updated_at: '2026-08-13T07:00:00Z' }) },
    ]
    expect(oldestWaiting(states)?.record.id).toBe('b')
  })

  test('null without any waiting conversation', () => {
    expect(oldestWaiting([{ record: record({ status: 'running' }) }])).toBeNull()
  })
})

// ── T8: what a stopped conversation offers ─────────────────────────────────

describe('resumeStateOf', () => {
  const pending = {
    prompt: 'do it',
    response: null,
    question: null,
    started_at: '',
    ended_at: null,
  }
  const answered = { ...pending, response: 'done', ended_at: '2026-08-13T10:00:00Z' }

  test("'ready' when the last turn never answered: that turn is re-runnable", () => {
    expect(resumeStateOf(record({ status: 'interrupted', turns: [pending] }))).toBe('ready')
    // Several turns deep, the same rule: only the last one matters.
    expect(resumeStateOf(record({ status: 'interrupted', turns: [answered, pending] }))).toBe(
      'ready',
    )
  })

  test("'reply' when the agent HAD answered: nothing to restart, only to say", () => {
    expect(resumeStateOf(record({ status: 'interrupted', turns: [answered] }))).toBe('reply')
    // A record with no turn at all cannot re-run anything either.
    expect(resumeStateOf(record({ status: 'interrupted', turns: [] }))).toBe('reply')
  })

  test("'none' on every other status: there is no resume to offer", () => {
    const statuses: TaskStatus[] = [
      'queued',
      'running',
      'waiting_for_you',
      'reviewing',
      'review_ok',
      'review_ko',
      'shipped',
      'failed',
    ]
    for (const status of statuses) {
      expect(resumeStateOf(record({ status, turns: [pending] }))).toBe('none')
    }
  })
})

describe('focusTabs', () => {
  test('conversation and checks are always live (the checks body self-explains)', () => {
    for (const hasBranch of [true, false]) {
      const tabs = focusTabs(hasBranch)
      expect(tabs.map((tab) => tab.id)).toEqual(['conversation', 'diff', 'checks'])
      expect(tabs[0]?.enabled).toBe(true)
      expect(tabs[2]?.enabled).toBe(true)
    }
  })

  test('diff needs a branch to diff against', () => {
    expect(focusTabs(true)[1]?.enabled).toBe(true)
    expect(focusTabs(false)[1]?.enabled).toBe(false)
  })
})

describe('timeAgo', () => {
  const NOW = Date.parse('2026-08-13T10:04:00Z')

  test('renders the relative phrase (no window: English catalog)', () => {
    expect(timeAgo('2026-08-13T10:00:00Z', NOW)).toBe('4min ago')
  })

  test('a future stamp clamps to zero instead of going negative', () => {
    expect(timeAgo('2026-08-13T10:05:00Z', NOW)).toBe('0s ago')
  })

  test('null on an unparsable date', () => {
    expect(timeAgo('not-a-date', NOW)).toBeNull()
  })
})

describe('splitInlineCode', () => {
  test('backtick pairs become code segments', () => {
    expect(splitInlineCode('use `cursor_v2` here')).toEqual([
      { code: false, text: 'use ' },
      { code: true, text: 'cursor_v2' },
      { code: false, text: ' here' },
    ])
  })

  test('plain text stays one segment', () => {
    expect(splitInlineCode('no code at all')).toEqual([{ code: false, text: 'no code at all' }])
  })

  test('an unpaired backtick is literal text', () => {
    expect(splitInlineCode('a ` b')).toEqual([{ code: false, text: 'a ` b' }])
  })

  test('empty input yields one empty plain segment', () => {
    expect(splitInlineCode('')).toEqual([{ code: false, text: '' }])
  })

  test('code at both ends', () => {
    expect(splitInlineCode('`a` mid `b`')).toEqual([
      { code: true, text: 'a' },
      { code: false, text: ' mid ' },
      { code: true, text: 'b' },
    ])
  })
})
