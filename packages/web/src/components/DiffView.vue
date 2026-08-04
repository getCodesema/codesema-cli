<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  collapsedByBudget,
  toSplit,
  type DiffFile,
  type Finding,
  type FindingSeverity,
  type HunkBlock,
  type HunkLine,
  type SplitRow,
} from '../composables/useDiff'
import { t } from '../i18n'

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

const isClient = typeof window !== 'undefined'

const SPLIT_KEY = 'codesema-diff-mode'

function loadMode(): 'split' | 'unified' {
  if (!isClient) {
    return 'unified'
  }
  return (localStorage.getItem(SPLIT_KEY) as 'split' | 'unified') ?? 'unified'
}

const internalMode = ref<'split' | 'unified'>(loadMode())

const diffMode = computed<'split' | 'unified'>(() => props.mode ?? internalMode.value)

function setMode(m: 'split' | 'unified') {
  internalMode.value = m
  if (isClient) {
    localStorage.setItem(SPLIT_KEY, m)
  }
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
  if (collapsed.value.has(path)) {
    collapsed.value.delete(path)
  } else {
    collapsed.value.add(path)
  }
  // force reactivity
  collapsed.value = new Set(collapsed.value)
}

function isCollapsed(path: string): boolean {
  return collapsed.value.has(path)
}

function fileFindingCount(file: {
  topFindings: Finding[]
  byLine: Record<number, Finding[]>
}): number {
  return file.topFindings.length + Object.values(file.byLine).reduce((n, arr) => n + arr.length, 0)
}

type KindMeta = { label: string; color: string; bg: string }

const NL_KIND: Partial<Record<string, KindMeta>> = {
  security: {
    label: t('diffView.kindSecurity'),
    color: 'var(--codesema-kind-security)',
    bg: 'var(--codesema-kind-security-soft)',
  },
  perf: {
    label: t('diffView.kindPerf'),
    color: 'var(--codesema-kind-perf)',
    bg: 'var(--codesema-kind-perf-soft)',
  },
  convention: {
    label: t('diffView.kindConvention'),
    color: 'var(--codesema-kind-convention)',
    bg: 'var(--codesema-kind-convention-soft)',
  },
  design: {
    label: t('diffView.kindDesign'),
    color: 'var(--codesema-kind-design)',
    bg: 'var(--codesema-kind-design-soft)',
  },
  praise: {
    label: t('diffView.kindPraise'),
    color: 'var(--codesema-kind-praise)',
    bg: 'var(--codesema-kind-praise-soft)',
  },
  why: {
    label: t('diffView.kindWhy'),
    color: 'var(--codesema-kind-why)',
    bg: 'var(--codesema-kind-why-soft)',
  },
}

const SEV_KIND: Record<FindingSeverity, KindMeta> = {
  critical: {
    label: t('diffView.sevCritical'),
    color: 'var(--codesema-risk-high)',
    bg: 'var(--codesema-risk-high-soft)',
  },
  major: {
    label: t('diffView.sevMajor'),
    color: 'var(--codesema-risk-high)',
    bg: 'var(--codesema-risk-high-soft)',
  },
  minor: {
    label: t('diffView.sevMinor'),
    color: 'var(--codesema-risk-med)',
    bg: 'var(--codesema-risk-med-soft)',
  },
  info: {
    label: t('diffView.sevInfo'),
    color: 'var(--codesema-ink-3)',
    bg: 'var(--codesema-line-2)',
  },
}

const FALLBACK_KIND: KindMeta = {
  label: t('diffView.sevInfo'),
  color: 'var(--codesema-ink-3)',
  bg: 'var(--codesema-line-2)',
}

function resolveKind(f: Finding): KindMeta {
  if (f.kind) {
    const k = NL_KIND[f.kind]
    if (k) {
      return k
    }
  }
  return SEV_KIND[f.severity] ?? FALLBACK_KIND
}

function noteBorderColor(f: Finding): string {
  return resolveKind(f).color
}

