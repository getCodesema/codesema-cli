import { describe, expect, test } from 'bun:test'
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
  queueSectionOf,
  replyModeOf,
  resumeStateOf,
  reviewRefOf,
  sectionOf,
  settlesLiveMessages,
  severityBreakdown,
  splitInlineCode,
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

  test('long payloads are clipped', () => {
    const long = eventSummary(event({ type: 'message', data: { text: 'x'.repeat(500) } }))
    expect(long.length).toBeLessThanOrEqual(140)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('eventTone', () => {
  test('semaphore: commits and ships go green, errors go red', () => {
    expect(eventTone('commit')).toBe('go')
    expect(eventTone('shipped')).toBe('go')
    expect(eventTone('error')).toBe('stop')
  })

  test('turns and reviews in flight are amber, tools neutral', () => {
    expect(eventTone('turn_started')).toBe('check')
    expect(eventTone('review_started')).toBe('check')
    expect(eventTone('tool_use')).toBe('idle')
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
