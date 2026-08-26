import { describe, expect, test } from 'bun:test'
import {
  absoluteCeiling,
  autoGrowHeight,
  clampHeight,
  COMPOSER_AUTO_GROW_CAP,
  COMPOSER_BURST_CAP,
  COMPOSER_MANUAL_FLOOR,
  COMPOSER_MIN_HEIGHT,
  COMPOSER_RESIZE_STEP,
  COMPOSER_RESIZE_STEP_COARSE,
  composerHeight,
  composerHintState,
  heightAfterDrag,
  heightAfterKey,
  manualFloor,
  nextGrowthMode,
  sendDisabled,
  type ComposerResizeBounds,
} from './ComposerLogic'

/** Terser call sites below: heightAfterDrag/heightAfterKey/composerHeight all
 * take this pair bundled, exactly like the functions themselves require. */
function bounds(bannersHeight: number, windowHeight: number): ComposerResizeBounds {
  return { bannersHeight, windowHeight }
}

describe('clampHeight', () => {
  test('keeps a value already inside the bounds untouched', () => {
    expect(clampHeight(100, 44, 140)).toBe(100)
  })

  test('raises a value below the floor', () => {
    expect(clampHeight(10, 44, 140)).toBe(44)
  })

  test('lowers a value above the ceiling', () => {
    expect(clampHeight(999, 44, 140)).toBe(140)
  })
})

describe('absoluteCeiling', () => {
  test('is exactly half the window height', () => {
    expect(absoluteCeiling(800)).toBe(400)
    expect(absoluteCeiling(1000)).toBe(500)
  })
})

describe('manualFloor', () => {
  test('is 93px with no banners', () => {
    expect(manualFloor(0)).toBe(COMPOSER_MANUAL_FLOOR)
  })

  test('adds the stacked banners height on top of 93px', () => {
    expect(manualFloor(40)).toBe(133)
  })
})

describe('nextGrowthMode', () => {
  test('typing never changes the mode on its own', () => {
    expect(nextGrowthMode('typing', 'type')).toBe('typing')
    expect(nextGrowthMode('burst', 'type')).toBe('burst')
  })

  test('a paste always lifts the mode to burst, from either starting mode', () => {
    expect(nextGrowthMode('typing', 'paste')).toBe('burst')
    expect(nextGrowthMode('burst', 'paste')).toBe('burst')
  })

  test('an external prefill is treated exactly like a paste', () => {
    expect(nextGrowthMode('typing', 'external')).toBe('burst')
    expect(nextGrowthMode('burst', 'external')).toBe('burst')
  })

  test('clearing the box is the only thing that drops back to typing', () => {
    expect(nextGrowthMode('burst', 'clear')).toBe('typing')
    expect(nextGrowthMode('typing', 'clear')).toBe('typing')
  })
})

describe('autoGrowHeight', () => {
  test('never shrinks below the 44px floor, even for empty content', () => {
    expect(autoGrowHeight(0, 'typing', 2000)).toBe(COMPOSER_MIN_HEIGHT)
  })

  test('follows the content between the floor and the typing cap', () => {
    expect(autoGrowHeight(90, 'typing', 2000)).toBe(90)
  })

  test('typing mode stops growing at 140px', () => {
    expect(autoGrowHeight(500, 'typing', 2000)).toBe(COMPOSER_AUTO_GROW_CAP)
  })

  test('burst mode grows past 140px, up to 320px', () => {
    expect(autoGrowHeight(200, 'burst', 2000)).toBe(200)
    expect(autoGrowHeight(500, 'burst', 2000)).toBe(COMPOSER_BURST_CAP)
  })

  test('a small window caps growth below either mode cap: the absolute ceiling wins', () => {
    // windowHeight 200 -> absolute ceiling 100, under both the 140 and 320 caps.
    expect(autoGrowHeight(500, 'typing', 200)).toBe(100)
    expect(autoGrowHeight(500, 'burst', 200)).toBe(100)
  })
})

