<script setup lang="ts">
// Dense branches/worktrees table for the repository view: one row per local
// branch plus one per detached-HEAD worktree, an expandable list of the
// conversations attached to each branch, and the toolbar that filters/sorts
// them. Purely presentational: rows arrive already built, filtered and
// sorted (useRepository.ts) — this component only renders `visibleRows` and
// reports user intent through emits, it never re-filters or re-sorts itself.
import { ChevronDown, RefreshCw, Search } from '@lucide/vue'
import { computed } from 'vue'
import {
  BRANCH_SORT_KEYS,
  branchRowKey,
  type BranchRow,
  type BranchSortKey,
} from '../../composables/useRepository'
import { queueSectionOf, type QueueSection } from '../../composables/useTaskBoard'
import { taskKey, type TaskState } from '../../composables/useTasks'
import { EXECUTION_STATUS, type StatusTone } from '../../execution-status'
import { G } from '../../glyphs'
import { t, type MessageKey } from '../../i18n'
import type { ForgeMr, TaskStatus } from '../../types'
import ConversationRow from '../conversations/ConversationRow.vue'

const props = defineProps<{
  rows: readonly BranchRow[]
  /** Rows after the toolbar's own filter; `rows` is the unfiltered corpus. */
  visibleRows: readonly BranchRow[]
  query: string
  sort: BranchSortKey
  expanded: ReadonlySet<string>
  loading: boolean
  /**
   * Display name for each conversation's home project (`state.projectId`).
   * A conversation can attach to a row through a cross-repo attachment, so
   * it may belong to a DIFFERENT project than the one this table renders —
   * the same reason ConversationsColumn/ConversationsList take this exact
   * lookup rather than assuming a single name for every row.
   */
  projectNames: ReadonlyMap<string, string>
}>()

const emit = defineEmits<{
  'update:query': [value: string]
  'update:sort': [value: BranchSortKey]
  refresh: []
  'toggle-expanded': [key: string]
  'open-conversation': [state: TaskState]
  'new-conversation': [row: BranchRow]
}>()

type BranchOnlyRow = Extract<BranchRow, { kind: 'branch' }>

