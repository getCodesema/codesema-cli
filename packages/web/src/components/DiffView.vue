<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { collapsedByBudget, type DiffFile } from '../composables/useDiff'
import { t } from '../i18n'
import { readStorageItem, writeStorageItem } from '../storage'
import DiffFileBlock from './diff/DiffFile.vue'

const props = defineProps<{
  files: DiffFile[]
  mode?: 'split' | 'unified'
  hideToolbar?: boolean
  collapseKey?: number
  /** Forces the initial collapse of these files. The caller decides on a cumulative
   *  budget when each DiffView gets a single file and can't see the page-wide total. */
  initialCollapsed?: boolean
  /** Scroll to (and flash) the note with this finding id; nonce retriggers the same id. */
  reveal?: { id: number; nonce: number } | null | undefined
}>()

const SPLIT_KEY = 'codesema-diff-mode'

function loadMode(): 'split' | 'unified' {
  return readStorageItem(SPLIT_KEY) === 'split' ? 'split' : 'unified'
}

const internalMode = ref<'split' | 'unified'>(loadMode())

const diffMode = computed<'split' | 'unified'>(() => props.mode ?? internalMode.value)

function setMode(m: 'split' | 'unified') {
  internalMode.value = m
  writeStorageItem(SPLIT_KEY, m)
}

// Large files (or files past the page's cumulative budget) start collapsed: their
// DOM (v-if) is only created on expand, keeping the first render smooth on huge diffs.
function initialCollapsedSet(): Set<string> {
  const collapsed = collapsedByBudget(props.files)
  if (props.initialCollapsed) {
    for (const f of props.files) {
      collapsed.add(f.path)
    }
  }
  return collapsed
}

const collapsed = ref<Set<string>>(initialCollapsedSet())

// When collapseKey changes: force the collapsed state (even = expanded, odd = collapsed)
watch(
  () => props.collapseKey,
  (k) => {
    if (k == null) {
      return
    }
    collapsed.value = k % 2 === 1 ? new Set(props.files.map((f) => f.path)) : new Set()
  },
)

function toggleFile(path: string) {
  const next = new Set(collapsed.value)
  if (next.has(path)) {
    next.delete(path)
  } else {
    next.add(path)
  }
  collapsed.value = next
}

const totals = computed(() => {
  let add = 0
  let del = 0
  let notes = 0
  for (const f of props.files) {
    add += f.addCount
    del += f.delCount
    notes += f.topFindings.length + Object.values(f.byLine).reduce((n, arr) => n + arr.length, 0)
  }
  return { add, del, notes }
})

const rootEl = ref<HTMLElement | null>(null)

function fileContaining(id: number): DiffFile | undefined {
  return props.files.find(
    (f) =>
      f.topFindings.some((finding) => finding.id === id) ||
      Object.values(f.byLine).some((arr) => arr.some((finding) => finding.id === id)),
  )
}

async function revealFinding(id: number): Promise<void> {
  const file = fileContaining(id)
  if (file && collapsed.value.has(file.path)) {
    const next = new Set(collapsed.value)
    next.delete(file.path)
    collapsed.value = next
  }
  await nextTick()
  const anchor = rootEl.value?.querySelector(`[data-finding-id="${id}"]`)
  if (!(anchor instanceof HTMLElement)) {
    return
  }
  anchor.scrollIntoView({ behavior: 'smooth', block: 'center' })
  const card = anchor.closest('.nlr-note') ?? anchor
  card.classList.add('nlr-note--flash')
  setTimeout(() => card.classList.remove('nlr-note--flash'), 1600)
}

watch(
  () => props.reveal,
  (r) => {
    if (r) {
      void revealFinding(r.id)
    }
  },
)
</script>

<template>
  <p v-if="!files.length" class="muted">{{ t('reviews.noDiff') }}</p>
  <div v-else ref="rootEl" class="diff diff-view-root">
    <div v-if="!hideToolbar" class="diff-t diff-toolbar">
      <span class="dv-totals">
        {{ t('preview.filesChanged', { n: files.length }, files.length) }}
        <span class="dv-add">+{{ totals.add }}</span>
        <span class="dv-del">−{{ totals.del }}</span>
        <span v-if="totals.notes">{{
          t('diffView.noteCount', { n: totals.notes }, totals.notes)
        }}</span>
      </span>
      <span class="seg diff-seg" role="group">
        <button
          type="button"
          :aria-pressed="diffMode === 'unified'"
          :class="{ on: diffMode === 'unified' }"
          @click="setMode('unified')"
        >
          {{ t('diffView.modeUnified') }}
        </button>
        <button
          type="button"
          :aria-pressed="diffMode === 'split'"
          :class="{ on: diffMode === 'split' }"
          @click="setMode('split')"
        >
          {{ t('diffView.modeSplit') }}
        </button>
      </span>
    </div>

    <DiffFileBlock
      v-for="file in files"
      :key="file.path"
      :file="file"
      :mode="diffMode"
      :collapsed="collapsed.has(file.path)"
      @toggle="toggleFile(file.path)"
    />
  </div>
</template>

<style scoped>
p.muted {
  font-size: 12px;
}

.dv-totals {
  display: inline-flex;
  gap: 1ch;
  align-items: baseline;
}

.dv-add {
  color: var(--ok);
}

.dv-del {
  color: var(--err);
}
</style>
