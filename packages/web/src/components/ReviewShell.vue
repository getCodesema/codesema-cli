<script setup lang="ts">
// ReviewShell — page unique de review : header, onglets Chapitres / Fichiers,
// vue d'ensemble (prologue + liste des chapitres), mode guidé, explorateur de fichiers.

import { computed, onUnmounted, ref } from 'vue'
import type { Finding } from '../composables/useDiff'
import { parseDiff, sameFile } from '../composables/useDiff'
import { buildFixPrompt, isActionable } from '../composables/useFixPrompt'
import { useReviewProgress } from '../composables/useReviewProgress'
import type { ReviewRecord } from '../types'
import ReviewPrologue from './ReviewPrologue.vue'
import ChapterList from './ChapterList.vue'
import ChapterReview from './ChapterReview.vue'
import DiffView from './DiffView.vue'
import FileTree from './FileTree.vue'

const props = defineProps<{
  record: ReviewRecord
}>()

const isClient = typeof window !== 'undefined'

// ── Données dérivées du record ─────────────────────────────────

const meta = computed(() => props.record.meta)
const findings = computed<Finding[]>(() => props.record.review.findings)
const narrative = computed(() => props.record.review.narrative)
// check: null (contrat) normalisé en undefined (attendu par les composants)
const chapters = computed(() =>
  (narrative.value?.chapters ?? []).map((ch) => ({ ...ch, check: ch.check ?? undefined })),
)
const hasChapters = computed(() => chapters.value.length > 0)
const reviewFirst = computed(() => narrative.value?.review_first ?? [])

const parsedDiff = computed(() => parseDiff(props.record.diff, findings.value))
const unmatched = computed(() => parsedDiff.value.unmatched)
const filesCount = computed(() => parsedDiff.value.files.length)

const globalDelta = computed(() => {
  let add = 0
  let del = 0
  for (const f of parsedDiff.value.files) {
    add += f.addCount
    del += f.delCount
  }
  return { add, del }
})

const VERDICT_META: Record<string, { labelKey: string; cls: string }> = {
  approve: { labelKey: 'verdict.approve', cls: 'sr-verdict--approve' },
  request_changes: { labelKey: 'verdict.request_changes', cls: 'sr-verdict--changes' },
  comment: { labelKey: 'verdict.comment', cls: 'sr-verdict--comment' },
}

const verdictMeta = computed(() => VERDICT_META[props.record.review.verdict] ?? VERDICT_META.comment!)

// ── Copie du prompt de fix (clipboard) ─────────────────────────

const actionableCount = computed(() => findings.value.filter(isActionable).length)

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copyFixPrompt() {
  try {
    await navigator.clipboard.writeText(buildFixPrompt(props.record))
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    // clipboard indisponible : pas de feedback
  }
}

onUnmounted(() => clearTimeout(copiedTimer))

// ── Progression lu / checks (localStorage, clé par review) ─────

const progressKey = `${props.record.meta.branch}:${props.record.meta.created_at}`
const { readSet, checkedSet, toggleRead, toggleChecked } = useReviewProgress(progressKey)

// ── Onglets + mode guidé ───────────────────────────────────────

const activeTab = ref<'chapters' | 'files'>('chapters')

const guidedIndex = ref<number | null>(null)
const isGuidedMode = computed(() => guidedIndex.value !== null)

function onChapterSelect(index: number) {
  guidedIndex.value = index
  syncHash()
}
function onGuidedBack() {
  guidedIndex.value = null
  syncHash()
}
function onGuidedNavigate(index: number) {
  guidedIndex.value = index
  syncHash()
}

// Deep-linking : #files / #chapter-N (état initial + partage d'URL)
function syncHash() {
  if (!isClient) return
  const hash = activeTab.value === 'files' ? '#files' : guidedIndex.value !== null ? `#chapter-${guidedIndex.value}` : ''
  history.replaceState(null, '', hash || location.pathname)
}

if (isClient) {
  const m = /^#chapter-(\d+)$/.exec(location.hash)
  if (location.hash === '#files') activeTab.value = 'files'
  else if (m && Number(m[1]) < chapters.value.length) guidedIndex.value = Number(m[1])
}

// ── Fichiers hors chapitres (vue d'ensemble sans chapitre) ─────

const otherFiles = computed(() => {
  if (!hasChapters.value) return []
  const covered = chapters.value.flatMap((ch) => ch.files)
  return parsedDiff.value.files.filter((f) => !covered.some((c) => sameFile(c, f.path)))
})

