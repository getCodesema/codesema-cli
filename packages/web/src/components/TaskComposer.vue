<script setup lang="ts">
// Task composer: one textarea (the title derives from its first line), a
// per-task agent picker, and the auto-ship opt-in. The target repo is the
// active project card the composer sits under — the parent owns that choice.
// No role picker: the tool runs anonymous dev agents, the user defines the
// workflow in the prompt itself.
import { computed, ref, watch } from 'vue'
import {
  commandForAgentId,
  matchAgentId,
  pickerAgents,
  taskComposerPayload,
} from '../composables/taskComposer'
import { draftBranch, type DraftTarget } from '../composables/useColumns'
import { titleFromPrompt } from '../composables/useTaskBoard'
import {
  planBaseLine,
  planBranchLine,
  planIsolationLine,
  planIssueLine,
  planQueueLine,
  planWorktreeLine,
  retargetLabel,
  type PlanComposerInput,
} from '../composables/useTaskPlan'
import type { CreateTaskInput } from '../composables/useTasks'
import { t } from '../i18n'
import type { AgentOption, Project, TaskIsolation, TaskPlan } from '../types'

const props = defineProps<{
  creating: boolean
  error: string | null
  /** Embedded in a draft column: the column is the card, drop the chrome. */
  compact?: boolean
  agents?: readonly AgentOption[]
  currentAgent?: string
  isolation?: TaskIsolation | null
  /**
   * T2.6. The draft column this composer sits in — absent in the standalone
   * queue composer, which targets no branch and shows no plan. The SAME draft
   * model the deck already uses (`forkDraft`/`workonDraft`): correcting the
   * target swaps that draft in place rather than opening a second one.
   */
  draft?: DraftTarget | null
  /** The draft's target project. 'scratch' forks no branch: the plan panel
   * shows a sober no-repository notice instead of the branch/base fields and
   * asks the parent for no preview at all. */
  projectKind?: Project['kind']
  /** The plan of what would be created, or null while there is nothing to plan. */
  plan?: TaskPlan | null
  /** Why the plan could not be worked out — shown instead of a stale plan. */
  planError?: string | null
  planPending?: boolean
  /** Carried across a target correction, which remounts this column. */
  initialPrompt?: string
}>()

const emit = defineEmits<{
  create: [input: CreateTaskInput]
  /** What this composer contributes to the plan; the parent owns the request. */
  'plan-input': [input: PlanComposerInput]
  /** The corrected target branch, with the prompt so it survives the remount. */
  retarget: [branch: string, prompt: string]
}>()

const prompt = ref(props.initialPrompt ?? '')
const autoShip = ref(false)
const selectedId = ref(matchAgentId(props.currentAgent, props.agents ?? []))

watch(
  () => [props.currentAgent, props.agents] as const,
  ([command, agents]) => {
    selectedId.value = matchAgentId(command, agents ?? [])
  },
)

const orderedAgents = computed(() => pickerAgents(props.agents ?? [], props.currentAgent))

const showPicker = computed(() => orderedAgents.value.length > 0)
const showBuildHint = computed(() => showPicker.value && props.isolation === 'container')

function optionDisabled(opt: AgentOption): boolean {
  return !opt.detected && opt.id !== selectedId.value
}

function submit(): void {
  const text = prompt.value.trim()
  if (!text || props.creating) {
    return
  }
  emit(
    'create',
    taskComposerPayload({
      title: titleFromPrompt(text),
      prompt: text,
      autoShip: autoShip.value,
      agent: commandForAgentId(selectedId.value, props.agents ?? [], props.currentAgent),
      defaultAgent: props.currentAgent ?? '',
    }),
  )
}

// ── T2.6 the plan panel ───────────────────────────────────────────────────

/** No repository at all: the scratch project forks no branch, so there is
 * nothing here for a preview to describe. */
const noRepo = computed(() => props.projectKind === 'scratch')

/** The composer's half of the plan request: the parent adds the draft's own. */
const planInput = computed<PlanComposerInput>(() => ({
  title: titleFromPrompt(prompt.value.trim()),
  prompt: prompt.value.trim(),
  autoShip: autoShip.value,
  agent: commandForAgentId(selectedId.value, props.agents ?? [], props.currentAgent),
}))

// A plan is only worth asking for once there IS a prompt: an empty one is a
// 400 on the creation route too, and showing that refusal before the human has
// typed anything would be an error message about nothing — which is why the
// parent, not this watch, is the one that decides to skip it. A scratch draft
// asks for nothing either: the server has no branch or base to preview, and
// the panel shows its own fixed notice instead of a plan.
//
// `immediate` is not a nicety here, it is the whole point (review round 1,
// MAJEUR 3). Correcting the target branch changes the draft column's key, so
// the `v-for` REMOUNTS this component with the prompt carried over in
// `initialPrompt`. A watch that only fires on CHANGE fires never on a fresh
// mount: the parent gets no `plan-input`, has no entry under the new key, and
// the panel shows an empty plan until the human types one more character —
// exactly where the spec promises "the plan is recalculated and shown again
// with the new branch". Firing on the initial value makes a mount an input
// like any other.
watch(
  [() => planInput.value.prompt, () => planInput.value.autoShip, () => planInput.value.agent],
  () => {
    if (props.draft && !noRepo.value) {
      emit('plan-input', planInput.value)
    }
  },
  { immediate: true },
)

