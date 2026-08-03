<script setup lang="ts">
import { computed } from 'vue'
import type { DiffFile } from '../composables/useDiff'

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

const paddingLeft = computed(() => {
  if (props.node.kind === 'dir') {
    return 8 + props.depth * 14
  }
  return 12 + props.depth * 14
})
</script>

<template>
  <div v-if="node.kind === 'dir'" class="ftn-dir-wrap">
    <button
      class="ftn-dir"
      :style="{ paddingLeft: paddingLeft + 'px' }"
      @click="emit('toggleDir', dirPath)"
    >
      <span class="ftn-dir-ic" :class="{ open: !isCollapsed }">▸</span>
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
    :style="{ paddingLeft: paddingLeft + 'px' }"
    @click="emit('pick', (node as FileLeaf).path)"
  >
    <span class="ftn-file-ic">▤</span>
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

.ftn-dir {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  padding-top: 4px;
  padding-bottom: 4px;
  padding-right: 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--codesema-ink-3);
  font-weight: 600;
  text-align: left;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  transition: background 0.1s;
  min-width: 0;
}

.ftn-dir:hover {
  background: var(--codesema-line-2);
  color: var(--codesema-ink-2);
}

.ftn-dir-ic {
  font-size: 9px;
  transition: transform 0.15s;
  display: inline-block;
  flex-shrink: 0;
  color: var(--codesema-ink-3);
}

.ftn-dir-ic.open {
  transform: rotate(90deg);
}

.ftn-dir-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ftn-file {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  padding-top: 3px;
  padding-bottom: 3px;
  padding-right: 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--codesema-ink-2);
  text-align: left;
  transition: background 0.1s;
  min-width: 0;
}

.ftn-file:hover {
  background: var(--codesema-line-2);
  color: var(--codesema-ink);
}

.ftn-file-ic {
  color: var(--codesema-ink-3);
  font-size: 10px;
  flex-shrink: 0;
}

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
  gap: 3px;
  font-size: 10.5px;
  flex-shrink: 0;
}

.ftn-delta-add {
  color: var(--codesema-risk-low);
}

.ftn-delta-del {
  color: var(--codesema-risk-high);
}

.ftn-cmt {
  font-size: 10px;
  color: var(--codesema-ink-3);
  flex-shrink: 0;
  background: var(--codesema-line-2);
  border-radius: 999px;
  padding: 0 5px;
}
</style>
