<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DiffFile, Finding, HunkBlock, HunkLine, SplitRow } from '../composables/useDiff'
import { toSplit } from '../composables/useDiff'
import { t } from '../i18n'

const props = defineProps<{
  /** Fichiers déjà parsés (parseDiff/pickFiles chez l'appelant : un seul parse par vue). */
  files: DiffFile[]
  /** Mode split/unifié piloté depuis l'extérieur (toolbar onglet Fichiers).
   *  Si absent, DiffView gère son propre état localStorage. */
  mode?: 'split' | 'unified'
  /** Si vrai, masque la toolbar interne split/unifié (toolbar externe fournie). */
  hideToolbar?: boolean
  /** Clé de remount — quand elle change, les fichiers reprennent leur état par défaut (déplié). */
  collapseKey?: number
}>()

const isClient = typeof window !== 'undefined'

// ── Toggle split / unifié (préférence globale, persistée localStorage) ───────

const SPLIT_KEY = 'mr-review-diff-mode'

function loadMode(): 'split' | 'unified' {
  if (!isClient) return 'unified'
  return (localStorage.getItem(SPLIT_KEY) as 'split' | 'unified') ?? 'unified'
}

const internalMode = ref<'split' | 'unified'>(loadMode())

const diffMode = computed<'split' | 'unified'>(() => props.mode ?? internalMode.value)

function setMode(m: 'split' | 'unified') {
  internalMode.value = m
  if (isClient) localStorage.setItem(SPLIT_KEY, m)
}

// ── Repliage des fichiers ──────────────────────────────────────────────────

// Les très gros fichiers démarrent repliés : leur DOM (v-if) n'est créé qu'au
// dépliage, ce qui garde le premier rendu fluide sur les diffs énormes.
const BIG_FILE_LINES = 500

const collapsed = ref<Set<string>>(
  new Set(props.files.filter((f) => f.addCount + f.delCount > BIG_FILE_LINES).map((f) => f.path)),
)

// Quand collapseKey change : force l'état replié (pair = déplié, impair = replié)
watch(
  () => props.collapseKey,
  (k) => {
    if (k == null) return
    collapsed.value = k % 2 === 1 ? new Set(props.files.map((f) => f.path)) : new Set()
  },
)

function toggleFile(path: string) {
  if (collapsed.value.has(path)) collapsed.value.delete(path)
  else collapsed.value.add(path)
  // force reactivity
  collapsed.value = new Set(collapsed.value)
}

function isCollapsed(path: string): boolean {
  return collapsed.value.has(path)
}

// ── Compteur de findings par fichier ──────────────────────────────────────

function fileFindingCount(file: { topFindings: Finding[]; byLine: Record<number, Finding[]> }): number {
  return file.topFindings.length + Object.values(file.byLine).reduce((n, arr) => n + arr.length, 0)
}

// ── NL_KIND : map kind → libellé + couleurs ───────────────────────────────

type KindMeta = { label: string; color: string; bg: string }

const NL_KIND: Partial<Record<string, KindMeta>> = {
  security:   { label: t('diffView.kindSecurity'),   color: 'var(--nolyra-kind-security)',   bg: 'var(--nolyra-kind-security-soft)' },
  perf:       { label: t('diffView.kindPerf'),        color: 'var(--nolyra-kind-perf)',        bg: 'var(--nolyra-kind-perf-soft)' },
  convention: { label: t('diffView.kindConvention'),  color: 'var(--nolyra-kind-convention)',  bg: 'var(--nolyra-kind-convention-soft)' },
  design:     { label: t('diffView.kindDesign'),      color: 'var(--nolyra-kind-design)',      bg: 'var(--nolyra-kind-design-soft)' },
  praise:     { label: t('diffView.kindPraise'),      color: 'var(--nolyra-kind-praise)',      bg: 'var(--nolyra-kind-praise-soft)' },
  why:        { label: t('diffView.kindWhy'),         color: 'var(--nolyra-kind-why)',         bg: 'var(--nolyra-kind-why-soft)' },
}

const SEV_KIND: Partial<Record<string, KindMeta>> = {
  critical: { label: t('diffView.sevCritical'), color: 'var(--nolyra-risk-high)',     bg: 'var(--nolyra-risk-high-soft)' },
  major:    { label: t('diffView.sevMajor'),    color: 'var(--nolyra-risk-high)',     bg: 'var(--nolyra-risk-high-soft)' },
  minor:    { label: t('diffView.sevMinor'),    color: 'var(--nolyra-risk-med)',      bg: 'var(--nolyra-risk-med-soft)' },
  info:     { label: t('diffView.sevInfo'),     color: 'var(--nolyra-ink-3)',         bg: 'var(--nolyra-line-2)' },
}

