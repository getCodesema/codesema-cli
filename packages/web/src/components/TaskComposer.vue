<script setup lang="ts">
// Task composer: one textarea (the title derives from its first line) and the
// per-task auto-ship opt-in. The target repo is the active project card the
// composer sits under — the parent owns that choice, nothing to pick here.
// No role picker: the tool runs anonymous dev agents, the user defines the
// workflow in the prompt itself.
import { computed, ref, watch } from 'vue'
import { commandForAgentId, matchAgentId, taskComposerPayload } from '../composables/taskComposer'
import { titleFromPrompt } from '../composables/useTaskBoard'
import type { CreateTaskInput } from '../composables/useTasks'
import { t } from '../i18n'
import type { AgentOption, TaskIsolation } from '../types'

const props = defineProps<{
  creating: boolean
  error: string | null
  /** Embedded in a draft column: the column is the card, drop the chrome. */
  compact?: boolean
  agents?: readonly AgentOption[]
  currentAgent?: string
  isolation?: TaskIsolation | null
}>()

const emit = defineEmits<{ create: [input: CreateTaskInput] }>()

const prompt = ref('')
const autoShip = ref(false)
const selectedId = ref(matchAgentId(props.currentAgent, props.agents ?? []))

watch(
  () => [props.currentAgent, props.agents] as const,
  ([command, agents]) => {
    selectedId.value = matchAgentId(command, agents ?? [])
  },
)

const orderedAgents = computed(() =>
  (props.agents ?? []).toSorted((a, b) => Number(b.detected) - Number(a.detected)),
)

const showPicker = computed(() => orderedAgents.value.length > 0)
const showBuildHint = computed(() => showPicker.value && props.isolation === 'container')

function optionDisabled(opt: AgentOption): boolean {
  return !opt.detected && opt.id !== matchAgentId(props.currentAgent, props.agents ?? [])
}

function submit(): void {
  const text = prompt.value.trim()
  if (!text || props.creating) {
    return
  }
  emit(
    'create',
    taskComposerPayload(
      titleFromPrompt(text),
      text,
      autoShip.value,
      commandForAgentId(selectedId.value, props.agents ?? [], props.currentAgent),
    ),
  )
}

/** Called by the parent once the task is actually created. */
function reset(): void {
  prompt.value = ''
  autoShip.value = false
  selectedId.value = matchAgentId(props.currentAgent, props.agents ?? [])
}

defineExpose({ reset })
</script>

<template>
  <form class="tc-root" :class="{ 'tc-root--compact': compact }" @submit.prevent="submit">
    <textarea
      v-model="prompt"
      class="tc-input"
      rows="3"
      :placeholder="t('workspace.composerPlaceholder')"
      @keydown.enter="(e) => (e.metaKey || e.ctrlKey) && submit()"
    />
    <div class="tc-row">
      <label v-if="showPicker" class="tc-agent">
        <span>{{ t('workspace.agentLabel') }}</span>
        <select v-model="selectedId" class="tc-agent-select">
          <option
            v-for="opt in orderedAgents"
            :key="opt.id"
            :value="opt.id"
            :disabled="optionDisabled(opt)"
          >
            {{ opt.label }}
          </option>
        </select>
      </label>
      <label class="tc-autoship" :title="t('workspace.autoShipHint')">
        <input v-model="autoShip" type="checkbox" class="tc-check" />
        <span>{{ t('workspace.autoShip') }}</span>
      </label>
      <button class="tc-launch" type="submit" :disabled="creating || !prompt.trim()">
        {{ creating ? t('workspace.launching') : t('workspace.launch') }}
      </button>
    </div>
    <p v-if="showBuildHint" class="tc-hint">{{ t('workspace.agentBuildHint') }}</p>
    <p v-if="error" class="tc-error">{{ t('workspace.createError') }} ({{ error }})</p>
  </form>
</template>

<style scoped>
.tc-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--cs-line-2);
  border-radius: 13px;
  background: var(--cs-surface);
  box-shadow: var(--cs-shadow-panel);
}

/* Inside a draft column the column already draws the card. */
.tc-root--compact {
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.tc-input {
  border: 1px solid var(--cs-line);
  border-radius: 9px;
  background: var(--cs-bg);
  color: var(--cs-text);
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.55;
  padding: 10px 12px;
  resize: vertical;
  min-height: 62px;
}

.tc-input::placeholder {
  color: var(--cs-ghost);
}

.tc-row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.tc-agent {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--cs-text-2);
}

.tc-agent-select {
  font-family: inherit;
  font-size: 12.5px;
  color: var(--cs-text);
  background: var(--cs-bg);
  border: 1px solid var(--cs-line);
  border-radius: 7px;
  padding: 4px 8px;
}

.tc-hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--cs-text-2);
}

.tc-autoship {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--cs-text-2);
  cursor: pointer;
}

.tc-check {
  accent-color: var(--cs-green);
}

.tc-launch {
  margin-left: auto;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  padding: 8px 18px;
  border-radius: 9px;
  border: 1px solid var(--cs-green);
  background: var(--cs-green);
  color: var(--cs-on-green);
  cursor: pointer;
  transition: opacity 0.12s ease;
}

.tc-launch:disabled {
  opacity: 0.45;
  cursor: default;
}

.tc-error {
  margin: 0;
  font-size: 12.5px;
  color: var(--cs-red-text);
}
</style>
