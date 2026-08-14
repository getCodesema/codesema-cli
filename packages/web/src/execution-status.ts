// One status, one visual, defined ONCE. Every component that shows a task
// state (home cards, conversation header, chips) reads this table instead of
// mapping TaskStatus to colors locally. Semaphore grammar: green = done and
// passed, amber = the machine works (pulse) or the human is needed (strong),
// red = blocked, neutral = nothing is happening.

import type { MessageKey } from './i18n'
import type { TaskStatus } from './types'

export type StatusVisual = {
  /** Core signal color (dot, active border). Always a --sema-* token. */
  color: string
  /** Soft wash behind the status chip. */
  soft: string
  /** Text-legible variant of the signal color (AA on the soft wash). */
  text: string
  /** Compact glyph for dense rows; never the only carrier of the state. */
  icon: string
  labelKey: MessageKey
  /** Discreet pulse: the agent itself is working right now (live signal). */
  pulse: boolean
  /** Strong amber treatment: the task is blocked on the human. */
  attention: boolean
}

const green: Pick<StatusVisual, 'color' | 'soft' | 'text'> = {
  color: 'var(--sema-green)',
  soft: 'var(--sema-green-soft)',
  text: 'var(--sema-green-text)',
}
const amber: Pick<StatusVisual, 'color' | 'soft' | 'text'> = {
  color: 'var(--sema-amber)',
  soft: 'var(--sema-amber-soft)',
  text: 'var(--sema-amber-text)',
}
const red: Pick<StatusVisual, 'color' | 'soft' | 'text'> = {
  color: 'var(--sema-red)',
  soft: 'var(--sema-red-soft)',
  text: 'var(--sema-red-text)',
}
const idle: Pick<StatusVisual, 'color' | 'soft' | 'text'> = {
  color: 'var(--sema-dot-idle)',
  soft: 'var(--sema-hover)',
  text: 'var(--sema-ink-3)',
}

export const EXECUTION_STATUS: Record<TaskStatus, StatusVisual> = {
  queued: {
    ...idle,
    icon: '○',
    labelKey: 'workspace.statusQueued',
    pulse: false,
    attention: false,
  },
  running: {
    ...amber,
    icon: '●',
    labelKey: 'workspace.statusRunning',
    pulse: true,
    attention: false,
  },
  waiting_for_you: {
    ...amber,
    icon: '?',
    labelKey: 'workspace.statusWaiting',
    pulse: false,
    attention: true,
  },
  reviewing: {
    ...amber,
    icon: '◎',
    labelKey: 'workspace.statusReviewing',
    pulse: true,
    attention: false,
  },
  review_ok: {
    ...green,
    icon: '✓',
    labelKey: 'workspace.statusReviewOk',
    pulse: false,
    attention: false,
  },
  review_ko: {
    ...red,
    icon: '✕',
    labelKey: 'workspace.statusReviewKo',
    pulse: false,
    attention: false,
  },
  shipped: {
    ...green,
    icon: '↗',
    labelKey: 'workspace.statusShipped',
    pulse: false,
    attention: false,
  },
  failed: { ...red, icon: '✕', labelKey: 'workspace.statusFailed', pulse: false, attention: false },
  interrupted: {
    ...idle,
    icon: '‖',
    labelKey: 'workspace.statusInterrupted',
    pulse: false,
    attention: false,
  },
}
