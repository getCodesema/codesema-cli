<script setup lang="ts">
// 'checks' journal line: the final verdict of a sandboxed checks run appended
// by the manager — "Checks — 3 passed" (go) / "Checks — 1 failed" (stop),
// tagged with the turn it verified. The thread carries the latest verdict of
// each turn only; every run stays listed in the Checks tab.
import { computed } from 'vue'
import { checksEventLine } from '../../composables/useChecks'
import { clockTime } from '../../composables/useTaskBoard'
import { G } from '../../glyphs'
import { t } from '../../i18n'
import { formatExactStamp } from '../../relative-time'
import type { TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent, TaskRecord } from '../../types'

const props = defineProps<{ event: TaskEvent; task: TaskRecord; ctx: TaskEventCtx }>()

const ROW_STATUS = {
  go: 'passed',
  check: 'passed',
  stop: 'failed',
  busy: 'skipped',
  idle: 'skipped',
} as const

const ROW_GLYPH = {
  go: G.ok,
  check: G.ok,
  stop: G.ko,
  busy: G.pending,
  idle: G.minus,
} as const

const line = computed(() => checksEventLine(props.event.data))
const rowStatus = computed(() => ROW_STATUS[line.value.tone])
const glyph = computed(() => ROW_GLYPH[line.value.tone])
const stamp = computed(() => clockTime(props.event.at))
const exact = computed(() => formatExactStamp(props.event.at))
const text = computed(() =>
  props.ctx.turnNumber === null
    ? line.value.text
    : t('conversation.checksLine', { text: line.value.text, n: props.ctx.turnNumber }),
)
</script>

<template>
  <div class="tvc-line check-row" :data-s="rowStatus" :title="exact">
    <span class="tvc-dot g" aria-hidden="true">{{ glyph }}</span>
    <span class="tvc-text" :class="{ 'tvc-text--stop': line.tone === 'stop' }">
      {{ text }}
    </span>
    <span v-if="ctx.showTime && stamp" class="tvc-time">{{ stamp }}</span>
  </div>
</template>

<style scoped>
/* One line, not a table: the stamp follows the verdict instead of anchoring
   a column of its own. */
.tvc-line.check-row {
  display: flex;
  align-items: baseline;
  gap: 1ch;
}

.tvc-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* Only a failure colours its own words; a pass is said by the glyph alone. */
.tvc-text--stop {
  color: var(--err);
}

.tvc-time {
  flex: none;
  font-size: 12px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
</style>
