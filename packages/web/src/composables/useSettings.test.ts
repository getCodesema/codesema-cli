import { describe, expect, test } from 'bun:test'
import { isMergeStrategyOption, parseSettingsSnapshot } from './useSettings'

describe('isMergeStrategyOption', () => {
  test('accepts exactly the three forge strategies', () => {
    expect(isMergeStrategyOption('merge')).toBe(true)
    expect(isMergeStrategyOption('squash')).toBe(true)
    expect(isMergeStrategyOption('rebase')).toBe(true)
  })

  test('rejects anything else, including the empty placeholder value', () => {
    expect(isMergeStrategyOption('')).toBe(false)
    expect(isMergeStrategyOption('fast-forward')).toBe(false)
    expect(isMergeStrategyOption('Merge')).toBe(false)
  })
})

describe('parseSettingsSnapshot', () => {
  test('reads a well-formed GET/PUT response', () => {
    expect(
      parseSettingsSnapshot({
        runnerAutoMerge: { value: false, raw: false },
        mergeStrategy: { value: 'squash', raw: 'squash' },
        maxTaskTurns: { value: 60, raw: 60 },
      }),
    ).toEqual({ runnerAutoMerge: false, mergeStrategy: 'squash', maxTaskTurns: 60 })
  })

  test('an absent mergeStrategy field (the forge-default state) parses to undefined', () => {
    expect(
      parseSettingsSnapshot({
        runnerAutoMerge: { value: true },
        mergeStrategy: {},
        maxTaskTurns: { value: 30 },
      }),
    ).toEqual({ runnerAutoMerge: true, mergeStrategy: undefined, maxTaskTurns: 30 })
  })

  test('degrades to the server defaults on garbage, never throws', () => {
    expect(parseSettingsSnapshot(null)).toEqual({
      runnerAutoMerge: true,
      mergeStrategy: undefined,
      maxTaskTurns: 30,
    })
    expect(parseSettingsSnapshot('nope')).toEqual({
      runnerAutoMerge: true,
      mergeStrategy: undefined,
      maxTaskTurns: 30,
    })
    expect(
      parseSettingsSnapshot({
        runnerAutoMerge: { value: 'yes' },
        mergeStrategy: { value: 'fast-forward' },
        maxTaskTurns: { value: -1 },
      }),
    ).toEqual({ runnerAutoMerge: true, mergeStrategy: undefined, maxTaskTurns: 30 })
    expect(
      parseSettingsSnapshot({
        maxTaskTurns: { value: 12.5 },
      }),
    ).toEqual({ runnerAutoMerge: true, mergeStrategy: undefined, maxTaskTurns: 30 })
  })
})