// ── Onglet Fichiers : split/unifié + replier + scroll-to-file ──

const FILES_SPLIT_KEY = 'mr-review-diff-mode'

const filesDiffMode = ref<'split' | 'unified'>(
  isClient ? ((localStorage.getItem(FILES_SPLIT_KEY) as 'split' | 'unified') ?? 'unified') : 'unified',
)

function setFilesDiffMode(m: 'split' | 'unified') {
  filesDiffMode.value = m
  if (isClient) localStorage.setItem(FILES_SPLIT_KEY, m)
}

const filesCollapseKey = ref(0)
const filesAllCollapsed = computed(() => filesCollapseKey.value % 2 === 1)
function toggleFilesCollapse() {
  filesCollapseKey.value++
}

const fileScrollRefs = new Map<string, HTMLElement>()
function setFileScrollRef(path: string, el: unknown) {
  if (el instanceof HTMLElement) fileScrollRefs.set(path, el)
  else fileScrollRefs.delete(path)
}
function onFilePick(path: string) {
  fileScrollRefs.get(path)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ── Sévérités (remarques générales) ────────────────────────────

const SEV_CLS: Record<string, string> = {
  critical: 'sr-sev--high',
  major: 'sr-sev--high',
  minor: 'sr-sev--med',
  info: 'sr-sev--info',
}
</script>

<template>
  <div class="sr-root">

    <!-- ── Header ─────────────────────────────────────────────── -->
    <header class="sr-header">
      <div class="sr-header-main">
        <h1 class="sr-title">{{ meta.title }}</h1>
        <div class="sr-branches">
          <code>{{ meta.branch }}</code>
          <span class="sr-branch-arrow">→</span>
          <code>{{ meta.target }}</code>
        </div>
      </div>
      <button
        v-if="actionableCount > 0"
        class="sr-copy-btn"
        :class="{ 'sr-copy-btn--done': copied }"
        @click="copyFixPrompt"
      >
        {{ copied ? $t('header.copied') : $t('header.copyPrompt', { n: actionableCount }) }}
      </button>
      <span class="sr-verdict" :class="verdictMeta!.cls">{{ $t(verdictMeta!.labelKey) }}</span>
    </header>

    <!-- ── Onglets ────────────────────────────────────────────── -->
    <div class="sr-tabs" role="tablist">
      <button
        role="tab"
        class="sr-tab"
        :class="{ on: activeTab === 'chapters' }"
        :aria-selected="activeTab === 'chapters'"
        @click="activeTab = 'chapters'; syncHash()"
      >
        {{ $t('app.tabChapters') }}
        <span v-if="chapters.length > 0" class="sr-tab-n">{{ chapters.length }}</span>
      </button>
      <button
        role="tab"
        class="sr-tab"
        :class="{ on: activeTab === 'files' }"
        :aria-selected="activeTab === 'files'"
        @click="activeTab = 'files'; guidedIndex = null; syncHash()"
      >
        {{ $t('app.tabFiles') }}
        <span v-if="filesCount > 0" class="sr-tab-n">{{ filesCount }}</span>
      </button>
      <span class="sr-tabs-spacer" />
      <span class="sr-tabs-delta">
        <span class="sr-add">+{{ globalDelta.add }}</span>
        <span class="sr-del">−{{ globalDelta.del }}</span>
      </span>
    </div>

    <!-- ── Onglet Chapitres ───────────────────────────────────── -->
    <div v-show="activeTab === 'chapters'" class="sr-stage">

      <!-- Mode guidé -->
      <ChapterReview
        v-if="isGuidedMode && hasChapters && record.diff"
        :chapters="chapters"
        :findings="findings"
        :diff="record.diff"
        :selected-index="guidedIndex!"
        :read-set="readSet"
        :checked-set="checkedSet"
        @back="onGuidedBack"
        @toggle-read="toggleRead"
        @toggle-checked="toggleChecked"
        @navigate="onGuidedNavigate"
      />

      <!-- Vue d'ensemble -->
      <template v-else>
        <div class="sr-cols">
          <div class="sr-col-left">
            <ReviewPrologue
              :prologue="narrative?.prologue"
              :review-first="reviewFirst"
              :intent="narrative?.intent"
              :confidence="narrative?.confidence"
              :summary="record.review.summary"
            />

            <!-- Remarques générales (non rattachées à un fichier du diff) -->
            <div v-if="unmatched.length" class="sr-general">
              <div class="sr-general-tag">{{ $t('reviews.generalNotes') }}</div>
              <ul class="sr-general-list">
                <li v-for="(f, i) in unmatched" :key="i" class="sr-general-item">
                  <span class="sr-sev" :class="SEV_CLS[f.severity] ?? 'sr-sev--info'">{{ f.severity }}</span>
                  <code v-if="f.file" class="sr-general-file">{{ f.file }}<template v-if="f.line">:{{ f.line }}</template></code>
                  {{ f.message }}
                  <pre v-if="f.suggestion" class="sr-general-sugg">{{ f.suggestion }}</pre>
                </li>
              </ul>
            </div>
          </div>

          <div class="sr-col-right">
            <ChapterList
              :chapters="chapters"
              :parsed-diff="parsedDiff"
              :read-set="readSet"
              @select="onChapterSelect"
            />
          </div>
        </div>

        <!-- Sans chapitres : diff annoté complet -->
        <div v-if="!hasChapters && record.diff" class="sr-flat-diff">
          <div class="sr-general-tag">{{ $t('reviews.annotatedDiff') }}</div>
          <DiffView :files="parsedDiff.files" />
        </div>

        <!-- Fichiers non couverts par les chapitres -->
        <div v-if="hasChapters && otherFiles.length" class="sr-flat-diff">
          <div class="sr-general-tag">{{ $t('reviews.otherChanges') }}</div>
          <DiffView :files="otherFiles" />
        </div>
      </template>

    </div>

    <!-- ── Onglet Fichiers ────────────────────────────────────── -->
    <div v-show="activeTab === 'files'" class="sr-stage sr-files-stage">
      <div v-if="record.diff" class="sr-files-layout">
        <FileTree
          :files="parsedDiff.files"
          :findings="findings"
          @pick="onFilePick"
        />

        <div class="sr-files-right">
          <div class="sr-files-toolbar">
            <button class="sr-files-tbtn" @click="toggleFilesCollapse">
              {{ filesAllCollapsed ? $t('fileTree.expandAll') : $t('fileTree.collapseAll') }}
            </button>
            <div class="sr-files-seg">
              <button :class="{ on: filesDiffMode === 'unified' }" @click="setFilesDiffMode('unified')">
                {{ $t('diffView.modeUnified') }}
              </button>
              <button :class="{ on: filesDiffMode === 'split' }" @click="setFilesDiffMode('split')">
                {{ $t('diffView.modeSplit') }}
              </button>
            </div>
            <span class="sr-tabs-spacer" />
            <span class="sr-tabs-delta">
              <span class="sr-add">+{{ globalDelta.add }}</span>
              <span class="sr-del">−{{ globalDelta.del }}</span>
            </span>
          </div>

          <div class="sr-files-difflist">
            <div
              v-for="file in parsedDiff.files"
              :key="file.path"
              :ref="(el) => setFileScrollRef(file.path, el)"
            >
              <DiffView
                :files="[file]"
                :mode="filesDiffMode"
                :collapse-key="filesCollapseKey"
                hide-toolbar
              />
            </div>
          </div>
        </div>
      </div>
      <p v-else class="nolyra-muted sr-empty-msg">{{ $t('reviews.noDiff') }}</p>
    </div>

  </div>
</template>

<style scoped>
.sr-root {
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 0 60px;
}

/* ── Header ─────────────────────────────────────────────────── */
.sr-header {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 26px 26px 18px;
}

.sr-header-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.sr-title {
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 500;
  letter-spacing: -0.01em;
  margin: 0;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.sr-branches {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--nolyra-ink-3);
}

.sr-branches code {
  background: var(--nolyra-line-2);
  border-radius: 6px;
  padding: 2px 8px;
  color: var(--nolyra-ink-2);
}

.sr-branch-arrow {
  color: var(--nolyra-ink-3);
}

.sr-verdict {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 700;
  border-radius: 999px;
  padding: 5px 13px;
  border: 1px solid transparent;
  margin-top: 4px;
}

.sr-verdict--approve {
  color: var(--nolyra-risk-low);
  background: var(--nolyra-risk-low-soft);
}

.sr-verdict--changes {
  color: var(--nolyra-risk-high);
  background: var(--nolyra-risk-high-soft);
}

.sr-verdict--comment {
  color: var(--nolyra-amber);
  background: var(--nolyra-amber-soft);
}

.sr-copy-btn {
  flex-shrink: 0;
  margin-top: 4px;
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--nolyra-line);
  background: var(--nolyra-panel);
  color: var(--nolyra-ink-2);
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.12s ease, color 0.12s ease;
}

