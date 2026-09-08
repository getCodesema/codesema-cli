<script setup lang="ts">
// The changes panel (fiche 14): the merge-request side panel attached to a
// conversation. Draws the envelope (resizable, right-docked card) and both
// tab rows; the PR header and the file list are its own content below them
// (fiche §1's own correction: two tab rows in real usage, not three, a
// third would only exist for switching between SEVERAL linked pull
// requests, a feature this app's data model does not have: TaskRecord
// carries no merge-request field at all, see §8.3. Row 1 here is built as a
// real, if currently single-item, tab strip rather than hand-waved, so nothing
// needs restructuring the day a conversation can carry more than one).
//
// This component receives its merge request as a prop, already resolved by
// the caller (today: matched by branch name against TaskRecord.branch, see
// composables/useProjects.ts's buildProjectTree). It does not look one up
// itself, and renders an honest empty state when there is none.
import {
  Check,
  CircleCheck,
  CircleDot,
  CircleSlash,
  CircleX,
  Copy,
  ExternalLink,
  GitPullRequest,
  ListChecks,
  LoaderCircle,
  RefreshCw,
} from '@lucide/vue'
import { computed, onMounted, onUnmounted, ref, watch, type Component } from 'vue'
import { useChangedFiles } from '../../composables/useChangedFiles'
import { G } from '../../glyphs'
import { t, type MessageKey } from '../../i18n'
import { formatRelativeAge } from '../../relative-time'
import type { ForgeMr } from '../../types'
import type { CheckAggregateStatus } from '../mr/Checks'
import ChangedFileList from './ChangedFileList.vue'
import ChangesEmptyTab from './ChangesEmptyTab.vue'
import {
  CHANGES_PANEL_WIDTH_DEFAULT,
  CHANGES_PANEL_WIDTH_MIN,
  checksTabIndicator,
  forgeNameFromUrl,
  maxChangesPanelWidth,
  mrStateVariant,
  widthAfterDrag,
  widthAfterKey,
  type MrStateVariant,
} from './ChangesLogic'
import { readChangesPrefs, writeChangesPrefs } from './ChangesPrefs'

const props = defineProps<{
  mr: ForgeMr | null
  /** Registry id scoping the file fetch to a registered repo, same contract
   * as PreviewPanel.vue's own `project` prop (absent = the launch cwd). */
  project?: string
}>()

const emit = defineEmits<{ close: [] }>()

// ── Width: resizable, persisted, bounded by "the window minus a reserve" ───

const isClient = typeof window !== 'undefined'

const width = ref(isClient ? readChangesPrefs().width : CHANGES_PANEL_WIDTH_DEFAULT)
const viewportWidth = ref(isClient ? window.innerWidth : 1280)
const maxWidth = computed(() => maxChangesPanelWidth(viewportWidth.value))
const bounds = computed(() => ({
  min: CHANGES_PANEL_WIDTH_MIN,
  max: maxWidth.value,
  defaultWidth: CHANGES_PANEL_WIDTH_DEFAULT,
}))

// The reserve is evaluated against the CURRENT viewport, so a window shrunk
// after the width was persisted must still bring the panel back in bounds.
watch(maxWidth, (max) => {
  if (width.value > max) {
    width.value = max
  }
})

function persistWidth(): void {
  writeChangesPrefs({ width: width.value })
}

function onWindowResize(): void {
  viewportWidth.value = window.innerWidth
}

onMounted(() => {
  if (isClient) {
    window.addEventListener('resize', onWindowResize)
  }
})

onUnmounted(() => {
  if (isClient) {
    window.removeEventListener('resize', onWindowResize)
  }
})

const dragging = ref(false)
let dragStartX = 0
let dragStartWidth = 0

