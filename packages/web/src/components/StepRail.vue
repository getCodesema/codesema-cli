<script setup lang="ts">
import type { Finding } from '../composables/useDiff'
import { stepTone } from '../composables/useStepTone'
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

function toneOf(index: number): string {
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
  <nav class="rail-root" :aria-label="$t('rail.aria')">
    <span class="rail-edge">{{ $t('rail.mr') }}</span>

    <template v-for="(step, i) in steps" :key="i">
      <span class="rail-link" :class="{ 'rail-link--passed': linkPassed(i) }" />
      <button
        class="rail-node"
        :class="`rail-node--${stateOf(i)}`"
        :title="step.title"
        @click="emit('select', i)"
      >
        <span class="rail-dot" :class="[`rail-dot--tone-${toneOf(i)}`, `rail-dot--${stateOf(i)}`]">
          <template v-if="stateOf(i) === 'passed'">✓</template>
          <template v-else>{{ i + 1 }}</template>
        </span>
        <span class="rail-label">{{ step.title }}</span>
      </button>
    </template>

    <span class="rail-link" :class="{ 'rail-link--passed': allPassed() }" />
    <span class="rail-edge" :class="{ 'rail-edge--merged': allPassed() }">{{
      $t('rail.merge')
    }}</span>
  </nav>
</template>

<style scoped>
.rail-root {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 26px;
  border-bottom: 1px solid var(--codesema-line);
  overflow-x: auto;
}

.rail-edge {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--codesema-ink-3);
  white-space: nowrap;
  flex-shrink: 0;
}

.rail-edge--merged {
  color: var(--codesema-risk-low);
}

.rail-link {
  flex: 1;
  min-width: 14px;
  border-top: 1.5px dashed var(--codesema-line-idle);
  transition: border-color 0.5s ease;
}

.rail-link--passed {
  border-top-color: var(--codesema-signal-go);
}

.rail-node {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  max-width: 190px;
  background: var(--codesema-panel);
  border: 1px solid var(--codesema-line-2);
  border-radius: 11px;
  padding: 5px 12px 5px 6px;
  font-family: inherit;
  cursor: pointer;
  transition:
    border-color 0.5s ease,
    box-shadow 0.25s ease;
}

.rail-node:hover {
  border-color: var(--codesema-ink-3);
}

.rail-node--passed {
  border-color: var(--codesema-signal-go);
}

.rail-node--active {
  border-color: var(--codesema-signal-check);
}

.rail-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  background: var(--codesema-dot-idle);
  color: #fff;
  transition:
    background 0.5s ease,
    box-shadow 0.25s ease;
}

/* The dot carries the verdict tone; read state stays on the ✓ and node border. */
.rail-dot--tone-low {
  background: var(--codesema-risk-low);
}

.rail-dot--tone-medium {
  background: var(--codesema-risk-med);
}

.rail-dot--tone-high {
  background: var(--codesema-risk-high);
}

.rail-dot--active.rail-dot--tone-low {
  box-shadow: 0 0 8px var(--codesema-risk-low);
}

.rail-dot--active.rail-dot--tone-medium {
  box-shadow: 0 0 8px var(--codesema-risk-med);
}

.rail-dot--active.rail-dot--tone-high {
  box-shadow: 0 0 8px var(--codesema-risk-high);
}

.rail-label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--codesema-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
