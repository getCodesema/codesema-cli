import { describe, expect, test } from 'bun:test'
import type { TaskEvent, TaskRecord, TaskStatus } from '../types'
import {
  clockTime,
  compareByActivity,
  eventSummary,
  eventTone,
  findingsCount,
  firstString,
  formatDuration,
  groupBySection,
  lastActivity,
  mergeEvent,
  sectionOf,
  titleFromPrompt,
  verdictLabelKey,
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

  test('running, reviewing and queued are in progress', () => {
    expect(sectionOf('running')).toBe('active')
    expect(sectionOf('reviewing')).toBe('active')
    expect(sectionOf('queued')).toBe('active')
  })

  test('terminal states are done', () => {
    expect(sectionOf('review_ok')).toBe('done')
    expect(sectionOf('shipped')).toBe('done')
    expect(sectionOf('failed')).toBe('done')
    expect(sectionOf('interrupted')).toBe('done')
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

describe('groupBySection', () => {
  test('splits and sorts each zone by activity', () => {
    const waiting = record({
      id: 'aaaaaaaaaaaa',
      status: 'waiting_for_you',
      updated_at: '2026-08-13T09:00:00.000Z',
    })
    const runningNew = record({
      id: 'bbbbbbbbbbbb',
      status: 'running',
      updated_at: '2026-08-13T11:00:00.000Z',
    })
    const runningOld = record({
      id: 'cccccccccccc',
      status: 'running',
      updated_at: '2026-08-13T10:00:00.000Z',
    })
    const done = record({ id: 'dddddddddddd', status: 'shipped' })
    const grouped = groupBySection([done, runningOld, waiting, runningNew])
    expect(grouped.waiting.map((r) => r.id)).toEqual(['aaaaaaaaaaaa'])
    expect(grouped.active.map((r) => r.id)).toEqual(['bbbbbbbbbbbb', 'cccccccccccc'])
    expect(grouped.done.map((r) => r.id)).toEqual(['dddddddddddd'])
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

describe('lastActivity', () => {
  test('the streamed text wins while the agent writes', () => {
    const events = [event({ seq: 1, type: 'commit', data: { message: 'c1' } })]
    expect(lastActivity(events, 'first line\nlatest line\n')).toBe('latest line')
  })

  test('falls back to the latest journal event', () => {
    const events = [
      event({ seq: 1, type: 'commit', data: { message: 'c1' } }),
      event({ seq: 2, type: 'message', data: { text: 'wrote the tests' } }),
    ]
    expect(lastActivity(events, '')).toBe('wrote the tests')
  })

  test('null when there is nothing at all', () => {
    expect(lastActivity([], '')).toBeNull()
    expect(lastActivity([], '   \n ')).toBeNull()
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
