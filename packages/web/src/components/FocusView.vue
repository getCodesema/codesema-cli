<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { DiffFile, Finding, FindingSeverity } from '../composables/useDiff'
import { buildFixPrompt } from '../composables/useFixPrompt'
import { excerptFor } from '../composables/useFocusList'
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

type SevMeta = { labelKey: string; cls: string }

const SEV_META: Record<FindingSeverity, SevMeta> = {
  critical: { labelKey: 'diffView.sevCritical', cls: 'fv-sev--high' },
  major: { labelKey: 'diffView.sevMajor', cls: 'fv-sev--high' },
  minor: { labelKey: 'diffView.sevMinor', cls: 'fv-sev--med' },
  info: { labelKey: 'diffView.sevInfo', cls: 'fv-sev--info' },
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
    <p class="codesema-muted">{{ $t('focus.empty') }}</p>
  </div>

  <div v-else class="fv-root">
    <aside class="fv-list">
      <div class="fv-list-head">
        <span class="fv-list-title">
          {{ $t('focus.title') }}
          <span class="fv-list-n">{{ list.length }}</span>
        </span>
        <span class="fv-list-spacer" />
        <button class="fv-sel-btn" @click="selectAll">{{ $t('focus.selectAll') }}</button>
        <button class="fv-sel-btn" @click="selectNone">{{ $t('focus.selectNone') }}</button>
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
            class="fv-check"
            :class="{ 'fv-check--done': selected.has(f.id!) }"
            :aria-pressed="selected.has(f.id!)"
            @click.stop="toggle(f.id!)"
          >
            <span v-if="selected.has(f.id!)">✓</span>
          </button>
          <div class="fv-item-body">
            <div class="fv-item-top">
              <span class="fv-sev" :class="SEV_META[f.severity].cls">{{
                $t(SEV_META[f.severity].labelKey)
              }}</span>
              <span v-if="f.consensus" class="fv-consensus" :title="$t('finding.consensus')">
                <span class="fv-consensus-dots" aria-hidden="true"><span /><span /></span>
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
          class="fv-run"
          :disabled="selectedCount === 0 || fixRunning"
          @click="runFixes"
        >
          <span v-if="fixRunning" class="fv-run-spin" aria-hidden="true" />
          {{ fixRunning ? $t('focus.fixRunning') : $t('focus.runFixes', { n: selectedCount }) }}
        </button>
        <button
          class="fv-copy"
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
          <div class="fv-fix-done-head">✓ {{ $t('focus.fixDone') }}</div>
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
          class="fv-arrow"
          :disabled="!canPrev"
          :title="$t('focus.prev')"
          :aria-label="$t('focus.prev')"
          @click="goPrev"
        >
          ‹
        </button>
        <button
          class="fv-arrow"
          :disabled="!canNext"
          :title="$t('focus.next')"
          :aria-label="$t('focus.next')"
          @click="goNext"
        >
          ›
        </button>
      </div>

      <div class="fv-note">
        <div class="fv-note-head">
          <span class="fv-sev" :class="SEV_META[current.severity].cls">{{
            $t(SEV_META[current.severity].labelKey)
          }}</span>
          <span v-if="current.kind && KIND_LABEL[current.kind]" class="fv-kind">{{
            $t(KIND_LABEL[current.kind]!)
          }}</span>
          <span v-if="current.consensus" class="fv-consensus fv-consensus--pill">
            <span class="fv-consensus-dots" aria-hidden="true"><span /><span /></span>
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
      <p v-else class="fv-no-excerpt codesema-muted">{{ $t('focus.noExcerpt') }}</p>
    </section>
  </div>
</template>

<style scoped>
.fv-empty {
  padding: 40px 26px;
  font-size: 13px;
}

.fv-root {
  display: flex;
  align-items: stretch;
  min-height: calc(100vh - 170px);
}

/* ── Left: selectable list ─────────────────────────────────── */
.fv-list {
  width: 400px;
  flex-shrink: 0;
  border-right: 1px solid var(--codesema-line);
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--codesema-panel) 60%, var(--codesema-bg));
}

.fv-list-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 18px 10px;
}

