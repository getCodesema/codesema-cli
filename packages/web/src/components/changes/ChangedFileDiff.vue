<script setup lang="ts">
// Wraps DiffView.vue for exactly one already-expanded ChangedFileRow (fiche
// 14 §6). Two corrections DiffView's own defaults do not give us for free:
//
// 1. DiffView draws a per-file header (path, chevron, +/- counts) on every
//    file it renders. The row that expanded this diff already drew all of
//    that; repeating it would contradict the fiche directly ("l'en-tête de
//    fichier n'est pas répété"). DiffView has no prop to suppress just its
//    header, so it is hidden from outside with a :deep() rule, consuming
//    the component, not editing it.
//
// 2. DiffView auto-collapses any single file whose change count crosses its
//    own big-file budget (composables/useDiff.ts's collapsedByBudget), and
//    the only in-component control for that is the header this file just
//    hid. Left alone, a large file would render nothing and nothing could
//    ever reveal it. DiffView does expose collapseKey for exactly this: a
//    change from an even value forces full expansion (its own watcher,
//    "even = expanded"). Bumping it once, right after mount, never before,
//    the watcher does not fire on the value it was created with, forces
//    the file open regardless of its size.
import { onMounted, ref } from 'vue'
import type { DiffFile } from '../../composables/useDiff'
import DiffView from '../DiffView.vue'

defineProps<{ files: DiffFile[] }>()

const collapseKey = ref(0)
onMounted(() => {
  collapseKey.value = 2
})
</script>

<template>
  <div class="cfd-root">
    <DiffView :files="files" mode="unified" hide-toolbar :collapse-key="collapseKey" />
  </div>
</template>

<style scoped>
.cfd-root :deep(.srd-file-head) {
  display: none;
}

/* The per-file card chrome (border, radius, background) is redundant once
   its header is gone: the row above already frames this content with its
   own top hairline (ChangedFileRow.vue's .cfr-expanded). */
.cfd-root :deep(.srd-file) {
  border: none;
  border-radius: 0;
  background: none;
}

/* fiche §6: wraps instead of scrolling horizontally. Forcing unified mode
   above already keeps this narrow (no side-by-side split columns); this is
   the defensive half, for a single unbroken long token that plain
   white-space wrapping would not break on its own. */
.cfd-root :deep(.srd-body) {
  overflow-x: visible;
}

.cfd-root :deep(.srd-code) {
  overflow-wrap: anywhere;
}
</style>
