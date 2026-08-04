<script setup lang="ts">
import type { ConsensusNode } from '../composables/useConsensusTree'

const props = defineProps<{
  node: ConsensusNode
  depth: number
}>()

function paddingFor(depth: number, kind: 'dir' | 'file'): number {
  return (kind === 'dir' ? 8 : 12) + depth * 14
}

const padding = paddingFor(props.depth, props.node.kind)
</script>

<template>
  <div v-if="node.kind === 'dir'" class="dmn-dir-wrap">
    <div
      class="dmn-row dmn-dir"
      :class="{ 'dmn-row--hot': node.hot }"
      :style="{ paddingLeft: `${padding}px` }"
    >
      <span class="dmn-dot" :title="node.hot ? $t('live.consensusHotZone') : undefined">
        <span class="dmn-dot-half dmn-dot-half--a" :class="{ 'dmn-dot-half--on': node.a }" />
        <span class="dmn-dot-half dmn-dot-half--b" :class="{ 'dmn-dot-half--on': node.b }" />
      </span>
      <span class="dmn-dir-name">{{ node.dir }}</span>
    </div>
    <DualMapNode v-for="(child, i) in node.children" :key="i" :node="child" :depth="depth + 1" />
  </div>

  <div
    v-else
    class="dmn-row dmn-file"
    :class="{ 'dmn-row--hot': node.row.hot }"
    :style="{ paddingLeft: `${padding}px` }"
  >
    <span class="dmn-dot" :title="node.row.hot ? $t('live.consensusHotZone') : undefined">
      <span class="dmn-dot-half dmn-dot-half--a" :class="{ 'dmn-dot-half--on': node.row.a }" />
      <span class="dmn-dot-half dmn-dot-half--b" :class="{ 'dmn-dot-half--on': node.row.b }" />
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
  align-items: center;
  gap: 8px;
  padding-top: 4px;
  padding-bottom: 4px;
  padding-right: 8px;
  border-radius: 7px;
  min-width: 0;
  transition: background 0.2s ease;
}

.dmn-row--hot {
  background: color-mix(in srgb, var(--codesema-accent) 8%, transparent);
  animation: dmn-pulse 2.2s ease-in-out infinite;
}

@keyframes dmn-pulse {
  0%,
  100% {
    box-shadow: inset 0 0 0 0 color-mix(in srgb, var(--codesema-accent) 22%, transparent);
  }
  50% {
    box-shadow: inset 0 0 0 3px color-mix(in srgb, var(--codesema-accent) 16%, transparent);
  }
}

.dmn-dot {
  position: relative;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid var(--codesema-line);
  overflow: hidden;
  flex-shrink: 0;
  display: inline-block;
}

.dmn-dot-half {
  position: absolute;
  top: 0;
  width: 50%;
  height: 100%;
  background: var(--codesema-dot-idle);
  transition: background 0.2s ease;
}

.dmn-dot-half--a {
  left: 0;
}

.dmn-dot-half--b {
  left: 50%;
}

.dmn-dot-half--a.dmn-dot-half--on {
  background: var(--codesema-accent);
}

.dmn-dot-half--b.dmn-dot-half--on {
  background: var(--codesema-amber);
}

.dmn-dir-name {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--codesema-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dmn-file-name {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--codesema-ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dmn-delta {
  font-family: var(--font-mono);
  font-size: 11px;
  flex-shrink: 0;
  display: inline-flex;
  gap: 6px;
}

.dmn-add {
  color: var(--codesema-risk-low);
}

.dmn-del {
  color: var(--codesema-risk-high);
}
</style>