function onHandlePointerDown(event: PointerEvent): void {
  dragging.value = true
  dragStartX = event.clientX
  dragStartWidth = width.value
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onHandlePointerMove(event: PointerEvent): void {
  if (!dragging.value) {
    return
  }
  width.value = widthAfterDrag(
    dragStartWidth,
    event.clientX - dragStartX,
    bounds.value.min,
    bounds.value.max,
  )
}

function onHandlePointerUp(event: PointerEvent): void {
  if (!dragging.value) {
    return
  }
  dragging.value = false
  ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
  persistWidth()
}

function onHandleKeydown(event: KeyboardEvent): void {
  const next = widthAfterKey(event.key, width.value, bounds.value, event.shiftKey)
  if (next === null) {
    return
  }
  event.preventDefault()
  width.value = next
  persistWidth()
}

// ── The file list's data (fetched here, handed down as a controlled prop) ──

const filesStore = useChangedFiles()

watch(
  () => [props.mr?.number, props.project] as const,
  ([mrNumber, project]) => {
    if (mrNumber !== undefined) {
      filesStore.load(mrNumber, project)
    }
  },
  { immediate: true },
)

// Switching to a different MR starts back on the files section: staying on
// "checks" from a previous MR would show the new one's indicator under a
// tab the reader did not choose for it.
watch(
  () => props.mr?.number,
  () => {
    activeSection.value = 'files'
  },
)

// ── Row 2: Files / Checks sections ──────────────────────────────────────────

type Section = 'files' | 'checks'
const activeSection = ref<Section>('files')

const filesTabLabel = computed(() => {
  const n = props.mr?.changedFiles ?? null
  return n === null ? t('changes.tabs.files') : t('changes.tabs.filesCount', { n }, n)
})

const checksIndicator = computed(() => checksTabIndicator(props.mr?.checks ?? null))

const CHECKS_ICON: Record<CheckAggregateStatus, Component> = {
  passed: CircleCheck,
  failed: CircleX,
  pending: LoaderCircle,
  skipped: CircleSlash,
  unknown: CircleDot,
}

const checksTabIcon = computed(() =>
  checksIndicator.value ? CHECKS_ICON[checksIndicator.value.status] : null,
)

const AGGREGATE_LABEL_KEYS: Record<CheckAggregateStatus, MessageKey> = {
  passed: 'mrs.checks.aggregatePassed',
  failed: 'mrs.checks.aggregateFailed',
  pending: 'mrs.checks.aggregatePending',
  skipped: 'mrs.checks.aggregateSkipped',
  unknown: 'mrs.checks.aggregateUnknown',
}

const checksTabCounter = computed(() => {
  const indicator = checksIndicator.value
  if (indicator === null) {
    return null
  }
  return indicator.kind === 'fraction'
    ? t('changes.tabs.checksFraction', { passed: indicator.passed, total: indicator.total })
    : t(AGGREGATE_LABEL_KEYS[indicator.status])
})

// ── The PR header (fiche §4) ────────────────────────────────────────────────

const mrState = computed<MrStateVariant | null>(() => (props.mr ? mrStateVariant(props.mr) : null))

const MR_STATE_LABEL_KEYS: Record<MrStateVariant, MessageKey> = {
  open: 'mrs.card.stateOpen',
  draft: 'mrs.card.stateDraft',
  merged: 'mrs.card.stateMerged',
  closed: 'mrs.card.stateClosed',
}

const forgeName = computed(() => (props.mr ? forgeNameFromUrl(props.mr.url) : ''))
const age = computed(() => (props.mr ? formatRelativeAge(props.mr.updatedAt) : ''))

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copySourceBranch(): Promise<void> {
  if (!props.mr) {
    return
  }
  try {
    await navigator.clipboard.writeText(props.mr.sourceBranch)
    copied.value = true
    if (copiedTimer) {
      clearTimeout(copiedTimer)
    }
    copiedTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    // clipboard unavailable: no feedback, same as ReviewFocusMode.vue/ReviewShell.vue
  }
}

onUnmounted(() => {
  if (copiedTimer) {
    clearTimeout(copiedTimer)
  }
})

function refreshFiles(): void {
  if (props.mr) {
    filesStore.reload(props.mr.number, props.project)
  }
}
</script>

<template>
  <div class="cp-root" :style="{ width: `${width}px` }">
    <div
      class="cp-handle"
      :class="{ 'cp-handle--active': dragging }"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      :aria-label="t('changes.resizeAria')"
      :aria-valuenow="Math.round(width)"
      :aria-valuemin="bounds.min"
      :aria-valuemax="bounds.max"
      @pointerdown="onHandlePointerDown"
      @pointermove="onHandlePointerMove"
      @pointerup="onHandlePointerUp"
      @pointercancel="onHandlePointerUp"
      @keydown="onHandleKeydown"
    />

    <div class="cp-body">
      <div class="cp-row1">
        <div class="tabs cp-row1-tabs">
          <button v-if="mr" type="button" class="tab cp-tab1 cp-tab1--active" aria-selected="true">
            <GitPullRequest class="cp-tab1-icon" aria-hidden="true" />
            {{ t('mrs.number', { n: mr.number }) }}
          </button>
        </div>
        <button
          type="button"
          class="btn ghost cp-close"
          :aria-label="t('changes.close')"
          @click="emit('close')"
        >
          <span aria-hidden="true">{{ G.ko }}</span>
        </button>
      </div>

      <template v-if="mr">
        <div class="cp-meta">
          <span v-if="mrState" class="badge cp-badge" :class="`cp-badge--${mrState}`">{{
            t(MR_STATE_LABEL_KEYS[mrState])
          }}</span>
          <span class="cp-forge">{{ forgeName }}</span>
          <span class="cp-branches">
            <button
              type="button"
              class="cp-branch-copy"
              :aria-label="t('changes.copySourceBranch')"
              @click="copySourceBranch"
            >
              <code>{{ mr.sourceBranch }}</code>
              <Check v-if="copied" class="cp-branch-copy-icon" aria-hidden="true" />
              <Copy v-else class="cp-branch-copy-icon" aria-hidden="true" />
            </button>
            <span class="cp-branch-arrow" aria-hidden="true">{{ G.arrow }}</span>
            <code class="cp-branch-target" :title="mr.targetBranch">{{ mr.targetBranch }}</code>
          </span>
          <span class="cp-meta-actions">
            <button
              type="button"
              class="cp-icon-btn"
              :aria-label="t('changes.refresh')"
              @click="refreshFiles"
            >
              <RefreshCw aria-hidden="true" />
            </button>
            <a
              class="cp-icon-btn"
              :href="mr.url"
              target="_blank"
              rel="noopener noreferrer"
              :aria-label="t('changes.openInForge')"
            >
              <ExternalLink aria-hidden="true" />
            </a>
          </span>
        </div>

        <div class="cp-titleblock">
          <h2 class="cp-title">
            {{ mr.title }} <span class="cp-number">{{ t('mrs.number', { n: mr.number }) }}</span>
          </h2>
          <p class="cp-byline">
            <span class="cp-author">{{ mr.author }}</span>
            <span v-if="mr.additions !== null" class="cp-add">+{{ mr.additions }}</span>
            <span v-if="mr.deletions !== null" class="cp-del">−{{ mr.deletions }}</span>
            <span class="cp-age">{{ age }}</span>
          </p>
        </div>

        <div class="tabs cp-row2">
          <button
            type="button"
            class="tab cp-tab2"
            :class="{ 'cp-tab2--active': activeSection === 'files' }"
            :aria-selected="activeSection === 'files'"
            @click="activeSection = 'files'"
          >
            {{ filesTabLabel }}
          </button>
          <button
            type="button"
            class="tab cp-tab2"
            :class="{ 'cp-tab2--active': activeSection === 'checks' }"
            :aria-selected="activeSection === 'checks'"
            @click="activeSection = 'checks'"
          >
            <component
              :is="checksTabIcon"
              v-if="checksTabIcon"
              class="cp-tab2-icon"
              aria-hidden="true"
            />
            {{ t('changes.tabs.checks') }}
            <span v-if="checksTabCounter" class="cp-tab2-counter">{{ checksTabCounter }}</span>
          </button>
        </div>

        <div class="cp-section">
          <ChangedFileList
            v-if="activeSection === 'files'"
            :files-state="filesStore.state.value"
            :mr-number="mr.number"
            :project="project"
            @retry="refreshFiles"
          />
          <ChangesEmptyTab v-else :icon="ListChecks" :text="t('changes.checksTab.placeholder')" />
        </div>
      </template>

      <p v-else class="cp-empty">{{ t('changes.noMr') }}</p>
    </div>
  </div>
</template>

<style scoped>
.cp-root {
  flex: none;
  display: flex;
  flex-direction: row;
  align-items: stretch;
  height: 100%;
  min-height: 0;
  /* fiche §2: a card docked to the right edge, no border and nothing after
     it on that side. */
  border: 1px solid var(--line);
  border-right: none;
  background: var(--bg);
  overflow: hidden;
}

.cp-handle {
  flex: none;
  width: 6px;
  position: relative;
  cursor: col-resize;
  background: none;
  touch-action: none;
}

.cp-handle::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 2px;
  background: var(--ok);
  opacity: 0;
  transition: opacity 150ms ease;
}

