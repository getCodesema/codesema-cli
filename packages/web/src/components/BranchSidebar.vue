<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { LocalBranch } from '../types'

const props = defineProps<{ selectedName: string | null; runningName?: string | null }>()
const emit = defineEmits<{ select: [branch: LocalBranch] }>()

const loading = ref(true)
const loadError = ref<string | null>(null)
const branches = ref<LocalBranch[]>([])
const collapsed = ref(false)

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const res = await fetch('/api/branches')
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    branches.value = (await res.json()) as LocalBranch[]
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)

defineExpose({ reload: load })
</script>

<template>
  <section class="brs-sidebar">
    <div class="brs-header">
      <button
        class="brs-collapse-btn"
        @click="collapsed = !collapsed"
        :aria-label="$t(collapsed ? 'branches.expand' : 'branches.collapse')"
      >
        <span
          class="brs-chevron"
          :class="{ 'brs-chevron--collapsed': collapsed }"
          aria-hidden="true"
          >▾</span
        >
        <h2 class="brs-title">{{ $t('branches.title') }}</h2>
      </button>
      <button
        class="brs-refresh-btn"
        :disabled="loading"
        @click="load"
        :aria-label="$t('branches.refresh')"
      >
        {{ $t('branches.refresh') }}
      </button>
    </div>

    <template v-if="!collapsed">
      <div v-if="loading" class="brs-state">
        <span class="brs-spinner" aria-hidden="true" />
        <p class="codesema-muted">{{ $t('branches.loading') }}</p>
      </div>
      <div v-else-if="loadError" class="brs-state">
        <p class="brs-error">{{ $t('branches.loadError') }} ({{ loadError }})</p>
      </div>
      <p v-else-if="branches.length === 0" class="codesema-muted brs-reason">
        {{ $t('branches.empty') }}
      </p>
      <ul v-else class="brs-list">
        <li v-for="branch in branches" :key="branch.name">
          <button
            class="brs-item"
            :class="{ 'brs-item--selected': branch.name === props.selectedName }"
            @click="emit('select', branch)"
          >
            <span class="brs-item-top">
              <span class="brs-item-branch">{{ branch.name }}</span>
              <span v-if="branch.isCurrent" class="brs-badge brs-badge--current">{{
                $t('branches.current')
              }}</span>
              <span v-else-if="branch.worktreePath" class="brs-badge">{{
                $t('branches.inWorktree')
              }}</span>
            </span>
            <span class="brs-item-subject">{{ branch.subject }}</span>
            <span class="brs-item-meta codesema-muted">{{ branch.lastCommitRelative }}</span>
            <span v-if="branch.name === props.runningName" class="brs-item-running">{{
              $t('mrs.reviewRunning')
            }}</span>
          </button>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.brs-sidebar {
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.brs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.brs-collapse-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: none;
  cursor: pointer;
  padding: 0;
  font-family: inherit;
}

.brs-chevron {
  color: var(--codesema-ink-3);
  font-size: 10px;
  transition: transform 0.15s;
  display: inline-block;
}

.brs-chevron--collapsed {
  transform: rotate(-90deg);
}

.brs-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--codesema-ink);
  margin: 0;
}

.brs-refresh-btn {
  font-size: 11.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--codesema-line);
  background: var(--codesema-bg);
  color: var(--codesema-ink-2);
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.brs-refresh-btn:hover {
  border-color: var(--codesema-ink-3);
}

.brs-refresh-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.brs-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px 8px;
  font-size: 12.5px;
  text-align: center;
}

.brs-reason {
  font-size: 12px;
  padding: 8px 4px;
}

.brs-error {
  color: var(--codesema-risk-high);
  margin: 0;
  font-size: 12px;
}

.brs-spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2.5px solid var(--codesema-line);
  border-top-color: var(--codesema-accent);
  animation: brs-spin 0.8s linear infinite;
}

@keyframes brs-spin {
  to {
    transform: rotate(360deg);
  }
}

.brs-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.brs-item {
  width: 100%;
  text-align: left;
  font-family: inherit;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    background 0.12s ease;
}

.brs-item:hover {
  border-color: var(--codesema-line);
  background: var(--codesema-bg);
}

.brs-item--selected {
  border-color: color-mix(in srgb, var(--codesema-accent) 45%, transparent);
  background: var(--codesema-accent-soft);
}

.brs-item-top {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.brs-item-branch {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  color: var(--codesema-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.brs-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  border-radius: 999px;
  padding: 1px 7px;
  color: var(--codesema-ink-3);
  background: var(--codesema-line-2);
}

.brs-badge--current {
  color: var(--codesema-accent);
  background: var(--codesema-accent-soft);
}

.brs-item-subject {
  font-size: 12px;
  color: var(--codesema-ink-2);
  line-height: 1.35;
}

.brs-item-meta {
  font-size: 11px;
}

.brs-item-running {
  align-self: flex-start;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--codesema-accent);
}
</style>
