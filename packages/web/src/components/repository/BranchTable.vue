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
import { EXECUTION_STATUS } from '../../execution-status'
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

// ── Sort control: option labels reuse the matching column header ──────────

/**
 * `repository.sortStatus` does not exist yet (flagged in the handoff
 * report): the cast is a placeholder confined to this one entry so the other
 * two real keys stay strictly typed. `t()` falls back to the raw key at
 * runtime rather than throwing, so this degrades safely until the key lands.
 */
const SORT_OPTION_LABEL_KEYS: Record<BranchSortKey, MessageKey> = {
  status: 'repository.sortStatus' as MessageKey,
  updated: 'repository.colUpdated',
  name: 'repository.colBranch',
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
      conversationsColor: string | null
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
    conversationsColor: urgent !== null ? EXECUTION_STATUS[urgent].text : null,
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
      <span class="bt-row-count">{{ visibleRows.length }}</span>
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
        class="bt-refresh"
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
            <td class="bt-empty" colspan="7">{{ t('repository.noBranches') }}</td>
          </tr>
          <tr v-else-if="visibleRows.length === 0">
            <td class="bt-empty" colspan="7">{{ t('repository.filterEmpty') }}</td>
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
                <span class="bt-pill">{{ entry.worktreeLabel }}</span>
              </td>
              <td class="bt-cell bt-cell-branch">
                <template v-if="entry.kind === 'branch'">
                  <div class="bt-branch-name">
                    <span class="bt-branch-mono">{{ entry.row.name }}</span>
                    <span v-if="entry.row.isCurrent" class="bt-current-badge">
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
                  class="bt-mr-pastille"
                  :class="`bt-mr-pastille--${entry.mrPastille.variant}`"
                >
                  <span class="bt-mr-number">{{ entry.mrPastille.number }}</span>
                  <span class="bt-mr-state-text">{{ entry.mrPastille.label }}</span>
                </span>
              </td>
              <td class="bt-cell">
                <span
                  v-if="entry.kind === 'branch' && entry.conversationsLabel"
                  class="bt-conversations-badge"
                  :style="
                    entry.conversationsColor ? { color: entry.conversationsColor } : undefined
                  "
                >
                  {{ entry.conversationsLabel }}
                </span>
              </td>
              <td class="bt-cell bt-cell-age">
                {{ entry.kind === 'branch' ? entry.row.lastCommitRelative : '–' }}
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
                  class="bt-action-btn"
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
                    class="bt-expanded-create"
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
  gap: 10px;
}

.bt-header {
  display: flex;
  align-items: baseline;
}

.bt-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--cs-text);
}

.bt-title-count {
  font-weight: 400;
  color: var(--cs-muted);
}

.bt-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bt-filter {
  flex: 1;
  min-width: 160px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  background: var(--cs-surface-2);
}

.bt-filter:focus-within {
  border-color: var(--cs-focus-ring);
}

.bt-filter-icon {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--cs-muted);
}

.bt-filter-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  padding: 7px 0;
  color: var(--cs-text);
}

.bt-filter-input::placeholder {
  color: var(--cs-muted);
}

.bt-row-count {
  flex: none;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--cs-surface-2);
  color: var(--cs-text-2);
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.bt-sort {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--cs-muted);
}

.bt-sort-select {
  border: 1px solid var(--cs-line-2);
  border-radius: 6px;
  background: var(--cs-surface-2);
  color: var(--cs-text);
  font-family: inherit;
  font-size: 12px;
  padding: 4px 6px;
}

.bt-refresh {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--cs-line-2);
  border-radius: 6px;
  background: transparent;
  color: var(--cs-text-2);
  font-family: inherit;
  font-size: 12px;
  padding: 5px 10px;
  cursor: pointer;
}

.bt-refresh:hover {
  background: var(--cs-hover);
}

.bt-refresh:disabled {
  cursor: default;
  opacity: 0.7;
}

