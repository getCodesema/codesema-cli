// One status, one visual, defined ONCE. Every component that shows a task
// state (home cards, conversation header, chips) reads this table instead of
// mapping TaskStatus to colors locally. Semaphore grammar: green = done and
// passed, amber = the machine works (pulse) or the human is needed (strong),
// red = blocked, neutral = nothing is happening.

import type { MessageKey } from './i18n'
import type { TaskStatus } from './types'

export type StatusVisual = {
  /** Core signal color (dot, active border). Always a --cs-* token. */
  color: string
  /** Soft wash behind the status chip. */
  soft: string
  /** Text-legible variant of the signal color (AA on the soft wash). */
  text: string
  /** Compact glyph for dense rows; never the only carrier of the state. */
  icon: string
  labelKey: MessageKey
  /** Sentence-length phrase for the conversation header ("paused — waiting
   * for your answer"), colored with `text`. */
  phraseKey: MessageKey
  /** Discreet pulse: the agent itself is working right now (live signal). */
  pulse: boolean
  /** Strong amber treatment: the task is blocked on the human. */
  attention: boolean
}

const green: Pick<StatusVisual, 'color' | 'soft' | 'text'> = {
  color: 'var(--cs-green)',
  soft: 'var(--cs-green-soft)',
  text: 'var(--cs-green-text)',
}
const amber: Pick<StatusVisual, 'color' | 'soft' | 'text'> = {
  color: 'var(--cs-amber)',
  soft: 'var(--cs-amber-soft)',
  text: 'var(--cs-amber-text)',
}
const red: Pick<StatusVisual, 'color' | 'soft' | 'text'> = {
  color: 'var(--cs-red)',
  soft: 'var(--cs-red-soft)',
  text: 'var(--cs-red-text)',
}
const idle: Pick<StatusVisual, 'color' | 'soft' | 'text'> = {
  color: 'var(--cs-dot-idle)',
  soft: 'var(--cs-hover)',
  text: 'var(--cs-muted)',
}

export const EXECUTION_STATUS: Record<TaskStatus, StatusVisual> = {
  queued: {
    ...idle,
    icon: '○',
    labelKey: 'workspace.statusQueued',
    phraseKey: 'workspace.phaseQueued',
    pulse: false,
    attention: false,
  },
  running: {
    ...amber,
    icon: '●',
    labelKey: 'workspace.statusRunning',
    phraseKey: 'workspace.phaseRunning',
    pulse: true,
    attention: false,
  },
  waiting_for_you: {
    ...amber,
    icon: '?',
    labelKey: 'workspace.statusWaiting',
    phraseKey: 'workspace.phaseWaiting',
    pulse: false,
    attention: true,
  },
  reviewing: {
    ...amber,
    icon: '◎',
    labelKey: 'workspace.statusReviewing',
    phraseKey: 'workspace.phaseReviewing',
    pulse: true,
    attention: false,
  },
  review_ok: {
    ...green,
    icon: '✓',
    labelKey: 'workspace.statusReviewOk',
    phraseKey: 'workspace.phaseReviewOk',
    pulse: false,
    attention: false,
  },
  review_ko: {
    ...red,
    icon: '✕',
    labelKey: 'workspace.statusReviewKo',
    phraseKey: 'workspace.phaseReviewKo',
    pulse: false,
    attention: false,
  },
  shipped: {
    ...green,
    icon: '↗',
    labelKey: 'workspace.statusShipped',
    phraseKey: 'workspace.phaseShipped',
    pulse: false,
    attention: false,
  },
  failed: {
    ...red,
    icon: '✕',
    labelKey: 'workspace.statusFailed',
    phraseKey: 'workspace.phaseFailed',
    pulse: false,
    attention: false,
  },
  interrupted: {
    ...idle,
    icon: '‖',
    labelKey: 'workspace.statusInterrupted',
    phraseKey: 'workspace.phaseInterrupted',
    pulse: false,
    attention: false,
  },
}
