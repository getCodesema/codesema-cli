<script setup lang="ts">
// The changes panel's "Files changed" section (fiche 14 §5-§7): a flat,
// sticky-headed list of ChangedFileRow, each expandable in place into a
// ChangedFileDiff. The file list itself arrives as a prop (`filesState`,
// owned by ChangesPanel.vue's useChangedFiles() instance) so this component
// stays a pure function of its props for SSR testing; only the per-file
// diff fetching and the expand/collapse UI state are this component's own,
// via useFileDiffs().
import { FileX, TriangleAlert } from '@lucide/vue'
import { computed, onUnmounted, ref } from 'vue'
import type { ChangedFilesState } from '../../composables/useChangedFiles'
import { parseDiff, type DiffFile } from '../../composables/useDiff'
import { useFileDiffs, type FileDiffState } from '../../composables/useFileDiffs'
import { t } from '../../i18n'
import type { PreviewFile } from '../../types'
import ChangedFileDiff from './ChangedFileDiff.vue'
import ChangedFileRow from './ChangedFileRow.vue'
import ChangesEmptyTab from './ChangesEmptyTab.vue'
import { DIFF_MOUNT_DELAY_MS } from './ChangesLogic'

const props = defineProps<{
  filesState: ChangedFilesState
  mrNumber: number
  // `| undefined` alongside `?:` on purpose: the caller forwards its own
  // possibly-undefined `project` prop directly (`:project="project"`), which
  // under this repo's exactOptionalPropertyTypes always sends the key, just
  // sometimes holding undefined, a plain `project?: string` only allows the
  // key to be OMITTED, not present-and-undefined.
  project?: string | undefined
}>()

const emit = defineEmits<{ retry: [] }>()

// ── Expand/collapse + the 140ms delayed mount (fiche §6) ───────────────────

const diffs = useFileDiffs()
const expandedPaths = ref<Set<string>>(new Set())
const readyPaths = ref<Set<string>>(new Set())
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

function toggleFile(path: string): void {
  const next = new Set(expandedPaths.value)
  if (next.has(path)) {
    next.delete(path)
    expandedPaths.value = next
    return
  }
  next.add(path)
  expandedPaths.value = next
  diffs.load(props.mrNumber, path, props.project)
  if (!readyPaths.value.has(path) && !pendingTimers.has(path)) {
    pendingTimers.set(
      path,
      setTimeout(() => {
        pendingTimers.delete(path)
        readyPaths.value = new Set(readyPaths.value).add(path)
      }, DIFF_MOUNT_DELAY_MS),
    )
  }
}

onUnmounted(() => {
  for (const timer of pendingTimers.values()) {
    clearTimeout(timer)
  }
  pendingTimers.clear()
})

const preview = computed(() =>
  props.filesState.phase === 'loaded' ? props.filesState.preview : null,
)

type RowView = {
  file: PreviewFile
  expanded: boolean
  last: boolean
  ready: boolean
  diffState: FileDiffState | null
}

/** One view-model per row, computed once per render pass instead of calling
 * diffs.stateOf() repeatedly inline in the template for the same path. */
const rows = computed<RowView[]>(() => {
  const files = preview.value?.files ?? []
  return files.map((file, i) => ({
    file,
    expanded: expandedPaths.value.has(file.path),
    last: i === files.length - 1,
    ready: readyPaths.value.has(file.path),
    diffState: diffs.stateOf(props.mrNumber, file.path, props.project),
  }))
})

function parsedDiffFiles(diff: FileDiffState): DiffFile[] {
  return diff.phase === 'loaded' ? parseDiff(diff.diff.diff).files : []
}
</script>

<template>
  <div class="cfl-root">
    <div v-if="filesState.phase === 'loading' || filesState.phase === 'idle'" class="cfl-state">
      <span class="cfl-spinner" aria-hidden="true" />
      <p class="cfl-state-text">{{ t('changes.fileList.loading') }}</p>
    </div>

    <div v-else-if="filesState.phase === 'error'" class="cfl-state">
      <TriangleAlert class="cfl-error-icon" aria-hidden="true" />
      <p class="cfl-error-title">{{ t('changes.fileList.loadError') }}</p>
      <pre class="cfl-error-detail">{{ filesState.message }}</pre>
      <button type="button" class="cfl-retry" @click="emit('retry')">
        {{ t('changes.fileList.retry') }}
      </button>
    </div>

    <template v-else-if="preview">
      <ChangesEmptyTab
        v-if="preview.files.length === 0"
        :icon="FileX"
        :text="t('changes.fileList.empty')"
      />
      <template v-else>
        <div class="cfl-summary">
          <span class="cfl-summary-count">{{
            t('changes.fileList.summary', { n: preview.diffStats.files }, preview.diffStats.files)
          }}</span>
          <span class="cfl-summary-add">+{{ preview.diffStats.additions }}</span>
          <span class="cfl-summary-del">−{{ preview.diffStats.deletions }}</span>
        </div>
        <div class="cfl-rows">
          <ChangedFileRow
            v-for="row in rows"
            :key="row.file.path"
            :file="row.file"
            :expanded="row.expanded"
            :last="row.last"
            @toggle="toggleFile(row.file.path)"
          >
            <p v-if="row.diffState?.phase === 'error'" class="cfl-diff-error">
              {{ t('changes.fileList.diffLoadError') }} ({{ row.diffState.message }})
            </p>
            <ChangedFileDiff
              v-else-if="row.ready && row.diffState?.phase === 'loaded'"
              :files="parsedDiffFiles(row.diffState)"
            />
            <p v-else class="cfl-diff-waiting">{{ t('changes.fileList.diffLoading') }}</p>
          </ChangedFileRow>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.cfl-root {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
}

.cfl-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px 16px;
  text-align: center;
}

.cfl-state-text {
  margin: 0;
  font-size: 13px;
  color: var(--cs-muted);
}

.cfl-spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2.5px solid var(--cs-line-2);
  border-top-color: var(--cs-green);
  animation: cfl-spin 0.8s linear infinite;
}

@keyframes cfl-spin {
  to {
    transform: rotate(360deg);
  }
}

.cfl-error-icon {
  width: 20px;
  height: 20px;
  color: var(--cs-red-text);
}

.cfl-error-title {
  margin: 0;
  font-size: 13px;
  color: var(--cs-text);
}

/* fiche §7: the error detail sits in a capped, scrollable frame instead of
   pushing the panel taller, a long stack trace stays readable without
   breaking the layout. */
.cfl-error-detail {
  max-width: 100%;
  max-height: 120px;
  overflow-y: auto;
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--cs-line);
  background: var(--cs-inset);
  color: var(--cs-text-2);
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: pre-wrap;
  text-align: left;
}

.cfl-retry {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--cs-line-2);
  background: var(--cs-surface-2);
  color: var(--cs-text);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color var(--cs-duration-fast) var(--cs-ease-out);
}

.cfl-retry:hover {
  border-color: var(--cs-line-3);
}

.cfl-summary {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--cs-line);
  background: var(--cs-surface);
  font-size: 12px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.cfl-summary-count {
  color: var(--cs-text-2);
  margin-right: auto;
}

.cfl-summary-add {
  color: var(--cs-green-text);
}

.cfl-summary-del {
  color: var(--cs-red-text);
}

.cfl-rows {
  display: flex;
  flex-direction: column;
}

.cfl-diff-waiting,
.cfl-diff-error {
  margin: 0;
  padding: 12px;
  font-size: 12px;
  color: var(--cs-muted);
}

.cfl-diff-error {
  color: var(--cs-red-text);
}
</style>
