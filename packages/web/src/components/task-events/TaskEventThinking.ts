// Pure preview-window math for TaskEventThinking.vue, split out so it is
// unit-testable with no SSR render and no timers involved.

/** fiche 12 section 3: a reasoning block is still "in progress" once no new
 * content has arrived for this long — independent of the streaming turn as
 * a whole, which may keep running past this one block going quiet. */
export const THINKING_IDLE_MS = 1200

/** fiche 12 section 3: the folded preview keeps only the last N characters —
 * the tail of the thought is the only interesting part while it streams. */
export const THINKING_PREVIEW_CHARS = 240

export type ThinkingPreview = {
  /** The last `maxChars` characters of `text` (all of it when shorter). */
  text: string
  /** True when `text` overran the window, i.e. something before this slice
   * was cut off — this is what gates the left-edge fade. */
  truncated: boolean
}

/** "les 240 derniers caractères" (fiche 12 section 3), never more. */
export function previewTail(
  text: string,
  maxChars: number = THINKING_PREVIEW_CHARS,
): ThinkingPreview {
  if (text.length <= maxChars) {
    return { text, truncated: false }
  }
  return { text: text.slice(-maxChars), truncated: true }
}
