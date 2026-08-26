// Pure height/state math for the autonomous chat composer (fiche 13,
// sections 1-2): the three growth caps, the manual-resize bounds (drag and
// keyboard), and the priority-ordered status hint. Split out, exactly like
// ForgeLogic.ts, because the auto-grow height depends on a textarea's
// scrollHeight, which only exists once mounted in a real browser: nothing
// here touches the DOM, so all of it is directly testable without one.

/** The textarea's own floor: below this a single line does not fit. */
export const COMPOSER_MIN_HEIGHT = 44
/** Where ordinary typing stops growing the box on its own. */
export const COMPOSER_AUTO_GROW_CAP = 140
/** A paste or a prefill arrives all at once and earns more room to reread it. */
export const COMPOSER_BURST_CAP = 320
/** Below this a manually dragged box would start clipping its own toolbar. */
export const COMPOSER_MANUAL_FLOOR = 93
/** One arrow-key nudge on the resize handle, in pixels; four with Shift held. */
export const COMPOSER_RESIZE_STEP = 16
export const COMPOSER_RESIZE_STEP_COARSE = 64

/** Keeps a height inside [min, max]: the one rule every resize path (auto-grow,
 * drag, keyboard) shares. */
export function clampHeight(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Half the viewport: the absolute ceiling neither growth mode nor a manual
 * resize may cross, in practice never actually reached by either. */
export function absoluteCeiling(windowHeight: number): number {
  return windowHeight / 2
}

/** The manual-resize floor for a given caller: 93px plus whatever stacked
 * banners it renders above the box, so a dragged-down composer never clips them. */
export function manualFloor(bannersHeight: number): number {
  return COMPOSER_MANUAL_FLOOR + bannersHeight
}

// ── Auto-grow: three caps, one active at a time ────────────────────────────

export type ComposerGrowthMode = 'typing' | 'burst'

/** What just happened to the content, in the vocabulary the mode transition
 * cares about. 'external' is a value the caller set rather than typed (a
 * prefill), which deserves the same courtesy as a paste: it arrived all at once. */
export type ComposerContentEvent = 'type' | 'paste' | 'external' | 'clear'

/**
 * The growth mode after one content event. A burst (paste or external
 * prefill) lifts the cap to 320px; ordinary typing never lowers it back on
 * its own, so the elevated cap holds for the rest of that message instead of
 * snapping shut mid-read. Only clearing the box resets it to the normal
 * 140px-capped mode.
 */
export function nextGrowthMode(
  current: ComposerGrowthMode,
  event: ComposerContentEvent,
): ComposerGrowthMode {
  if (event === 'clear') {
    return 'typing'
  }
  if (event === 'paste' || event === 'external') {
    return 'burst'
  }
  return current
}

/**
 * The height an auto-growing textarea should take for its current content,
 * before any manual override: clamped between the 44px floor and whichever
 * growth cap is active (140 typing / 320 burst), itself never crossing the
 * absolute half-window ceiling.
 */
export function autoGrowHeight(
  contentHeight: number,
  mode: ComposerGrowthMode,
  windowHeight: number,
): number {
  const growthCap = mode === 'burst' ? COMPOSER_BURST_CAP : COMPOSER_AUTO_GROW_CAP
  const cap = Math.min(growthCap, absoluteCeiling(windowHeight))
  return clampHeight(contentHeight, COMPOSER_MIN_HEIGHT, cap)
}

// ── Manual resize: drag and keyboard, floor 93px (+banners), half-window cap ─

/** The two numbers every manual-resize path needs together: bundled so none
 * of these functions crosses the project's 4-parameter limit, exactly like
 * ForgeSplitterBounds bundles min/max/defaultWidth for widthAfterKey. */
export type ComposerResizeBounds = { bannersHeight: number; windowHeight: number }

/**
 * The height after one pointer-drag step. `deltaY` is already sign-corrected
 * by the caller so that dragging the handle UP (it grows the box, since the
 * handle sits above the textarea) is positive: mirrors ForgeSplitter's
 * `widthAfterDrag`, on the other axis.
 */
export function heightAfterDrag(
  startHeight: number,
  deltaY: number,
  bounds: ComposerResizeBounds,
): number {
  return clampHeight(
    startHeight + deltaY,
    manualFloor(bounds.bannersHeight),
    absoluteCeiling(bounds.windowHeight),
  )
}

export type ComposerKeyResult = { kind: 'resize'; height: number } | { kind: 'reset' } | null

/**
 * The result of one keyboard interaction on the resize handle (ARIA "window
 * splitter" pattern, same as ForgeSplitter): ArrowUp/ArrowDown nudge the
 * height by one notch (a coarse one with Shift held), Enter asks for a
 * reset: there is no fixed "default height" to recall here, unlike a panel
 * width, so `{ kind: 'reset' }` tells the caller to clear its manual
 * override and let auto-grow decide, exactly like the handle's double-click.
 * Any other key is not this handle's concern: `null` means leave the event alone.
 */
export function heightAfterKey(
  key: string,
  current: number,
  bounds: ComposerResizeBounds,
  coarse = false,
): ComposerKeyResult {
  const step = coarse ? COMPOSER_RESIZE_STEP_COARSE : COMPOSER_RESIZE_STEP
  const floor = manualFloor(bounds.bannersHeight)
  const ceiling = absoluteCeiling(bounds.windowHeight)
  if (key === 'ArrowUp') {
    return { kind: 'resize', height: clampHeight(current + step, floor, ceiling) }
  }
  if (key === 'ArrowDown') {
    return { kind: 'resize', height: clampHeight(current - step, floor, ceiling) }
  }
  if (key === 'Enter') {
    return { kind: 'reset' }
  }
  return null
}

/** The textarea's actual height for this render: a manual override (drag or
 * keyboard) wins for as long as one is set. Double-clicking (or Enter on)
 * the handle is what clears it and hands control back to `autoGrowHeight`. */
export function composerHeight(
  manualHeight: number | null,
  contentHeight: number,
  mode: ComposerGrowthMode,
  bounds: ComposerResizeBounds,
): number {
  if (manualHeight !== null) {
    return clampHeight(
      manualHeight,
      manualFloor(bounds.bannersHeight),
      absoluteCeiling(bounds.windowHeight),
    )
  }
  return autoGrowHeight(contentHeight, mode, bounds.windowHeight)
}

// ── Mode (section 1): the filet's own state, no separate badge ────────────

/** The filet's mode: 'clean' is the neutral 1px default; 'temporary' and
 * 'private' are the two states DESIGN.md carves out for a colored border,
 * so the box itself carries the conversation's mode. */
export type ComposerMode = 'clean' | 'temporary' | 'private'

// ── Status hint (section 2): the placeholder IS the state display ─────────

export type ComposerStatus = {
  offline?: boolean
  stopping?: boolean
  dictating?: boolean
  transcribing?: boolean
}

export type ComposerHintState = 'offline' | 'stopping' | 'dictating' | 'transcribing' | null

/**
 * Which of the four state variants wins, in the fiche's own priority order:
 * offline first (nothing else matters without a connection), then a stop
 * already in flight, then dictation, then transcription. `null` means none
 * are active and the normal placeholder (message + shortcuts) applies.
 */
export function composerHintState(status: ComposerStatus): ComposerHintState {
  if (status.offline) {
    return 'offline'
  }
  if (status.stopping) {
    return 'stopping'
  }
  if (status.dictating) {
    return 'dictating'
  }
  if (status.transcribing) {
    return 'transcribing'
  }
  return null
}

// ── Send button ─────────────────────────────────────────────────────────

/** The round send button is live only with something to send, outside a
 * request already in flight. */
export function sendDisabled(text: string, sending: boolean): boolean {
  return text.trim().length === 0 || sending
}
