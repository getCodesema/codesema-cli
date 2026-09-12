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
import { draftBranch, type DraftTarget } from '../composables/useWorkspaceNav'
import { G } from '../glyphs'
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
const showBuildHint = computed(
  () => showPicker.value && (props.isolation === 'container' || props.isolation === 'microvm'),
)

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

/** No repository at all: a scratch draft forks no branch, so there is
 * nothing here for a preview to describe. The draft's own mode is the fact
 * that decides; the project kind only answers for a composer mounted with no
 * draft at all. */
const noRepo = computed(() =>
  props.draft ? props.draft.mode === 'scratch' : props.projectKind === 'scratch',
)

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

const retargetInput = ref(draftBranchOrEmpty(props.draft))
watch(
  () => props.draft,
  (draft) => {
    retargetInput.value = draftBranchOrEmpty(draft)
  },
)

/** A scratch draft names no branch, and neither does an absent one: the
 * field then starts empty rather than on a name nothing would accept. */
function draftBranchOrEmpty(draft: DraftTarget | null | undefined): string {
  return draft ? (draftBranch(draft) ?? '') : ''
}

const retargetFieldLabel = computed(() =>
  props.draft ? retargetLabel(props.draft) : t('workspace.planBranchLabel'),
)

const retargetChanged = computed(
  () =>
    props.draft !== null &&
    props.draft !== undefined &&
    retargetInput.value.trim() !== '' &&
    retargetInput.value.trim() !== draftBranchOrEmpty(props.draft),
)

function applyRetarget(): void {
  if (retargetChanged.value) {
    emit('retarget', retargetInput.value.trim(), prompt.value)
  }
}

/** A plan row's semantic weight: a degraded or uncertain fact reads as a
 * warning, an absent one as muted, everything else as plain text. */
type PlanRowTone = 'warn' | 'muted' | undefined

/** The plan, as rows. Built here so the panel never renders a field raw. */
const planRows = computed<{ key: string; label: string; value: string; tone: PlanRowTone }[]>(
  () => {
    const plan = props.plan
    if (!plan) {
      return []
    }
    const caged = plan.isolation === 'container' || plan.isolation === 'microvm'
    return [
      { key: 'repo', label: t('workspace.planRepo'), value: plan.repo, tone: undefined },
      {
        key: 'branch',
        label: t('workspace.planBranch'),
        value: planBranchLine(plan),
        tone: plan.branch_certain ? undefined : 'warn',
      },
      {
        key: 'worktree',
        label: t('workspace.planWorktree'),
        value: planWorktreeLine(plan),
        tone: undefined,
      },
      // Only a fork branches FROM something: a work-on conversation continues
      // its own branch, and an empty "Starts from" row would say nothing.
      ...(plan.mode === 'fork'
        ? [
            {
              key: 'base',
              label: t('workspace.planBase'),
              value: planBaseLine(plan),
              tone: undefined,
            },
          ]
        : []),
      {
        key: 'target',
        label: t('workspace.planTarget'),
        value: plan.target || t('workspace.planNone'),
        tone: plan.target ? undefined : ('muted' as const),
      },
      {
        key: 'isolation',
        label: t('workspace.planIsolation'),
        value: planIsolationLine(plan),
        tone: caged ? undefined : ('warn' as const),
      },
      { key: 'agent', label: t('workspace.planAgent'), value: plan.agent, tone: undefined },
      {
        key: 'queue',
        label: t('workspace.planQueue'),
        value: planQueueLine(plan),
        tone: undefined,
      },
      {
        key: 'issue',
        label: t('workspace.planIssue'),
        value: planIssueLine(plan),
        tone: plan.issue ? undefined : ('muted' as const),
      },
    ]
  },
)

/** A branch name the field no longer carries is not a target anything could
 * be applied to: the field says so rather than the button failing silently. */
const retargetInvalid = computed(
  () => draftBranchOrEmpty(props.draft) !== '' && retargetInput.value.trim() === '',
)

/** Called by the parent once the task is actually created. */
function reset(): void {
  prompt.value = ''
  autoShip.value = false
  selectedId.value = matchAgentId(props.currentAgent, props.agents ?? [])
}

defineExpose({ reset })
</script>