.bt-refresh-icon {
  width: 12px;
  height: 12px;
}

.bt-refresh--spin .bt-refresh-icon {
  animation: bt-spin 0.9s linear infinite;
}

@keyframes bt-spin {
  to {
    transform: rotate(360deg);
  }
}

.bt-scroll {
  overflow-x: auto;
  border: 1px solid var(--cs-line);
  border-radius: 10px;
}

.bt-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.bt-th {
  text-align: left;
  padding: 8px 10px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cs-muted);
  background: var(--cs-surface);
  border-bottom: 1px solid var(--cs-line);
  white-space: nowrap;
}

.bt-th-chevron {
  width: 28px;
}

.bt-th-actions {
  text-align: right;
}

.bt-row {
  border-bottom: 1px solid var(--cs-line);
}

.bt-row:hover {
  background: var(--cs-hover);
}

.bt-cell {
  padding: 8px 10px;
  vertical-align: top;
  color: var(--cs-text-2);
}

.bt-cell-chevron {
  width: 28px;
}

.bt-cell-actions {
  text-align: right;
}

.bt-cell-age {
  white-space: nowrap;
  color: var(--cs-muted);
}

.bt-chevron-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--cs-muted);
  cursor: pointer;
  padding: 0;
}

.bt-chevron-icon {
  width: 14px;
  height: 14px;
  transition: transform var(--cs-duration-fast) var(--cs-ease-out);
}

.bt-chevron-icon--closed {
  transform: rotate(-90deg);
}

.bt-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border: 1px solid var(--cs-line-2);
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--cs-muted);
  background: color-mix(in srgb, var(--cs-surface-2) 60%, transparent);
  white-space: nowrap;
}

.bt-branch-name {
  display: flex;
  align-items: center;
  gap: 6px;
}

.bt-branch-mono {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--cs-text);
}

.bt-branch-mono--detached {
  color: var(--cs-muted);
}

.bt-current-badge {
  padding: 1px 6px;
  border: 1px solid var(--cs-line-2);
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--cs-text-2);
}

.bt-branch-subject {
  margin: 2px 0 0;
  max-width: 360px;
  font-size: 12px;
  color: var(--cs-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bt-mr-pastille {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.bt-mr-number {
  font-family: var(--font-mono);
}

.bt-mr-state-text {
  font-size: 10px;
  font-weight: 500;
  color: var(--cs-muted);
}

.bt-mr-pastille--open {
  color: var(--cs-amber-text);
}

.bt-mr-pastille--draft {
  color: var(--cs-ghost);
}

.bt-mr-pastille--merged {
  color: var(--cs-green-text);
}

.bt-mr-pastille--closed {
  color: var(--cs-red-text);
}

.bt-conversations-badge {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.bt-action-btn {
  border: 1px solid var(--cs-line-2);
  border-radius: 6px;
  background: transparent;
  color: var(--cs-text-2);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: 5px 10px;
  cursor: pointer;
  white-space: nowrap;
}

.bt-action-btn:hover {
  background: var(--cs-hover);
}

.bt-detached-hint {
  font-size: 11px;
  color: var(--cs-muted);
  cursor: help;
}

.bt-empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--cs-muted);
  font-size: 13px;
}

.bt-expanded-row {
  border-bottom: 1px solid var(--cs-line);
}

.bt-expanded-cell {
  padding: 10px 10px 14px 38px;
  background: var(--cs-surface);
}

.bt-expanded-empty {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--cs-muted);
}

.bt-expanded-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}

.bt-conversation-btn {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
  padding: 0;
  text-align: left;
  cursor: pointer;
  border-radius: 8px;
}

.bt-expanded-create {
  border: 1px solid var(--cs-line-2);
  border-radius: 6px;
  background: transparent;
  color: var(--cs-text-2);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: 5px 10px;
  cursor: pointer;
}

.bt-expanded-create:hover {
  background: var(--cs-hover);
}
</style>
