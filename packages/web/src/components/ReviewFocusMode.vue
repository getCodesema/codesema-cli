<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { DiffFile, Finding, FindingSeverity } from '../composables/useDiff'
import { buildFixPrompt } from '../composables/useFixPrompt'
import { excerptFor } from '../composables/useFocusList'
import { G } from '../glyphs'
import type { FixStatus, ReviewRecord } from '../types'

const props = defineProps<{
  record: ReviewRecord
  /** Actionable findings only, already sorted (see actionableFindings). */
  list: Finding[]
  files: DiffFile[]
}>()

function listIds(): number[] {
  return props.list.flatMap((f) => (f.id == null ? [] : [f.id]))
}

const selected = ref<Set<number>>(new Set(listIds()))
const cursor = ref(0)

const current = computed(() => props.list[cursor.value] ?? null)
const excerpt = computed(() => (current.value ? excerptFor(props.files, current.value) : null))
const selectedCount = computed(() => selected.value.size)

function toggle(id: number) {
  const next = new Set(selected.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selected.value = next
}

function selectAll() {
  selected.value = new Set(listIds())
}

function selectNone() {
  selected.value = new Set()
}

const canPrev = computed(() => cursor.value > 0)
const canNext = computed(() => cursor.value < props.list.length - 1)

function goPrev() {
  if (canPrev.value) {
    cursor.value--
  }
}
function goNext() {
  if (canNext.value) {
    cursor.value++
  }
}

watch(
  () => props.list,
  (list) => {
    if (cursor.value >= list.length) {
      cursor.value = Math.max(0, list.length - 1)
    }
  },
)

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copySelection() {
  try {
    await navigator.clipboard.writeText(buildFixPrompt(props.record, [...selected.value]))
    copied.value = true
    if (copiedTimer) {
      clearTimeout(copiedTimer)
    }
    copiedTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    // clipboard unavailable: no feedback
  }
}

// ── Run fixes through the local CLI server ─────────────────────
const isClient = typeof window !== 'undefined'
const fixToken = isClient
  ? (window as { __CODESEMA_FIX_TOKEN__?: string }).__CODESEMA_FIX_TOKEN__
  : undefined

const fixStatus = ref<FixStatus | null>(null)
const fixRequestError = ref<string | null>(null)
let pollTimer: ReturnType<typeof setInterval> | undefined

const fixDetail = computed(() => (fixStatus.value?.available ? fixStatus.value : null))
const fixAvailable = computed(() => Boolean(fixToken) && fixDetail.value !== null)
const fixRunning = computed(() => fixDetail.value?.phase === 'running')

function stopPolling() {
  if (!pollTimer) {
    return
  }
  clearInterval(pollTimer)
  pollTimer = undefined
}

function startPolling() {
  if (!pollTimer) {
    pollTimer = setInterval(() => void refreshFixStatus(), 1500)
  }
}

async function refreshFixStatus(): Promise<void> {
  try {
    const res = await fetch('/api/fix/status')
    if (!res.ok) {
      return
    }
    const status = (await res.json()) as FixStatus
    fixStatus.value = status
    if (status.available && status.phase === 'running') {
      startPolling()
    } else {
      stopPolling()
    }
  } catch {
    // local server stopped (Ctrl+C): keep the last known state
  }
}

async function runFixes() {
  if (!fixToken || selectedCount.value === 0 || fixRunning.value) {
    return
  }
  fixRequestError.value = null
  try {
    const res = await fetch('/api/fix', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-codesema-fix-token': fixToken },
      body: JSON.stringify({ findings: [...selected.value] }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      fixRequestError.value = body?.error ?? `HTTP ${res.status}`
      return
    }
    await refreshFixStatus()
    startPolling()
  } catch (err) {
    fixRequestError.value = err instanceof Error ? err.message : String(err)
  }
}

onMounted(() => void refreshFixStatus())

onUnmounted(() => {
  clearTimeout(copiedTimer)
  stopPolling()
})

const SEV_LABEL_KEY: Record<FindingSeverity, string> = {
  critical: 'diffView.sevCritical',
  major: 'diffView.sevMajor',
  minor: 'diffView.sevMinor',
  info: 'diffView.sevInfo',
}

const KIND_LABEL: Partial<Record<string, string>> = {
  security: 'diffView.kindSecurity',
  perf: 'diffView.kindPerf',
  convention: 'diffView.kindConvention',
  design: 'diffView.kindDesign',
}

function isTarget(rowLine: number | null, rowOld: number | null, rowKind: string): boolean {
  const f = current.value
  if (!f || f.line == null) {
    return false
  }
  const end = f.endLine ?? f.line
  if (rowLine != null) {
    return rowLine >= f.line && rowLine <= end
  }
  return rowKind === 'del' && rowOld === f.line
}

function richParts(s: string): { text: string; isCode: boolean }[] {
  return s.split(/(`[^`]+`)/g).map((p) => ({
    text: p.startsWith('`') && p.endsWith('`') ? p.slice(1, -1) : p,
    isCode: p.startsWith('`') && p.endsWith('`'),
  }))
}
</script>

<template>
  <div v-if="list.length === 0" class="fv-empty">
    <p class="empty">{{ $t('focus.empty') }}</p>
  </div>

  <div v-else class="fv-root">
    <aside class="fv-list">
      <div class="fv-list-head">
        <span class="fv-list-title">
          {{ $t('focus.title') }}
          <span class="fv-list-n">{{ list.length }}</span>
        </span>
        <span class="fv-list-spacer" />
        <button class="fv-sel-btn btn ghost" @click="selectAll">
          {{ $t('focus.selectAll') }}
        </button>
        <button class="fv-sel-btn btn ghost" @click="selectNone">
          {{ $t('focus.selectNone') }}
        </button>
      </div>

      <div class="fv-items">
        <div
          v-for="(f, i) in list"
          :key="f.id"
          class="fv-item"
          :class="{ 'fv-item--on': i === cursor }"
          role="button"
          tabindex="0"
          @click="cursor = i"
          @keydown.enter="cursor = i"
        >
          <button
            class="fv-check btn ghost"
            :class="{ 'fv-check--done': selected.has(f.id!) }"
            :aria-pressed="selected.has(f.id!)"
            @click.stop="toggle(f.id!)"
          >
            <span aria-hidden="true">{{ selected.has(f.id!) ? G.ok : G.pending }}</span>
          </button>
          <div class="fv-item-body">
            <div class="fv-item-top">
              <span class="fv-sev sev" :data-v="f.severity">{{
                $t(SEV_LABEL_KEY[f.severity])
              }}</span>
              <span v-if="f.consensus" class="fv-consensus" :title="$t('finding.consensus')">
                <span class="fv-consensus-dots" aria-hidden="true">{{ G.dot }}{{ G.dot }}</span>
              </span>
              <span class="fv-item-title">{{ f.title ?? f.message }}</span>
            </div>
            <code class="fv-item-file"
              >{{ f.file }}<template v-if="f.line">:{{ f.line }}</template></code
            >
          </div>
        </div>
      </div>

      <div class="fv-list-foot">
        <div
          v-if="fixAvailable && fixDetail?.head_moved && fixDetail.phase !== 'done'"
          class="fv-warn"
        >
          {{ $t('focus.headMoved') }}
        </div>
        <button
          v-if="fixAvailable"
          class="fv-run btn primary"
          :disabled="selectedCount === 0 || fixRunning"
          @click="runFixes"
        >
          <span v-if="fixRunning" class="fv-run-spin status" data-s="running" />
          {{ fixRunning ? $t('focus.fixRunning') : $t('focus.runFixes', { n: selectedCount }) }}
        </button>
        <button
          class="fv-copy btn"
          :class="{ 'fv-copy--done': copied }"
          :disabled="selectedCount === 0"
          @click="copySelection"
        >
          {{ copied ? $t('header.copied') : $t('focus.copySelected', { n: selectedCount }) }}
        </button>
        <p v-if="fixRequestError" class="fv-fix-error">
          {{ $t('focus.fixFailed') }} · {{ fixRequestError }}
        </p>
        <div v-if="fixDetail?.phase === 'done'" class="fv-fix-done">
          <div class="fv-fix-done-head">
            <span aria-hidden="true">{{ G.ok }}</span> {{ $t('focus.fixDone') }}
          </div>
          <pre v-if="fixDetail.summary" class="fv-fix-summary">{{ fixDetail.summary }}</pre>
        </div>
        <p v-else-if="fixDetail?.phase === 'error'" class="fv-fix-error">
          {{ $t('focus.fixFailed')
          }}<template v-if="fixDetail.error"> · {{ fixDetail.error }}</template>
        </p>
      </div>
    </aside>

    <section v-if="current" class="fv-detail">
      <div class="fv-nav">
        <span class="fv-count">
          {{ $t('focus.problem') }} {{ cursor + 1 }}
          <span class="fv-count-total">/ {{ list.length }}</span>
        </span>
        <span class="fv-nav-spacer" />
        <button
          class="fv-arrow btn"
          :disabled="!canPrev"
          :title="$t('focus.prev')"
          :aria-label="$t('focus.prev')"
          @click="goPrev"
        >
          <span aria-hidden="true">{{ G.back }}</span>
        </button>
        <button
          class="fv-arrow btn"
          :disabled="!canNext"
          :title="$t('focus.next')"
          :aria-label="$t('focus.next')"
          @click="goNext"
        >
          <span aria-hidden="true">{{ G.arrow }}</span>
        </button>
      </div>

      <div class="fv-note note" :data-kind="current.kind">
        <div class="fv-note-head">
          <span class="fv-sev sev" :data-v="current.severity">{{
            $t(SEV_LABEL_KEY[current.severity])
          }}</span>
          <span v-if="current.kind && KIND_LABEL[current.kind]" class="fv-kind">{{
            $t(KIND_LABEL[current.kind]!)
          }}</span>
          <span v-if="current.consensus" class="fv-consensus fv-consensus--pill">
            <span class="fv-consensus-dots" aria-hidden="true">{{ G.dot }}{{ G.dot }}</span>
            {{ $t('finding.consensus') }}
          </span>
          <code class="fv-note-file"
            >{{ current.file }}<template v-if="current.line">:{{ current.line }}</template></code
          >
        </div>
        <p v-if="current.title" class="fv-note-title">
          <template v-for="(part, j) in richParts(current.title)" :key="j">
            <code v-if="part.isCode">{{ part.text }}</code>
            <template v-else>{{ part.text }}</template>
          </template>
        </p>
        <p class="fv-note-body">
          <template v-for="(part, j) in richParts(current.message)" :key="j">
            <code v-if="part.isCode">{{ part.text }}</code>
            <template v-else>{{ part.text }}</template>
          </template>
        </p>
        <div v-if="current.suggestion" class="fv-sugg">
          <div class="fv-sugg-head">{{ $t('diffView.suggestionLabel') }}</div>
          <pre class="fv-sugg-code"><code>{{ current.suggestion }}</code></pre>
        </div>
      </div>

      <div v-if="excerpt" class="fv-code">
        <div class="fv-code-head">
          <code>{{ current.file }}</code>
        </div>
        <div class="fv-code-body">
          <div
            v-for="(row, ri) in excerpt"
            :key="ri"
            class="fv-line"
            :class="[
              row.t === 'add' ? 'fv-line--add' : row.t === 'del' ? 'fv-line--del' : 'fv-line--ctx',
              { 'fv-line--target': isTarget(row.n, row.o, row.t) },
            ]"
          >
            <span class="fv-no">{{ row.n ?? row.o ?? '' }}</span>
            <span class="fv-sign">{{ row.t === 'add' ? '+' : row.t === 'del' ? '−' : ' ' }}</span>
            <span class="fv-src">{{ row.c || ' ' }}</span>
          </div>
        </div>
      </div>
      <p v-else class="fv-no-excerpt empty">{{ $t('focus.noExcerpt') }}</p>
    </section>
  </div>
</template>

<style scoped>
.fv-empty {
  padding: var(--row) 2ch;
}

.fv-root {
  display: flex;
  align-items: stretch;
  min-height: calc(100vh - var(--row) * 8);
}

.fv-list {
  width: 52ch;
  flex-shrink: 0;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
}

.fv-list-head {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  padding: calc(var(--row) / 2) 2ch;
}

.fv-list-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-dim);
  display: inline-flex;
  align-items: baseline;
  gap: 1ch;
}

.fv-list-n {
  font-size: 12px;
  color: var(--fg-dim);
}

.fv-list-spacer {
  flex: 1;
}

.fv-sel-btn {
  font-size: 12px;
  padding: 0 1ch;
}

.fv-sel-btn:hover {
  color: var(--accent);
  background: transparent;
}

.fv-items {
  flex: 1;
  overflow-y: auto;
  padding: 0 1ch;
  display: flex;
  flex-direction: column;
}

.fv-item {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  padding: calc(var(--row) / 2) 1ch;
  border-left: 2px solid transparent;
  cursor: pointer;
}

.fv-item:hover,
.fv-item:focus-visible {
  background: var(--bg-hover);
}

.fv-item--on {
  border-left-color: var(--accent);
  background: var(--bg-hover);
}

.fv-check {
  flex-shrink: 0;
  padding: 0 1ch;
}

.fv-check--done {
  color: var(--accent);
}

.fv-item-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.fv-item-top {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  min-width: 0;
}

.fv-item-title {
  font-weight: 700;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.fv-item-file {
  font-size: 12px;
  color: var(--fg-dim);
  background: none;
  padding: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fv-sev {
  flex-shrink: 0;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.fv-consensus {
  flex-shrink: 0;
  display: inline-flex;
  align-items: baseline;
  gap: 1ch;
  color: var(--ok);
}

.fv-consensus--pill {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border: 1px solid currentColor;
  padding: 0 1ch;
}

.fv-consensus-dots {
  flex-shrink: 0;
  letter-spacing: -0.1em;
}

.fv-list-foot {
  padding: calc(var(--row) / 2) 2ch;
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}

.fv-copy--done {
  color: var(--ok);
  border-color: var(--ok);
}

.fv-warn {
  border: 1px solid var(--warn);
  color: var(--warn);
  font-size: 12px;
  padding: 2px 1ch;
}

.fv-run {
  display: inline-flex;
  align-items: baseline;
  justify-content: center;
  gap: 1ch;
}

.fv-fix-error {
  font-size: 12px;
  color: var(--err);
}

.fv-fix-done {
  border: 1px solid var(--ok);
  padding: 2px 1ch;
  display: flex;
  flex-direction: column;
}

.fv-fix-done-head {
  font-size: 12px;
  font-weight: 700;
  color: var(--ok);
}

.fv-fix-summary {
  margin: 0;
  font-size: 12px;
  color: var(--fg-dim);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: calc(var(--row) * 8);
  overflow-y: auto;
}

.fv-detail {
  flex: 1;
  min-width: 0;
  padding: var(--row) 2ch;
  display: flex;
  flex-direction: column;
  gap: var(--row);
}

.fv-nav {
  display: flex;
  align-items: baseline;
  gap: 1ch;
}

.fv-count {
  font-weight: 700;
}

.fv-count-total {
  color: var(--fg-dim);
  font-weight: 400;
}

.fv-nav-spacer {
  flex: 1;
}

.fv-arrow {
  padding: 0 1ch;
  color: var(--fg-dim);
}

.fv-note-head {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  flex-wrap: wrap;
}

.fv-kind {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border: 1px solid currentColor;
  padding: 0 1ch;
  color: var(--accent);
}

.fv-note-file {
  font-size: 12px;
  color: var(--fg-dim);
  background: none;
  padding: 0;
}

.fv-note-title {
  font-weight: 700;
  color: var(--fg);
}

.fv-note-body {
  color: var(--fg-dim);
}

.fv-note code,
.fv-note-title code {
  background: var(--bg-raised);
  padding: 0 0.5ch;
  color: var(--accent);
}

.fv-sugg {
  border: 1px solid var(--line);
}

.fv-sugg-head {
  color: var(--ok);
  padding: 0 1ch;
  font-size: 12px;
  font-weight: 700;
  border-bottom: 1px solid var(--line);
}

.fv-sugg-code {
  margin: 0;
  padding: 2px 1ch;
  background: var(--bg-raised);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.fv-code {
  border: 1px solid var(--line);
  background: var(--bg-raised);
}

.fv-code-head {
  padding: 0 2ch;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
}

.fv-code-head code {
  background: none;
  padding: 0;
}

.fv-code-body {
  font-size: 12px;
  overflow-x: auto;
}

.fv-line {
  display: flex;
  align-items: baseline;
  border-left: 2px solid transparent;
}

.fv-line--add {
  background: color-mix(in srgb, var(--ok) 14%, transparent);
}

.fv-line--del {
  background: color-mix(in srgb, var(--err) 14%, transparent);
}

.fv-line--target {
  border-left-color: var(--accent);
}

.fv-line--add .fv-sign {
  color: var(--ok);
}

.fv-line--del .fv-sign {
  color: var(--err);
}

.fv-no {
  width: 6ch;
  flex-shrink: 0;
  text-align: right;
  padding: 0 1ch;
  color: var(--fg-muted);
  user-select: none;
}

.fv-sign {
  width: 2ch;
  flex-shrink: 0;
  user-select: none;
  text-align: center;
}

.fv-src {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  padding-right: 1ch;
}

.fv-no-excerpt {
  margin: 0;
}

@media (max-width: 900px) {
  .fv-root {
    flex-direction: column;
  }
  .fv-list {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--line);
  }
}
</style>
