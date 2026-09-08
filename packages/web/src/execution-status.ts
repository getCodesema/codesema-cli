// One status, one visual, defined ONCE. Every component that shows a task
// state (home cards, conversation header, chips) reads this table instead of
// mapping TaskStatus to colors locally. Semaphore grammar: green = done and
// passed, amber = the machine works (pulse) or the human is needed (strong),
// red = blocked, neutral = nothing is happening.

import { G } from './glyphs'
import type { MessageKey } from './i18n'
import type { TaskStatus } from './types'

export type StatusTone = 'ok' | 'warn' | 'err' | 'info' | 'idle'

export type StatusVisual = {
  /** Semantic tone, rendered by CSS through `data-s`/`data-tone`: info = the
   * machine works, warn = the human is awaited, ok/err = final, idle = nothing. */
  tone: StatusTone
  /** Compact glyph for dense rows; never the only carrier of the state. */
  icon: string
  labelKey: MessageKey
  /** Sentence-length phrase for the conversation header ("paused — waiting
   * for your answer"), in the tone colour. */
  phraseKey: MessageKey
  /** Discreet pulse: the agent itself is working right now (live signal). */
  pulse: boolean
  /** Strong amber treatment: the task is blocked on the human. */
  attention: boolean
}

const green: Pick<StatusVisual, 'tone'> = { tone: 'ok' }
const amber: Pick<StatusVisual, 'tone'> = { tone: 'warn' }
const red: Pick<StatusVisual, 'tone'> = { tone: 'err' }
const idle: Pick<StatusVisual, 'tone'> = { tone: 'idle' }

export const EXECUTION_STATUS: Record<TaskStatus, StatusVisual> = {
  queued: {
    ...idle,
    icon: G.pending,
    labelKey: 'workspace.statusQueued',
    phraseKey: 'workspace.phaseQueued',
    pulse: false,
    attention: false,
  },
  running: {
    ...amber,
    tone: 'info',
    icon: G.dot,
    labelKey: 'workspace.statusRunning',
    phraseKey: 'workspace.phaseRunning',
    pulse: true,
    attention: false,
  },
  waiting_for_you: {
    ...amber,
    icon: G.ask,
    labelKey: 'workspace.statusWaiting',
    phraseKey: 'workspace.phaseWaiting',
    pulse: false,
    attention: true,
  },
  reviewing: {
    ...amber,
    tone: 'info',
    icon: G.review,
    labelKey: 'workspace.statusReviewing',
    phraseKey: 'workspace.phaseReviewing',
    pulse: true,
    attention: false,
  },
  review_ok: {
    ...green,
    icon: G.ok,
    labelKey: 'workspace.statusReviewOk',
    phraseKey: 'workspace.phaseReviewOk',
    pulse: false,
    attention: false,
  },
  review_ko: {
    ...red,
    icon: G.ko,
    labelKey: 'workspace.statusReviewKo',
    phraseKey: 'workspace.phaseReviewKo',
    pulse: false,
    attention: false,
  },
  shipped: {
    ...green,
    icon: G.shipped,
    labelKey: 'workspace.statusShipped',
    phraseKey: 'workspace.phaseShipped',
    pulse: false,
    attention: false,
  },
  failed: {
    ...red,
    icon: G.ko,
    labelKey: 'workspace.statusFailed',
    phraseKey: 'workspace.phaseFailed',
    pulse: false,
    attention: false,
  },
  // Amber, not neutral: nothing runs, but the conversation is not over — it
  // sits in the "needs you" zone waiting for a Resume (T8). No `attention`
  // though: an unanswered question is louder than a paused turn.
  interrupted: {
    ...amber,
    icon: G.paused,
    labelKey: 'workspace.statusInterrupted',
    phraseKey: 'workspace.phaseInterrupted',
    pulse: false,
    attention: false,
  },
}