.fv-list-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--codesema-ink-3);
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.fv-list-n {
  font-family: var(--font-mono);
  font-size: 10.5px;
  background: var(--codesema-line-2);
  border-radius: 999px;
  padding: 1px 7px;
  color: var(--codesema-ink-3);
}

.fv-list-spacer {
  flex: 1;
}

.fv-sel-btn {
  font-size: 11px;
  font-weight: 600;
  font-family: inherit;
  color: var(--codesema-ink-3);
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 4px;
  transition: color 0.12s ease;
}

.fv-sel-btn:hover {
  color: var(--codesema-accent);
}

.fv-items {
  flex: 1;
  overflow-y: auto;
  padding: 4px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.fv-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 11px;
  border: 1px solid transparent;
  border-radius: 10px;
  cursor: pointer;
  outline: none;
  transition:
    background 0.1s ease,
    border-color 0.1s ease;
}

.fv-item:hover,
.fv-item:focus-visible {
  background: color-mix(in srgb, var(--codesema-line-2) 80%, var(--codesema-bg));
}

.fv-item--on {
  border-color: var(--codesema-accent);
  background: var(--codesema-accent-soft);
}

.fv-check {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 5px;
  border: 1.5px solid var(--codesema-line);
  background: var(--codesema-panel);
  display: grid;
  place-items: center;
  cursor: pointer;
  font-size: 10px;
  color: #fff;
  font-weight: 700;
  transition:
    background 0.1s ease,
    border-color 0.1s ease;
}

.fv-check--done {
  background: var(--codesema-accent);
  border-color: var(--codesema-accent);
}

.fv-item-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.fv-item-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.fv-item-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--codesema-ink);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.fv-item-file {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--codesema-ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fv-sev {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-radius: 999px;
  padding: 2px 8px;
}

.fv-sev--high {
  color: var(--codesema-risk-high);
  background: var(--codesema-risk-high-soft);
}

.fv-sev--med {
  color: var(--codesema-risk-med);
  background: var(--codesema-risk-med-soft);
}

.fv-sev--info {
  color: var(--codesema-ink-3);
  background: var(--codesema-line-2);
}

.fv-consensus {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--codesema-risk-low);
}

.fv-consensus--pill {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 999px;
  padding: 2px 9px;
  background: var(--codesema-risk-low-soft);
}

.fv-consensus-dots {
  position: relative;
  width: 11px;
  height: 8px;
  flex-shrink: 0;
}

.fv-consensus-dots span {
  position: absolute;
  top: 1px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.fv-consensus-dots span:first-child {
  left: 0;
}

.fv-consensus-dots span:last-child {
  left: 5px;
  opacity: 0.65;
}

.fv-list-foot {
  padding: 12px 14px;
  border-top: 1px solid var(--codesema-line);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fv-copy {
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  color: var(--codesema-ink-2);
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    color 0.12s ease;
}

.fv-copy:hover:not(:disabled) {
  border-color: var(--codesema-ink-3);
}

.fv-copy:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.fv-copy--done {
  color: var(--codesema-risk-low);
  border-color: var(--codesema-risk-low);
}

.fv-warn {
  border: 1px solid color-mix(in srgb, var(--codesema-amber) 30%, transparent);
  border-radius: 8px;
  background: var(--codesema-amber-soft);
  color: var(--codesema-amber);
  font-size: 11.5px;
  line-height: 1.5;
  padding: 8px 10px;
}

.fv-run {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 700;
  font-family: inherit;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--codesema-accent);
  background: var(--codesema-accent);
  color: #fff;
  cursor: pointer;
  transition: opacity 0.12s ease;
}

.fv-run:hover:not(:disabled) {
  opacity: 0.9;
}

.fv-run:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.fv-run-spin {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, #fff 45%, transparent);
  border-top-color: #fff;
  animation: fv-spin 0.8s linear infinite;
}

@keyframes fv-spin {
  to {
    transform: rotate(360deg);
  }
}

.fv-fix-error {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--codesema-risk-high);
}

