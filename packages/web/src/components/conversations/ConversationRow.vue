<script setup lang="ts">
// One conversation row: pure presentational, props in, nothing owned, nothing
// fetched. The caller (ConversationsColumn.vue) wraps this in the clickable
// element and decides what a click does, same split as ForgeIssueCard.vue /
// ForgeListPanel.vue.
//
// Geometry and the four lines follow the row spec of the internal
// measurement notes: 14/12/8 padding, radius 8, NO gap between
// rows (the column stacks them edge to edge, spacing comes only from this
// padding), every icon at 10px, the first three lines truncated to one line
// and never wrapped. The activity line and the reference pills are resolved
// upstream (ConversationsLogic.ts, §7-8) so this component only renders what
// it is handed.
import {
  AlertTriangle,
  Check,
  CircleAlert,
  Clock,
  MessageCircleQuestion,
  Pause,
  RefreshCw,
  ShieldAlert,
  Ticket,
  X,
} from '@lucide/vue'
import { computed, type Component } from 'vue'
import { queueSectionOf } from '../../composables/useTaskBoard'
import type { TaskState } from '../../composables/useTasks'
import { EXECUTION_STATUS } from '../../execution-status'
import { t } from '../../i18n'
import {
  formatConversationTimestamp,
  resolveActivityLine,
  resolveChecksPill,
  type ActivityGlyph,
  type ReferencePillGlyph,
} from './ConversationsLogic'

const props = defineProps<{
  state: TaskState
  /** Display name of the conversation's project, for the meta line. */
  projectName: string
  selected: boolean
}>()

/** Which of the four work sections this conversation is in. The row draws
 *  its outline from it, and the table it comes from is exhaustive over every
 *  TaskStatus, so a new status cannot silently fall through to "no outline". */
const section = computed(() => queueSectionOf(props.state.record.status))

const activity = computed(() => resolveActivityLine(props.state))
const checksPill = computed(() => resolveChecksPill(props.state))
const ticket = computed(() => props.state.record.issue)
const timestamp = computed(() => formatConversationTimestamp(props.state.record.updated_at))
// Reuses the same status -> color table every other status treatment in the
// workspace already reads from, rather than a second opinion on what
// "running" or "review_ko" should look like.
const activityColor = computed(() => EXECUTION_STATUS[props.state.record.status].text)

const ACTIVITY_ICONS: Partial<Record<ActivityGlyph, Component>> = {
  pause: Pause,
  'shield-alert': ShieldAlert,
  question: MessageCircleQuestion,
  'circle-alert': CircleAlert,
  check: Check,
  refresh: RefreshCw,
  clock: Clock,
  x: X,
}

const CHECKS_ICONS: Partial<Record<ReferencePillGlyph, Component>> = {
  x: X,
  'alert-triangle': AlertTriangle,
  check: Check,
}
</script>

<template>
  <div class="cvr-root" :class="`cvr-root--${section}`">
    <p class="cvr-meta">{{ projectName }} · {{ timestamp }}</p>
    <p class="cvr-title">{{ state.record.title }}</p>
    <p class="cvr-activity" :style="{ color: activityColor }">
      <span
        class="cvr-activity-glyph"
        :class="`cvr-activity-glyph--${activity.motion}`"
        aria-hidden="true"
      >
        <span v-if="activity.glyph === 'dot'" class="cvr-dot" />
        <component :is="ACTIVITY_ICONS[activity.glyph]" v-else />
      </span>
      <span class="cvr-activity-text">{{ activity.text }}</span>
    </p>
    <div v-if="ticket || checksPill" class="cvr-pills">
      <span
        v-if="ticket"
        class="cvr-pill"
        :title="t('conversations.ticketRefAria', { n: ticket.iid })"
      >
        <Ticket class="cvr-pill-icon" aria-hidden="true" />
        <span class="cvr-pill-text">#{{ ticket.iid }}</span>
      </span>
      <span v-if="checksPill" class="cvr-pill" :class="`cvr-pill--${checksPill.tone}`">
        <span v-if="checksPill.glyph === 'dot'" class="cvr-dot cvr-dot--pill" aria-hidden="true" />
        <component
          :is="CHECKS_ICONS[checksPill.glyph]"
          v-else
          class="cvr-pill-icon"
          aria-hidden="true"
        />
        <span class="cvr-pill-text">{{ checksPill.text }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
/* No gap of its own: the column stacks rows edge to edge and this padding IS
   the spacing (sheet §4). Height stays auto/variable, never fixed. */
.cvr-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 8px 12px 8px 14px;
  /* EVERY row carries a border, only its colour changes with the state, so
     the geometry never shifts between one row and the next. */
  border: 1px solid var(--cs-line);
  border-radius: 8px;
}

