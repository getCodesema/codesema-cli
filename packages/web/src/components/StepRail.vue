<script setup lang="ts">
import type { Finding } from '../composables/useDiff'
import { stepTone, type StepTone } from '../composables/useStepTone'
import { G } from '../glyphs'
import type { StepView } from '../types'

const props = defineProps<{
  steps: StepView[]
  findings: Finding[]
  readSet?: Set<number>
  currentIndex: number | null
}>()

const emit = defineEmits<{
  select: [index: number]
}>()

type RailState = 'passed' | 'active' | 'pending'

function stateOf(index: number): RailState {
  if (props.readSet?.has(index)) {
    return 'passed'
  }
  if (props.currentIndex === index) {
    return 'active'
  }
  return 'pending'
}

function toneOf(index: number): StepTone {
  const step = props.steps[index]
  return step ? stepTone(step, props.findings) : 'low'
}

function linkPassed(index: number): boolean {
  if (index === 0) {
    return stateOf(0) === 'passed'
  }
  return stateOf(index - 1) === 'passed'
}

function allPassed(): boolean {
  return props.steps.every((_, i) => stateOf(i) === 'passed')
}
</script>

<template>
  <nav class="rail-root steprail" :aria-label="$t('rail.aria')">
    <span class="rail-edge muted">{{ $t('rail.mr') }}</span>

    <template v-for="(step, i) in steps" :key="i">
      <span class="rail-link link" :class="{ 'rail-link--passed': linkPassed(i) }" />
      <button
        class="rail-node node"
        :class="[
          `rail-node--${stateOf(i)}`,
          {
            done: stateOf(i) === 'passed',
            cur: stateOf(i) === 'active',
            risk: toneOf(i) === 'high',
          },
        ]"
        :title="step.title"
        @click="emit('select', i)"
      >
        <span class="rail-dot" :data-r="toneOf(i)">
          <template v-if="stateOf(i) === 'passed'">{{ G.ok }}</template>
          <template v-else>{{ i + 1 }}</template>
        </span>
        <span class="rail-label">{{ step.title }}</span>
      </button>
    </template>

    <span class="rail-link link" :class="{ 'rail-link--passed': allPassed() }" />
    <span class="rail-edge" :class="{ 'rail-edge--merged': allPassed() }">{{
      $t('rail.merge')
    }}</span>
  </nav>
</template>

<style scoped>
.rail-root {
  gap: 1ch;
  padding: calc(var(--row) / 2) 2ch;
  border-bottom: 1px solid var(--line);
}

.rail-edge {
  white-space: nowrap;
  flex-shrink: 0;
}

.rail-edge--merged {
  color: var(--ok);
}

.rail-link {
  flex: 1;
  min-width: 2ch;
}

.rail-link--passed {
  border-top-color: var(--ok);
}

.rail-node {
  display: inline-flex;
  align-items: center;
  gap: 1ch;
  flex-shrink: 0;
  max-width: 30ch;
  font: inherit;
  background: transparent;
}

.rail-node:hover {
  background: var(--bg-hover);
}

.rail-dot {
  flex-shrink: 0;
  font-weight: 700;
}

.rail-dot[data-r='low'] {
  color: var(--ok);
}

.rail-dot[data-r='medium'] {
  color: var(--warn);
}

.rail-dot[data-r='high'] {
  color: var(--err);
}

.rail-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