function panelId(key: string): string {
  return `bt-panel-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function isExpanded(row: BranchOnlyRow): boolean {
  return props.expanded.has(branchRowKey(row))
}

// ── MR pastille: the exact state → color table mr/MrCard.vue already owns ──

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

type MrPastille = { variant: MrVariant; number: string; label: string }

function buildMrPastille(mr: ForgeMr): MrPastille | null {
  const variant = mrVariant(mr)
  if (variant === null) {
    return null
  }
  return {
    variant,
    number: t('mrs.number', { n: mr.number }),
    label: t(MR_VARIANT_LABEL_KEYS[variant]),
  }
}

// ── Conversations badge: tinted by the most urgent status it carries ───────

const SECTION_PRIORITY: Record<QueueSection, number> = {
  attention: 0,
  active: 1,
  ready: 2,
  done: 3,
}

function mostUrgentStatus(conversations: readonly TaskState[]): TaskStatus | null {
  let best: TaskStatus | null = null
  for (const { record } of conversations) {
    if (
      best === null ||
      SECTION_PRIORITY[queueSectionOf(record.status)] < SECTION_PRIORITY[queueSectionOf(best)]
    ) {
      best = record.status
    }
  }
  return best
}

// ── Sort control ──────────────────────────────────────────────────────────

/**
 * Each option names what it sorts BY, never the column it looks like: the
 * `updated` sort orders by the most recent conversation activity, while the
 * Updated column shows the last commit's age. Borrowing that column's label
 * here would promise a sort on the number the reader can see.
 */
const SORT_OPTION_LABEL_KEYS: Record<BranchSortKey, MessageKey> = {
  status: 'repository.sortStatus',
  updated: 'repository.sortActivity',
  name: 'repository.sortName',
}

// ── Row view model: derived display data, computed once per render ────────

function resolveOpenTarget(row: BranchOnlyRow): TaskState | null {
  const action = row.action
  if (action.kind !== 'open') {
    return null
  }
  return row.conversations.find((state) => state.record.id === action.taskId) ?? null
}

type RowEntry =
  | {
      kind: 'branch'
      row: BranchOnlyRow
      key: string
      panelId: string
      worktreeLabel: string
      mrPastille: MrPastille | null
      conversationsLabel: string | null
      conversationsTone: StatusTone | null
      actionLabel: string
      actionTarget: TaskState | null
    }
  | {
      kind: 'detached-worktree'
      row: Extract<BranchRow, { kind: 'detached-worktree' }>
      key: string
      worktreeLabel: string
    }

function toRowEntry(row: BranchRow): RowEntry {
  const key = branchRowKey(row)
  if (row.kind === 'detached-worktree') {
    return { kind: 'detached-worktree', row, key, worktreeLabel: t('repository.worktreeDetached') }
  }
  const openTarget = resolveOpenTarget(row)
  const urgent = row.conversations.length > 0 ? mostUrgentStatus(row.conversations) : null
  return {
    kind: 'branch',
    row,
    key,
    panelId: panelId(key),
    worktreeLabel: t(
      row.worktreePath !== null ? 'repository.worktreeLive' : 'repository.worktreeNone',
    ),
    mrPastille: row.openMr ? buildMrPastille(row.openMr) : null,
    conversationsLabel:
      row.conversations.length > 0
        ? t(
            'repository.conversationsCount',
            { n: row.conversations.length },
            row.conversations.length,
          )
        : null,
    conversationsTone: urgent !== null ? EXECUTION_STATUS[urgent].tone : null,
    actionLabel: t(openTarget !== null ? 'repository.rowOpen' : 'repository.rowNewConversation'),
    actionTarget: openTarget,
  }
}

const entries = computed<RowEntry[]>(() => props.visibleRows.map(toRowEntry))

function handleRowAction(entry: Extract<RowEntry, { kind: 'branch' }>): void {
  if (entry.actionTarget !== null) {
    emit('open-conversation', entry.actionTarget)
    return
  }
  emit('new-conversation', entry.row)
}

function resolveProjectName(state: TaskState): string {
  return props.projectNames.get(state.projectId) ?? state.projectId
}

function onFilterInput(event: Event): void {
  emit('update:query', (event.target as HTMLInputElement).value)
}

function onSortChange(event: Event): void {
  emit('update:sort', (event.target as HTMLSelectElement).value as BranchSortKey)
}
</script>

<template>
  <div class="bt-root">
    <div class="bt-header">
      <h2 class="bt-title">
        {{ t('repository.tabBranches') }} <span class="bt-title-count">({{ rows.length }})</span>
      </h2>
    </div>

    <div class="bt-toolbar">
      <div class="bt-filter">
        <Search class="bt-filter-icon" aria-hidden="true" />
        <input
          :value="query"
          type="text"
          class="bt-filter-input"
          :placeholder="t('repository.filterPlaceholder')"
          :aria-label="t('repository.filterPlaceholder')"
          @input="onFilterInput"
        />
      </div>
      <span class="bt-row-count badge">{{ visibleRows.length }}</span>
      <label class="bt-sort">
        <span class="bt-sort-label">{{ t('repository.sortLabel') }}</span>
        <select class="bt-sort-select" :value="sort" @change="onSortChange">
          <option v-for="key in BRANCH_SORT_KEYS" :key="key" :value="key">
            {{ t(SORT_OPTION_LABEL_KEYS[key]) }}
          </option>
        </select>
      </label>
      <button
        type="button"
        class="bt-refresh btn"
        :class="{ 'bt-refresh--spin': loading }"
        :disabled="loading"
        @click="emit('refresh')"
      >
        <RefreshCw class="bt-refresh-icon" aria-hidden="true" />
        <span>{{ t('repository.refresh') }}</span>
      </button>
    </div>

    <div class="bt-scroll">
      <table class="bt-table">
        <thead>
          <tr>
            <th class="bt-th bt-th-chevron"></th>
            <th class="bt-th">{{ t('repository.colWorktree') }}</th>
            <th class="bt-th">{{ t('repository.colBranch') }}</th>
            <th class="bt-th">{{ t('repository.colMr') }}</th>
            <th class="bt-th">{{ t('repository.colConversations') }}</th>
            <th class="bt-th">{{ t('repository.colUpdated') }}</th>
            <th class="bt-th bt-th-actions">{{ t('repository.colActions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="rows.length === 0">
            <td class="bt-empty" colspan="7">
              <span class="empty">{{ t('repository.noBranches') }}</span>
            </td>
          </tr>
          <tr v-else-if="visibleRows.length === 0">
            <td class="bt-empty" colspan="7">
              <span class="empty">{{ t('repository.filterEmpty') }}</span>
            </td>
          </tr>
          <template v-for="entry in entries" :key="entry.key">
            <tr class="bt-row">
              <td class="bt-cell bt-cell-chevron">
                <button
                  v-if="entry.kind === 'branch'"
                  type="button"
                  class="bt-chevron-btn"
                  :aria-expanded="isExpanded(entry.row)"
                  :aria-controls="entry.panelId"
                  :aria-label="
                    t(
                      isExpanded(entry.row)
                        ? 'repository.rowCollapseAria'
                        : 'repository.rowExpandAria',
                      { branch: entry.row.name },
                    )
                  "
                  @click="emit('toggle-expanded', entry.key)"
                >
                  <ChevronDown
                    class="bt-chevron-icon"
                    :class="{ 'bt-chevron-icon--closed': !isExpanded(entry.row) }"
                    aria-hidden="true"
                  />
                </button>
              </td>
              <td class="bt-cell">
                <span class="bt-pill badge">{{ entry.worktreeLabel }}</span>
              </td>
              <td class="bt-cell bt-cell-branch">
                <template v-if="entry.kind === 'branch'">
                  <div class="bt-branch-name">
                    <span class="bt-branch-mono">{{ entry.row.name }}</span>
                    <span v-if="entry.row.isCurrent" class="bt-current-badge badge">
                      {{ t('repository.branchCurrent') }}
                    </span>
                  </div>
                  <p class="bt-branch-subject">{{ entry.row.subject }}</p>
                </template>
                <span v-else class="bt-branch-mono bt-branch-mono--detached">{{
                  entry.row.worktreePath
                }}</span>
              </td>
              <td class="bt-cell">
                <span
                  v-if="entry.kind === 'branch' && entry.mrPastille"
                  class="bt-mr-pastille badge"
                  :class="`bt-mr-pastille--${entry.mrPastille.variant}`"
                >
                  <span class="bt-mr-number">{{ entry.mrPastille.number }}</span>
                  <span class="bt-mr-state-text">{{ entry.mrPastille.label }}</span>
                </span>
              </td>
              <td class="bt-cell">
                <span
                  v-if="entry.kind === 'branch' && entry.conversationsLabel"
                  class="bt-conversations-badge status"
                  :data-tone="entry.conversationsTone ?? undefined"
                >
                  {{ entry.conversationsLabel }}
                </span>
              </td>
              <td class="bt-cell bt-cell-age">
                {{ entry.kind === 'branch' ? entry.row.lastCommitRelative : G.minus }}
              </td>
              <td class="bt-cell bt-cell-actions">
                <span
                  v-if="entry.kind === 'detached-worktree'"
                  class="bt-detached-hint"
                  :title="t('repository.detachedHint')"
                >
                  {{ t('repository.detachedHint') }}
                </span>
                <button
                  v-else-if="entry.kind === 'branch'"
                  type="button"
                  class="bt-action-btn btn"
                  @click="handleRowAction(entry)"
                >
                  {{ entry.actionLabel }}
                </button>
              </td>
            </tr>
            <template v-if="entry.kind === 'branch'">
              <tr v-if="isExpanded(entry.row)" class="bt-expanded-row">
                <td :id="entry.panelId" class="bt-expanded-cell" colspan="7">
                  <p v-if="entry.row.conversations.length === 0" class="bt-expanded-empty">
                    {{ t('repository.noConversationsOnBranch') }}
                  </p>
                  <div v-else class="bt-expanded-list">
                    <button
                      v-for="state in entry.row.conversations"
                      :key="taskKey(state.projectId, state.record.id)"
                      type="button"
                      class="bt-conversation-btn"
                      @click="emit('open-conversation', state)"
                    >
                      <ConversationRow
                        :state="state"
                        :project-name="resolveProjectName(state)"
                        :selected="false"
                      />
                    </button>
                  </div>
                  <button
                    type="button"
                    class="bt-expanded-create btn"
                    @click="emit('new-conversation', entry.row)"
                  >
                    {{ t('repository.rowNewConversation') }}
                  </button>
                </td>
              </tr>
            </template>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.bt-root {
  display: flex;
  flex-direction: column;
  gap: var(--row);
}

.bt-header {
  display: flex;
  align-items: baseline;
}

.bt-title {
  font-size: 18px;
  color: var(--fg);
}

.bt-title-count {
  font-weight: 400;
  color: var(--fg-dim);
}

.bt-toolbar {
  display: flex;
  align-items: center;
  gap: 1ch;
}

.bt-filter {
  flex: 1;
  min-width: 24ch;
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: 0 1ch;
  border: 1px solid var(--line);
  background: var(--bg-raised);
}

.bt-filter:focus-within {
  border-color: var(--accent);
}

.bt-filter-icon {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--fg-dim);
}

.bt-filter-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  padding: 2px 0;
}

.bt-row-count {
  flex: none;
  font-variant-numeric: tabular-nums;
}

.bt-sort {
  flex: none;
  display: flex;
  align-items: center;
  gap: 1ch;
  color: var(--fg-dim);
}

.bt-sort-select {
  min-width: 0;
}

.bt-refresh {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 1ch;
  color: var(--fg-dim);
}

.bt-refresh-icon {
  width: 14px;
  height: 14px;
}

/* Loading is a colour, never a spin: the whole package carries one motion
   vocabulary and rotation is not part of it. */
.bt-refresh--spin {
  color: var(--info);
}

.bt-scroll {
  overflow-x: auto;
  border: 1px solid var(--line);
}

.bt-table {
  width: 100%;
}

.bt-th {
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.bt-th-chevron {
  width: 4ch;
}

.bt-th-actions {
  text-align: right;
}

.bt-cell {
  vertical-align: top;
  color: var(--fg-dim);
  white-space: normal;
}

.bt-cell-chevron {
  width: 4ch;
}

.bt-cell-actions {
  text-align: right;
}

.bt-cell-age {
  white-space: nowrap;
}

.bt-chevron-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--fg-dim);
  cursor: pointer;
  padding: 0;
}

.bt-chevron-icon {
  width: 14px;
  height: 14px;
  transition: transform 150ms ease;
}

.bt-chevron-icon--closed {
  transform: rotate(-90deg);
}

.bt-branch-name {
  display: flex;
  align-items: baseline;
  gap: 1ch;
}

.bt-branch-mono {
  color: var(--fg);
}

.bt-branch-mono--detached {
  color: var(--fg-dim);
}

.bt-branch-subject {
  max-width: 48ch;
  font-size: 12px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bt-mr-pastille {
  display: inline-flex;
  align-items: baseline;
  gap: 1ch;
  white-space: nowrap;
}

.bt-mr-state-text {
  color: var(--fg-dim);
}

.bt-mr-pastille--open {
  color: var(--warn);
}

.bt-mr-pastille--draft {
  color: var(--fg-muted);
}

.bt-mr-pastille--merged {
  color: var(--ok);
}

.bt-mr-pastille--closed {
  color: var(--err);
}

.bt-conversations-badge {
  white-space: nowrap;
}

.bt-action-btn {
  white-space: nowrap;
}

.bt-detached-hint {
  color: var(--fg-dim);
  cursor: help;
}

.bt-empty {
  padding: var(--row) 2ch;
  text-align: center;
}

.bt-empty .empty {
  display: block;
}

.bt-expanded-cell {
  padding: calc(var(--row) / 2) 1ch calc(var(--row) / 2) 4ch;
  white-space: normal;
}

.bt-expanded-empty {
  margin-bottom: calc(var(--row) / 2);
  color: var(--fg-dim);
}

.bt-expanded-list {
  display: flex;
  flex-direction: column;
  margin-bottom: calc(var(--row) / 2);
}

.bt-conversation-btn {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
  padding: 0;
  text-align: left;
  font: inherit;
  cursor: pointer;
}

.bt-conversation-btn:hover {
  background: var(--bg-hover);
}
</style>
