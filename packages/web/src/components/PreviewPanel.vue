<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { parseDiff } from '../composables/useDiff'
import type { PreviewFileDiff, PreviewResult, ReviewSource } from '../types'
import DiffView from './DiffView.vue'

const props = defineProps<{
  source: ReviewSource
  /** Registry id scoping /api/preview* to a registered repo; absent = the
   * launch cwd (legacy single-repo behavior, frozen contract). */
  project?: string
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

const diffFiles = computed(() => (diffResult.value ? parseDiff(diffResult.value.diff).files : []))

watch(() => props.source, load, { immediate: true, deep: true })

const STATUS_LABEL: Record<string, string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
}
</script>

<template>
  <div class="pv-root">
    <div v-if="loading" class="pv-state">
      <span class="pv-spinner" aria-hidden="true" />
      <p class="codesema-muted">{{ $t('preview.loading') }}</p>
    </div>
    <p v-else-if="loadError" class="pv-error">{{ $t('preview.loadError') }} ({{ loadError }})</p>

    <template v-else-if="preview">
      <div class="pv-refs">
        <code class="pv-branch">{{ preview.branch }}</code>
        <span class="pv-arrow" aria-hidden="true">→</span>
        <code class="pv-branch">{{ preview.target }}</code>
      </div>

      <div class="pv-summary codesema-muted">
        <span>{{
          $t('preview.commits', { n: preview.commits.length }, preview.commits.length)
        }}</span>
        <span>{{
          $t('preview.filesChanged', { n: preview.diffStats.files }, preview.diffStats.files)
        }}</span>
        <span class="pv-add">+{{ preview.diffStats.additions }}</span>
        <span class="pv-del">−{{ preview.diffStats.deletions }}</span>
      </div>

      <ul v-if="preview.commits.length" class="pv-commits">
        <li v-for="(subject, i) in preview.commits" :key="i">{{ subject }}</li>
      </ul>

      <p v-if="preview.files.length === 0" class="codesema-muted pv-empty">
        {{ $t('preview.noFiles') }}
      </p>
      <ul v-else class="pv-files">
        <li v-for="file in preview.files" :key="file.path">
          <button
            class="pv-file"
            :class="{ 'pv-file--selected': file.path === selectedPath }"
            @click="pickFile(file.path)"
          >
            <span class="pv-file-status" :class="`pv-file-status--${file.status}`">{{
              STATUS_LABEL[file.status]
            }}</span>
            <span class="pv-file-path">{{ file.path }}</span>
            <span class="pv-file-delta">
              <span class="pv-add">+{{ file.additions }}</span>
              <span class="pv-del">−{{ file.deletions }}</span>
            </span>
          </button>
        </li>
      </ul>

      <div class="pv-diff">
        <div v-if="diffLoading" class="pv-state">
          <span class="pv-spinner" aria-hidden="true" />
        </div>
        <p v-else-if="diffError" class="pv-error">
          {{ $t('preview.diffLoadError') }} ({{ diffError }})
        </p>
        <template v-else-if="diffResult">
          <p v-if="diffResult.truncated" class="pv-truncated">{{ $t('preview.diffTruncated') }}</p>
          <DiffView :files="diffFiles" :findings="[]" hide-toolbar />
        </template>
        <p v-else-if="preview.files.length" class="codesema-muted pv-empty">
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
  gap: 16px;
}

.pv-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px 8px;
  font-size: 12.5px;
  text-align: center;
}

.pv-spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2.5px solid var(--codesema-line);
  border-top-color: var(--codesema-accent);
  animation: pv-spin 0.8s linear infinite;
}

@keyframes pv-spin {
  to {
    transform: rotate(360deg);
  }
}

.pv-error {
  color: var(--codesema-risk-high);
  font-size: 12.5px;
  margin: 0;
}

.pv-refs {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}

.pv-branch {
  font-family: var(--font-mono);
  background: var(--codesema-line-2);
  border-radius: 6px;
  padding: 3px 8px;
  color: var(--codesema-ink);
}

.pv-arrow {
  color: var(--codesema-ink-3);
}

.pv-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
}

.pv-add {
  color: var(--codesema-risk-low);
}

.pv-del {
  color: var(--codesema-risk-high);
}

.pv-commits {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
  color: var(--codesema-ink-2);
  max-height: 140px;
  overflow-y: auto;
}

.pv-commits li {
  padding: 2px 0;
}

.pv-empty {
  font-size: 12.5px;
}

.pv-files {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--codesema-line);
  border-radius: 10px;
  overflow: hidden;
}

.pv-file {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: none;
  background: var(--codesema-panel);
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  transition: background 0.1s;
}

.pv-file:hover {
  background: var(--codesema-line-2);
}

.pv-file--selected {
  background: var(--codesema-accent-soft);
}

.pv-file-status {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--codesema-ink-3);
  background: var(--codesema-line-2);
}

.pv-file-status--added {
  color: var(--codesema-risk-low);
}

.pv-file-status--deleted {
  color: var(--codesema-risk-high);
}

.pv-file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--codesema-ink);
}

.pv-file-delta {
  flex-shrink: 0;
  display: inline-flex;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
}

.pv-truncated {
  font-size: 12px;
  color: var(--codesema-risk-med);
  margin: 0 0 10px;
}
</style>
