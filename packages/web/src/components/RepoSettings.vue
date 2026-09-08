<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { firstTokenBin, parseModelFlag } from '../composables/agentCommand'
import {
  isMergeStrategyOption,
  parseSettingsSnapshot,
  type MergeStrategy,
  type RunnerSettings,
} from '../composables/useSettings'
import { G } from '../glyphs'
import type { AgentOption } from '../types'

type RepoConfigSnapshot = {
  rulesContent: string
  syncAutoPush: boolean
  agent?: string
  model?: string
  effort?: string
  agents?: AgentOption[]
}

const isClient = typeof window !== 'undefined'
const configToken = isClient
  ? (window as { __CODESEMA_CONFIG_TOKEN__?: string }).__CODESEMA_CONFIG_TOKEN__
  : undefined

const loading = ref(true)
const loadError = ref<string | null>(null)
const rulesContent = ref('')
const syncAutoPush = ref(false)
const agent = ref('')
const agents = ref<AgentOption[]>([])

const savingRules = ref(false)
const rulesSaved = ref(false)
const rulesError = ref<string | null>(null)
let rulesSavedTimer: ReturnType<typeof setTimeout> | undefined

const togglingSync = ref(false)
const syncError = ref<string | null>(null)

const savingAgent = ref(false)
const agentError = ref<string | null>(null)
const model = ref('')
const effort = ref('')

const runnerAutoMerge = ref(true)
const mergeStrategy = ref<MergeStrategy | undefined>(undefined)
const maxTaskTurns = ref(30)
const savingRunnerAutoMerge = ref(false)
const runnerAutoMergeError = ref<string | null>(null)
const savingMergeStrategy = ref(false)
const mergeStrategyError = ref<string | null>(null)
const savingMaxTaskTurns = ref(false)
const maxTaskTurnsError = ref<string | null>(null)

function applySettings(settings: RunnerSettings): void {
  runnerAutoMerge.value = settings.runnerAutoMerge
  mergeStrategy.value = settings.mergeStrategy
  maxTaskTurns.value = settings.maxTaskTurns
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [configRes, settingsRes] = await Promise.all([
      fetch('/api/config'),
      fetch('/api/settings'),
    ])
    if (!configRes.ok) {
      throw new Error(`HTTP ${configRes.status}`)
    }
    if (!settingsRes.ok) {
      throw new Error(`HTTP ${settingsRes.status}`)
    }
    const snapshot = (await configRes.json()) as RepoConfigSnapshot
    rulesContent.value = snapshot.rulesContent
    syncAutoPush.value = snapshot.syncAutoPush
    agent.value = snapshot.agent ?? ''
    agents.value = Array.isArray(snapshot.agents) ? snapshot.agents : []
    // `model`/`effort` are authoritative; parseModelFlag only covers a CLI
    // old enough to omit them from the snapshot.
    model.value = snapshot.model ?? parseModelFlag(agent.value)
    effort.value = snapshot.effort ?? ''
    applySettings(parseSettingsSnapshot(await settingsRes.json()))
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function putSettings(
  partial: Partial<{
    runnerAutoMerge: boolean
    mergeStrategy: MergeStrategy
    maxTaskTurns: number
  }>,
): Promise<RunnerSettings> {
  if (!configToken) {
    throw new Error('missing config token')
  }
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-codesema-config-token': configToken },
    body: JSON.stringify(partial),
  })
  if (!res.ok) {
    const errorBody = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(errorBody?.error ?? `HTTP ${res.status}`)
  }
  return parseSettingsSnapshot(await res.json())
}

async function saveRunnerAutoMerge(next: boolean) {
  if (!configToken || savingRunnerAutoMerge.value) {
    return
  }
  const previous = runnerAutoMerge.value
  runnerAutoMerge.value = next
  savingRunnerAutoMerge.value = true
  runnerAutoMergeError.value = null
  try {
    applySettings(await putSettings({ runnerAutoMerge: next }))
  } catch (e) {
    runnerAutoMerge.value = previous
    runnerAutoMergeError.value = e instanceof Error ? e.message : String(e)
  } finally {
    savingRunnerAutoMerge.value = false
  }
}

async function saveMergeStrategy(next: string) {
  if (
    !configToken ||
    savingMergeStrategy.value ||
    !isMergeStrategyOption(next) ||
    next === mergeStrategy.value
  ) {
    return
  }
  const previous = mergeStrategy.value
  mergeStrategy.value = next
  savingMergeStrategy.value = true
  mergeStrategyError.value = null
  try {
    applySettings(await putSettings({ mergeStrategy: next }))
  } catch (e) {
    mergeStrategy.value = previous
    mergeStrategyError.value = e instanceof Error ? e.message : String(e)
  } finally {
    savingMergeStrategy.value = false
  }
}

