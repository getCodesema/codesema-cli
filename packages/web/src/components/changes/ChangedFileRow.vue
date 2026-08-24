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
//  3. no parasite border-radius on hover: the button resets its own
//     background/border/radius rather than inheriting a rounded button
//     component's defaults into a square list.
//  4. the path truncates from its START (CSS direction:rtl trick), keeping
//     the filename, the information, always visible, instead of the
//     fiche's end truncation which hides it on a deep path.
import { computed, useId } from 'vue'
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
      class="cfr-button"
      :aria-expanded="expanded"
      :aria-controls="diffRegionId"
      @click="emit('toggle')"
    >
      <span class="cfr-chevron" :class="{ 'cfr-chevron--open': expanded }" aria-hidden="true"
        >▸</span
      >
      <span class="cfr-path" :title="pathLabel">{{ pathLabel }}</span>
      <span class="cfr-status" :class="`cfr-status--${file.status}`">{{ statusLabel }}</span>
      <span
        class="cfr-counters"
        role="img"
        :aria-label="
          t('changes.file.deltaLabel', { additions: file.additions, deletions: file.deletions })
        "
      >
        <span class="cfr-add">+{{ file.additions }}</span>
        <span class="cfr-del">−{{ file.deletions }}</span>
      </span>
    </button>
    <div v-if="expanded" :id="diffRegionId" class="cfr-expanded">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.cfr-root {
  border-bottom: 1px solid var(--cs-line);
}

.cfr-root--last {
  border-bottom: none;
}

/* Defect #3 fixed: every box property is reset explicitly (background,
   border, radius) instead of inheriting a rounded button component's
   defaults, because the hover fill below has to draw a plain rectangle in
   this square list. */
.cfr-button {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 8px;
  padding: 10px 12px;
  margin: 0;
  border: none;
  border-radius: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background var(--cs-duration-fast) var(--cs-ease-out);
}

.cfr-button:hover {
  background: var(--cs-hover);
}

.cfr-chevron {
  flex: none;
  display: inline-block;
  color: var(--cs-muted);
  transition: transform var(--cs-duration-fast) var(--cs-ease-out);
}

.cfr-chevron--open {
  transform: rotate(90deg);
}

/* Defect #4 fixed: truncate from the START so the filename (the end of the
   path, the informative part) always stays visible. Latin path segments lay
   out left-to-right even inside a direction:rtl block; unicode-bidi keeps
   punctuation-heavy strings (lots of "/") from visually reordering. */
.cfr-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
  unicode-bidi: plaintext;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--cs-text);
}

/* Defect #1 fixed: a color per status instead of one uniform muted gray. */
.cfr-status {
  flex: none;
  font-size: 11px;
}

.cfr-status--added {
  color: var(--cs-green-text);
}

.cfr-status--modified {
  color: var(--cs-amber-text);
}

.cfr-status--deleted {
  color: var(--cs-red-text);
}

.cfr-status--renamed {
  color: var(--cs-water);
}

/* Defect #2 fixed: tabular figures so +/- counts do not dance between rows. */
.cfr-counters {
  flex: none;
  display: inline-flex;
  gap: 6px;
  font-size: 11px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.cfr-add {
  color: var(--cs-green-text);
}

.cfr-del {
  color: var(--cs-red-text);
}

/* fiche §6: a top hairline, then the diff render. */
.cfr-expanded {
  border-top: 1px solid var(--cs-line);
}
</style>
