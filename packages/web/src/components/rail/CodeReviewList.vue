<script setup lang="ts">
// Zone 2c of the 3-zone workspace layout: the "Code review" category's list,
// sister of ConversationsList.vue/RepositoriesList.vue for header/search/
// empty-state anatomy, and of BranchTable.vue for the controlled rows/
// visibleRows/query/expanded contract — this component builds and filters
// nothing itself (useCodeReview.ts owns that), it only renders what it is
// given and reports intent through emits.
import { ChevronDown, GitBranch, Search, X } from '@lucide/vue'
import { computed, ref } from 'vue'
import {
  codeReviewRowKey,
  isCodeReviewRowRunning,
  type CodeReviewRow,
} from '../../composables/useCodeReview'
import { t, type MessageKey } from '../../i18n'
import { formatRelativeAge } from '../../relative-time'
import type { ForgeMr, MrReviewMode, MrReviewStatus, ReviewArchiveSummary } from '../../types'
import { searchRightPadding } from '../conversations/ConversationsLogic'

const props = defineProps<{
  rows: readonly CodeReviewRow[]
  /** Rows after the header's own search; `rows` is the unfiltered corpus. */
  visibleRows: readonly CodeReviewRow[]
  query: string
  expanded: ReadonlySet<string>
  /** The globally running review, if any (null = not fetched yet). Compared
   * per row via isCodeReviewRowRunning: never baked into a row itself, since
   * MrReviewStatus changes on every poll and a row must stay a stable value. */
  running: MrReviewStatus | null
  /** Archived history per row key (codeReviewRowKey), fetched lazily by the
   * parent on expand. A key absent from both this and `historyErrors` reads
   * as "not requested yet", distinct from a requested-and-empty history. */
  history: ReadonlyMap<string, readonly ReviewArchiveSummary[]>
  historyErrors: ReadonlyMap<string, string>
  selectedKey: string | null
}>()

const emit = defineEmits<{
  'update:query': [value: string]
  select: [row: CodeReviewRow]
  'toggle-expanded': [key: string]
  'open-archive': [row: CodeReviewRow, ref: string]
}>()

const searchInput = ref<HTMLInputElement | null>(null)

/** Exposed for the shell's ⌘K, which focuses whichever list is up
 * rather than a search box of its own. */
defineExpose({ focusSearch: () => searchInput.value?.focus() })

const searchPaddingRight = computed(() => searchRightPadding(props.query !== '' ? 1 : 0))

function onQueryInput(event: Event): void {
  emit('update:query', (event.target as HTMLInputElement).value)
}

const isEmpty = computed(() => props.rows.length === 0)
const isSearchEmpty = computed(() => props.rows.length > 0 && props.visibleRows.length === 0)

// ── MR pastille: the exact state → color table BranchTable.vue also owns ───

type MrVariant = 'open' | 'draft' | 'merged' | 'closed'

const MR_VARIANT_LABEL_KEYS: Record<MrVariant, MessageKey> = {
  open: 'mrs.card.stateOpen',
  draft: 'mrs.card.stateDraft',
  merged: 'mrs.card.stateMerged',
  closed: 'mrs.card.stateClosed',
}

function mrVariant(mr: ForgeMr): MrVariant | null {
  if (mr.state === null) {
    return null
  }
  if (mr.state === 'open' && mr.isDraft === true) {
    return 'draft'
  }
  if (mr.state === 'open') {
    return 'open'
  }
  return mr.state === 'merged' ? 'merged' : 'closed'
}

// ── Verdict/mode vocabulary, exactly ReviewTargetPanel.vue's own tables ────

/** A Record over the union rather than an interpolated key: `t` takes a bare
 * string, so a fourth verdict would render its own key on screen instead of
 * failing to compile. */
const VERDICT_KEYS: Record<ReviewArchiveSummary['verdict'], MessageKey> = {
  approve: 'verdict.approve',
  request_changes: 'verdict.request_changes',
  comment: 'verdict.comment',
}

const modeLabel = (mode: MrReviewMode): string =>
  mode === 'dual' ? t('codeReview.modeDual') : t('codeReview.modeSimple')

// ── Row view model: derived display data, computed once per render ────────