describe('heightAfterDrag', () => {
  test('grows the box by the drag delta, within bounds', () => {
    expect(heightAfterDrag(100, 20, bounds(0, 2000))).toBe(120)
  })

  test('shrinks the box by a negative delta, within bounds', () => {
    expect(heightAfterDrag(150, -20, bounds(0, 2000))).toBe(130)
  })

  test('never drags below the 93px floor', () => {
    expect(heightAfterDrag(100, -500, bounds(0, 2000))).toBe(COMPOSER_MANUAL_FLOOR)
  })

  test('the floor rises with the stacked banners height', () => {
    expect(heightAfterDrag(100, -500, bounds(40, 2000))).toBe(133)
  })

  test('never drags above the half-window ceiling', () => {
    expect(heightAfterDrag(100, 5000, bounds(0, 800))).toBe(400)
  })
})

describe('heightAfterKey', () => {
  test('ArrowUp grows by one step', () => {
    expect(heightAfterKey('ArrowUp', 100, bounds(0, 2000))).toEqual({
      kind: 'resize',
      height: 116,
    })
  })

  test('ArrowDown shrinks by one step', () => {
    expect(heightAfterKey('ArrowDown', 150, bounds(0, 2000))).toEqual({
      kind: 'resize',
      height: 134,
    })
  })

  test('the coarse step is four times larger, for Shift-held navigation', () => {
    expect(COMPOSER_RESIZE_STEP_COARSE).toBe(COMPOSER_RESIZE_STEP * 4)
    expect(heightAfterKey('ArrowUp', 100, bounds(0, 2000), true)).toEqual({
      kind: 'resize',
      height: 100 + COMPOSER_RESIZE_STEP_COARSE,
    })
  })

  test('ArrowDown is clamped at the 93px floor', () => {
    expect(heightAfterKey('ArrowDown', 95, bounds(0, 2000))).toEqual({
      kind: 'resize',
      height: 93,
    })
  })

  test('ArrowUp is clamped at the half-window ceiling', () => {
    expect(heightAfterKey('ArrowUp', 395, bounds(0, 800))).toEqual({ kind: 'resize', height: 400 })
  })

  test('Enter asks for a reset, not a numeric height', () => {
    expect(heightAfterKey('Enter', 200, bounds(0, 2000))).toEqual({ kind: 'reset' })
  })

  test("any other key is not this handle's concern", () => {
    expect(heightAfterKey('Tab', 100, bounds(0, 2000))).toBeNull()
    expect(heightAfterKey('a', 100, bounds(0, 2000))).toBeNull()
  })
})

describe('composerHeight', () => {
  test('with no manual override, falls back to autoGrowHeight', () => {
    expect(composerHeight(null, 90, 'typing', bounds(0, 2000))).toBe(90)
    expect(composerHeight(null, 500, 'typing', bounds(0, 2000))).toBe(COMPOSER_AUTO_GROW_CAP)
  })

  test('a manual override wins over the content height and growth mode', () => {
    expect(composerHeight(250, 90, 'typing', bounds(0, 2000))).toBe(250)
  })

  test('a manual override is still clamped to the manual floor and ceiling', () => {
    expect(composerHeight(10, 90, 'typing', bounds(0, 2000))).toBe(COMPOSER_MANUAL_FLOOR)
    expect(composerHeight(10, 90, 'typing', bounds(40, 2000))).toBe(133)
    expect(composerHeight(9999, 90, 'typing', bounds(0, 800))).toBe(400)
  })
})

describe('composerHintState', () => {
  test('nothing active: no override, the normal placeholder applies', () => {
    expect(composerHintState({})).toBeNull()
  })

  test('offline wins over every other state', () => {
    expect(
      composerHintState({ offline: true, stopping: true, dictating: true, transcribing: true }),
    ).toBe('offline')
  })

  test('stopping wins over dictating and transcribing', () => {
    expect(composerHintState({ stopping: true, dictating: true, transcribing: true })).toBe(
      'stopping',
    )
  })

  test('dictating wins over transcribing', () => {
    expect(composerHintState({ dictating: true, transcribing: true })).toBe('dictating')
  })

  test('transcribing alone', () => {
    expect(composerHintState({ transcribing: true })).toBe('transcribing')
  })
})

describe('sendDisabled', () => {
  test('empty text is disabled', () => {
    expect(sendDisabled('', false)).toBe(true)
  })

  test('whitespace-only text is disabled', () => {
    expect(sendDisabled('   \n  ', false)).toBe(true)
  })

  test('real text while a send is already in flight stays disabled', () => {
    expect(sendDisabled('fix the bug', true)).toBe(true)
  })

  test('real text, nothing in flight: enabled', () => {
    expect(sendDisabled('fix the bug', false)).toBe(false)
  })
})
