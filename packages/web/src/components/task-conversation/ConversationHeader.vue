<script setup lang="ts">
// The conversation's header: two lines. The first carries the state dot, the
// short label and the offers that move the task forward (interrupt, resume,
// ship). The second is ONE meta line of plain text — phrase, project, branch,
// isolation, chronos — separated by `G.sep`, with the asked sentence folded
// behind a toggle. Only a state a human must act on takes a colour: the dot
// always, the phrase when it is warn or err. Deleting the worktree is NOT
// here: an irreversible action lives at the tail of the thread. The state is
// carried by `data-tone`, never by an inline colour.
import { computed, ref } from 'vue'
import { agentRoleName } from '../../agent-label'
import { conversationMeta } from '../../composables/useConversationMeta'
import {
  reasonDetailText,
  resumeStateOf,
  statusPhraseKey,
  type FocusTab,
  type FocusTabState,
} from '../../composables/useTaskBoard'
import type { ApiResult, TaskState } from '../../composables/useTasks'
import { EXECUTION_STATUS } from '../../execution-status'
import { G } from '../../glyphs'
import { t } from '../../i18n'
import type { Project } from '../../types'

const props = defineProps<{
  state: TaskState
  projectName: string
  projectKind: Project['kind']
  repoProjects: Project[]
  attach: (repoProjectId: string) => Promise<ApiResult>
  interrupt: () => Promise<ApiResult>
  resume: () => Promise<ApiResult>
  ship: () => Promise<ApiResult>
  tab: FocusTab
  tabs: FocusTabState[]
  diffTabLabel: string
  checksTabText: string
  checksToneClass: string
  actionError: string | null
}>()

const emit = defineEmits<{ 'pick-tab': [tab: FocusTab]; error: [message: string | null] }>()

// Default 1:1 chrome: agent/role name only. Meta line, tab bar, and
// ship/interrupt/attach clusters stay in this file — unmounted, not deleted.
const SHOW_EXTRA_CHROME = false

const record = computed(() => props.state.record)
// Identité = rôle issu du projet (session agent), pas le titre du ticket.
const label = computed(
  () =>
    agentRoleName({ projectName: props.projectName, record: record.value }) ??
    t('workspace.agentLabel'),
)
const visual = computed(() => EXECUTION_STATUS[record.value.status])
// A 'queued' task waiting for the MACHINE-wide cap gets its own phrase.
const phraseKey = computed(() =>
  statusPhraseKey(record.value, props.state.liveLoadCap?.waitingForSlot ?? false),
)
// The phrase says WHAT holds the conversation; this says what to DO about it.
const reasonDetail = computed(() => reasonDetailText(record.value))
const attachments = computed(() => record.value.attachments ?? [])
// Offering a repository this conversation already holds would be an action
// with nothing to do.
const attachableProjects = computed(() => {
  const held = new Set(attachments.value.map((attachment) => attachment.project_id))
  return props.repoProjects.filter((project) => !held.has(project.id))
})

const shipNotice = ref<string | null>(null)

async function run(action: () => Promise<ApiResult>): Promise<boolean> {
  emit('error', null)
  const result = await action()
  if (!result.ok) {
    emit('error', result.error)
  }
  return result.ok
}

// 'reviewing' is deliberately ABSENT: the runner frees the slot before the
// review, so an interrupt there always 409s.
const canInterrupt = computed(() =>
  ['queued', 'running', 'waiting_for_you'].includes(record.value.status),
)

// T8. Only shown when there IS a turn to restart; 'reply' says, in words,
// that the composer is the way forward.
const resumeState = computed(() => resumeStateOf(record.value))
const resumeBusy = ref(false)

async function doResume(): Promise<void> {
  if (resumeBusy.value) {
    return
  }
  resumeBusy.value = true
  await run(props.resume)
  resumeBusy.value = false
}

async function doShip(): Promise<void> {
  shipNotice.value = null
  emit('error', null)
  const result = await props.ship()
  if (result.ok) {
    return
  }
  if (result.status === 501) {
    // T5 wires the actual push + MR creation; the button honors the contract.
    shipNotice.value = t('workspace.shipSoon')
  } else {
    emit('error', result.error)
  }
}

// ── Attach: give a scratch conversation a repo, any time, more than once ──
const attachSelection = ref('')
const attachBusy = ref(false)

async function doAttach(): Promise<void> {
  if (attachBusy.value || attachSelection.value === '') {
    return
  }
  attachBusy.value = true
  if (await run(() => props.attach(attachSelection.value))) {
    attachSelection.value = ''
  }
  attachBusy.value = false
}

async function doInterrupt(): Promise<void> {
  await run(props.interrupt)
}

// A phrase is only coloured when it names something a human must act on or
// has been given; 'ok', 'idle' and 'info' leave the dot as the only colour.
const phraseTone = computed(() =>
  visual.value.tone === 'warn' || visual.value.tone === 'err' ? visual.value.tone : null,
)