.sr-copy-btn:hover {
  border-color: var(--nolyra-ink-3);
}

.sr-copy-btn--done {
  color: var(--nolyra-risk-low);
  border-color: var(--nolyra-risk-low);
}

/* ── Onglets ────────────────────────────────────────────────── */
.sr-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 26px;
  border-bottom: 1px solid var(--nolyra-line);
}

.sr-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 10px 12px;
  margin-bottom: -1px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--nolyra-ink-3);
  cursor: pointer;
  transition: color 0.12s ease;
}

.sr-tab:hover {
  color: var(--nolyra-ink);
}

.sr-tab.on {
  color: var(--nolyra-ink);
  border-bottom-color: var(--nolyra-accent);
}

.sr-tab-n {
  font-family: var(--font-mono);
  font-size: 10.5px;
  background: var(--nolyra-line-2);
  border-radius: 999px;
  padding: 1px 7px;
  color: var(--nolyra-ink-3);
}

.sr-tabs-spacer {
  flex: 1;
}

.sr-tabs-delta {
  font-family: var(--font-mono);
  font-size: 11.5px;
  display: inline-flex;
  gap: 6px;
}

.sr-add {
  color: var(--nolyra-risk-low);
}

.sr-del {
  color: var(--nolyra-risk-high);
}