async function saveMaxTaskTurns(next: string) {
  const parsed = Number(next)
  if (!configToken || savingMaxTaskTurns.value || !Number.isFinite(parsed)) {
    return
  }
  const rounded = Math.trunc(parsed)
  if (rounded === maxTaskTurns.value) {
    return
  }
  const previous = maxTaskTurns.value
  maxTaskTurns.value = rounded
  savingMaxTaskTurns.value = true
  maxTaskTurnsError.value = null
  try {
    applySettings(await putSettings({ maxTaskTurns: rounded }))
  } catch (e) {
    maxTaskTurns.value = previous
    maxTaskTurnsError.value = e instanceof Error ? e.message : String(e)
  } finally {
    savingMaxTaskTurns.value = false
  }
}

async function saveRules() {
  if (!configToken || savingRules.value) {
    return
  }
  savingRules.value = true
  rulesError.value = null
  try {
    const res = await fetch('/api/config/rules', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-codesema-config-token': configToken },
      body: JSON.stringify({ content: rulesContent.value }),
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    rulesSaved.value = true
    if (rulesSavedTimer) {
      clearTimeout(rulesSavedTimer)
    }
    rulesSavedTimer = setTimeout(() => {
      rulesSaved.value = false
    }, 2000)
  } catch (e) {
    rulesError.value = e instanceof Error ? e.message : String(e)
  } finally {
    savingRules.value = false
  }
}

async function toggleAutoSync() {
  if (!configToken || togglingSync.value) {
    return
  }
  const next = !syncAutoPush.value
  togglingSync.value = true
  syncError.value = null
  try {
    const res = await fetch('/api/config/sync-auto-push', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-codesema-config-token': configToken },
      body: JSON.stringify({ enabled: next }),
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    syncAutoPush.value = next
  } catch (e) {
    syncError.value = e instanceof Error ? e.message : String(e)
  } finally {
    togglingSync.value = false
  }
}

const agentSelectValue = computed(() => {
  const current = agent.value.trim()
  if (agents.value.some((opt) => opt.command === current)) {
    return current
  }
  const bin = firstTokenBin(current)
  return agents.value.find((opt) => opt.bin === bin)?.command ?? current
})

const selectedAgent = computed(() => {
  const current = agentSelectValue.value
  return (
    agents.value.find((opt) => opt.command === current) ??
    agents.value.find((opt) => opt.bin === firstTokenBin(current))
  )
})

const selectedAgentId = computed(() => selectedAgent.value?.id ?? agentSelectValue.value)

/** Model ids the CLI reported; free text stays possible, hence a datalist. */
const modelOptions = computed(() => selectedAgent.value?.models ?? [])
const effortOptions = computed(() => selectedAgent.value?.efforts ?? [])

async function persistAgent(
  nextCommand: string,
  nextModel: string,
  nextEffort: string,
): Promise<void> {
  if (!configToken || savingAgent.value) {
    return
  }
  const previous = { agent: agent.value, model: model.value, effort: effort.value }
  const opt =
    agents.value.find((a) => a.command === nextCommand) ??
    agents.value.find((a) => a.bin === firstTokenBin(nextCommand))
  agent.value = nextCommand
  model.value = nextModel
  effort.value = nextEffort
  savingAgent.value = true
  agentError.value = null
  try {
    const res = await fetch('/api/config/agent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-codesema-config-token': configToken },
      body: JSON.stringify({
        agent: opt?.id ?? nextCommand,
        model: nextModel.trim(),
        effort: nextEffort.trim(),
      }),
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const body = (await res.json()) as { agent?: string; model?: string; effort?: string }
    if (typeof body.agent === 'string') {
      agent.value = body.agent
      model.value = body.model ?? parseModelFlag(body.agent)
      effort.value = body.effort ?? nextEffort.trim()
    }
  } catch (e) {
    agent.value = previous.agent
    model.value = previous.model
    effort.value = previous.effort
    agentError.value = e instanceof Error ? e.message : String(e)
  } finally {
    savingAgent.value = false
  }
}

async function saveAgent(next: string) {
  if (next === agentSelectValue.value) {
    return
  }
  // Model and effort ids are provider-specific: switching provider drops them.
  const sameBin = firstTokenBin(next) === firstTokenBin(agent.value)
  await persistAgent(next, sameBin ? model.value : '', sameBin ? effort.value : '')
}

async function saveModel(next: string) {
  if (next.trim() === model.value.trim()) {
    return
  }
  await persistAgent(agentSelectValue.value, next, effort.value)
}

async function saveEffort(next: string) {
  if (next.trim() === effort.value.trim()) {
    return
  }
  await persistAgent(agentSelectValue.value, model.value, next)
}

onMounted(load)
</script>

<template>
  <div class="cfg-root">
    <h1 class="cfg-title">{{ $t('settings.title') }}</h1>

    <div v-if="loading" class="cfg-state">
      <p class="cfg-state-line status" data-s="running">{{ $t('settings.loading') }}</p>
    </div>
    <div v-else-if="loadError" class="cfg-state">
      <p class="cfg-error live err">{{ $t('settings.loadError') }} ({{ loadError }})</p>
      <button class="cfg-retry btn" type="button" @click="load">{{ $t('app.retry') }}</button>
    </div>
    <template v-else>
      <section class="cfg-section panel">
        <h2 class="cfg-section-title panel-title left">{{ $t('settings.rulesTitle') }}</h2>
        <p class="cfg-hint muted">{{ $t('settings.rulesHint') }}</p>
        <textarea v-model="rulesContent" class="cfg-textarea" rows="14" spellcheck="false" />
        <div class="cfg-section-actions">
          <button
            class="cfg-save-btn btn primary"
            :class="{ 'cfg-save-btn--done': rulesSaved }"
            type="button"
            :disabled="!configToken || savingRules"
            @click="saveRules"
          >
            {{ rulesSaved ? $t('settings.saved') : $t('settings.save') }}
          </button>
          <p v-if="rulesError" class="cfg-error live err">
            {{ $t('settings.saveError') }} ({{ rulesError }})
          </p>
        </div>
      </section>

      <section v-if="agents.length > 0" class="cfg-section panel">
        <h2 class="cfg-section-title panel-title left">{{ $t('settings.agentTitle') }}</h2>
        <p class="cfg-hint muted">{{ $t('settings.agentHint') }}</p>
        <div class="cfg-agent-fields">
          <select
            class="cfg-select"
            :value="agentSelectValue"
            :disabled="!configToken || savingAgent"
            @change="saveAgent(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="opt in agents"
              :key="opt.id"
              :value="opt.command"
              :disabled="!opt.detected && opt.command !== agentSelectValue"
            >
              {{ opt.label }}
            </option>
          </select>
          <label class="cfg-model field">
            <span class="cfg-model-label">{{ $t('settings.modelLabel') }}</span>
            <input
              class="cfg-input"
              type="text"
              :value="model"
              :list="modelOptions.length > 0 ? `cfg-models-${selectedAgentId}` : undefined"
              :placeholder="
                selectedAgentId === 'opencode'
                  ? $t('settings.modelPlaceholderOpencode')
                  : $t('settings.modelPlaceholder')
              "
              :disabled="!configToken || savingAgent"
              spellcheck="false"
              autocomplete="off"
              @change="saveModel(($event.target as HTMLInputElement).value)"
            />
            <datalist v-if="modelOptions.length > 0" :id="`cfg-models-${selectedAgentId}`">
              <option v-for="id in modelOptions" :key="id" :value="id" />
            </datalist>
          </label>
          <label v-if="effortOptions.length > 0" class="cfg-model cfg-effort field">
            <span class="cfg-model-label">{{ $t('settings.effortLabel') }}</span>
            <select
              class="cfg-select cfg-input"
              :value="effort"
              :disabled="!configToken || savingAgent"
              @change="saveEffort(($event.target as HTMLSelectElement).value)"
            >
              <option value="">{{ $t('settings.effortDefault') }}</option>
              <option v-for="level in effortOptions" :key="level" :value="level">
                {{ level }}
              </option>
            </select>
          </label>
        </div>
        <p v-if="agentError" class="cfg-error live err">
          {{ $t('settings.agentError') }} ({{ agentError }})
        </p>
      </section>

      <section class="cfg-section panel">
        <h2 class="cfg-section-title panel-title left">{{ $t('settings.autoSyncTitle') }}</h2>
        <p class="cfg-hint muted">{{ $t('settings.autoSyncHint') }}</p>
        <div class="cfg-section-actions">
          <button
            class="cfg-toggle-btn toggle"
            type="button"
            :aria-pressed="syncAutoPush"
            :disabled="!configToken || togglingSync"
            @click="toggleAutoSync"
          >
            <i aria-hidden="true">{{ syncAutoPush ? G.ok : G.minus }}</i>
            <span>{{ syncAutoPush ? $t('settings.autoSyncOn') : $t('settings.autoSyncOff') }}</span>
          </button>
          <p v-if="syncError" class="cfg-error live err">
            {{ $t('settings.autoSyncError') }} ({{ syncError }})
          </p>
        </div>
      </section>

      <section class="cfg-section panel">
        <h2 class="cfg-section-title panel-title left">{{ $t('settings.runnerTitle') }}</h2>

        <p class="cfg-hint muted">{{ $t('settings.runnerAutoMergeHint') }}</p>
        <div class="cfg-section-actions">
          <button
            class="cfg-toggle-btn toggle"
            type="button"
            :aria-pressed="runnerAutoMerge"
            :disabled="!configToken || savingRunnerAutoMerge"
            @click="saveRunnerAutoMerge(!runnerAutoMerge)"
          >
            <i aria-hidden="true">{{ runnerAutoMerge ? G.ok : G.minus }}</i>
            <span>{{
              runnerAutoMerge ? $t('settings.runnerAutoMergeOn') : $t('settings.runnerAutoMergeOff')
            }}</span>
          </button>
          <p v-if="runnerAutoMergeError" class="cfg-error live err">
            {{ $t('settings.runnerAutoMergeError') }} ({{ runnerAutoMergeError }})
          </p>
        </div>

        <p class="cfg-hint muted">{{ $t('settings.mergeStrategyHint') }}</p>
        <div class="cfg-section-actions">
          <label class="cfg-model field">
            <span class="cfg-model-label">{{ $t('settings.mergeStrategyLabel') }}</span>
            <select
              class="cfg-select cfg-input"
              :value="mergeStrategy ?? ''"
              :disabled="!configToken || savingMergeStrategy"
              @change="saveMergeStrategy(($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>{{ $t('settings.mergeStrategyUnset') }}</option>
              <option value="merge">merge</option>
              <option value="squash">squash</option>
              <option value="rebase">rebase</option>
            </select>
          </label>
          <p v-if="mergeStrategyError" class="cfg-error live err">
            {{ $t('settings.mergeStrategyError') }} ({{ mergeStrategyError }})
          </p>
        </div>

        <p class="cfg-hint muted">{{ $t('settings.maxTaskTurnsHint') }}</p>
        <div class="cfg-section-actions">
          <label class="cfg-model cfg-effort field">
            <span class="cfg-model-label">{{ $t('settings.maxTaskTurnsLabel') }}</span>
            <input
              class="cfg-input"
              type="number"
              min="1"
              max="500"
              step="1"
              :value="maxTaskTurns"
              :disabled="!configToken || savingMaxTaskTurns"
              @change="saveMaxTaskTurns(($event.target as HTMLInputElement).value)"
            />
          </label>
          <p v-if="maxTaskTurnsError" class="cfg-error live err">
            {{ $t('settings.maxTaskTurnsError') }} ({{ maxTaskTurnsError }})
          </p>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.cfg-root {
  max-width: 90ch;
  margin: 0 auto;
  padding: calc(var(--row) * 2) 2ch calc(var(--row) * 3);
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) * 1.5);
}

.cfg-title {
  margin: 0;
}

.cfg-state {
  min-height: 40vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--row);
}

.cfg-state-line,
.cfg-error {
  margin: 0;
}

.cfg-section-title {
  font-size: var(--fs);
  font-weight: 400;
}

.cfg-hint {
  margin: 0 0 calc(var(--row) / 2);
}

.cfg-textarea {
  width: 100%;
  min-width: 0;
  min-height: calc(var(--row) * 12);
  resize: vertical;
}

.cfg-section-actions {
  margin-top: calc(var(--row) / 2);
  display: flex;
  align-items: center;
  gap: 2ch;
  flex-wrap: wrap;
}

.cfg-save-btn--done {
  background: var(--ok);
  border-color: var(--ok);
}

.cfg-agent-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 2ch var(--row);
}

.cfg-model {
  min-width: min(100%, 40ch);
  flex: 1;
}

.cfg-effort {
  min-width: min(100%, 20ch);
  flex: 0 1 20ch;
}

.cfg-model-label {
  color: var(--fg-dim);
}

.cfg-select,
.cfg-input {
  min-width: 0;
}

.cfg-input {
  width: 100%;
}
</style>