.fv-fix-done {
  border: 1px solid color-mix(in srgb, var(--codesema-risk-low) 35%, transparent);
  border-radius: 8px;
  background: var(--codesema-risk-low-soft);
  padding: 9px 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.fv-fix-done-head {
  font-size: 12px;
  font-weight: 700;
  color: var(--codesema-risk-low);
}

.fv-fix-summary {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--codesema-ink-2);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 180px;
  overflow-y: auto;
}

/* ── Right: focused problem ────────────────────────────────── */
.fv-detail {
  flex: 1;
  min-width: 0;
  padding: 16px 22px 60px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.fv-nav {
  display: flex;
  align-items: center;
  gap: 10px;
}

.fv-count {
  font-size: 13px;
  font-weight: 600;
  color: var(--codesema-ink);
}

.fv-count-total {
  color: var(--codesema-ink-3);
  font-weight: 400;
}

.fv-nav-spacer {
  flex: 1;
}

.fv-arrow {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  color: var(--codesema-ink-2);
  font-size: 15px;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: border-color 0.1s ease;
  font-family: inherit;
}

.fv-arrow:hover:not(:disabled) {
  border-color: var(--codesema-ink-3);
}

.fv-arrow:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.fv-note {
  border: 1px solid var(--codesema-line);
  border-radius: 12px;
  background: var(--codesema-panel);
  padding: 14px 16px;
}

.fv-note-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 9px;
}

.fv-kind {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 999px;
  padding: 2px 9px;
  color: var(--codesema-accent);
  background: var(--codesema-accent-soft);
}

.fv-note-file {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--codesema-ink-3);
}

.fv-note-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 4px;
  color: var(--codesema-ink);
}

.fv-note-body {
  font-size: 13px;
  line-height: 1.6;
  color: var(--codesema-ink-2);
  margin: 0;
  text-wrap: pretty;
}

.fv-note code,
.fv-note-title code {
  font-family: var(--font-mono);
  font-size: 0.85em;
  background: var(--codesema-line-2);
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--codesema-accent);
}

.fv-sugg {
  margin-top: 11px;
  border: 1px solid var(--codesema-line);
  border-radius: 8px;
  overflow: hidden;
}

.fv-sugg-head {
  background: var(--codesema-risk-low-soft);
  color: var(--codesema-risk-low);
  padding: 6px 11px;
  font-size: 11px;
  font-weight: 700;
}

.fv-sugg-code {
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

/* ── Code excerpt ──────────────────────────────────────────── */
.fv-code {
  border: 1px solid var(--codesema-line);
  border-radius: 10px;
  overflow: hidden;
  background: var(--codesema-panel);
}

.fv-code-head {
  padding: 8px 14px;
  background: var(--codesema-line-2);
  border-bottom: 1px solid var(--codesema-line);
  font-size: 11.5px;
}

.fv-code-head code {
  font-family: var(--font-mono);
  color: var(--codesema-ink);
}

.fv-code-body {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
}

.fv-line {
  display: flex;
  align-items: flex-start;
}

.fv-line--ctx {
  background: var(--codesema-panel);
}

.fv-line--add {
  background: var(--codesema-diff-add);
}

.fv-line--del {
  background: var(--codesema-diff-del);
}

.fv-line--target {
  box-shadow: inset 3px 0 0 var(--codesema-accent);
}

.fv-line--add .fv-sign {
  color: var(--codesema-risk-low);
}

.fv-line--del .fv-sign {
  color: var(--codesema-risk-high);
}

.fv-line--del .fv-src {
  color: color-mix(in srgb, var(--codesema-risk-high) 70%, var(--codesema-ink-2));
}

.fv-no {
  width: 38px;
  flex-shrink: 0;
  text-align: right;
  padding: 0 8px;
  color: var(--codesema-ink-3);
  user-select: none;
  font-size: 11px;
}

.fv-sign {
  width: 12px;
  flex-shrink: 0;
  user-select: none;
  text-align: center;
}

.fv-src {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  padding-right: 10px;
  color: var(--codesema-ink);
}

.fv-no-excerpt {
  font-size: 12.5px;
  margin: 0;
}

/* responsive */
@media (max-width: 900px) {
  .fv-root {
    flex-direction: column;
  }
  .fv-list {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--codesema-line);
  }
}
</style>
