<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DiffFile, Finding } from '../composables/useDiff'
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
      <span class="ft-head-count">{{ files.length }}</span>
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
          style="padding-left: 12px"
          @click="emit('pick', path)"
        >
          <span class="ft-file-ic">▤</span>
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
  width: 252px;
  flex-shrink: 0;
  border-right: 1px solid var(--codesema-line);
  background: color-mix(in srgb, var(--codesema-panel) 60%, var(--codesema-bg));
  overflow: hidden;
  height: 100%;
}

.ft-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 14px 14px 6px;
  flex-shrink: 0;
}

.ft-head-label {
  font-size: 10.5px;
  font-weight: 700;
  color: var(--codesema-ink-3);
  text-transform: uppercase;
  letter-spacing: 0.07em;
}

.ft-head-count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  background: var(--codesema-line-2);
  color: var(--codesema-ink-3);
  border-radius: 999px;
  padding: 1px 7px;
  font-weight: 600;
}

.ft-filter-wrap {
  padding: 0 10px 8px;
  flex-shrink: 0;
}

.ft-filter {
  width: 100%;
  background: var(--codesema-panel);
  border: 1px solid var(--codesema-line);
  border-radius: 8px;
  padding: 8px 11px;
  font-size: 12.5px;
  font-family: inherit;
  color: var(--codesema-ink);
  outline: none;
  transition: border-color 0.12s;
  box-sizing: border-box;
}

.ft-filter:focus {
  border-color: var(--codesema-accent);
}

.ft-filter::placeholder {
  color: var(--codesema-ink-3);
}

.ft-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.ft-file {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  padding: 6px 9px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--codesema-ink-2);
  text-align: left;
  transition: background 0.1s;
  min-width: 0;
}

.ft-file:hover {
  background: var(--codesema-line-2);
  color: var(--codesema-ink);
}

.ft-file-ic {
  color: var(--codesema-ink-3);
  font-size: 10px;
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
  gap: 3px;
  font-size: 10.5px;
  flex-shrink: 0;
}

.ft-delta-add {
  color: var(--codesema-risk-low);
}

.ft-delta-del {
  color: var(--codesema-risk-high);
}

.ft-cmt {
  font-size: 10px;
  color: var(--codesema-ink-3);
  flex-shrink: 0;
}

.ft-empty {
  font-size: 12px;
  color: var(--codesema-ink-3);
  padding: 10px 14px;
}
</style>
