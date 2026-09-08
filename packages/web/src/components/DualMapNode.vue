<script setup lang="ts">
import type { ConsensusNode } from '../composables/useConsensusTree'
import { G } from '../glyphs'

const props = defineProps<{
  node: ConsensusNode
  depth: number
}>()

function paddingFor(depth: number, kind: 'dir' | 'file'): number {
  return (kind === 'dir' ? 1 : 2) + depth * 2
}

const padding = paddingFor(props.depth, props.node.kind)
</script>

<template>
  <div v-if="node.kind === 'dir'" class="dmn-dir-wrap">
    <div
      class="dmn-row dmn-dir"
      :class="{ 'dmn-row--hot': node.hot }"
      :style="{ paddingLeft: `${padding}ch` }"
    >
      <span
        class="dmn-dot"
        aria-hidden="true"
        :title="node.hot ? $t('live.consensusHotZone') : undefined"
      >
        <span class="dmn-dot-half dmn-dot-half--a" :class="{ 'dmn-dot-half--on': node.a }">{{
          G.dot
        }}</span>
        <span class="dmn-dot-half dmn-dot-half--b" :class="{ 'dmn-dot-half--on': node.b }">{{
          G.dot
        }}</span>
      </span>
      <span class="dmn-dir-name">{{ node.dir }}</span>
    </div>
    <DualMapNode v-for="(child, i) in node.children" :key="i" :node="child" :depth="depth + 1" />
  </div>

  <div
    v-else
    class="dmn-row dmn-file"
    :class="{ 'dmn-row--hot': node.row.hot }"
    :style="{ paddingLeft: `${padding}ch` }"
  >
    <span
      class="dmn-dot"
      aria-hidden="true"
      :title="node.row.hot ? $t('live.consensusHotZone') : undefined"
    >
      <span class="dmn-dot-half dmn-dot-half--a" :class="{ 'dmn-dot-half--on': node.row.a }">{{
        G.dot
      }}</span>
      <span class="dmn-dot-half dmn-dot-half--b" :class="{ 'dmn-dot-half--on': node.row.b }">{{
        G.dot
      }}</span>
    </span>
    <span class="dmn-file-name">{{ node.name }}</span>
    <span class="dmn-delta">
      <span class="dmn-add">+{{ node.row.additions }}</span>
      <span class="dmn-del">−{{ node.row.deletions }}</span>
    </span>
  </div>
</template>

<style scoped>
.dmn-dir-wrap {
  display: flex;
  flex-direction: column;
}

.dmn-row {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  padding-right: 1ch;
  min-width: 0;
  border-left: 2px solid transparent;
}

.dmn-row--hot {
  border-left-color: var(--accent);
}

.dmn-row--hot .dmn-dir-name,
.dmn-row--hot .dmn-file-name {
  color: var(--accent);
}

.dmn-dot {
  flex-shrink: 0;
  letter-spacing: -0.1em;
}

.dmn-dot-half {
  color: var(--fg-muted);
}

.dmn-dot-half--a.dmn-dot-half--on {
  color: var(--accent);
}

.dmn-dot-half--b.dmn-dot-half--on {
  color: var(--warn);
}

.dmn-dir-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dmn-file-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dmn-delta {
  font-size: 12px;
  flex-shrink: 0;
  display: inline-flex;
  gap: 1ch;
}

.dmn-add {
  color: var(--ok);
}

.dmn-del {
  color: var(--err);
}
</style>
