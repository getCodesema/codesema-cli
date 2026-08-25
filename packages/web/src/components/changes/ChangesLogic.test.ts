import { describe, expect, test } from 'bun:test'
import type { ForgeCheckRollup } from '../../types'
import {
  CHANGES_PANEL_RESERVE,
  CHANGES_PANEL_WIDTH_DEFAULT,
  CHANGES_PANEL_WIDTH_MIN,
  checksTabIndicator,
  forgeNameFromUrl,
  maxChangesPanelWidth,
  mrStateVariant,
  widthAfterDrag,
  widthAfterKey,
} from './ChangesLogic'

describe('maxChangesPanelWidth', () => {
  test('a wide viewport leaves the reserve and nothing more', () => {
    expect(maxChangesPanelWidth(1600)).toBe(1600 - CHANGES_PANEL_RESERVE)
  })

  test('a viewport too narrow for the reserve still honors the panel minimum', () => {
    expect(maxChangesPanelWidth(700)).toBe(CHANGES_PANEL_WIDTH_MIN)
  })

  test('the boundary where the reserve exactly meets the minimum', () => {
    const boundary = CHANGES_PANEL_WIDTH_MIN + CHANGES_PANEL_RESERVE
    expect(maxChangesPanelWidth(boundary)).toBe(CHANGES_PANEL_WIDTH_MIN)
    expect(maxChangesPanelWidth(boundary + 1)).toBe(CHANGES_PANEL_WIDTH_MIN + 1)
  })
})

describe('widthAfterDrag (right-docked: dragging the handle left grows the panel)', () => {
  test('a negative delta (handle dragged left) grows the width', () => {
    expect(widthAfterDrag(460, -40, 320, 900)).toBe(500)
  })

  test('a positive delta (handle dragged right) shrinks the width', () => {
    expect(widthAfterDrag(460, 40, 320, 900)).toBe(420)
  })

  test('growth clamps at the maximum', () => {
    expect(widthAfterDrag(880, -100, 320, 900)).toBe(900)
  })

  test('shrinkage clamps at the minimum', () => {
    expect(widthAfterDrag(340, 100, 320, 900)).toBe(320)
  })

  test('a zero delta leaves the start width unchanged', () => {
    expect(widthAfterDrag(460, 0, 320, 900)).toBe(460)
  })
})

describe('widthAfterKey (right-docked: mirrored from ForgeLogic.ts)', () => {
  const bounds = { min: 320, max: 900, defaultWidth: 460 }

  test('ArrowLeft grows by one notch', () => {
    const grown = widthAfterKey('ArrowLeft', 460, bounds)
    expect(grown).not.toBeNull()
    expect(grown as number).toBeGreaterThan(460)
  })

  test('ArrowRight shrinks by one notch', () => {
    const shrunk = widthAfterKey('ArrowRight', 460, bounds)
    expect(shrunk).not.toBeNull()
    expect(shrunk as number).toBeLessThan(460)
  })

  test('ArrowLeft never grows past the maximum', () => {
    expect(widthAfterKey('ArrowLeft', bounds.max, bounds)).toBe(bounds.max)
  })

  test('ArrowRight never shrinks past the minimum', () => {
    expect(widthAfterKey('ArrowRight', bounds.min, bounds)).toBe(bounds.min)
  })

  test('Enter recalls the default width, clamped to the current bounds', () => {
    expect(widthAfterKey('Enter', 320, bounds)).toBe(460)
    expect(widthAfterKey('Enter', 320, { min: 500, max: 900, defaultWidth: 460 })).toBe(500)
  })

  test("any other key is not this handle's concern: null, not a width", () => {
    expect(widthAfterKey('Tab', 460, bounds)).toBeNull()
    expect(widthAfterKey('a', 460, bounds)).toBeNull()
  })

  test('the coarse step (Shift) moves further than the fine one, in both directions', () => {
    const fineLeft = widthAfterKey('ArrowLeft', 460, bounds) as number
    const coarseLeft = widthAfterKey('ArrowLeft', 460, bounds, true) as number
    expect(coarseLeft - 460).toBeGreaterThan(fineLeft - 460)

    const fineRight = widthAfterKey('ArrowRight', 460, bounds) as number
    const coarseRight = widthAfterKey('ArrowRight', 460, bounds, true) as number
    expect(460 - coarseRight).toBeGreaterThan(460 - fineRight)
  })

  test('the coarse step still clamps like the fine one', () => {
    expect(widthAfterKey('ArrowLeft', bounds.max - 1, bounds, true)).toBe(bounds.max)
    expect(widthAfterKey('ArrowRight', bounds.min + 1, bounds, true)).toBe(bounds.min)
  })

  test('Shift changes nothing for Enter, which recalls the default width either way', () => {
    expect(widthAfterKey('Enter', 320, bounds, true)).toBe(460)
  })
})