/* State outlines. DESIGN.md reserves a COLOURED border for a state, never for
   decoration, so only the two sections that ask something of the reader get
   one: amber when the human is the bottleneck, green when the work is one
   click from shipping. "Working" and "done" stay neutral and are told apart
   by intensity, plus, for working, the living dot the activity line already
   renders. Painting all four would make a dense column read as a garland. */
.cvr-root--attention {
  border-color: var(--cs-amber-line);
}

.cvr-root--ready {
  border-color: var(--cs-green-ring);
}

.cvr-root--active {
  border-color: var(--cs-line-3);
}

.cvr-root--done {
  border-color: var(--cs-line);
}

.cvr-meta,
.cvr-title,
.cvr-activity {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cvr-meta {
  font-size: 10px;
  line-height: 12px;
  color: var(--cs-ghost);
}

.cvr-title {
  margin-top: 2px;
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
  /* Row state (rest/hover/selected) governs the title's own weight and
     color from the wrapping button in ConversationsColumn.vue: dimmed at
     rest, full on hover, reinforced when selected. */
  color: var(--cs-text-2);
}

.cvr-activity {
  margin-top: 1px;
  font-size: 11px;
  line-height: 16px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.cvr-activity-glyph {
  flex: none;
  width: 10px;
  height: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.cvr-activity-glyph svg {
  width: 10px;
  height: 10px;
}

.cvr-activity-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A live dot for the "pulse" motion (running): same visual language as
   WorkQueue's own wq-dot--pulse, no fill mode, the reduced-motion guard in
   style.css clamps this back to at-rest without a frozen keyframe. */
.cvr-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentcolor;
}

.cvr-activity-glyph--pulse .cvr-dot {
  animation: cvr-pulse 1.6s ease-in-out infinite;
}

@keyframes cvr-pulse {
  50% {
    opacity: 0.35;
  }
}

/* Sheet §7's own point: the "in progress" glyph never turns. Spin is
   reserved for the activity line's own 'reviewing' state below. */
.cvr-activity-glyph--spin svg {
  animation: cvr-spin 0.9s linear infinite;
}

@keyframes cvr-spin {
  to {
    transform: rotate(360deg);
  }
}

.cvr-pills {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

/* Sheet §7's gabarit: 6px horizontal by 1px vertical padding, radius 4,
   10px text with no dedicated line-height, semi-bold, a 1px hairline, an
   elevated-surface fill at 60%, 4px between the icon and the text. Neutral
   by default (the ticket reference carries no state of its own); a toned
   variant below overrides the fill for the checks pill. */
.cvr-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: 1px solid var(--cs-line-2);
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--cs-muted);
  background: color-mix(in srgb, var(--cs-surface-2) 60%, transparent);
  white-space: nowrap;
}

.cvr-pill-icon {
  flex: none;
  width: 10px;
  height: 10px;
}

.cvr-dot--pill {
  width: 6px;
  height: 6px;
}

.cvr-pill--red {
  color: var(--cs-red-text);
  border-color: var(--cs-red-line);
  background: var(--cs-red-soft);
}

.cvr-pill--amber {
  color: var(--cs-amber-text);
  border-color: var(--cs-amber-line);
  background: var(--cs-amber-soft);
}

.cvr-pill--green {
  color: var(--cs-green-text);
  border-color: var(--cs-green-ring);
  background: var(--cs-green-soft);
}
</style>