const retargetInput = ref(props.draft ? draftBranch(props.draft) : '')
watch(
  () => props.draft,
  (draft) => {
    retargetInput.value = draft ? draftBranch(draft) : ''
  },
)

const retargetFieldLabel = computed(() =>
  props.draft ? retargetLabel(props.draft) : t('workspace.planBranchLabel'),
)

const retargetChanged = computed(
  () =>
    props.draft !== null &&
    props.draft !== undefined &&
    retargetInput.value.trim() !== '' &&
    retargetInput.value.trim() !== draftBranch(props.draft),
)

function applyRetarget(): void {
  if (retargetChanged.value) {
    emit('retarget', retargetInput.value.trim(), prompt.value)
  }
}

/** The plan, as rows. Built here so the panel never renders a field raw. */
const planRows = computed(() => {
  const plan = props.plan
  if (!plan) {
    return []
  }
  return [
    { key: 'repo', label: t('workspace.planRepo'), value: plan.repo },
    { key: 'branch', label: t('workspace.planBranch'), value: planBranchLine(plan) },
    { key: 'worktree', label: t('workspace.planWorktree'), value: planWorktreeLine(plan) },
    // Only a fork branches FROM something: a work-on conversation continues
    // its own branch, and an empty "Starts from" row would say nothing.
    ...(plan.mode === 'fork'
      ? [{ key: 'base', label: t('workspace.planBase'), value: planBaseLine(plan) }]
      : []),
    {
      key: 'target',
      label: t('workspace.planTarget'),
      value: plan.target || t('workspace.planNone'),
    },
    { key: 'isolation', label: t('workspace.planIsolation'), value: planIsolationLine(plan) },
    { key: 'agent', label: t('workspace.planAgent'), value: plan.agent },
    { key: 'queue', label: t('workspace.planQueue'), value: planQueueLine(plan) },
    { key: 'issue', label: t('workspace.planIssue'), value: planIssueLine(plan) },
  ]
})

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

    <!-- T2.6: what WILL be created, and the one field that changes it. Only
         inside a draft column — the standalone queue composer targets no
         branch, so it has no plan to show. -->
    <section v-if="draft" class="tc-plan">
      <h4 class="tc-plan-title">{{ t('workspace.planTitle') }}</h4>
      <!-- No repository: no branch is ever forked, so neither the retarget
           field nor a plan would describe anything real. -->
      <p v-if="noRepo" class="tc-plan-state">{{ t('workspace.draftNoRepo') }}</p>
      <template v-else>
        <div class="tc-plan-edit">
          <label class="tc-plan-label" :for="'tc-retarget'">{{ retargetFieldLabel }}</label>
          <input
            id="tc-retarget"
            v-model="retargetInput"
            class="tc-plan-input"
            type="text"
            spellcheck="false"
            @keydown.enter.prevent="applyRetarget"
          />
          <button
            class="tc-plan-apply"
            type="button"
            :disabled="!retargetChanged"
            @click="applyRetarget"
          >
            {{ t('workspace.planRetarget') }}
          </button>
        </div>
        <p v-if="planPending" class="tc-plan-state">{{ t('workspace.planLoading') }}</p>
        <p v-else-if="planError" class="tc-plan-state tc-plan-state--bad">
          {{ t('workspace.planError', { error: planError }) }}
        </p>
        <template v-else-if="plan">
          <dl class="tc-plan-rows">
            <div v-for="row in planRows" :key="row.key" class="tc-plan-row">
              <dt class="tc-plan-key">{{ row.label }}</dt>
              <dd class="tc-plan-value">{{ row.value }}</dd>
            </div>
          </dl>
          <p v-if="plan.mode === 'fork'" class="tc-plan-hint">
            {{ t('workspace.planBranchDerived') }}
          </p>
          <p class="tc-plan-hint">{{ t('workspace.planIndicative') }}</p>
        </template>
      </template>
    </section>
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

/* ── T2.6 plan panel ──────────────────────────────────────────────────── */
.tc-plan {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--cs-line);
}

.tc-plan-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--cs-text-2);
}

.tc-plan-edit {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tc-plan-label {
  font-size: 12.5px;
  color: var(--cs-text-2);
}

.tc-plan-input {
  flex: 1;
  min-width: 140px;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--cs-text);
  background: var(--cs-bg);
  border: 1px solid var(--cs-line);
  border-radius: 7px;
  padding: 4px 8px;
}

.tc-plan-apply {
  font-family: inherit;
  font-size: 12.5px;
  padding: 4px 12px;
  border-radius: 7px;
  border: 1px solid var(--cs-line-2);
  background: var(--cs-surface);
  color: var(--cs-text);
  cursor: pointer;
}

.tc-plan-apply:disabled {
  opacity: 0.45;
  cursor: default;
}

.tc-plan-state {
  margin: 0;
  font-size: 12.5px;
  color: var(--cs-text-2);
}

.tc-plan-state--bad {
  color: var(--cs-red-text);
}

.tc-plan-rows {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  margin: 0;
  font-size: 12.5px;
}

.tc-plan-row {
  display: contents;
}

.tc-plan-key {
  color: var(--cs-text-2);
}

.tc-plan-value {
  margin: 0;
  color: var(--cs-text);
  overflow-wrap: anywhere;
}

.tc-plan-hint {
  margin: 0;
  font-size: 12px;
  color: var(--cs-ghost);
}
</style>
