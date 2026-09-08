<script setup lang="ts">
// One row of the changes panel's file list (fiche 14 §5): a flat list, no
// tree, no indentation. Purely presentational, the caller owns the
// expanded set and whatever renders inside the expanded slot (the parent,
// ChangedFileList.vue, is what fetches and mounts the diff there, on its own
// 140ms delay). This file only renders the row button and the slot's
// wrapper (the top hairline before the diff, fiche §6).
//
// Three defects fixed relative to the fiche's source, plus a fourth of our
// own:
//  1. a color per status (added/modified/deleted/renamed), not one uniform
//     muted gray.
//  2. tabular figures on the +/- counters, so they do not dance from row to
//     row.
//  3. the button resets its own background and border rather than
//     inheriting a button component's defaults into a flat list.
//  4. the path truncates from its START (CSS direction:rtl trick), keeping
//     the filename, the information, always visible, instead of the
//     fiche's end truncation which hides it on a deep path.
import { computed, useId } from 'vue'
import { G } from '../../glyphs'
import { t, type MessageKey } from '../../i18n'
import type { PreviewFile } from '../../types'

const props = defineProps<{
  file: PreviewFile
  expanded: boolean
  /** Suppresses the bottom hairline: the container carries no border under
   * the last row of the list (fiche §5). */
  last?: boolean
}>()

const emit = defineEmits<{ toggle: [] }>()

const STATUS_LABEL_KEYS: Record<PreviewFile['status'], MessageKey> = {
  added: 'changes.file.statusAdded',
  modified: 'changes.file.statusModified',
  deleted: 'changes.file.statusDeleted',
  renamed: 'changes.file.statusRenamed',
}

const pathLabel = computed(() =>
  props.file.previousPath ? `${props.file.previousPath} → ${props.file.path}` : props.file.path,
)

const statusLabel = computed(() => t(STATUS_LABEL_KEYS[props.file.status]))

const diffRegionId = `cfr-diff-${useId()}`
</script>

<template>
  <div class="cfr-root" :class="{ 'cfr-root--last': last }">
    <button
      type="button"
      class="diff-f cfr-button"
      :aria-expanded="expanded"
      :aria-controls="diffRegionId"
      @click="emit('toggle')"
    >
      <span class="chev cfr-chevron" aria-hidden="true">{{
        expanded ? G.expand : G.collapse
      }}</span>
      <span class="path cfr-path" :title="pathLabel">{{ pathLabel }}</span>
      <span class="cfr-status" :class="`cfr-status--${file.status}`">{{ statusLabel }}</span>
      <span
        class="pm cfr-counters"
        role="img"
        :aria-label="
          t('changes.file.deltaLabel', { additions: file.additions, deletions: file.deletions })
        "
      >
        <span class="a cfr-add">+{{ file.additions }}</span>
        <span class="d cfr-del">−{{ file.deletions }}</span>
      </span>
    </button>
    <div v-if="expanded" :id="diffRegionId" class="cfr-expanded">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.cfr-root {
  border-bottom: 1px solid var(--line);
}

.cfr-root--last {
  border-bottom: none;
}

/* Defect #3 fixed: every box property is reset explicitly (background,
   border) instead of inheriting a button component's defaults, because the
   hover fill below has to draw a plain rectangle in this flat list. */
.cfr-button {
  width: 100%;
  gap: 2ch;
  padding: 2px 1ch;
  margin: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.cfr-button:hover {
  background: var(--bg-hover);
}

.cfr-chevron {
  flex: none;
}

/* Defect #4 fixed: truncate from the START so the filename (the end of the
   path, the informative part) always stays visible. Latin path segments lay
   out left-to-right even inside a direction:rtl block; unicode-bidi keeps
   punctuation-heavy strings (lots of "/") from visually reordering. */
.cfr-path {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
  unicode-bidi: plaintext;
}

/* Defect #1 fixed: a color per status instead of one uniform muted gray. */
.cfr-status {
  font-size: 12px;
}

.cfr-status--added {
  color: var(--ok);
}

.cfr-status--modified {
  color: var(--warn);
}

.cfr-status--deleted {
  color: var(--err);
}

.cfr-status--renamed {
  color: var(--info);
}

/* Defect #2 fixed: tabular figures so +/- counts do not dance between rows. */
.cfr-counters {
  display: inline-flex;
  gap: 1ch;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* fiche §6: a top hairline, then the diff render. */
.cfr-expanded {
  border-top: 1px solid var(--line);
}
</style>