describe('mrStateVariant', () => {
  test('open, not draft: open', () => {
    expect(mrStateVariant({ state: 'open', isDraft: false })).toBe('open')
  })

  test('open and draft: draft, not open', () => {
    expect(mrStateVariant({ state: 'open', isDraft: true })).toBe('draft')
  })

  test('open with an unknown draft flag: open, never guessed as draft', () => {
    expect(mrStateVariant({ state: 'open', isDraft: null })).toBe('open')
  })

  test('merged: merged, regardless of the draft flag (a merged MR is never a draft)', () => {
    expect(mrStateVariant({ state: 'merged', isDraft: false })).toBe('merged')
    expect(mrStateVariant({ state: 'merged', isDraft: true })).toBe('merged')
  })

  test('closed: closed', () => {
    expect(mrStateVariant({ state: 'closed', isDraft: false })).toBe('closed')
  })

  test('no known state: null, never a guessed badge', () => {
    expect(mrStateVariant({ state: null, isDraft: null })).toBeNull()
  })
})

describe('forgeNameFromUrl', () => {
  test('github.com: GitHub', () => {
    expect(forgeNameFromUrl('https://github.com/octo/repo/pull/1')).toBe('GitHub')
  })

  test('gitlab.com: GitLab', () => {
    expect(forgeNameFromUrl('https://gitlab.com/octo/repo/-/merge_requests/1')).toBe('GitLab')
  })

  test('a www-prefixed host is normalized before matching', () => {
    expect(forgeNameFromUrl('https://www.github.com/octo/repo/pull/1')).toBe('GitHub')
  })

  test('a self-hosted instance falls back to its own hostname, never a guess', () => {
    expect(forgeNameFromUrl('https://forge.example.internal/octo/repo/-/merge_requests/1')).toBe(
      'forge.example.internal',
    )
  })

  test('an unparseable URL is returned as-is rather than throwing', () => {
    expect(forgeNameFromUrl('not a url')).toBe('not a url')
  })
})

describe('checksTabIndicator', () => {
  function rollup(overrides: Partial<ForgeCheckRollup> = {}): ForgeCheckRollup {
    return { passed: 0, failed: 0, pending: 0, skipped: 0, truncated: false, ...overrides }
  }

  test('no checks at all: null, no tab indicator', () => {
    expect(checksTabIndicator(null)).toBeNull()
  })

  test('a rollup with all-zero counts and not truncated: null, nothing to show', () => {
    expect(checksTabIndicator(rollup())).toBeNull()
  })

  test('all passed: a fraction of passed over total, status passed', () => {
    expect(checksTabIndicator(rollup({ passed: 42 }))).toEqual({
      kind: 'fraction',
      passed: 42,
      total: 42,
      status: 'passed',
    })
  })

  test('a mix of buckets: the fraction totals every bucket, status by urgency', () => {
    expect(checksTabIndicator(rollup({ passed: 12, failed: 1, pending: 2, skipped: 3 }))).toEqual({
      kind: 'fraction',
      passed: 12,
      total: 18,
      status: 'failed',
    })
  })

  test('truncated: the aggregate form only, never a fabricated total', () => {
    expect(checksTabIndicator(rollup({ passed: 12, truncated: true }))).toEqual({
      kind: 'aggregate',
      status: 'passed',
    })
  })

  test('truncated with nothing yet observed: aggregate, unknown', () => {
    expect(checksTabIndicator(rollup({ truncated: true }))).toEqual({
      kind: 'aggregate',
      status: 'unknown',
    })
  })
})

// Sanity check on the constants themselves: the fiche pins these exact
// pixel values (§2), a silent drift here would desync every geometry test
// in ChangesPanel.test.ts that reads them back from source.
describe('panel width constants', () => {
  test('default is 460, minimum is 320, reserve is 560', () => {
    expect(CHANGES_PANEL_WIDTH_DEFAULT).toBe(460)
    expect(CHANGES_PANEL_WIDTH_MIN).toBe(320)
    expect(CHANGES_PANEL_RESERVE).toBe(560)
  })
})
