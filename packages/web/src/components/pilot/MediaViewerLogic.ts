export const ZOOM_MIN = 1
export const ZOOM_MAX = 8
export const ZOOM_STEP = 1.5
export const ZOOM_TOGGLE = 2.5

export type ZoomState = { scale: number; x: number; y: number }

export const ZOOM_RESET: ZoomState = { scale: 1, x: 0, y: 0 }

export function clampScale(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
}

/** A scale back at 1 always recenters: a translation is meaningless when nothing overflows. */
function settle(state: ZoomState): ZoomState {
  return state.scale === ZOOM_MIN ? ZOOM_RESET : state
}

export function zoomBy(state: ZoomState, factor: number): ZoomState {
  return settle({ ...state, scale: clampScale(state.scale * factor) })
}

export function zoomIn(state: ZoomState): ZoomState {
  return zoomBy(state, ZOOM_STEP)
}

export function zoomOut(state: ZoomState): ZoomState {
  return zoomBy(state, 1 / ZOOM_STEP)
}

/** A click toggles between fit and a fixed close-up, whatever the wheel set before. */
export function toggleZoom(state: ZoomState): ZoomState {
  return state.scale > ZOOM_MIN ? ZOOM_RESET : { scale: ZOOM_TOGGLE, x: 0, y: 0 }
}

export function wheelZoom(state: ZoomState, deltaY: number): ZoomState {
  return deltaY < 0 ? zoomIn(state) : zoomOut(state)
}

export function panBy(state: ZoomState, dx: number, dy: number): ZoomState {
  return state.scale === ZOOM_MIN ? state : { ...state, x: state.x + dx, y: state.y + dy }
}

export function zoomPercent(state: ZoomState): string {
  return `${Math.round(state.scale * 100)} %`
}