const promptOpen = ref(false)

const metaItems = computed(() =>
  conversationMeta(record.value, props.projectName, props.projectKind),
)

type TabLabel = { name: string; count: string | null }

// The counter travels glued to its label ('Diff · 3 files', 'Checks ✓'); the
// first space is the seam, and only the tail is allowed a tone.
function splitTabLabel(text: string): TabLabel {
  const seam = text.indexOf(' ')
  return seam === -1
    ? { name: text, count: null }
    : { name: text.slice(0, seam), count: text.slice(seam + 1) }
}

const diffTab = computed(() => splitTabLabel(props.diffTabLabel))
const checksTab = computed(() => splitTabLabel(props.checksTabText))
</script>

<template>
  <header class="cv-head">
    <div class="cv-conv-h conv-h">
      <div class="cv-title-row">
        <span class="cv-dot status" :data-tone="visual.tone" aria-hidden="true" />
        <h1 class="cv-title">{{ label }}</h1>
      </div>
      <span v-if="SHOW_EXTRA_CHROME" class="cv-actions act">
        <button
          v-if="canInterrupt"
          class="cv-btn cv-btn--interrupt btn ghost"
          type="button"
          @click="doInterrupt"
        >
          {{ t('workspace.interrupt') }}
        </button>
        <button
          v-if="resumeState === 'ready'"
          class="cv-btn cv-btn--resume btn ghost"
          type="button"
          :disabled="resumeBusy"
          :title="t('workspace.resumeHint')"
          @click="doResume"
        >
          {{ t('workspace.resume') }}
        </button>
        <button
          v-if="record.status === 'review_ok'"
          class="cv-btn cv-btn--ship btn primary"
          type="button"
          @click="doShip"
        >
          {{ t('workspace.ship') }}
        </button>
      </span>

      <!-- Quiet status phrase under the name; meta chips stay behind the flag. -->
      <div class="cv-sub chips">
        <span class="cv-phrase" :data-tone="phraseTone">{{ t(phraseKey) }}</span>

        <template v-if="SHOW_EXTRA_CHROME">
          <template v-for="item in metaItems" :key="item.key">
            <span class="cv-sep" aria-hidden="true">{{ G.sep }}</span>
            <span class="cv-chip" :class="`cv-chip--${item.kind}`" :title="item.hint ?? undefined">
              {{ item.text }}
            </span>
          </template>
        </template>

        <!-- Still offered once some are attached: a scratch conversation can
             take more than one. -->
        <template v-if="SHOW_EXTRA_CHROME && projectKind === 'scratch'">
          <template v-if="repoProjects.length === 0">
            <span class="cv-sep" aria-hidden="true">{{ G.sep }}</span>
            <span class="cv-chip">{{ t('workspace.attachRepoNone') }}</span>
          </template>
          <template v-else-if="attachableProjects.length > 0">
            <select
              v-model="attachSelection"
              class="cv-attach-select"
              :disabled="attachBusy"
              :aria-label="t('workspace.attachRepoPlaceholder')"
            >
              <option value="" disabled>{{ t('workspace.attachRepoPlaceholder') }}</option>
              <option
                v-for="repoProject in attachableProjects"
                :key="repoProject.id"
                :value="repoProject.id"
              >
                {{ repoProject.name }}
              </option>
            </select>
            <button
              type="button"
              class="cv-attach-btn btn"
              :disabled="attachBusy || attachSelection === ''"
              @click="doAttach"
            >
              {{ attachBusy ? t('workspace.attaching') : t('workspace.attachRepo') }}
            </button>
          </template>
        </template>

        <!-- The label on line 1 is a name; the sentence that was asked is one
             click away rather than in front of the first message. -->
        <button
          v-if="SHOW_EXTRA_CHROME"
          class="cv-prompt-toggle"
          type="button"
          :aria-expanded="promptOpen"
          @click="promptOpen = !promptOpen"
        >
          <span aria-hidden="true">{{ promptOpen ? G.expand : G.collapse }}</span>
          {{ promptOpen ? t('workspace.hidePrompt') : t('workspace.showPrompt') }}
        </button>
      </div>

      <p v-if="SHOW_EXTRA_CHROME" v-show="promptOpen" class="cv-full-title">{{ record.title }}</p>

      <p v-if="reasonDetail" class="cv-reason">{{ reasonDetail }}</p>
      <p v-if="shipNotice" class="cv-notice">{{ shipNotice }}</p>
      <!-- Interrupted, but with nothing to restart: say it instead of showing
           a Resume that could only fail. -->
      <p v-if="resumeState === 'reply'" class="cv-notice">{{ t('workspace.resumeNothing') }}</p>
      <p v-if="actionError" class="cv-error">{{ actionError }}</p>
    </div>

    <nav v-if="SHOW_EXTRA_CHROME" class="cv-tabs tabs" :aria-label="t('workspace.conversations')">
      <button
        class="cv-tab tab"
        :class="{ 'cv-tab--active': tab === 'conversation' }"
        type="button"
        @click="emit('pick-tab', 'conversation')"
      >
        {{ t('workspace.tabConversation') }}
      </button>
      <button
        class="cv-tab tab"
        :class="{ 'cv-tab--active': tab === 'diff' }"
        type="button"
        :disabled="!tabs[1]?.enabled"
        :title="tabs[1]?.enabled ? undefined : t('workspace.noBranchYet')"
        @click="emit('pick-tab', 'diff')"
      >
        {{ diffTab.name }}
        <span v-if="diffTab.count" class="cv-tab-count">{{ diffTab.count }}</span>
      </button>
      <button
        class="cv-tab tab"
        :class="{ 'cv-tab--active': tab === 'checks' }"
        type="button"
        @click="emit('pick-tab', 'checks')"
      >
        {{ checksTab.name }}
        <!-- The counter is the only part allowed a colour, and only when the
             checks actually failed or the runner broke. -->
        <span v-if="checksTab.count" class="cv-tab-count" :class="checksToneClass">{{
          checksTab.count
        }}</span>
      </button>
    </nav>
  </header>