function panelId(key: string): string {
  return `crl-panel-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

type RowEntry = {
  row: CodeReviewRow
  key: string
  panelId: string
  targetLabel: string
  mrVariant: MrVariant | null
  mrNumber: string | null
  mrStateLabel: string | null
}

function toEntry(row: CodeReviewRow): RowEntry {
  const key = codeReviewRowKey(row)
  const number = row.kind === 'mr' ? t('mrs.number', { n: row.mr.number }) : null
  const variant = row.kind === 'mr' ? mrVariant(row.mr) : null
  return {
    row,
    key,
    panelId: panelId(key),
    targetLabel: row.kind === 'mr' ? (number ?? '') : row.branch.name,
    mrVariant: variant,
    mrNumber: number,
    mrStateLabel: variant ? t(MR_VARIANT_LABEL_KEYS[variant]) : null,
  }
}

const entries = computed<RowEntry[]>(() => props.visibleRows.map(toEntry))

function isExpanded(key: string): boolean {
  return props.expanded.has(key)
}

function isSelected(key: string): boolean {
  return props.selectedKey === key
}

function isRunning(row: CodeReviewRow): boolean {
  return props.running !== null && isCodeReviewRowRunning(row, props.running)
}

function historyOf(key: string): readonly ReviewArchiveSummary[] | null {
  return props.history.get(key) ?? null
}

function historyErrorOf(key: string): string | null {
  return props.historyErrors.get(key) ?? null
}
</script>

<template>
  <section class="crl-root" :aria-label="t('codeReview.title')">
    <header class="crl-header">
      <div class="crl-heading">
        <h2 class="crl-title">{{ t('codeReview.title') }}</h2>
        <span class="crl-count">{{ rows.length }}</span>
      </div>
    </header>

    <div class="crl-search">
      <Search class="crl-search-icon" aria-hidden="true" />
      <input
        ref="searchInput"
        :value="query"
        type="text"
        class="crl-search-input"
        :style="{ paddingRight: `${searchPaddingRight}px` }"
        :placeholder="t('codeReview.searchPlaceholder')"
        :aria-label="t('codeReview.searchPlaceholder')"
        @input="onQueryInput"
      />
      <button
        v-if="query !== ''"
        type="button"
        class="crl-search-clear"
        :aria-label="t('conversations.searchClear')"
        @click="emit('update:query', '')"
      >
        <X aria-hidden="true" />
      </button>
    </div>

    <div class="crl-scroll">
      <p v-if="isEmpty" class="crl-empty">{{ t('codeReview.empty') }}</p>
      <p v-else-if="isSearchEmpty" class="crl-empty">{{ t('codeReview.searchEmpty') }}</p>

      <div v-for="entry in entries" :key="entry.key" class="crl-row-wrap">
        <div class="crl-row">
          <button
            type="button"
            class="crl-chevron-btn"
            :aria-expanded="isExpanded(entry.key)"
            :aria-controls="entry.panelId"
            :aria-label="
              t(isExpanded(entry.key) ? 'codeReview.collapseAria' : 'codeReview.expandAria', {
                target: entry.targetLabel,
              })
            "
            @click="emit('toggle-expanded', entry.key)"
          >
            <ChevronDown
              class="crl-chevron-icon"
              :class="{ 'crl-chevron-icon--closed': !isExpanded(entry.key) }"
              aria-hidden="true"
            />
          </button>

          <button
            type="button"
            class="crl-select-btn"
            :class="{ 'crl-select-btn--selected': isSelected(entry.key) }"
            :aria-current="isSelected(entry.key) ? 'true' : undefined"
            @click="emit('select', entry.row)"
          >
            <span class="crl-main">
              <span v-if="entry.row.kind === 'mr'" class="crl-mr-head">
                <span
                  v-if="entry.mrVariant"
                  class="crl-mr-pastille"
                  :class="`crl-mr-pastille--${entry.mrVariant}`"
                >
                  <span class="crl-mr-number">{{ entry.mrNumber }}</span>
                  <span class="crl-mr-state-text">{{ entry.mrStateLabel }}</span>
                </span>
                <span class="crl-mr-title">{{ entry.row.mr.title }}</span>
              </span>
              <span v-else class="crl-branch-head">
                <GitBranch class="crl-branch-icon" aria-hidden="true" />
                <span class="crl-branch-name">{{ entry.row.branch.name }}</span>
              </span>

              <span class="crl-meta">
                <span class="crl-project-tag">{{ entry.row.projectName }}</span>

                <span v-if="isRunning(entry.row)" class="crl-badge crl-badge--running">
                  {{ t('codeReview.running') }}
                </span>
                <template v-else-if="entry.row.lastReview">
                  <span class="crl-verdict" :class="`crl-verdict--${entry.row.lastReview.verdict}`">
                    {{ t(VERDICT_KEYS[entry.row.lastReview.verdict]) }}
                  </span>
                  <span class="crl-age">{{
                    formatRelativeAge(entry.row.lastReview.created_at)
                  }}</span>
                </template>
                <span v-else class="crl-never" :title="t('codeReview.neverReviewed')">–</span>
              </span>
            </span>
          </button>
        </div>

        <div v-if="isExpanded(entry.key)" :id="entry.panelId" class="crl-panel">
          <h3 class="crl-panel-title">{{ t('codeReview.historyTitle') }}</h3>
          <p v-if="historyErrorOf(entry.key)" class="crl-history-error" role="alert">
            {{ t('codeReview.historyError') }}
          </p>
          <p v-else-if="historyOf(entry.key) === null" class="crl-history-hint">
            {{ t('codeReview.historyLoading') }}
          </p>
          <p v-else-if="historyOf(entry.key)?.length === 0" class="crl-history-hint">
            {{ t('codeReview.historyEmpty') }}
          </p>
          <ul v-else class="crl-history-list">
            <li v-for="record in historyOf(entry.key)" :key="record.ref">
              <button
                type="button"
                class="crl-history-item"
                @click="emit('open-archive', entry.row, record.ref)"
              >
                <span class="crl-verdict" :class="`crl-verdict--${record.verdict}`">
                  {{ t(VERDICT_KEYS[record.verdict]) }}
                </span>
                <span class="crl-history-age">{{ formatRelativeAge(record.created_at) }}</span>
                <span class="crl-history-mode">{{ modeLabel(record.mode) }}</span>
                <span class="crl-history-findings">
                  {{
                    t(
                      'workspace.findingsCount',
                      { n: record.findings_total },
                      record.findings_total,
                    )
                  }}
                </span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Same swappable-slot doctrine as ConversationsList.vue/RepositoriesList.vue:
   no own width, the parent's rail slot gives this 100%. Same card treatment
   so all three read as one family when toggled. */
.crl-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  border-radius: 16px;
  border: 1px solid var(--cs-line-2);
  background: var(--cs-panel);
  box-shadow: var(--cs-shadow-panel);
  overflow: hidden;
}

.crl-header {
  flex: none;
  height: 40px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--cs-line);
}

.crl-heading {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.crl-title {
  min-width: 0;
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--cs-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crl-count {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--cs-ghost);
}

.crl-search {
  flex: none;
  position: relative;
  padding: 8px 12px;
}

.crl-search-icon {
  position: absolute;
  left: 19px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  color: var(--cs-ghost);
  pointer-events: none;
}

.crl-search-input {
  width: 100%;
  font-family: inherit;
  font-size: 13px;
  padding: 7px 0 7px 28px;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  background: var(--cs-inset);
  color: var(--cs-text);
}

.crl-search-input:focus-visible {
  outline: none;
  border-color: var(--cs-green-ring);
}

.crl-search-clear {
  position: absolute;
  right: 20px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--cs-ghost);
  cursor: pointer;
  padding: 0;
}

.crl-search-clear svg {
  width: 100%;
  height: 100%;
}

.crl-search-clear:hover {
  color: var(--cs-text-2);
}

.crl-search-clear:focus-visible {
  outline: 2px solid var(--cs-focus-ring);
  outline-offset: 1px;
}

.crl-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 8px;
}

.crl-empty {
  margin: 0;
  padding: 10px 6px;
  font-size: 12px;
  color: var(--cs-ghost);
}

.crl-row-wrap {
  margin-top: 4px;
}

.crl-row {
  display: flex;
  align-items: stretch;
  gap: 2px;
}

.crl-chevron-btn {
  flex: none;
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--cs-ghost);
  cursor: pointer;
  padding: 0;
}

.crl-chevron-btn:hover {
  background: var(--cs-hover);
  color: var(--cs-text-2);
}

.crl-chevron-btn:focus-visible {
  outline: 2px solid var(--cs-focus-ring);
  outline-offset: 1px;
}

.crl-chevron-icon {
  width: 14px;
  height: 14px;
  transition: transform var(--cs-duration-fast) var(--cs-ease-out);
}

.crl-chevron-icon--closed {
  transform: rotate(-90deg);
}

.crl-select-btn {
  flex: 1;
  min-width: 0;
  text-align: left;
  font-family: inherit;
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--cs-text-2);
  cursor: pointer;
}

.crl-select-btn:hover:not(.crl-select-btn--selected) {
  background: var(--cs-hover);
}

.crl-select-btn:focus-visible {
  outline: 2px solid var(--cs-focus-ring);
  outline-offset: -2px;
}

/* Selection is a tinted fill, the same green-soft convention every other
   "currently open" row in this workspace uses (ConversationsList, RepositoriesList). */
.crl-select-btn--selected {
  background: var(--cs-green-soft);
  color: var(--cs-text);
}

.crl-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.crl-mr-head {
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.crl-mr-pastille {
  flex: none;
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  font-size: 12px;
  font-weight: 700;
}

.crl-mr-number {
  font-family: var(--font-mono);
}

.crl-mr-state-text {
  font-size: 10px;
  font-weight: 500;
  color: var(--cs-muted);
}

.crl-mr-pastille--open {
  color: var(--cs-amber-text);
}

.crl-mr-pastille--draft {
  color: var(--cs-ghost);
}

.crl-mr-pastille--merged {
  color: var(--cs-green-text);
}

.crl-mr-pastille--closed {
  color: var(--cs-red-text);
}

.crl-mr-title {
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--cs-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.crl-branch-head {
  display: flex;
  align-items: center;
  gap: 7px;
}

.crl-branch-icon {
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--cs-ghost);
}

.crl-branch-name {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--cs-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crl-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}

.crl-project-tag {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--cs-line-2);
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--cs-muted);
  background: color-mix(in srgb, var(--cs-surface-2) 60%, transparent);
  white-space: nowrap;
}

.crl-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}

/* Plain amber, never the strong amber reserved for "the human is waited on":
   an agent is at work here, nothing is asked of the reader. */
.crl-badge--running {
  background: var(--cs-inset);
  color: var(--cs-amber);
}

.crl-verdict {
  flex: none;
  font-weight: 600;
  white-space: nowrap;
}

.crl-verdict--approve {
  color: var(--cs-green-text);
}

.crl-verdict--request_changes {
  color: var(--cs-red-text);
}

.crl-verdict--comment {
  color: var(--cs-text-2);
}

.crl-age {
  flex: none;
  color: var(--cs-muted);
  white-space: nowrap;
}

/* Never reviewed: a neutral dash, never a fabricated status color. */
.crl-never {
  flex: none;
  color: var(--cs-ghost);
  cursor: help;
}

.crl-panel {
  margin: 2px 0 4px 30px;
  padding: 8px 10px;
  border: 1px solid var(--cs-line);
  border-radius: 8px;
  background: var(--cs-surface);
}

.crl-panel-title {
  margin: 0 0 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--cs-muted);
}

.crl-history-hint {
  margin: 0;
  font-size: 12px;
  color: var(--cs-muted);
}

.crl-history-error {
  margin: 0;
  font-size: 12px;
  color: var(--cs-red-text);
}

.crl-history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.crl-history-item {
  width: 100%;
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 5px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--cs-text-2);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.crl-history-item:hover {
  background: var(--cs-hover);
}

.crl-history-item:focus-visible {
  outline: 2px solid var(--cs-focus-ring);
  outline-offset: -2px;
}

.crl-history-age,
.crl-history-mode,
.crl-history-findings {
  color: var(--cs-muted);
}
</style>
