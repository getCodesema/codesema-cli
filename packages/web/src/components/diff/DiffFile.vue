<script setup lang="ts">
import { computed } from 'vue'
import {
  toSplit,
  type DiffFile,
  type Finding,
  type HunkBlock,
  type HunkLine,
  type SplitRow,
} from '../../composables/useDiff'
import { G } from '../../glyphs'
import { t } from '../../i18n'
import DiffNote from './DiffNote.vue'

const props = defineProps<{
  file: DiffFile
  mode: 'split' | 'unified'
  collapsed: boolean
}>()

const emit = defineEmits<{ toggle: [] }>()

const noteCount = computed(
  () =>
    props.file.topFindings.length +
    Object.values(props.file.byLine).reduce((n, arr) => n + arr.length, 0),
)

function isGap(block: HunkBlock): block is { gap: number } {
  return 'gap' in block
}

function gapSize(block: HunkBlock): number {
  return (block as { gap: number }).gap
}

function hunkRows(block: HunkBlock): HunkLine[] {
  return (block as { rows: HunkLine[] }).rows
}

function splitRows(block: HunkBlock): SplitRow[] {
  return toSplit(hunkRows(block))
}

function rowClass(row: HunkLine): string {
  return row.t === 'add' ? 'add' : row.t === 'del' ? 'del' : ''
}

function signed(row: HunkLine): string {
  const sign = row.t === 'add' ? '+' : row.t === 'del' ? G.minus : ' '
  return `${sign} ${row.c}`
}

/** The notes anchored on a line beyond the one the row already carries. */
function extraNotes(lineNo: number | null | undefined, primary: Finding): Finding[] {
  if (lineNo == null) {
    return []
  }
  return (props.file.byLine[lineNo] ?? []).filter((f) => f !== primary)
}

function notesOf(row: HunkLine): Finding[] {
  return row.note ? [row.note, ...extraNotes(row.n, row.note)] : []
}
</script>

<template>
  <div class="dv-file">
    <div class="diff-f dv-file-head" :data-diff-file="file.path" @click="emit('toggle')">
      <span class="chev" aria-hidden="true">{{ collapsed ? G.collapse : G.expand }}</span>
      <code class="path diff-file-path">{{ file.path }}</code>
      <span v-if="noteCount" class="notes"
        ><span aria-hidden="true">{{ G.note }}</span>
        {{ t('diffView.noteCount', { n: noteCount }, noteCount) }}</span
      >
      <span v-else />
      <span class="pm">
        <span class="a">+{{ file.addCount }}</span>
        <span class="d">{{ G.minus }}{{ file.delCount }}</span>
      </span>
    </div>

    <div v-if="!collapsed" class="diff-body dv-body">
      <DiffNote
        v-for="(f, i) in file.topFindings"
        :key="'top-' + i"
        class="dv-top-note"
        :finding="f"
      />

      <table>
        <colgroup v-if="mode === 'split'">
          <col class="n" />
          <col />
          <col class="n" />
          <col />
        </colgroup>
        <colgroup v-else>
          <col class="n" />
          <col class="n" />
          <col />
        </colgroup>
        <tbody v-if="mode === 'split'">
          <template v-for="(block, bi) in file.hunks" :key="bi">
            <tr v-if="isGap(block)" class="gap">
              <td class="n" />
              <td class="c" colspan="3">
                {{ t('diffView.gapLines', { n: gapSize(block) }, gapSize(block)) }}
              </td>
            </tr>
            <template v-else>
              <template v-for="(srow, si) in splitRows(block)" :key="si">
                <tr v-if="srow.kind === 'note'" class="note">
                  <td class="n" />
                  <td class="c" colspan="3"><DiffNote :finding="srow.note" /></td>
                </tr>
                <tr v-else>
                  <td class="n">{{ srow.left?.o ?? '' }}</td>
                  <td class="c" :class="srow.kind === 'chg' && srow.left ? 'del' : ''">
                    {{ srow.left ? signed(srow.left) : '' }}
                  </td>
                  <td class="n">{{ srow.right?.n ?? '' }}</td>
                  <td class="c" :class="srow.kind === 'chg' && srow.right ? 'add' : ''">
                    {{ srow.right ? signed(srow.right) : '' }}
                  </td>
                </tr>
              </template>
            </template>
          </template>
        </tbody>
        <tbody v-else>
          <template v-for="(block, bi) in file.hunks" :key="bi">
            <tr v-if="isGap(block)" class="gap">
              <td class="n" />
              <td class="n" />
              <td class="c">
                {{ t('diffView.gapLines', { n: gapSize(block) }, gapSize(block)) }}
              </td>
            </tr>
            <template v-else>
              <template v-for="(row, ri) in hunkRows(block)" :key="ri">
                <tr :class="rowClass(row)">
                  <td class="n">{{ row.o ?? '' }}</td>
                  <td class="n">{{ row.n ?? '' }}</td>
                  <td class="c">{{ signed(row) }}</td>
                </tr>
                <tr v-if="row.note" class="note">
                  <td class="n" />
                  <td class="n" />
                  <td class="c">
                    <DiffNote v-for="(f, ni) in notesOf(row)" :key="ni" :finding="f" />
                  </td>
                </tr>
              </template>
            </template>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.dv-file {
  /* skip layout/paint for off-screen files on large diffs */
  content-visibility: auto;
  contain-intrinsic-size: auto 320px;
}

.dv-file-head {
  user-select: none;
}

.dv-file-head {
  border-top: 0;
}

.dv-file + .dv-file .dv-file-head {
  border-top: 1px solid var(--line);
}

.dv-file-head .pm {
  display: inline-flex;
  gap: 1ch;
}

.dv-file-head .path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dv-top-note {
  margin: calc(var(--row) / 2) 1ch;
}

.diff-body td.c.add {
  background: color-mix(in srgb, var(--ok) 14%, transparent);
}

.diff-body td.c.del {
  background: color-mix(in srgb, var(--err) 14%, transparent);
}

.diff-body tr.note td.c > .note + .note {
  margin-top: calc(var(--row) / 2);
}
</style>