</template>

<style scoped>
.cv-head {
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-bottom: 0;
  padding: calc(var(--row) / 2) 1rem;
}

.cv-conv-h {
  border-bottom: 0;
}

.cv-title-row {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  min-width: 0;
}

/* The dot is the kit `.status` bullet: the tone colours it, and `info`
   blinks — the machine is the only thing that moves. On an ok/idle/busy
   header it is the ONLY colour on the line. */
.cv-dot {
  flex: none;
}

.cv-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--fg);
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: 0;
  text-transform: none;
}

.cv-actions {
  flex: none;
  align-items: baseline;
}

.cv-btn--resume {
  color: var(--warn);
}

/* Stopping a turn is not destructive: it stays a quiet offer until hovered. */
.cv-btn--interrupt:hover:not(:disabled) {
  border-color: var(--err);
  color: var(--err);
}

.cv-full-title {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--fg-dim);
  overflow-wrap: anywhere;
}

/* One line of meta, one grey: the separators do the work a box used to. */
.cv-sub.chips {
  align-items: baseline;
  gap: 1ch;
  font-size: 12px;
  color: var(--fg-muted);
}

.cv-chip {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cv-sep {
  color: var(--fg-muted);
}

/* Attaching a repo is an ordinary action, not a state: no colour. */
.cv-attach-select {
  font-size: 12px;
  color: var(--fg-dim);
  max-width: 24ch;
}

.cv-attach-btn {
  font-size: 12px;
  color: var(--fg-dim);
  padding: 0 1ch;
}

/* Identity, not a state: the guarantee lives in the tooltip, never in a box. */
.cv-chip--iso {
  cursor: help;
}

/* The phrase takes the tone ONLY when a human is waited on or something
   failed; every other state leaves the dot as the single colour. */
.cv-phrase {
  color: var(--fg-muted);
}

.cv-phrase[data-tone='warn'],
.cv-phrase[data-tone='err'] {
  color: var(--tone);
}

.cv-chip--chrono {
  font-variant-numeric: tabular-nums;
}

.cv-prompt-toggle {
  font: inherit;
  font-size: 12px;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  color: var(--fg-muted);
}

.cv-prompt-toggle:hover {
  color: var(--fg-dim);
}

.cv-notice {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--warn);
}

/* The refusal's own sentence: a real state, so it keeps its amber — the
   phrase above names it, this one says what to do about it. */
.cv-reason {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 12px;
  color: var(--warn);
  overflow-wrap: anywhere;
}

.cv-error {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--err);
  overflow-wrap: anywhere;
}

.cv-tabs {
  padding: 0 1ch;
}

.cv-tab {
  font: inherit;
  color: var(--fg-dim);
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}

.cv-tab:hover:not(:disabled) {
  color: var(--fg);
}

/* The active tab is the one chosen, not the one passing: accent, not green. */
.cv-tab--active {
  color: var(--fg);
  font-weight: 700;
  border-bottom-color: var(--accent);
}

.cv-tab:disabled {
  cursor: default;
  color: var(--fg-muted);
}

/* A count is never a state: it stays the quietest grey, whichever tab is up
   (doubled specificity so --active does not pull it back to --fg). */
.cv-tab .cv-tab-count {
  font-weight: 400;
  color: var(--fg-muted);
}

/* …the one exception being a failure, which is a state the reader must act
   on: a broken runner is amber, failed checks are red. */
.cv-tab .cv-tab-count.cv-tab--checks-fail {
  color: var(--err);
}

.cv-tab .cv-tab-count.cv-tab--checks-warn {
  color: var(--warn);
}
</style>