/* ── Stage ──────────────────────────────────────────────────── */
.sr-stage {
  min-height: 40vh;
}

/* Vue d'ensemble : 2 colonnes */
.sr-cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);
  gap: 0;
  align-items: start;
}

.sr-col-left {
  min-width: 0;
}

.sr-col-right {
  border-left: 1px solid var(--nolyra-line);
  min-height: 100%;
}

@media (max-width: 900px) {
  .sr-cols {
    grid-template-columns: 1fr;
  }
  .sr-col-right {
    border-left: none;
    border-top: 1px solid var(--nolyra-line);
  }
}

/* Remarques générales */
.sr-general {
  padding: 0 26px 24px;
}

.sr-general-tag {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--nolyra-accent);
  margin-bottom: 10px;
}

.sr-general-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sr-general-item {
  border-left: 2px solid var(--nolyra-line);
  padding-left: 12px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--nolyra-ink-2);
}

.sr-sev {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  margin-right: 8px;
}

.sr-sev--high {
  color: var(--nolyra-risk-high);
}

.sr-sev--med {
  color: var(--nolyra-risk-med);
}

.sr-sev--info {
  color: var(--nolyra-ink-3);
}

.sr-general-file {
  font-family: var(--font-mono);
  font-size: 11px;
  margin-right: 6px;
  color: var(--nolyra-ink-3);
}

.sr-general-sugg {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 7px;
  background: var(--nolyra-risk-low-soft);
  color: var(--nolyra-risk-low);
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Diff plat (sans chapitres / autres fichiers) */
.sr-flat-diff {
  padding: 24px 26px 0;
}

/* ── Onglet Fichiers ────────────────────────────────────────── */
.sr-files-stage {
  min-height: 60vh;
}

.sr-files-layout {
  display: flex;
  align-items: stretch;
  min-height: calc(100vh - 160px);
}

.sr-files-right {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.sr-files-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--nolyra-line);
}

.sr-files-tbtn {
  font-size: 12px;
  padding: 6px 11px;
  border-radius: 8px;
  border: 1px solid var(--nolyra-line);
  background: var(--nolyra-panel);
  color: var(--nolyra-ink-2);
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.sr-files-tbtn:hover {
  border-color: var(--nolyra-ink-3);
}

.sr-files-seg {
  display: inline-flex;
  background: var(--nolyra-panel);
  border: 1px solid var(--nolyra-line);
  border-radius: 9px;
  padding: 2px;
  gap: 2px;
}

.sr-files-seg button {
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 7px;
  color: var(--nolyra-ink-2);
  font-weight: 500;
  border: none;
  background: none;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.12s, color 0.12s;
}

.sr-files-seg button.on {
  background: var(--nolyra-ink);
  color: var(--nolyra-bg);
}

.sr-files-difflist {
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.sr-empty-msg {
  padding: 32px 26px;
  font-size: 13px;
}

@media (max-width: 900px) {
  .sr-files-layout {
    flex-direction: column;
  }
}
</style>
