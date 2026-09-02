import { describe, expect, test } from 'bun:test'
import {
  PROOF_INTENT_PAGES_MAX,
  PROOF_INTENT_PATH_MAX,
  PROOF_INTENT_REASON_MAX,
  sanitizeProofIntent,
  sanitizeProofReview,
} from './proof-intent.js'

test('published bounds are locked to their literal values', () => {
  expect(PROOF_INTENT_REASON_MAX).toBe(500)
  expect(PROOF_INTENT_PAGES_MAX).toBe(8)
  expect(PROOF_INTENT_PATH_MAX).toBe(200)
})

describe('sanitizeProofIntent', () => {
  test('non-object input never throws and returns null', () => {
    for (const raw of [null, undefined, 42, 'x', [], Symbol('x'), true]) {
      expect(() => sanitizeProofIntent(raw)).not.toThrow()
      expect(sanitizeProofIntent(raw)).toBeNull()
    }
  })

  test('a kind outside the closed enum is refused', () => {
    expect(sanitizeProofIntent({ kind: 'bogus', reason: 'r' })).toBeNull()
  })

  test('a missing, empty or non-string reason is refused', () => {
    for (const bad of [undefined, '', '   ', 42, null, {}]) {
      expect(sanitizeProofIntent({ kind: 'none', reason: bad })).toBeNull()
    }
  })

  test('reason: over-long is truncated to the published bound', () => {
    const out = sanitizeProofIntent({
      kind: 'none',
      reason: 'x'.repeat(PROOF_INTENT_REASON_MAX + 500),
    })
    expect(out?.reason).toHaveLength(PROOF_INTENT_REASON_MAX)
  })

  test('kind: none carries no pages or journey even when supplied', () => {
    const out = sanitizeProofIntent({ kind: 'none', reason: 'r', pages: ['/a'], journey: 'b' })
    expect(out).toEqual({ kind: 'none', reason: 'r' })
  })

  test('kind: screenshot with valid pages keeps them', () => {
    const out = sanitizeProofIntent({ kind: 'screenshot', reason: 'r', pages: ['/a', '/b/c'] })
    expect(out).toEqual({ kind: 'screenshot', reason: 'r', pages: ['/a', '/b/c'] })
  })

  test('kind: screenshot ignores journey — not relevant to this kind', () => {
    const out = sanitizeProofIntent({ kind: 'screenshot', reason: 'r', journey: 'checkout' })
    expect(out).toEqual({ kind: 'screenshot', reason: 'r' })
  })

  test('kind: journey with a valid path keeps it', () => {
    const out = sanitizeProofIntent({ kind: 'journey', reason: 'r', journey: 'checkout/pay' })
    expect(out).toEqual({ kind: 'journey', reason: 'r', journey: 'checkout/pay' })
  })

  test('kind: journey ignores pages — not relevant to this kind', () => {
    const out = sanitizeProofIntent({ kind: 'journey', reason: 'r', pages: ['/a'] })
    expect(out).toEqual({ kind: 'journey', reason: 'r' })
  })

  test('pages: a protocol-relative entry ("//evil.com") is rejected outright', () => {
    const out = sanitizeProofIntent({
      kind: 'screenshot',
      reason: 'r',
      pages: ['//evil.com', '/ok'],
    })
    expect(out?.pages).toEqual(['/ok'])
  })

  test('pages: an entry without a leading slash is rejected', () => {
    const out = sanitizeProofIntent({ kind: 'screenshot', reason: 'r', pages: ['a', '/ok'] })
    expect(out?.pages).toEqual(['/ok'])
  })

  test('pages: an entry containing ".." is rejected', () => {
    const out = sanitizeProofIntent({
      kind: 'screenshot',
      reason: 'r',
      pages: ['/a/../b', '/ok'],
    })
    expect(out?.pages).toEqual(['/ok'])
  })

  test('pages: an entry containing an apostrophe is rejected', () => {
    const out = sanitizeProofIntent({ kind: 'screenshot', reason: 'r', pages: ["/it's", '/ok'] })
    expect(out?.pages).toEqual(['/ok'])
  })

  test('pages: an entry containing a space is rejected', () => {
    const out = sanitizeProofIntent({ kind: 'screenshot', reason: 'r', pages: ['/a b', '/ok'] })
    expect(out?.pages).toEqual(['/ok'])
  })

  test('pages: an entry over the max path length is rejected outright, never truncated', () => {
    const tooLong = `/${'a'.repeat(PROOF_INTENT_PATH_MAX)}`
    const out = sanitizeProofIntent({ kind: 'screenshot', reason: 'r', pages: [tooLong, '/ok'] })
    expect(out?.pages).toEqual(['/ok'])
  })

  test('pages: only the first 8 valid entries are kept, the excess dropped', () => {
    const pages = Array.from({ length: PROOF_INTENT_PAGES_MAX + 1 }, (_, i) => `/p${i}`)
    const out = sanitizeProofIntent({ kind: 'screenshot', reason: 'r', pages })
    expect(out?.pages).toHaveLength(PROOF_INTENT_PAGES_MAX)
  })

  test('pages: absent when the input carries none valid — never an empty array', () => {
    const out = sanitizeProofIntent({ kind: 'screenshot', reason: 'r', pages: ['nope', '//x'] })
    expect(out?.pages).toBeUndefined()
  })

  test('journey: an absolute path (leading slash) is rejected', () => {
    const out = sanitizeProofIntent({ kind: 'journey', reason: 'r', journey: '/checkout' })
    expect(out?.journey).toBeUndefined()
  })

  test('journey: a path containing ".." is rejected', () => {
    const out = sanitizeProofIntent({ kind: 'journey', reason: 'r', journey: 'a/../b' })
    expect(out?.journey).toBeUndefined()
  })

  test('journey: a path containing an apostrophe or a space is rejected', () => {
    expect(
      sanitizeProofIntent({ kind: 'journey', reason: 'r', journey: "it's" })?.journey,
    ).toBeUndefined()
    expect(
      sanitizeProofIntent({ kind: 'journey', reason: 'r', journey: 'a b' })?.journey,
    ).toBeUndefined()
  })

  test('journey: over the max path length is rejected outright', () => {
    const tooLong = 'a'.repeat(PROOF_INTENT_PATH_MAX + 1)
    expect(
      sanitizeProofIntent({ kind: 'journey', reason: 'r', journey: tooLong })?.journey,
    ).toBeUndefined()
  })

  test('hostile input never throws', () => {
    const hostile = {
      kind: 'screenshot',
      reason: { nested: true },
      pages: ['//evil.com', '../x', "it's", null, 42],
      journey: 42,
    }
    expect(() => sanitizeProofIntent(hostile)).not.toThrow()
    expect(sanitizeProofIntent(hostile)).toBeNull()
  })
})

