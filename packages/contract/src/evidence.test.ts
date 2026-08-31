import { describe, expect, test } from 'bun:test'
import {
  EVIDENCE_ITEMS_MAX,
  EVIDENCE_PATH_MAX,
  EVIDENCE_REASON_MAX,
  sanitizeEvidence,
  type EvidenceRecord,
} from './evidence.js'

const FULL_RECORD: EvidenceRecord = {
  version: 1,
  status: 'passed',
  reason: null,
  head_sha: 'a1b2c3d4',
  items: [
    {
      kind: 'screenshot',
      path: 'step-1.png',
      bytes: 1_024,
      turn: 1,
      created_at: '2026-08-30T10:00:00Z',
    },
    { kind: 'video', path: 'run.mp4', bytes: 2_048, turn: 2, created_at: '2026-08-30T10:05:00Z' },
  ],
}

test('published bounds are locked to their literal values', () => {
  expect(EVIDENCE_ITEMS_MAX).toBe(40)
  expect(EVIDENCE_PATH_MAX).toBe(200)
  expect(EVIDENCE_REASON_MAX).toBe(2_000)
})

describe('sanitizeEvidence', () => {
  test('a valid, full record round-trips unchanged', () => {
    expect(sanitizeEvidence(structuredClone(FULL_RECORD))).toEqual(FULL_RECORD)
  })

  test('a minimal record (no reason, no head_sha, no items) is honest about the rest', () => {
    const out = sanitizeEvidence({ version: 1, status: 'skipped', items: [] })
    expect(out).toEqual({ version: 1, status: 'skipped', reason: null, head_sha: null, items: [] })
  })

  test('non-object input never throws and returns null', () => {
    for (const raw of [null, undefined, 42, 'x', [], Symbol('x'), true]) {
      expect(() => sanitizeEvidence(raw)).not.toThrow()
      expect(sanitizeEvidence(raw)).toBeNull()
    }
  })

  test('an unknown or missing version is refused: the record identity is version 1', () => {
    for (const raw of [
      { version: 2, status: 'passed', items: [] },
      { version: '1', status: 'passed', items: [] },
      { status: 'passed', items: [] },
    ]) {
      expect(sanitizeEvidence(raw)).toBeNull()
    }
  })

  test('a status outside the union is refused', () => {
    expect(sanitizeEvidence({ version: 1, status: 'bogus', items: [] })).toBeNull()
  })

  test('reason: over-long is truncated to its published bound, not dropped', () => {
    const out = sanitizeEvidence({
      version: 1,
      status: 'failed',
      reason: 'x'.repeat(EVIDENCE_REASON_MAX + 500),
      items: [],
    })
    expect(out?.reason).toHaveLength(EVIDENCE_REASON_MAX)
  })

  test('reason: absent or non-string is null, never a placeholder', () => {
    for (const bad of [undefined, 42, null, {}, []]) {
      const out = sanitizeEvidence({ version: 1, status: 'passed', reason: bad, items: [] })
      expect(out?.reason).toBeNull()
    }
  })

  test('head_sha: non-string or empty is null, never a placeholder', () => {
    for (const bad of [undefined, 42, null, '', {}, []]) {
      const out = sanitizeEvidence({ version: 1, status: 'passed', head_sha: bad, items: [] })
      expect(out?.head_sha).toBeNull()
    }
  })

  test('unknown top-level fields are dropped (whitelist)', () => {
    const withExtra = { ...structuredClone(FULL_RECORD), evil: 'payload', __proto__: { x: 1 } }
    expect(Object.keys(sanitizeEvidence(withExtra) ?? {})).not.toContain('evil')
  })

  test('unknown item fields are dropped (whitelist)', () => {
    const out = sanitizeEvidence({
      version: 1,
      status: 'passed',
      items: [
        {
          kind: 'screenshot',
          path: 'ok.png',
          bytes: 1,
          turn: 1,
          created_at: 'x',
          evil: 'payload',
        },
      ],
    })
    expect(out?.items).toEqual([
      { kind: 'screenshot', path: 'ok.png', bytes: 1, turn: 1, created_at: 'x' },
    ])
  })

  test('items[]: an entry with an unrecognized kind is dropped, not the whole list', () => {
    const out = sanitizeEvidence({
      version: 1,
      status: 'passed',
      items: [
        { kind: 'gif', path: 'a.gif', bytes: 1, turn: 1, created_at: 'x' },
        { kind: 'screenshot', path: 'ok.png', bytes: 1, turn: 1, created_at: 'x' },
      ],
    })
    expect(out?.items).toEqual([
      { kind: 'screenshot', path: 'ok.png', bytes: 1, turn: 1, created_at: 'x' },
    ])
  })

  test('items[].path: a traversal segment ("../x") is rejected outright', () => {
    const out = sanitizeEvidence({
      version: 1,
      status: 'passed',
      items: [{ kind: 'screenshot', path: '../x', bytes: 1, turn: 1, created_at: 'x' }],
    })
    expect(out?.items).toEqual([])
  })

  test('items[].path: any path containing a slash is rejected', () => {
    const out = sanitizeEvidence({
      version: 1,
      status: 'passed',
      items: [{ kind: 'screenshot', path: 'dir/file.png', bytes: 1, turn: 1, created_at: 'x' }],
    })
    expect(out?.items).toEqual([])
  })

  test('items[].path: over the max length is rejected outright, never truncated', () => {
    const out = sanitizeEvidence({
      version: 1,
      status: 'passed',
      items: [
        {
          kind: 'screenshot',
          path: `${'a'.repeat(EVIDENCE_PATH_MAX + 1)}.png`,
          bytes: 1,
          turn: 1,
          created_at: 'x',
        },
      ],
    })
    expect(out?.items).toEqual([])
  })

  test('items[].path: a path at exactly the max length, matching the whitelist, is kept', () => {
    const path = 'a'.repeat(EVIDENCE_PATH_MAX)
    const out = sanitizeEvidence({
      version: 1,
      status: 'passed',
      items: [{ kind: 'screenshot', path, bytes: 1, turn: 1, created_at: 'x' }],
    })
    expect(out?.items).toEqual([{ kind: 'screenshot', path, bytes: 1, turn: 1, created_at: 'x' }])
  })

  test('items[].bytes: a negative, non-integer or non-numeric value is rejected, one entry at a time', () => {
    for (const bad of [-1, 1.5, 'x', null, undefined, Number.NaN, 2 ** 53]) {
      const out = sanitizeEvidence({
        version: 1,
        status: 'passed',
        items: [{ kind: 'screenshot', path: 'ok.png', bytes: bad, turn: 1, created_at: 'x' }],
      })
      expect(out?.items).toEqual([])
    }
  })

  test('items[].turn: a negative, non-integer or non-numeric value is rejected, one entry at a time', () => {
    for (const bad of [-1, 1.5, 'x', null, undefined, Number.NaN]) {
      const out = sanitizeEvidence({
        version: 1,
        status: 'passed',
        items: [{ kind: 'screenshot', path: 'ok.png', bytes: 1, turn: bad, created_at: 'x' }],
      })
      expect(out?.items).toEqual([])
    }
  })

  test('items[].created_at: a non-string or empty value is rejected, one entry at a time', () => {
    for (const bad of ['', 42, null, undefined]) {
      const out = sanitizeEvidence({
        version: 1,
        status: 'passed',
        items: [{ kind: 'screenshot', path: 'ok.png', bytes: 1, turn: 1, created_at: bad }],
      })
      expect(out?.items).toEqual([])
    }
  })

  test('items[]: a non-object entry (null, string, array) is dropped, never thrown on', () => {
    const out = sanitizeEvidence({
      version: 1,
      status: 'passed',
      items: [
        null,
        'x',
        [],
        { kind: 'screenshot', path: 'ok.png', bytes: 1, turn: 1, created_at: 'x' },
      ],
    })
    expect(out?.items).toEqual([
      { kind: 'screenshot', path: 'ok.png', bytes: 1, turn: 1, created_at: 'x' },
    ])
  })

  test('items[] is capped at EVIDENCE_ITEMS_MAX; the excess is discarded, not the whole list', () => {
    const many = Array.from({ length: EVIDENCE_ITEMS_MAX + 1 }, (_, i) => ({
      kind: 'screenshot' as const,
      path: `s${i}.png`,
      bytes: 1,
      turn: i,
      created_at: 'x',
    }))
    const out = sanitizeEvidence({ version: 1, status: 'passed', items: many })
    expect(out?.items).toHaveLength(EVIDENCE_ITEMS_MAX)
  })

  test('items that is not an array yields an empty list, never a throw', () => {
    for (const bad of ['not-an-array', 42, null]) {
      const out = sanitizeEvidence({ version: 1, status: 'passed', items: bad })
      expect(out?.items).toEqual([])
    }
  })

  test('hostile entry never throws: wrong types everywhere, null and undefined', () => {
    const hostile = {
      version: '1',
      status: 'BOGUS',
      reason: { nested: true },
      head_sha: 42,
      items: [
        { kind: 'gif', path: 'a.gif', bytes: 1, turn: 1, created_at: 'x' },
        { kind: 'screenshot', path: '../etc/passwd', bytes: -1, turn: 'z', created_at: '' },
        null,
        'x',
      ],
    }
    expect(() => sanitizeEvidence(hostile)).not.toThrow()
    expect(sanitizeEvidence(hostile)).toBeNull()
  })
})
