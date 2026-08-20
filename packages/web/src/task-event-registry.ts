// One registry resolves how each journal event type renders in the thread —
// a new event type gets a component here, never an if/else chain inside the
// conversation. Several types share a renderer on purpose: the mapping is the
// contract, the components are the implementations.

import type { Component } from 'vue'
import TaskEventChecks from './components/task-events/TaskEventChecks.vue'
import TaskEventLine from './components/task-events/TaskEventLine.vue'
import TaskEventMessage from './components/task-events/TaskEventMessage.vue'
import TaskEventQuestion from './components/task-events/TaskEventQuestion.vue'
import TaskEventReviewDone from './components/task-events/TaskEventReviewDone.vue'
import TaskEventTool from './components/task-events/TaskEventTool.vue'
import type { TaskEventType } from './types'

/**
 * Per-event render context, passed alongside the event by the conversation.
 * All registry components accept the same { event, task, ctx } props so the
 * thread can render them uniformly through <component :is>.
 */
export type TaskEventCtx = {
  /** True for the live question of a task in waiting_for_you: the card opens itself. */
  active: boolean
  /** True on a review_done event whose archive can be asked for: the ref it
   * carries, or the task's current review_ref on older journals. The load
   * itself happens on the click (and 404s on a pruned archive). */
  reviewAvailable: boolean
  /** Slow clock (epoch ms) owned by the conversation, for "il y a X" stamps. */
  now: number
  /**
   * Untruncated body for message/question events: the journal persists a
   * bounded preview, the full text lives on the turn (turns[i].response /
   * .question). Null when the record has no matching turn.
   */
  fullText: string | null
}

export const TASK_EVENT_COMPONENTS: Record<TaskEventType, Component> = {
  turn_started: TaskEventLine,
  tool_use: TaskEventTool,
  tool_result: TaskEventTool,
  message: TaskEventMessage,
  question: TaskEventQuestion,
  commit: TaskEventLine,
  review_started: TaskEventLine,
  review_done: TaskEventReviewDone,
  checks: TaskEventChecks,
  shipped: TaskEventLine,
  error: TaskEventLine,
  interrupted: TaskEventLine,
  isolation: TaskEventLine,
  cost: TaskEventLine,
  branch: TaskEventLine,
  resource: TaskEventLine,
}