describe('sanitizeProofReview', () => {
  test('non-object input never throws and returns null', () => {
    for (const raw of [null, undefined, 42, 'x', [], true]) {
      expect(() => sanitizeProofReview(raw)).not.toThrow()
      expect(sanitizeProofReview(raw)).toBeNull()
    }
  })

  test('an expected kind outside the closed enum is refused', () => {
    expect(sanitizeProofReview({ expected: 'bogus', coherent: true, reason: '' })).toBeNull()
  })

  test('a non-boolean coherent is refused', () => {
    for (const bad of ['true', 1, null, undefined]) {
      expect(sanitizeProofReview({ expected: 'none', coherent: bad, reason: '' })).toBeNull()
    }
  })

  test('an empty reason is allowed', () => {
    const out = sanitizeProofReview({ expected: 'none', coherent: true, reason: '' })
    expect(out).toEqual({ expected: 'none', coherent: true, reason: '' })
  })

  test('reason: over-long is truncated to the published bound', () => {
    const out = sanitizeProofReview({
      expected: 'journey',
      coherent: false,
      reason: 'x'.repeat(PROOF_INTENT_REASON_MAX + 10),
    })
    expect(out?.reason).toHaveLength(PROOF_INTENT_REASON_MAX)
  })

  test('a full, valid review round-trips', () => {
    const out = sanitizeProofReview({
      expected: 'screenshot',
      coherent: false,
      reason: 'no proof was actually taken',
    })
    expect(out).toEqual({
      expected: 'screenshot',
      coherent: false,
      reason: 'no proof was actually taken',
    })
  })
})