<template>
  <form class="tc-root composer" :class="{ 'tc-root--compact': compact }" @submit.prevent="submit">
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
      <button
        class="tc-autoship toggle"
        type="button"
        :aria-pressed="autoShip"
        :title="t('workspace.autoShipHint')"
        @click="autoShip = !autoShip"
      >
        <i aria-hidden="true">{{ autoShip ? G.ok : G.minus }}</i>
        <span>{{ t('workspace.autoShip') }}</span>
      </button>
      <button class="tc-launch btn primary" type="submit" :disabled="creating || !prompt.trim()">
        {{ creating ? t('workspace.launching') : t('workspace.launch')
        }}<span class="key" aria-hidden="true">^{{ G.reply }}</span>
      </button>
    </div>
    <p v-if="showBuildHint" class="tc-hint hint">{{ t('workspace.agentBuildHint') }}</p>
    <p v-if="error" class="tc-error live err">{{ t('workspace.createError') }} ({{ error }})</p>

    <!-- T2.6: what WILL be created, and the one field that changes it. Only
         inside a draft column — the standalone queue composer targets no
         branch, so it has no plan to show. -->
    <section v-if="draft" class="tc-plan plan">
      <h3 class="tc-plan-title">{{ t('workspace.planTitle') }}</h3>
      <!-- No repository: no branch is ever forked, so neither the retarget
           field nor a plan would describe anything real. -->
      <p v-if="noRepo" class="tc-plan-state muted">{{ t('workspace.draftNoRepo') }}</p>
      <template v-else>
        <div class="tc-plan-edit">
          <div class="tc-plan-field field" :class="{ invalid: retargetInvalid }">
            <label class="tc-plan-label" :for="'tc-retarget'">{{ retargetFieldLabel }}</label>
            <input
              id="tc-retarget"
              v-model="retargetInput"
              class="tc-plan-input"
              type="text"
              spellcheck="false"
              @keydown.enter.prevent="applyRetarget"
            />
          </div>
          <button
            class="tc-plan-apply btn"
            type="button"
            :disabled="!retargetChanged"
            @click="applyRetarget"
          >
            {{ t('workspace.planRetarget') }}
          </button>
        </div>
        <p v-if="planPending" class="tc-plan-state muted">{{ t('workspace.planLoading') }}</p>
        <p v-else-if="planError" class="tc-plan-state live err">
          {{ t('workspace.planError', { error: planError }) }}
        </p>
        <template v-else-if="plan">
          <dl class="tc-plan-rows kvs">
            <div v-for="row in planRows" :key="row.key" class="tc-plan-row">
              <dt class="tc-plan-key">{{ row.label }}</dt>
              <dd class="tc-plan-value" :class="row.tone">{{ row.value }}</dd>
            </div>
          </dl>
          <p v-if="plan.mode === 'fork'" class="tc-plan-hint hint">
            {{ t('workspace.planBranchDerived') }}
          </p>
          <p class="tc-plan-hint hint">{{ t('workspace.planIndicative') }}</p>
        </template>
      </template>
    </section>
  </form>
</template>

<style scoped>
.tc-root {
  grid-template-columns: 1fr;
  border: 0;
  border-radius: var(--radius-bubble);
  background: var(--bg-search);
  padding: 0.85rem 1rem;
}

/* Inside a draft column the column already draws the card. */
.tc-root--compact {
  border: 0;
  border-radius: var(--radius-bubble);
  padding: 0.85rem 1rem;
  background: var(--bg-search);
}

.tc-input {
  min-height: calc(var(--row) * 3);
  border: 0;
  background: transparent;
  border-radius: 0;
  padding: 0;
  min-width: 0;
  width: 100%;
}

.tc-input:focus {
  outline: none;
  border-color: transparent;
}

.tc-row {
  display: flex;
  align-items: center;
  gap: 2ch;
  flex-wrap: wrap;
}

.tc-agent {
  display: inline-flex;
  align-items: center;
  gap: 1ch;
  color: var(--fg-dim);
}

.tc-agent-select {
  min-width: 0;
}

.tc-launch {
  margin-left: auto;
  border-radius: var(--radius-pill);
}

.tc-error {
  margin: 0;
}

/* ── T2.6 plan panel ──────────────────────────────────────────────────── */
.tc-plan {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}

.tc-plan-title {
  margin: 0;
}

.tc-plan-edit {
  display: flex;
  align-items: flex-end;
  gap: 1ch;
  flex-wrap: wrap;
}

.tc-plan-field {
  flex: 1;
  min-width: 24ch;
}

.tc-plan-input {
  width: 100%;
  min-width: 0;
}

.tc-plan-state {
  margin: 0;
}

.tc-plan-rows {
  align-items: baseline;
}

.tc-plan-row {
  display: contents;
}

.tc-plan-value {
  overflow-wrap: anywhere;
}

.tc-plan-hint {
  margin: 0;
}
</style>
