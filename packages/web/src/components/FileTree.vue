<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DiffFile, Finding } from '../composables/useDiff'
import { G } from '../glyphs'
import FileTreeNode from './FileTreeNode.vue'

const props = defineProps<{
  files: DiffFile[]
  findings: Finding[]
}>()

const emit = defineEmits<{
  pick: [path: string]
}>()

const filter = ref('')

function fileFindingCount(file: DiffFile): number {
  return file.topFindings.length + Object.values(file.byLine).reduce((n, arr) => n + arr.length, 0)
}

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

function buildTree(files: DiffFile[]): TreeNode[] {
  const root: DirNode = { kind: 'dir', dir: '', children: [] }

  for (const file of files) {
    const parts = file.path.split('/')
    const name = parts.at(-1) ?? file.path
    let node = root
    for (const seg of parts.slice(0, -1)) {
      let child = node.children.find((c): c is DirNode => c.kind === 'dir' && c.dir === seg)
      if (!child) {
        child = { kind: 'dir', dir: seg, children: [] }
        node.children.push(child)
      }
      node = child
    }
    node.children.push({ kind: 'file', name, path: file.path })
  }

  return root.children
}

const tree = computed(() => buildTree(props.files))

function flattenTree(nodes: TreeNode[], acc: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === 'dir') {
      flattenTree(n.children, acc)
    } else {
      acc.push(n.path)
    }
  }
  return acc
}

const orderedPaths = computed(() => flattenTree(tree.value))

const filteredPaths = computed(() => {
  const q = filter.value.toLowerCase()
  if (!q) {
    return []
  }
  return orderedPaths.value.filter((p) => p.toLowerCase().includes(q))
})

const fileMap = computed(() => {
  const m = new Map<string, DiffFile>()
  for (const f of props.files) {
    m.set(f.path, f)
  }
  return m
})

const collapsedDirs = ref<Set<string>>(new Set())

function toggleDir(path: string) {
  if (collapsedDirs.value.has(path)) {
    collapsedDirs.value.delete(path)
  } else {
    collapsedDirs.value.add(path)
  }
  collapsedDirs.value = new Set(collapsedDirs.value)
}
</script>

<template>
  <div class="ft-root">
    <div class="ft-head">
      <span class="ft-head-label">{{ $t('fileTree.files') }}</span>
      <span class="ft-head-count muted">{{ files.length }}</span>
    </div>

    <div class="ft-filter-wrap">
      <input
        v-model="filter"
        class="ft-filter"
        :placeholder="$t('fileTree.filterPlaceholder')"
        type="text"
        autocomplete="off"
        spellcheck="false"
      />
    </div>

    <div class="ft-body">
      <template v-if="filter">
        <button
          v-for="path in filteredPaths"
          :key="path"
          class="ft-file"
          @click="emit('pick', path)"
        >
          <span class="ft-file-ic" aria-hidden="true">{{ G.file }}</span>
          <span class="ft-file-name">{{ path.split('/').pop() }}</span>
          <span v-if="fileMap.get(path)" class="ft-delta">
            <span class="ft-delta-add">+{{ fileMap.get(path)!.addCount }}</span>
            <span class="ft-delta-del">−{{ fileMap.get(path)!.delCount }}</span>
          </span>
          <span v-if="fileMap.get(path) && fileFindingCount(fileMap.get(path)!) > 0" class="ft-cmt">
            {{
              $t(
                'fileTree.noteCount',
                { n: fileFindingCount(fileMap.get(path)!) },
                fileFindingCount(fileMap.get(path)!),
              )
            }}
          </span>
        </button>
        <p v-if="filteredPaths.length === 0" class="ft-empty">{{ $t('fileTree.filterEmpty') }}</p>
      </template>

      <template v-else>
        <FileTreeNode
          v-for="(node, i) in tree"
          :key="i"
          :node="node"
          :depth="0"
          :ancestors="[]"
          :collapsed-dirs="collapsedDirs"
          :file-map="fileMap"
          :finding-count="fileFindingCount"
          @toggle-dir="toggleDir"
          @pick="(p: string) => emit('pick', p)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.ft-root {
  display: flex;
  flex-direction: column;
  width: 36ch;
  flex-shrink: 0;
  border-right: 1px solid var(--line);
  overflow: hidden;
  height: 100%;
}

.ft-head {
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: calc(var(--row) / 2) 1ch;
  flex-shrink: 0;
  color: var(--fg-dim);
}

.ft-head-label {
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.ft-filter-wrap {
  padding: 0 1ch calc(var(--row) / 2);
  flex-shrink: 0;
}

.ft-filter {
  width: 100%;
  min-width: 0;
}

.ft-body {
  flex: 1;
  overflow-y: auto;
  padding-bottom: calc(var(--row) / 2);
}

.ft-file {
  display: flex;
  align-items: center;
  gap: 1ch;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0 1ch;
  font: inherit;
  color: var(--fg-dim);
  text-align: left;
  min-width: 0;
}

.ft-file:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

.ft-file-ic {
  color: var(--fg-muted);
  flex-shrink: 0;
}

.ft-file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ft-delta {
  display: inline-flex;
  align-items: center;
  gap: 1ch;
  font-size: 12px;
  flex-shrink: 0;
}

.ft-delta-add {
  color: var(--ok);
}

.ft-delta-del {
  color: var(--err);
}

.ft-cmt {
  font-size: 12px;
  color: var(--warn);
  flex-shrink: 0;
}

.ft-empty {
  color: var(--fg-dim);
  padding: calc(var(--row) / 2) 1ch;
}
</style>