function richParts(s: string): { text: string; isCode: boolean }[] {
  return s.split(/(`[^`]+`)/g).map((p) => ({
    text: p.startsWith('`') && p.endsWith('`') ? p.slice(1, -1) : p,
    isCode: p.startsWith('`') && p.endsWith('`'),
  }))
}

function splitRows(rows: HunkLine[]): SplitRow[] {
  return toSplit(rows)
}

function cellClass(kind: 'add' | 'del' | 'ctx' | 'nil'): string {
  if (kind === 'add') {
    return 'srd-cell-add'
  }
  if (kind === 'del') {
    return 'srd-cell-del'
  }
  if (kind === 'nil') {
    return 'srd-cell-nil'
  }
  return 'srd-cell-ctx'
}

function isGap(block: HunkBlock): block is { gap: number } {
  return 'gap' in block
}

function isHunkRows(block: HunkBlock): block is { rows: HunkLine[] } {
  return 'rows' in block
}

function gapSize(block: HunkBlock): number {
  return (block as { gap: number }).gap
}

function hunkRows(block: HunkBlock): HunkLine[] {
  return (block as { rows: HunkLine[] }).rows
}

function extraNotes(byLine: Record<number, Finding[]>, lineNo: number | null): Finding[] {
  if (lineNo == null) {
    return []
  }
  return (byLine[lineNo] ?? []).slice(1)
}

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
    collapsed.value.delete(file.path)
    collapsed.value = new Set(collapsed.value)
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
  <p v-if="!files.length" class="codesema-muted text-sm">{{ $t('reviews.noDiff') }}</p>
  <div v-else ref="rootEl" class="diff-view-root">
    <div v-if="!hideToolbar" class="diff-toolbar">
      <div class="diff-seg">
        <button :class="{ on: diffMode === 'unified' }" @click="setMode('unified')">
          {{ $t('diffView.modeUnified') }}
        </button>
        <button :class="{ on: diffMode === 'split' }" @click="setMode('split')">
          {{ $t('diffView.modeSplit') }}
        </button>
      </div>
    </div>

    <div class="diff-files">
      <div v-for="file in files" :key="file.path" class="srd-file">
        <div class="srd-file-head" :data-diff-file="file.path" @click="toggleFile(file.path)">
          <span class="srd-chev" :class="{ open: !isCollapsed(file.path) }">▸</span>
          <code class="srd-path diff-file-path">{{ file.path }}</code>
          <span class="srd-flex1" />
          <span v-if="fileFindingCount(file)" class="srd-cmt">
            {{ $t('diffView.noteCount', { n: fileFindingCount(file) }, fileFindingCount(file)) }}
          </span>
          <span class="srd-delta">
            <span class="srd-delta-add">+{{ file.addCount }}</span>
            <span class="srd-delta-sep"> </span>
            <span class="srd-delta-del">−{{ file.delCount }}</span>
          </span>
        </div>

        <div v-if="!isCollapsed(file.path)" class="srd-body">
          <template v-if="file.topFindings.length">
            <div
              v-for="(f, i) in file.topFindings"
              :key="'top-' + i"
              class="nlr-note"
              :data-finding-id="f.id"
              :style="{ borderLeftColor: noteBorderColor(f) }"
            >
              <div class="nlr-note-head">
                <span class="nlr-mark">✦</span>
                <span class="nlr-name">{{ $t('note.author') }}</span>
                <span
                  class="nlr-kind"
                  :style="{ color: resolveKind(f).color, background: resolveKind(f).bg }"
                  >{{ resolveKind(f).label }}</span
                >
                <span v-if="f.consensus" class="nlr-consensus" :title="$t('finding.consensus')">
                  <span class="nlr-consensus-dots" aria-hidden="true"><span /><span /></span>
                  {{ $t('finding.consensus') }}
                </span>
              </div>
              <p v-if="f.title" class="nlr-note-title">
                <template v-for="(part, j) in richParts(f.title)" :key="j">
                  <code v-if="part.isCode">{{ part.text }}</code>
                  <template v-else>{{ part.text }}</template>
                </template>
              </p>
              <p class="nlr-note-body">
                <template v-for="(part, j) in richParts(f.message)" :key="j">
                  <code v-if="part.isCode">{{ part.text }}</code>
                  <template v-else>{{ part.text }}</template>
                </template>
              </p>
              <div v-if="f.suggestion" class="nlr-sugg">
                <div class="nlr-sugg-head">
                  <span>{{ $t('diffView.suggestionLabel') }}</span>
                </div>
                <pre class="nlr-sugg-code"><code>{{ f.suggestion }}</code></pre>
              </div>
            </div>
          </template>

          <template v-for="(block, bi) in file.hunks" :key="bi">
            <div v-if="isGap(block)" class="srd-gap">
              <span class="srd-gap-ic">↕</span>
              {{ $t('diffView.gapLines', { n: gapSize(block) }, gapSize(block)) }}
            </div>

            <template v-else-if="isHunkRows(block) && diffMode === 'unified'">
              <div class="srd-unified">
                <template v-for="(row, ri) in hunkRows(block)" :key="ri">
                  <div
                    class="srd-uline"
                    :class="
                      row.t === 'add'
                        ? 'srd-uline-add'
                        : row.t === 'del'
                          ? 'srd-uline-del'
                          : 'srd-uline-ctx'
                    "
                  >
                    <span class="srd-no">{{ row.o ?? '' }}</span>
                    <span class="srd-no">{{ row.n ?? '' }}</span>
                    <span class="srd-sign">{{
                      row.t === 'add' ? '+' : row.t === 'del' ? '−' : ' '
                    }}</span>
                    <span class="srd-code">{{ row.c || ' ' }}</span>
                  </div>
                  <div
                    v-if="row.note"
                    class="nlr-note nlr-note-inline"
                    :data-finding-id="row.note.id"
                    :style="{ borderLeftColor: noteBorderColor(row.note) }"
                  >
                    <div class="nlr-note-head">
                      <span class="nlr-mark">✦</span>
                      <span class="nlr-name">{{ $t('note.author') }}</span>
                      <span
                        class="nlr-kind"
                        :style="{
                          color: resolveKind(row.note).color,
                          background: resolveKind(row.note).bg,
                        }"
                        >{{ resolveKind(row.note).label }}</span
                      >
                      <span
                        v-if="row.note.consensus"
                        class="nlr-consensus"
                        :title="$t('finding.consensus')"
                      >
                        <span class="nlr-consensus-dots" aria-hidden="true"><span /><span /></span>
                        {{ $t('finding.consensus') }}
                      </span>
                    </div>
                    <p v-if="row.note.title" class="nlr-note-title">
                      <template v-for="(part, j) in richParts(row.note.title)" :key="j">
                        <code v-if="part.isCode">{{ part.text }}</code>
                        <template v-else>{{ part.text }}</template>
                      </template>
                    </p>
                    <p class="nlr-note-body">
                      <template v-for="(part, j) in richParts(row.note.message)" :key="j">
                        <code v-if="part.isCode">{{ part.text }}</code>
                        <template v-else>{{ part.text }}</template>
                      </template>
                    </p>
                    <div v-if="row.note.suggestion" class="nlr-sugg">
                      <div class="nlr-sugg-head">
                        <span>{{ $t('diffView.suggestionLabel') }}</span>
                      </div>
                      <pre class="nlr-sugg-code"><code>{{ row.note.suggestion }}</code></pre>
                    </div>
                    <template v-if="extraNotes(file.byLine, row.n).length">
                      <template
                        v-for="(extraNote, en) in extraNotes(file.byLine, row.n)"
                        :key="'extra-' + en"
                      >
                        <div class="nlr-note-sep" />
                        <div class="nlr-note-head" :data-finding-id="extraNote.id">
                          <span class="nlr-mark">✦</span>
                          <span class="nlr-name">{{ $t('note.author') }}</span>
                          <span
                            class="nlr-kind"
                            :style="{
                              color: resolveKind(extraNote).color,
                              background: resolveKind(extraNote).bg,
                            }"
                            >{{ resolveKind(extraNote).label }}</span
                          >
                          <span
                            v-if="extraNote.consensus"
                            class="nlr-consensus"
                            :title="$t('finding.consensus')"
                          >
                            <span class="nlr-consensus-dots" aria-hidden="true"
                              ><span /><span
                            /></span>
                            {{ $t('finding.consensus') }}
                          </span>
                        </div>
                        <p v-if="extraNote.title" class="nlr-note-title">
                          <template v-for="(part, j) in richParts(extraNote.title)" :key="j">
                            <code v-if="part.isCode">{{ part.text }}</code>
                            <template v-else>{{ part.text }}</template>
                          </template>
                        </p>
                        <p class="nlr-note-body">
                          <template v-for="(part, j) in richParts(extraNote.message)" :key="j">
                            <code v-if="part.isCode">{{ part.text }}</code>
                            <template v-else>{{ part.text }}</template>
                          </template>
                        </p>
                        <div v-if="extraNote.suggestion" class="nlr-sugg">
                          <div class="nlr-sugg-head">
                            <span>{{ $t('diffView.suggestionLabel') }}</span>
                          </div>
                          <pre class="nlr-sugg-code"><code>{{ extraNote.suggestion }}</code></pre>
                        </div>
                      </template>
                    </template>
                  </div>
                </template>
              </div>
            </template>

            <template v-else-if="isHunkRows(block) && diffMode === 'split'">
              <div class="srd-split">
                <template v-for="(srow, si) in splitRows(hunkRows(block))" :key="si">
                  <div v-if="srow.kind === 'note'" class="srd-split-note-row">
                    <div
                      class="nlr-note nlr-note-split"
                      :data-finding-id="srow.note.id"
                      :style="{ borderLeftColor: noteBorderColor(srow.note) }"
                    >
                      <div class="nlr-note-head">
                        <span class="nlr-mark">✦</span>
                        <span class="nlr-name">{{ $t('note.author') }}</span>
                        <span
                          class="nlr-kind"
                          :style="{
                            color: resolveKind(srow.note).color,
                            background: resolveKind(srow.note).bg,
                          }"
                          >{{ resolveKind(srow.note).label }}</span
                        >
                        <span
                          v-if="srow.note.consensus"
                          class="nlr-consensus"
                          :title="$t('finding.consensus')"
                        >
                          <span class="nlr-consensus-dots" aria-hidden="true"
                            ><span /><span
                          /></span>
                          {{ $t('finding.consensus') }}
                        </span>
                      </div>
                      <p v-if="srow.note.title" class="nlr-note-title">
                        <template v-for="(part, j) in richParts(srow.note.title)" :key="j">
                          <code v-if="part.isCode">{{ part.text }}</code>
                          <template v-else>{{ part.text }}</template>
                        </template>
                      </p>
                      <p class="nlr-note-body">
                        <template v-for="(part, j) in richParts(srow.note.message)" :key="j">
                          <code v-if="part.isCode">{{ part.text }}</code>
                          <template v-else>{{ part.text }}</template>
                        </template>
                      </p>
                      <div v-if="srow.note.suggestion" class="nlr-sugg">
                        <div class="nlr-sugg-head">
                          <span>{{ $t('diffView.suggestionLabel') }}</span>
                        </div>
                        <pre class="nlr-sugg-code"><code>{{ srow.note.suggestion }}</code></pre>
                      </div>
                    </div>
                  </div>

                  <div v-else class="srd-row">
                    <div
                      class="srd-cell"
                      :class="
                        srow.kind === 'ctx'
                          ? cellClass('ctx')
                          : srow.left
                            ? cellClass('del')
                            : cellClass('nil')
                      "
                    >
                      <span class="srd-no">{{
                        srow.kind === 'ctx' ? (srow.left.o ?? '') : (srow.left?.o ?? '')
                      }}</span>
                      <span class="srd-sign">{{
                        srow.kind !== 'ctx' && srow.left ? '−' : ' '
                      }}</span>
                      <span class="srd-code">{{
                        srow.kind === 'ctx' ? srow.left.c || ' ' : (srow.left?.c ?? ' ')
                      }}</span>
                    </div>
                    <div
                      class="srd-cell"
                      :class="
                        srow.kind === 'ctx'
                          ? cellClass('ctx')
                          : srow.right
                            ? cellClass('add')
                            : cellClass('nil')
                      "
                    >
                      <span class="srd-no">{{
                        srow.kind === 'ctx' ? (srow.right.n ?? '') : (srow.right?.n ?? '')
                      }}</span>
                      <span class="srd-sign">{{
                        srow.kind !== 'ctx' && srow.right ? '+' : ' '
                      }}</span>
                      <span class="srd-code">{{
                        srow.kind === 'ctx' ? srow.right.c || ' ' : (srow.right?.c ?? ' ')
                      }}</span>
                    </div>
                  </div>
                </template>
              </div>
            </template>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* root */
.diff-view-root {
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* toolbar */
.diff-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.diff-seg {
  display: inline-flex;
  background: var(--codesema-panel);
  border: 1px solid var(--codesema-line);
  border-radius: 9px;
  padding: 2px;
  gap: 2px;
}

.diff-seg button {
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 7px;
  color: var(--codesema-ink-2);
  font-weight: 500;
  border: none;
  background: none;
  cursor: pointer;
  font-family: inherit;
  transition:
    background 0.12s,
    color 0.12s;
}

.diff-seg button.on {
  background: var(--codesema-ink);
  color: var(--codesema-bg);
}

/* file list */
.diff-files {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* file */
.srd-file {
  border: 1px solid var(--codesema-line);
  border-radius: 10px;
  overflow: hidden;
  background: var(--codesema-panel);
  /* skip layout/paint for off-screen files on large diffs */
  content-visibility: auto;
  contain-intrinsic-size: auto 320px;
}

.srd-file-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 14px;
  background: var(--codesema-line-2);
  border-bottom: 1px solid var(--codesema-line);
  cursor: pointer;
  font-size: 12.5px;
  user-select: none;
}

.srd-file-head:hover {
  background: color-mix(in srgb, var(--codesema-line) 60%, var(--codesema-panel));
}

.srd-chev {
  color: var(--codesema-ink-3);
  font-size: 10px;
  transition: transform 0.15s;
  display: inline-block;
  flex-shrink: 0;
}

.srd-chev.open {
  transform: rotate(90deg);
}

.srd-path {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--codesema-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.srd-flex1 {
  flex: 1;
}

.srd-cmt {
  font-size: 11px;
  color: var(--codesema-ink-3);
  flex-shrink: 0;
}

.srd-delta {
  font-family: var(--font-mono);
  font-size: 11.5px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.srd-delta-add {
  color: var(--codesema-risk-low);
}

.srd-delta-del {
  color: var(--codesema-risk-high);
}

.srd-delta-sep {
  color: var(--codesema-ink-3);
}

/* file body */
.srd-body {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
}

/* gap bar */
.srd-gap {
  background: var(--codesema-line-2);
  color: var(--codesema-ink-3);
  padding: 5px 16px;
  font-size: 11px;
  border-bottom: 1px solid var(--codesema-line);
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
}

.srd-gap-ic {
  opacity: 0.6;
}

/* unified view */
.srd-unified {
  display: flex;
  flex-direction: column;
}

.srd-uline {
  display: flex;
  align-items: flex-start;
}

.srd-uline-ctx {
  background: var(--codesema-panel);
}

.srd-uline-add {
  background: var(--codesema-diff-add);
}

.srd-uline-add .srd-no {
  background: var(--codesema-diff-add-gut);
}

.srd-uline-del {
  background: var(--codesema-diff-del);
}

.srd-uline-del .srd-no {
  background: var(--codesema-diff-del-gut);
}

.srd-uline-add .srd-sign {
  color: var(--codesema-risk-low);
}

.srd-uline-del .srd-sign {
  color: var(--codesema-risk-high);
}

.srd-uline-del .srd-code {
  color: color-mix(in srgb, var(--codesema-risk-high) 70%, var(--codesema-ink-2));
}

/* split view */
.srd-split {
  display: flex;
  flex-direction: column;
}

.srd-row {
  display: flex;
  min-width: 0;
}

.srd-split-note-row {
}

.srd-cell {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  border-right: 1px solid var(--codesema-line);
}

.srd-cell:last-child {
  border-right: 0;
}

.srd-cell-ctx {
  background: var(--codesema-panel);
}

.srd-cell-add {
  background: var(--codesema-diff-add);
}

.srd-cell-add .srd-no {
  background: var(--codesema-diff-add-gut);
}

.srd-cell-add .srd-sign {
  color: var(--codesema-risk-low);
}

.srd-cell-del {
  background: var(--codesema-diff-del);
}

.srd-cell-del .srd-no {
  background: var(--codesema-diff-del-gut);
}

.srd-cell-del .srd-sign {
  color: var(--codesema-risk-high);
}

.srd-cell-del .srd-code {
  color: color-mix(in srgb, var(--codesema-risk-high) 70%, var(--codesema-ink-2));
}

.srd-cell-nil {
  background: repeating-linear-gradient(
    45deg,
    var(--codesema-line-2),
    var(--codesema-line-2) 6px,
    var(--codesema-bg) 6px,
    var(--codesema-bg) 12px
  );
}

/* line numbers + sign */
.srd-no {
  width: 38px;
  flex-shrink: 0;
  text-align: right;
  padding: 0 8px;
  color: var(--codesema-ink-3);
  user-select: none;
  font-size: 11px;
  line-height: inherit;
}

.srd-uline .srd-no {
  width: 34px;
}

.srd-sign {
  width: 12px;
  flex-shrink: 0;
  user-select: none;
  text-align: center;
  line-height: inherit;
}

.srd-code {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  padding-right: 10px;
  color: var(--codesema-ink);
  line-height: inherit;
}

/* note card */
.nlr-note {
  background: var(--codesema-panel);
  border: 1px solid var(--codesema-line);
  border-left-width: 3px;
  border-radius: 0 9px 9px 0;
  margin: 8px 12px 10px;
  padding: 11px 13px;
  font-family: var(--font-sans);
}

.nlr-note-inline {
  margin-left: 0;
  margin-right: 0;
  border-radius: 0;
  border-left-width: 3px;
  border-right: none;
}

.nlr-note-split {
  margin-left: 0;
  margin-right: 0;
  border-radius: 0;
  border-left-width: 3px;
  border-right: none;
}

.nlr-note-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 7px;
}

.nlr-mark {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--codesema-accent);
  color: #fff;
  font-family: var(--font-display);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.nlr-name {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--codesema-ink);
}

.nlr-kind {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 999px;
  padding: 2px 9px;
}

.nlr-consensus {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 999px;
  padding: 2px 9px;
  color: var(--codesema-risk-low);
  background: var(--codesema-risk-low-soft);
}

.nlr-consensus-dots {
  position: relative;
  width: 11px;
  height: 8px;
  flex-shrink: 0;
}

.nlr-consensus-dots span {
  position: absolute;
  top: 1px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.nlr-consensus-dots span:first-child {
  left: 0;
}

.nlr-consensus-dots span:last-child {
  left: 5px;
  opacity: 0.65;
}

.nlr-note-title {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 3px 0;
  color: var(--codesema-ink);
}

.nlr-note-body {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--codesema-ink-2);
  margin: 0;
}

.nlr-note code,
.nlr-note-title code {
  font-family: var(--font-mono);
  font-size: 0.85em;
  background: var(--codesema-line-2);
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--codesema-accent);
}

.nlr-note-sep {
  height: 1px;
  background: var(--codesema-line);
  margin: 10px 0;
}

.nlr-note--flash {
  animation: nlr-flash 1.6s ease;
}

@keyframes nlr-flash {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--codesema-accent) 60%, transparent);
  }
  35% {
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--codesema-accent) 45%, transparent);
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}

/* suggested fix */
.nlr-sugg {
  margin-top: 11px;
  border: 1px solid var(--codesema-line);
  border-radius: 8px;
  overflow: hidden;
}

.nlr-sugg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--codesema-risk-low-soft);
  color: var(--codesema-risk-low);
  padding: 6px 11px;
  font-size: 11px;
  font-weight: 700;
  font-family: var(--font-sans);
}

.nlr-sugg-code {
  margin: 0;
  padding: 10px 12px;
  background: var(--codesema-line-2);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--codesema-ink);
  white-space: pre-wrap;
  word-break: break-word;
}

.nlr-sugg-code code {
  background: none;
  padding: 0;
  color: inherit;
  font-size: inherit;
}

/* mobile density (<= 640px) */
@media (max-width: 640px) {
  .srd-body {
    font-size: 11.5px;
  }
  .srd-no {
    width: 30px;
    padding: 0 5px;
  }
  .srd-uline .srd-no {
    width: 28px;
  }
  .nlr-note {
    margin: 8px 8px 10px;
    padding: 10px 11px;
  }
}
</style>