const FALLBACK_KIND: KindMeta = { label: t('diffView.sevInfo'), color: 'var(--nolyra-ink-3)', bg: 'var(--nolyra-line-2)' }

function resolveKind(f: Finding): KindMeta {
  if (f.kind) {
    const k = NL_KIND[f.kind]
    if (k) return k
  }
  return SEV_KIND[f.severity] ?? FALLBACK_KIND
}

// ── Bordure gauche de note selon kind/severity ────────────────────────────

function noteBorderColor(f: Finding): string {
  return resolveKind(f).color
}

// ── Rendu inline du texte : `code` → <code> ───────────────────────────────

function richParts(s: string): { text: string; isCode: boolean }[] {
  return s.split(/(`[^`]+`)/g).map((p) => ({
    text: p.startsWith('`') && p.endsWith('`') ? p.slice(1, -1) : p,
    isCode: p.startsWith('`') && p.endsWith('`'),
  }))
}

// ── Split view helpers ────────────────────────────────────────────────────

function splitRows(rows: HunkLine[]): SplitRow[] {
  return toSplit(rows)
}

function cellClass(t: 'add' | 'del' | 'ctx' | 'nil'): string {
  if (t === 'add') return 'srd-cell-add'
  if (t === 'del') return 'srd-cell-del'
  if (t === 'nil') return 'srd-cell-nil'
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
  if (lineNo == null) return []
  return (byLine[lineNo] ?? []).slice(1)
}
</script>

<template>
  <p v-if="!files.length" class="nolyra-muted text-sm">{{ $t('reviews.noDiff') }}</p>
  <div v-else class="diff-view-root">
    <!-- Toggle split/unifié (masqué si toolbar externe fournie) -->
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

    <!-- Liste des fichiers -->
    <div class="diff-files">
      <div
        v-for="file in files"
        :key="file.path"
        class="srd-file"
      >
        <!-- Header repliable -->
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

        <!-- Corps -->
        <div v-if="!isCollapsed(file.path)" class="srd-body">
          <!-- Notes hors-ligne (topFindings) -->
          <template v-if="file.topFindings.length">
            <div
              v-for="(f, i) in file.topFindings"
              :key="'top-' + i"
              class="nlr-note"
              :style="{ borderLeftColor: noteBorderColor(f) }"
            >
              <div class="nlr-note-head">
                <span class="nlr-mark">✦</span>
                <span class="nlr-name">{{ $t('note.author') }}</span>
                <span
                  class="nlr-kind"
                  :style="{ color: resolveKind(f).color, background: resolveKind(f).bg }"
                >{{ resolveKind(f).label }}</span>
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

          <!-- Hunks avec gaps -->
          <template v-for="(block, bi) in file.hunks" :key="bi">
            <!-- Gap bar -->
            <div v-if="isGap(block)" class="srd-gap">
              <span class="srd-gap-ic">↕</span>
              {{ $t('diffView.gapLines', { n: gapSize(block) }, gapSize(block)) }}
            </div>

            <!-- Hunk unifié -->
            <template v-else-if="isHunkRows(block) && diffMode === 'unified'">
              <div class="srd-unified">
                <template v-for="(row, ri) in hunkRows(block)" :key="ri">
                  <div
                    class="srd-uline"
                    :class="row.t === 'add' ? 'srd-uline-add' : row.t === 'del' ? 'srd-uline-del' : 'srd-uline-ctx'"
                  >
                    <span class="srd-no">{{ row.o ?? '' }}</span>
                    <span class="srd-no">{{ row.n ?? '' }}</span>
                    <span class="srd-sign">{{ row.t === 'add' ? '+' : row.t === 'del' ? '−' : ' ' }}</span>
                    <span class="srd-code">{{ row.c || ' ' }}</span>
                  </div>
                  <!-- Note inline après la ligne dans le mode unifié -->
                  <div
                    v-if="row.note"
                    class="nlr-note nlr-note-inline"
                    :style="{ borderLeftColor: noteBorderColor(row.note) }"
                  >
                    <div class="nlr-note-head">
                      <span class="nlr-mark">✦</span>
                      <span class="nlr-name">{{ $t('note.author') }}</span>
                      <span
                        class="nlr-kind"
                        :style="{ color: resolveKind(row.note).color, background: resolveKind(row.note).bg }"
                      >{{ resolveKind(row.note).label }}</span>
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
                    <!-- Notes supplémentaires sur la même ligne (byLine[n][1..]) -->
                    <template v-if="extraNotes(file.byLine, row.n).length">
                      <template
                        v-for="(extraNote, en) in extraNotes(file.byLine, row.n)"
                        :key="'extra-' + en"
                      >
                        <div class="nlr-note-sep" />
                        <div class="nlr-note-head">
                          <span class="nlr-mark">✦</span>
                          <span class="nlr-name">{{ $t('note.author') }}</span>
                          <span
                            class="nlr-kind"
                            :style="{ color: resolveKind(extraNote).color, background: resolveKind(extraNote).bg }"
                          >{{ resolveKind(extraNote).label }}</span>
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

            <!-- Hunk split -->
            <template v-else-if="isHunkRows(block) && diffMode === 'split'">
              <div class="srd-split">
                <template v-for="(srow, si) in splitRows(hunkRows(block))" :key="si">
                  <!-- Note émise après le bloc apparié (mode split) -->
                  <div v-if="srow.kind === 'note'" class="srd-split-note-row">
                    <div
                      class="nlr-note nlr-note-split"
                      :style="{ borderLeftColor: noteBorderColor(srow.note) }"
                    >
                      <div class="nlr-note-head">
                        <span class="nlr-mark">✦</span>
                        <span class="nlr-name">{{ $t('note.author') }}</span>
                        <span
                          class="nlr-kind"
                          :style="{ color: resolveKind(srow.note).color, background: resolveKind(srow.note).bg }"
                        >{{ resolveKind(srow.note).label }}</span>
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

                  <!-- Ligne split (ctx ou chg) -->
                  <div v-else class="srd-row">
                    <!-- Cellule gauche -->
                    <div
                      class="srd-cell"
                      :class="srow.kind === 'ctx'
                        ? cellClass('ctx')
                        : srow.left ? cellClass('del') : cellClass('nil')"
                    >
                      <span class="srd-no">{{ srow.kind === 'ctx' ? srow.left.o ?? '' : (srow.left?.o ?? '') }}</span>
                      <span class="srd-sign">{{ srow.kind !== 'ctx' && srow.left ? '−' : ' ' }}</span>
                      <span class="srd-code">{{ srow.kind === 'ctx' ? (srow.left.c || ' ') : (srow.left?.c ?? ' ') }}</span>
                    </div>
                    <!-- Cellule droite -->
                    <div
                      class="srd-cell"
                      :class="srow.kind === 'ctx'
                        ? cellClass('ctx')
                        : srow.right ? cellClass('add') : cellClass('nil')"
                    >
                      <span class="srd-no">{{ srow.kind === 'ctx' ? srow.right.n ?? '' : (srow.right?.n ?? '') }}</span>
                      <span class="srd-sign">{{ srow.kind !== 'ctx' && srow.right ? '+' : ' ' }}</span>
                      <span class="srd-code">{{ srow.kind === 'ctx' ? (srow.right.c || ' ') : (srow.right?.c ?? ' ') }}</span>
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
/* ── Root ────────────────────────────────────────────────────────────────── */
.diff-view-root {
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* ── Toolbar toggle split/unifié ─────────────────────────────────────────── */
.diff-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.diff-seg {
  display: inline-flex;
  background: var(--nolyra-panel);
  border: 1px solid var(--nolyra-line);
  border-radius: 9px;
  padding: 2px;
  gap: 2px;
}

.diff-seg button {
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

.diff-seg button.on {
  background: var(--nolyra-ink);
  color: var(--nolyra-bg);
}

/* ── Liste de fichiers ───────────────────────────────────────────────────── */
.diff-files {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ── Fichier ─────────────────────────────────────────────────────────────── */
.srd-file {
  border: 1px solid var(--nolyra-line);
  border-radius: 10px;
  overflow: hidden;
  background: var(--nolyra-panel);
  /* saute layout/paint des fichiers hors viewport sur les gros diffs */
  content-visibility: auto;
  contain-intrinsic-size: auto 320px;
}

.srd-file-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 14px;
  background: var(--nolyra-line-2);
  border-bottom: 1px solid var(--nolyra-line);
  cursor: pointer;
  font-size: 12.5px;
  user-select: none;
}

.srd-file-head:hover {
  background: color-mix(in srgb, var(--nolyra-line) 60%, var(--nolyra-panel));
}

.srd-chev {
  color: var(--nolyra-ink-3);
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
  color: var(--nolyra-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.srd-flex1 {
  flex: 1;
}

.srd-cmt {
  font-size: 11px;
  color: var(--nolyra-ink-3);
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
  color: var(--nolyra-risk-low);
}

.srd-delta-del {
  color: var(--nolyra-risk-high);
}

.srd-delta-sep {
  color: var(--nolyra-ink-3);
}

/* ── Corps du fichier ────────────────────────────────────────────────────── */
.srd-body {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
}

/* ── Gap bar ────────────────────────────────────────────────────────────── */
.srd-gap {
  background: var(--nolyra-line-2);
  color: var(--nolyra-ink-3);
  padding: 5px 16px;
  font-size: 11px;
  border-bottom: 1px solid var(--nolyra-line);
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
}

.srd-gap-ic {
  opacity: 0.6;
}

/* ── Vue unifiée ─────────────────────────────────────────────────────────── */
.srd-unified {
  display: flex;
  flex-direction: column;
}

.srd-uline {
  display: flex;
  align-items: flex-start;
}

.srd-uline-ctx {
  background: var(--nolyra-panel);
}

.srd-uline-add {
  background: var(--nolyra-diff-add);
}

.srd-uline-add .srd-no {
  background: var(--nolyra-diff-add-gut);
}

.srd-uline-del {
  background: var(--nolyra-diff-del);
}

.srd-uline-del .srd-no {
  background: var(--nolyra-diff-del-gut);
}

.srd-uline-add .srd-sign {
  color: var(--nolyra-risk-low);
}

.srd-uline-del .srd-sign {
  color: var(--nolyra-risk-high);
}

.srd-uline-del .srd-code {
  color: color-mix(in srgb, var(--nolyra-risk-high) 70%, var(--nolyra-ink-2));
}

/* ── Vue split ───────────────────────────────────────────────────────────── */
.srd-split {
  display: flex;
  flex-direction: column;
}

.srd-row {
  display: flex;
  min-width: 0;
}

.srd-split-note-row {
  /* La note s'étend sur toute la largeur en mode split */
}

.srd-cell {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  border-right: 1px solid var(--nolyra-line);
}

.srd-cell:last-child {
  border-right: 0;
}

.srd-cell-ctx {
  background: var(--nolyra-panel);
}

.srd-cell-add {
  background: var(--nolyra-diff-add);
}

.srd-cell-add .srd-no {
  background: var(--nolyra-diff-add-gut);
}

.srd-cell-add .srd-sign {
  color: var(--nolyra-risk-low);
}

.srd-cell-del {
  background: var(--nolyra-diff-del);
}

.srd-cell-del .srd-no {
  background: var(--nolyra-diff-del-gut);
}

.srd-cell-del .srd-sign {
  color: var(--nolyra-risk-high);
}

.srd-cell-del .srd-code {
  color: color-mix(in srgb, var(--nolyra-risk-high) 70%, var(--nolyra-ink-2));
}

/* Cellule vide hachurée (pas d'équivalent del/add dans le bloc) */
.srd-cell-nil {
  background: repeating-linear-gradient(
    45deg,
    var(--nolyra-line-2),
    var(--nolyra-line-2) 6px,
    var(--nolyra-bg) 6px,
    var(--nolyra-bg) 12px
  );
}

/* ── Numéros de ligne + signe ────────────────────────────────────────────── */
.srd-no {
  width: 38px;
  flex-shrink: 0;
  text-align: right;
  padding: 0 8px;
  color: var(--nolyra-ink-3);
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
  color: var(--nolyra-ink);
  line-height: inherit;
}

/* ── Carte Note ──────────────────────────────────────────────────────────── */
.nlr-note {
  background: var(--nolyra-panel);
  border: 1px solid var(--nolyra-line);
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
  background: var(--nolyra-accent);
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
  color: var(--nolyra-ink);
}

.nlr-kind {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 999px;
  padding: 2px 9px;
}

.nlr-note-title {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 3px 0;
  color: var(--nolyra-ink);
}

.nlr-note-body {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--nolyra-ink-2);
  margin: 0;
}

.nlr-note code,
.nlr-note-title code {
  font-family: var(--font-mono);
  font-size: 0.85em;
  background: var(--nolyra-line-2);
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--nolyra-accent);
}

.nlr-note-sep {
  height: 1px;
  background: var(--nolyra-line);
  margin: 10px 0;
}

/* ── Proposition de correctif ────────────────────────────────────────────── */
.nlr-sugg {
  margin-top: 11px;
  border: 1px solid var(--nolyra-line);
  border-radius: 8px;
  overflow: hidden;
}

.nlr-sugg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--nolyra-risk-low-soft);
  color: var(--nolyra-risk-low);
  padding: 6px 11px;
  font-size: 11px;
  font-weight: 700;
  font-family: var(--font-sans);
}

.nlr-sugg-code {
  margin: 0;
  padding: 10px 12px;
  background: var(--nolyra-line-2);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--nolyra-ink);
  white-space: pre-wrap;
  word-break: break-word;
}

.nlr-sugg-code code {
  background: none;
  padding: 0;
  color: inherit;
  font-size: inherit;
}

/* ── Densité mobile (≤ 640px) : gouttières et notes resserrées ── */
@media (max-width: 640px) {
  .srd-body { font-size: 11.5px; }
  .srd-no { width: 30px; padding: 0 5px; }
  .srd-uline .srd-no { width: 28px; }
  .nlr-note { margin: 8px 8px 10px; padding: 10px 11px; }
}
</style>