.cp-handle:hover::after,
.cp-handle--active::after {
  opacity: 1;
}

.cp-body {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ── Row 1: envelope tabs (fiche §3) ───────────────────────────────────── */

.cp-row1 {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1ch;
  padding: 2px 1ch;
  border-bottom: 1px solid var(--line);
}

.cp-row1-tabs {
  border-bottom: none;
  min-width: 0;
}

.cp-tab1 {
  display: inline-flex;
  align-items: center;
  gap: 1ch;
  border: none;
  background: none;
  font: inherit;
  cursor: default;
}

.cp-tab1--active {
  color: var(--ok);
}

.cp-tab1-icon {
  flex: none;
  width: 14px;
  height: 14px;
}

.cp-close {
  flex: none;
}

/* ── PR header (fiche §4) ──────────────────────────────────────────────── */

.cp-meta {
  flex: none;
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: calc(var(--row) / 2) 1ch;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
  color: var(--fg-dim);
}

.cp-badge {
  flex: none;
}

.cp-badge--open {
  color: var(--ok);
}

.cp-badge--draft {
  color: var(--fg-dim);
}

.cp-badge--merged {
  color: var(--alt);
}

.cp-badge--closed {
  color: var(--err);
}

.cp-forge {
  flex: none;
}

.cp-branches {
  display: flex;
  align-items: center;
  gap: 1ch;
  min-width: 0;
  margin-left: auto;
}

.cp-branch-copy {
  display: inline-flex;
  align-items: center;
  gap: 1ch;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.cp-branch-copy:hover {
  color: var(--fg);
}

.cp-branch-copy-icon {
  width: 14px;
  height: 14px;
}

.cp-branch-arrow {
  flex: none;
}

.cp-branch-target {
  max-width: 24ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cp-meta-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 1ch;
}

.cp-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 1ch;
  border: none;
  background: none;
  color: var(--fg-dim);
  text-decoration: none;
  cursor: pointer;
}

.cp-icon-btn:hover {
  color: var(--fg);
}

.cp-icon-btn svg {
  width: 14px;
  height: 14px;
}

.cp-titleblock {
  flex: none;
  padding: calc(var(--row) / 2) 1ch;
}

.cp-title {
  color: var(--fg);
}

.cp-number {
  font-weight: 400;
  color: var(--fg-dim);
}

.cp-byline {
  margin: 2px 0 0;
  display: flex;
  align-items: center;
  gap: 2ch;
  font-size: 12px;
  color: var(--fg-dim);
}

.cp-author {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cp-add {
  color: var(--ok);
}

.cp-del {
  color: var(--err);
}

.cp-age {
  margin-left: auto;
  flex: none;
}

/* ── Row 2: section tabs (fiche §3) ────────────────────────────────────── */

.cp-row2 {
  flex: none;
  align-items: center;
  gap: 1ch;
  padding: 0 1ch;
}

.cp-tab2 {
  display: inline-flex;
  align-items: center;
  gap: 1ch;
  border-top: none;
  border-left: none;
  border-right: none;
  background: none;
  font: inherit;
  cursor: pointer;
}

.cp-tab2-icon {
  flex: none;
  width: 14px;
  height: 14px;
}

/* The checks tab's counter is a fraction, not a bare count: "42/42" and
   "12/42" do not say the same thing (fiche §3). Every other tab's counter
   (files) is attenuated text glued to the label, never a badge. */
.cp-tab2-counter {
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

.cp-section {
  flex: 1 1 auto;
  min-height: 0;
}

/* fiche §7: no pull request, plain centered text, no icon (the one empty
   state in this panel that is not ChangesEmptyTab's shape). */
.cp-empty {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: var(--row) 2ch;
  text-align: center;
  color: var(--fg-dim);
}
</style>
