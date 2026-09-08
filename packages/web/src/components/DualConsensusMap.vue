<script setup lang="ts">
import { computed } from 'vue'
import { buildConsensusTree } from '../composables/useConsensusTree'
import { sameFile } from '../composables/useDiff'
import { G } from '../glyphs'
import type { LiveInput, PartialReview } from '../types'
import DualMapNode from './DualMapNode.vue'

const props = defineProps<{
  files: LiveInput['files']
  partialA: PartialReview | null
  partialB: PartialReview | null
}>()

const PREVIEW_MAX = 40
// Below this many changed files the flat list stays readable; above it, grouping
// by folder keeps the map scannable instead of a long scroll of paths.
const TREE_THRESHOLD = 12

function touches(partial: PartialReview | null, path: string): boolean {
  return !!partial?.findings.some((f) => sameFile(f.file, path))
}

const rows = computed(() =>
  props.files.map((file) => {
    const a = touches(props.partialA, file.path)
    const b = touches(props.partialB, file.path)
    return { ...file, a, b, hot: a && b }
  }),
)

const previewRows = computed(() => rows.value.slice(0, PREVIEW_MAX))
const hiddenCount = computed(() => Math.max(0, rows.value.length - PREVIEW_MAX))
const isTree = computed(() => props.files.length > TREE_THRESHOLD)
const tree = computed(() => buildConsensusTree(previewRows.value))
</script>

<template>
  <section class="dmap-root">
    <div class="dmap-head">{{ $t('live.consensusTitle') }}</div>

    <div v-if="isTree" class="dmap-tree">
      <DualMapNode v-for="(node, i) in tree" :key="i" :node="node" :depth="0" />
      <p v-if="hiddenCount" class="dmap-more">{{ $t('live.moreFiles', { n: hiddenCount }) }}</p>
    </div>

    <div v-else class="dmap-rows">
      <div
        v-for="row in previewRows"
        :key="row.path"
        class="dmap-row"
        :class="{ 'dmap-row--hot': row.hot }"
      >
        <span
          class="dmap-dot"
          aria-hidden="true"
          :title="row.hot ? $t('live.consensusHotZone') : undefined"
        >
          <span class="dmap-dot-half dmap-dot-half--a" :class="{ 'dmap-dot-half--on': row.a }">{{
            G.dot
          }}</span>
          <span class="dmap-dot-half dmap-dot-half--b" :class="{ 'dmap-dot-half--on': row.b }">{{
            G.dot
          }}</span>
        </span>
        <span class="dmap-path">{{ row.path }}</span>
        <span class="dmap-delta">
          <span class="dmap-add">+{{ row.additions }}</span>
          <span class="dmap-del">−{{ row.deletions }}</span>
        </span>
      </div>
      <p v-if="hiddenCount" class="dmap-more">{{ $t('live.moreFiles', { n: hiddenCount }) }}</p>
    </div>
  </section>
</template>

<style scoped>
.dmap-root {
  border: 1px solid var(--line);
  padding: calc(var(--row) / 2) 1ch;
}

.dmap-head {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-dim);
}

.dmap-rows,
.dmap-tree {
  display: flex;
  flex-direction: column;
}

.dmap-row {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  padding: 0 1ch;
  border-left: 2px solid transparent;
}

.dmap-row--hot {
  border-left-color: var(--accent);
}

.dmap-row--hot .dmap-path {
  color: var(--accent);
}

.dmap-dot {
  flex-shrink: 0;
  letter-spacing: -0.1em;
}

.dmap-dot-half {
  color: var(--fg-muted);
}

.dmap-dot-half--a.dmap-dot-half--on {
  color: var(--accent);
}

.dmap-dot-half--b.dmap-dot-half--on {
  color: var(--warn);
}

.dmap-path {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dmap-delta {
  font-size: 12px;
  flex-shrink: 0;
  display: inline-flex;
  gap: 1ch;
}

.dmap-add {
  color: var(--ok);
}

.dmap-del {
  color: var(--err);
}

.dmap-more {
  font-size: 12px;
  color: var(--fg-dim);
  padding-left: 1ch;
}
</style>
