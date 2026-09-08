<script setup lang="ts">
import { computed } from 'vue'
import type { DiffFile } from '../composables/useDiff'
import { G } from '../glyphs'

type FileLeaf = {
  kind: 'file'
  name: string
  path: string
}

type DirNode = {
  kind: 'dir'
  dir: string
  children: TreeNode[]
}

type TreeNode = FileLeaf | DirNode

const props = defineProps<{
  node: TreeNode
  depth: number
  ancestors: string[]
  collapsedDirs: Set<string>
  fileMap: Map<string, DiffFile>
  findingCount: (f: DiffFile) => number
}>()

const emit = defineEmits<{
  toggleDir: [path: string]
  pick: [path: string]
}>()

const dirPath = computed(() => {
  if (props.node.kind !== 'dir') {
    return ''
  }
  return [...props.ancestors, (props.node as DirNode).dir].join('/')
})

const isCollapsed = computed(() => props.collapsedDirs.has(dirPath.value))

const indent = computed(() => `${props.depth * 2}ch`)
</script>

<template>
  <div v-if="node.kind === 'dir'" class="ftn-dir-wrap">
    <button class="ftn-dir" :style="{ paddingLeft: indent }" @click="emit('toggleDir', dirPath)">
      <span class="ftn-dir-ic" aria-hidden="true">{{ isCollapsed ? G.collapse : G.expand }}</span>
      <span class="ftn-dir-name">{{ (node as DirNode).dir }}</span>
    </button>
    <template v-if="!isCollapsed">
      <FileTreeNode
        v-for="(child, i) in (node as DirNode).children"
        :key="i"
        :node="child"
        :depth="depth + 1"
        :ancestors="[...ancestors, (node as DirNode).dir]"
        :collapsed-dirs="collapsedDirs"
        :file-map="fileMap"
        :finding-count="findingCount"
        @toggle-dir="(p: string) => emit('toggleDir', p)"
        @pick="(p: string) => emit('pick', p)"
      />
    </template>
  </div>

  <button
    v-else
    class="ftn-file"
    :style="{ paddingLeft: indent }"
    @click="emit('pick', (node as FileLeaf).path)"
  >
    <span class="ftn-file-ic" aria-hidden="true">{{ G.file }}</span>
    <span class="ftn-file-name">{{ (node as FileLeaf).name }}</span>
    <template v-if="fileMap.get((node as FileLeaf).path)">
      <span class="ftn-delta">
        <span class="ftn-delta-add">+{{ fileMap.get((node as FileLeaf).path)!.addCount }}</span>
        <span class="ftn-delta-del">−{{ fileMap.get((node as FileLeaf).path)!.delCount }}</span>
      </span>
      <span v-if="findingCount(fileMap.get((node as FileLeaf).path)!) > 0" class="ftn-cmt">
        {{ findingCount(fileMap.get((node as FileLeaf).path)!) }}
      </span>
    </template>
  </button>
</template>

<style scoped>
.ftn-dir-wrap {
  display: flex;
  flex-direction: column;
}

.ftn-dir,
.ftn-file {
  display: flex;
  align-items: center;
  gap: 1ch;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  padding-right: 1ch;
  font: inherit;
  color: var(--fg-dim);
  text-align: left;
  min-width: 0;
}

/* The tree lines are drawn, not indented into: one glyph per row, the last
   sibling closing its branch. */
.ftn-dir::before,
.ftn-file::before {
  content: '├─ ';
  color: var(--fg-muted);
}

.ftn-dir-wrap:last-child > .ftn-dir::before,
.ftn-file:last-child::before {
  content: '└─ ';
}

.ftn-dir:hover,
.ftn-file:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

.ftn-dir-ic,
.ftn-file-ic {
  flex-shrink: 0;
  color: var(--fg-muted);
}

.ftn-dir-name,
.ftn-file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ftn-delta {
  display: inline-flex;
  align-items: center;
  gap: 1ch;
  font-size: 12px;
  flex-shrink: 0;
}

.ftn-delta-add {
  color: var(--ok);
}

.ftn-delta-del {
  color: var(--err);
}

.ftn-cmt {
  font-size: 12px;
  color: var(--warn);
  flex-shrink: 0;
}
</style>
