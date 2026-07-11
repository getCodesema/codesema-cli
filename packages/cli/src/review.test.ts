import { describe, expect, test } from 'bun:test'
import { extractReviewJson } from './review.js'

const REVIEW = '{"verdict":"approve","summary":"ok","findings":[]}'

describe('extractReviewJson', () => {
  test('plain JSON', () => {
    expect(extractReviewJson(REVIEW)).toBe(REVIEW)
  })

  test('prose around the JSON', () => {
    expect(extractReviewJson(`Here is the review:\n${REVIEW}\nHope this helps!`)).toBe(REVIEW)
  })

  test('markdown fence', () => {
    expect(extractReviewJson('Sure!\n```json\n' + REVIEW + '\n```\ndone')).toBe(REVIEW)
  })

  test('prefers the object with verdict when multiple valid objects exist', () => {
    const raw = `Example input: {"branch":"x"} and the result ${REVIEW} end`
    expect(extractReviewJson(raw)).toBe(REVIEW)
  })

  test('braces inside strings respected', () => {
    const tricky = '{"verdict":"comment","summary":"code: if (a) { b() }","findings":[]}'
    expect(extractReviewJson(`note ${tricky} bye`)).toBe(tricky)
  })

  test('object without verdict accepted as last resort', () => {
    expect(extractReviewJson('x {"summary":"only"} y')).toBe('{"summary":"only"}')
  })

  test('no JSON: error', () => {
    expect(() => extractReviewJson('no json here')).toThrow(/did not return a JSON review/)
    expect(() => extractReviewJson('[1,2,3]')).toThrow(/did not return a JSON review/)
  })
})
