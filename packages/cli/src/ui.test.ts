import { describe, expect, test } from 'bun:test'
import type { PartialReview } from './partial.js'
import { progressLabel } from './ui.js'

const finding = { file: 'src/a.ts', message: 'broken' }
const empty: PartialReview = { findings: [], stepTitles: [] }

describe('progressLabel', () => {
  test('null while nothing is parsed yet', () => {
    expect(progressLabel(empty)).toBeNull()
  })

  test('verdict alone', () => {
    expect(progressLabel({ ...empty, verdict: 'approve' })).toBe('verdict approve · drafting findings')
  })

  test('findings win over verdict', () => {
    expect(progressLabel({ ...empty, verdict: 'comment', findings: [finding, finding] })).toBe('2 findings drafted')
  })

  test('singular finding', () => {
    expect(progressLabel({ ...empty, findings: [finding] })).toBe('1 finding drafted')
  })

  test('steps win over findings', () => {
    const partial: PartialReview = {
      ...empty,
      findings: [finding],
      stepTitles: ['Foundations', 'Surface changes'],
    }
    expect(progressLabel(partial)).toBe('step 2: Surface changes')
  })

  test('long step title is truncated', () => {
    const partial: PartialReview = { ...empty, stepTitles: ['x'.repeat(200)] }
    const label = progressLabel(partial)
    expect(label).not.toBeNull()
    expect(label!.length).toBeLessThanOrEqual(56)
    expect(label!.endsWith('…')).toBe(true)
  })
})
