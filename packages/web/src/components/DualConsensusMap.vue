<script setup lang="ts">
import { computed } from 'vue'
import { buildConsensusTree } from '../composables/useConsensusTree'
import { sameFile } from '../composables/useDiff'
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
        <span class="dmap-dot" :title="row.hot ? $t('live.consensusHotZone') : undefined">
          <span class="dmap-dot-half dmap-dot-half--a" :class="{ 'dmap-dot-half--on': row.a }" />
          <span class="dmap-dot-half dmap-dot-half--b" :class="{ 'dmap-dot-half--on': row.b }" />
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
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  border-radius: 12px;
  padding: 14px 16px;
}

.dmap-head {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--codesema-ink-3);
  margin-bottom: 10px;
}

.dmap-rows,
.dmap-tree {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dmap-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 6px;
  border-radius: 7px;
  transition: background 0.2s ease;
}

.dmap-row--hot {
  background: color-mix(in srgb, var(--codesema-accent) 8%, transparent);
  animation: dmap-pulse 2.2s ease-in-out infinite;
}

@keyframes dmap-pulse {
  0%,
  100% {
    box-shadow: inset 0 0 0 0 color-mix(in srgb, var(--codesema-accent) 22%, transparent);
  }
  50% {
    box-shadow: inset 0 0 0 3px color-mix(in srgb, var(--codesema-accent) 16%, transparent);
  }
}

.dmap-dot {
  position: relative;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid var(--codesema-line);
  overflow: hidden;
  flex-shrink: 0;
  display: inline-block;
}

.dmap-dot-half {
  position: absolute;
  top: 0;
  width: 50%;
  height: 100%;
  background: var(--codesema-dot-idle);
  transition: background 0.2s ease;
}

.dmap-dot-half--a {
  left: 0;
}

.dmap-dot-half--b {
  left: 50%;
}

.dmap-dot-half--a.dmap-dot-half--on {
  background: var(--codesema-accent);
}

.dmap-dot-half--b.dmap-dot-half--on {
  background: var(--codesema-amber);
}

.dmap-path {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--codesema-ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dmap-delta {
  font-family: var(--font-mono);
  font-size: 11px;
  flex-shrink: 0;
  display: inline-flex;
  gap: 6px;
}

.dmap-add {
  color: var(--codesema-risk-low);
}

.dmap-del {
  color: var(--codesema-risk-high);
}

.dmap-more {
  margin: 4px 0 0 6px;
  font-size: 11.5px;
  color: var(--codesema-ink-3);
}
</style>
