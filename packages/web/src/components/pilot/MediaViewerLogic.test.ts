import { describe, expect, test } from 'bun:test'
import {
  clampScale,
  panBy,
  toggleZoom,
  wheelZoom,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_RESET,
  ZOOM_STEP,
  ZOOM_TOGGLE,
  zoomIn,
  zoomOut,
  zoomPercent,
} from './MediaViewerLogic'

describe('clampScale', () => {
  test('never goes below fit nor above the ceiling', () => {
    expect(clampScale(0.2)).toBe(ZOOM_MIN)
    expect(clampScale(50)).toBe(ZOOM_MAX)
    expect(clampScale(3)).toBe(3)
  })
})

describe('zoomIn / zoomOut', () => {
  test('each step multiplies by ZOOM_STEP and is reversible', () => {
    const once = zoomIn(ZOOM_RESET)
    expect(once.scale).toBeCloseTo(ZOOM_STEP)
    expect(zoomOut(once)).toEqual(ZOOM_RESET)
  })

  test('zooming out at fit stays at fit and recenters', () => {
    expect(zoomOut({ scale: 1, x: 40, y: 40 })).toEqual(ZOOM_RESET)
  })

  test('zooming in saturates at the ceiling', () => {
    let state = ZOOM_RESET
    for (let i = 0; i < 20; i++) {
      state = zoomIn(state)
    }
    expect(state.scale).toBe(ZOOM_MAX)
  })

  test('a step keeps the current pan offset', () => {
    expect(zoomIn({ scale: 2, x: 10, y: -5 })).toEqual({ scale: 3, x: 10, y: -5 })
  })
})

describe('toggleZoom', () => {
  test('fit toggles to the close-up, any zoom toggles back to fit', () => {
    expect(toggleZoom(ZOOM_RESET)).toEqual({ scale: ZOOM_TOGGLE, x: 0, y: 0 })
    expect(toggleZoom({ scale: 4, x: 30, y: 30 })).toEqual(ZOOM_RESET)
  })
})

describe('wheelZoom', () => {
  test('wheel up zooms in, wheel down zooms out', () => {
    expect(wheelZoom(ZOOM_RESET, -100).scale).toBeCloseTo(ZOOM_STEP)
    expect(wheelZoom({ scale: ZOOM_STEP, x: 0, y: 0 }, 100)).toEqual(ZOOM_RESET)
  })
})

describe('panBy', () => {
  test('pans only when zoomed in', () => {
    expect(panBy(ZOOM_RESET, 10, 10)).toEqual(ZOOM_RESET)
    expect(panBy({ scale: 2, x: 5, y: 5 }, 10, -3)).toEqual({ scale: 2, x: 15, y: 2 })
  })
})

describe('zoomPercent', () => {
  test('renders a rounded percentage', () => {
    expect(zoomPercent(ZOOM_RESET)).toBe('100 %')
    expect(zoomPercent({ scale: 2.25, x: 0, y: 0 })).toBe('225 %')
  })
})
