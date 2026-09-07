<script setup lang="ts">
// One conversation row: pure presentational, props in, nothing owned, nothing
// fetched. The caller (rail/ConversationsList.vue) wraps this in the clickable
// element and decides what a click does, same split as ForgeIssueCard.vue /
// ForgeListPanel.vue.
//
// Geometry follows the UI kit's `.card` row: one text line per line, no gap
// between rows (the column stacks them edge to edge, spacing comes only from
// this padding), the first three lines truncated to one line and never
// wrapped. The activity line and the reference pills are resolved upstream
// (ConversationsLogic.ts, §7-8) so this component only renders what it is
// handed.
import {
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
import { G } from '../../glyphs'
import { t } from '../../i18n'
import ChecksChip from './ChecksChip.vue'
import {
  formatConversationTimestamp,
  resolveActivityLine,
  resolveChecksPill,
  type ActivityGlyph,
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
const tone = computed(() => EXECUTION_STATUS[props.state.record.status].tone)

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
</script>

<template>
  <div class="cvr-root card" :class="`cvr-root--${section}`" :data-tone="tone">
    <p class="cvr-meta">{{ projectName }} {{ G.sep }} {{ timestamp }}</p>
    <p class="cvr-title">{{ state.record.title }}</p>
    <p class="cvr-activity">
      <span
        class="cvr-activity-glyph"
        :class="`cvr-activity-glyph--${activity.motion}`"
        aria-hidden="true"
      >
        <span v-if="activity.glyph === 'dot'" class="cvr-dot">{{ G.dot }}</span>
        <component :is="ACTIVITY_ICONS[activity.glyph]" v-else />
      </span>
      <span class="cvr-activity-text">{{ activity.text }}</span>
    </p>
    <div v-if="ticket || checksPill" class="cvr-pills">
      <span
        v-if="ticket"
        class="cvr-pill badge"
        :title="t('conversations.ticketRefAria', { n: ticket.iid })"
      >
        <Ticket class="cvr-pill-icon" aria-hidden="true" />
        <span class="cvr-pill-text">#{{ ticket.iid }}</span>
      </span>
      <ChecksChip v-if="checksPill" :pill="checksPill" />
    </div>
  </div>
</template>

<style scoped>
/* No gap of its own: the column stacks rows edge to edge and this padding IS
   the spacing. Height stays auto/variable, never fixed. */
.cvr-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: calc(var(--row) / 2) 1ch;
  /* EVERY row carries a border, only its colour changes with the state, so
     the geometry never shifts between one row and the next. */
  border: 1px solid var(--line);
  border-left-width: 3px;
  border-left-color: var(--c);
}

/* State outlines. A COLOURED left rail is reserved for a state, never for
   decoration, so only the two sections that ask something of the reader read
   the row's semantic tone: the human is the bottleneck, or the work is one
   click from shipping. "Working" and "done" stay neutral and are told apart
   by the activity line. Painting all four would make a dense column read as
   a garland. */
.cvr-root--attention {
  --c: var(--tone);
}

.cvr-root--ready {
  --c: var(--tone);
}

.cvr-root--active {
  --c: var(--line);
}

.cvr-root--done {
  --c: var(--line);
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
  font-size: 12px;
  color: var(--fg-muted);
}

.cvr-title {
  font-weight: 700;
  /* Row state (rest/hover/selected) governs the title's own weight and
     color from the wrapping button in rail/ConversationsList.vue: dimmed at
     rest, full on hover, reinforced when selected. */
  color: var(--fg-dim);
}

.cvr-activity {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 1ch;
  color: var(--tone);
}

.cvr-activity-glyph {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.cvr-activity-glyph svg {
  width: 1em;
  height: 1em;
}

.cvr-activity-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A live dot for the "pulse" motion (running): the one animation the kit
   allows, shared with every other running signal. */
.cvr-activity-glyph--pulse .cvr-dot {
  animation: blink 1.2s steps(2) infinite;
}

.cvr-pills {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1ch;
  margin-top: 2px;
}

/* Neutral by default: the ticket reference carries no state of its own, so
   it keeps the kit badge's hairline and dimmed text. */
.cvr-pill {
  display: inline-flex;
  align-items: center;
  gap: 1ch;
  border-color: var(--line);
  white-space: nowrap;
}

.cvr-pill-icon {
  flex: none;
  width: 1em;
  height: 1em;
}
</style>
