<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { parseDiff, type Finding } from '../composables/useDiff'
import { G } from '../glyphs'
import type { PreviewFile, PreviewFileDiff, PreviewResult, ReviewSource } from '../types'
import DiffView from './DiffView.vue'

const props = defineProps<{
  source: ReviewSource
  /** Registry id scoping /api/preview* to a registered repo; absent = the
   * launch cwd (legacy single-repo behavior, frozen contract). */
  project?: string
  /** Review notes to annotate the opened file's diff with. Absent (or from
   * another file) simply leaves the diff bare — parseDiff drops what it
   * cannot anchor. Findings must carry their id, as the review view does. */
  findings?: Finding[]
}>()

/** Fired on every successful load: the parent can label its Diff tab with
 * the real file count without a second fetch. */
const emit = defineEmits<{ loaded: [preview: PreviewResult] }>()

function sourceQuery(source: ReviewSource): string {
  const base =
    source.kind === 'mr'
      ? `source=mr&number=${source.number}`
      : `source=branch&name=${encodeURIComponent(source.name)}`
  return props.project === undefined ? base : `${base}&project=${encodeURIComponent(props.project)}`
}

async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  return body?.error ?? `HTTP ${res.status}`
}

const loading = ref(true)
const loadError = ref<string | null>(null)
const preview = ref<PreviewResult | null>(null)

const selectedPath = ref<string | null>(null)
const diffLoading = ref(false)
const diffError = ref<string | null>(null)
const diffResult = ref<PreviewFileDiff | null>(null)

async function load() {
  loading.value = true
  loadError.value = null
  preview.value = null
  selectedPath.value = null
  diffResult.value = null
  try {
    const res = await fetch(`/api/preview?${sourceQuery(props.source)}`)
    if (!res.ok) {
      throw new Error(await errorFrom(res))
    }
    preview.value = (await res.json()) as PreviewResult
    emit('loaded', preview.value)
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function pickFile(path: string) {
  selectedPath.value = path
  diffLoading.value = true
  diffError.value = null
  diffResult.value = null
  try {
    const res = await fetch(
      `/api/preview/diff?${sourceQuery(props.source)}&path=${encodeURIComponent(path)}`,
    )
    if (!res.ok) {
      throw new Error(await errorFrom(res))
    }
    diffResult.value = (await res.json()) as PreviewFileDiff
  } catch (e) {
    diffError.value = e instanceof Error ? e.message : String(e)
  } finally {
    diffLoading.value = false
  }
}

// The findings are attached HERE, by parseDiff: the annotated rows are what
// DiffView renders, it does no matching of its own.
const diffFiles = computed(() =>
  diffResult.value ? parseDiff(diffResult.value.diff, props.findings ?? []).files : [],
)

watch(() => props.source, load, { immediate: true, deep: true })

const STATUS_LABEL: Record<string, string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
}

function fileLabel(file: PreviewFile): string {
  return file.previousPath ? `${file.previousPath} → ${file.path}` : file.path
}
</script>

<template>
  <div class="pv-root">
    <p v-if="loading" class="status pv-state" data-s="running">{{ $t('preview.loading') }}</p>
    <p v-else-if="loadError" class="pv-error">{{ $t('preview.loadError') }} ({{ loadError }})</p>

    <template v-else-if="preview">
      <div class="pv-refs">
        <code class="pv-branch">{{ preview.branch }}</code>
        <span class="pv-arrow" aria-hidden="true">{{ G.arrow }}</span>
        <code class="pv-branch">{{ preview.target }}</code>
      </div>

      <div class="pv-summary muted">
        <span>{{
          $t('preview.commits', { n: preview.commits.length }, preview.commits.length)
        }}</span>
        <span>{{
          $t('preview.filesChanged', { n: preview.diffStats.files }, preview.diffStats.files)
        }}</span>
        <span class="pv-add">+{{ preview.diffStats.additions }}</span>
        <span class="pv-del">−{{ preview.diffStats.deletions }}</span>
      </div>

      <ul v-if="preview.commits.length" class="log pv-commits">
        <li v-for="(subject, i) in preview.commits" :key="i">{{ subject }}</li>
      </ul>

      <p v-if="preview.files.length === 0" class="muted pv-empty">
        {{ $t('preview.noFiles') }}
      </p>
      <ul v-else class="pv-files">
        <li v-for="file in preview.files" :key="file.path">
          <button
            class="pv-file"
            :class="{ 'pv-file--selected': file.path === selectedPath }"
            @click="pickFile(file.path)"
          >
            <span class="badge pv-file-status" :class="`pv-file-status--${file.status}`">{{
              STATUS_LABEL[file.status]
            }}</span>
            <span class="pv-file-path" :title="fileLabel(file)">{{ fileLabel(file) }}</span>
            <span class="pv-file-delta">
              <span class="pv-add">+{{ file.additions }}</span>
              <span class="pv-del">−{{ file.deletions }}</span>
            </span>
          </button>
        </li>
      </ul>

      <div class="pv-diff">
        <p v-if="diffLoading" class="status pv-state" data-s="running">
          {{ $t('preview.loading') }}
        </p>
        <p v-else-if="diffError" class="pv-error">
          {{ $t('preview.diffLoadError') }} ({{ diffError }})
        </p>
        <template v-else-if="diffResult">
          <p v-if="diffResult.truncated" class="pv-truncated">{{ $t('preview.diffTruncated') }}</p>
          <DiffView :files="diffFiles" hide-toolbar />
        </template>
        <p v-else-if="preview.files.length" class="muted pv-empty">
          {{ $t('preview.selectFileHint') }}
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pv-root {
  display: flex;
  flex-direction: column;
  gap: var(--row);
}

.pv-state {
  margin: 0;
  padding: var(--row) 1ch;
}

.pv-error {
  color: var(--err);
  margin: 0;
}

.pv-refs {
  display: flex;
  align-items: center;
  gap: 1ch;
}

.pv-arrow {
  color: var(--fg-dim);
}

.pv-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 2ch;
  font-size: 12px;
}

.pv-add {
  color: var(--ok);
}

.pv-del {
  color: var(--err);
}

.pv-commits {
  list-style: none;
  max-height: calc(var(--row) * 6);
  overflow-y: auto;
  color: var(--fg-dim);
}

.pv-empty {
  color: var(--fg-dim);
}

.pv-files {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
}

.pv-file {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: 0 1ch;
  border: none;
  border-left: 2px solid transparent;
  background: var(--bg-raised);
  cursor: pointer;
  font: inherit;
  color: var(--fg-dim);
  text-align: left;
}

.pv-file:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

.pv-file--selected {
  border-left-color: var(--accent);
  color: var(--fg);
}

.pv-file-status {
  flex-shrink: 0;
}

.pv-file-status--added {
  color: var(--ok);
}

.pv-file-status--deleted {
  color: var(--err);
}

.pv-file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
}

.pv-file-delta {
  flex-shrink: 0;
  display: inline-flex;
  gap: 1ch;
  font-size: 12px;
}

.pv-truncated {
  font-size: 12px;
  color: var(--warn);
  margin: 0 0 calc(var(--row) / 2);
}
</style>
