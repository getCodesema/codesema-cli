<script setup lang="ts">
// Home composer: one textarea (the title derives from its first line), the
// per-task auto-ship opt-in, and — on a multi-project board — the target
// project selector (the parent owns and persists the choice). No role picker:
// the tool runs anonymous dev agents, the user defines the workflow in the
// prompt itself.
import { ref } from 'vue'
import { titleFromPrompt } from '../composables/useTaskBoard'
import type { CreateTaskInput } from '../composables/useTasks'
import { t } from '../i18n'
import type { Project } from '../types'

const props = defineProps<{
  creating: boolean
  error: string | null
  /** Selectable target repos (the selected projects, registry order). */
  projects: Project[]
}>()

/** Target project id, owned by the parent (last used, persisted). */
const target = defineModel<string | null>('target', { required: true })

const emit = defineEmits<{ create: [input: CreateTaskInput] }>()

const prompt = ref('')
const autoShip = ref(false)

function submit(): void {
  const text = prompt.value.trim()
  if (!text || props.creating || target.value === null) {
    return
  }
  emit('create', {
    title: titleFromPrompt(text),
    prompt: text,
    autoShip: autoShip.value,
  })
}

/** Called by the parent once the task is actually created. */
function reset(): void {
  prompt.value = ''
  autoShip.value = false
}

defineExpose({ reset })
</script>

<template>
  <form class="tc-root" @submit.prevent="submit">
    <textarea
      v-model="prompt"
      class="tc-input"
      rows="3"
      :placeholder="t('workspace.composerPlaceholder')"
      @keydown.enter="(e) => (e.metaKey || e.ctrlKey) && submit()"
    />
    <div class="tc-row">
      <label v-if="projects.length > 1" class="tc-target">
        <span class="tc-target-label">{{ t('workspace.composerTarget') }}</span>
        <select v-model="target" class="tc-target-select">
          <option v-for="project in projects" :key="project.id" :value="project.id">
            {{ project.name }}
          </option>
        </select>
      </label>
      <label class="tc-autoship" :title="t('workspace.autoShipHint')">
        <input v-model="autoShip" type="checkbox" class="tc-check" />
        <span>{{ t('workspace.autoShip') }}</span>
      </label>
      <button
        class="tc-launch"
        type="submit"
        :disabled="creating || !prompt.trim() || target === null"
      >
        {{ creating ? t('workspace.launching') : t('workspace.launch') }}
      </button>
    </div>
    <p v-if="error" class="tc-error">{{ t('workspace.createError') }} ({{ error }})</p>
  </form>
</template>

<style scoped>
.tc-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--sema-line-card);
  border-radius: 13px;
  background: var(--sema-card);
  box-shadow: var(--sema-shadow-panel);
}

.tc-input {
  border: 1px solid var(--sema-line-soft);
  border-radius: 9px;
  background: var(--sema-bg);
  color: var(--sema-ink);
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.55;
  padding: 10px 12px;
  resize: vertical;
  min-height: 62px;
}

.tc-input::placeholder {
  color: var(--sema-ink-ghost);
}

.tc-row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.tc-target {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--sema-ink-2);
}

.tc-target-label {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--sema-ink-3);
}

.tc-target-select {
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--sema-ink);
  background: var(--sema-bg);
  border: 1px solid var(--sema-line-soft);
  border-radius: 7px;
  padding: 4px 8px;
  cursor: pointer;
}

.tc-autoship {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--sema-ink-2);
  cursor: pointer;
}

.tc-check {
  accent-color: var(--sema-accent);
}

.tc-launch {
  margin-left: auto;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  padding: 8px 18px;
  border-radius: 9px;
  border: 1px solid var(--sema-accent);
  background: var(--sema-accent);
  color: var(--sema-on-accent);
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
  color: var(--sema-red-text);
}
</style>
