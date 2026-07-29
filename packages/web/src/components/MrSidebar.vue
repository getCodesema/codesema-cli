<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ForgeMr, ForgeMrsResult } from '../types'

const props = defineProps<{ selectedNumber: number | null; runningNumber?: number | null }>()
const emit = defineEmits<{ select: [mr: ForgeMr] }>()

const loading = ref(true)
const loadError = ref<string | null>(null)
const result = ref<ForgeMrsResult | null>(null)

const mrs = computed<ForgeMr[]>(() => {
  if (!result.value?.available) return []
  return [...result.value.mrs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
})

const unavailableReasonKey = computed<string | null>(() => {
  if (!result.value || result.value.available) return null
  return {
    'no-remote': 'mrs.reasonNoRemote',
    'no-cli': 'mrs.reasonNoCli',
    'cli-error': 'mrs.reasonCliError',
  }[result.value.reason]
})

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const res = await fetch('/api/mrs')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    result.value = (await res.json()) as ForgeMrsResult
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function formatUpdatedAt(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
  } catch {
    return iso
  }
}

onMounted(load)

defineExpose({ reload: load })
</script>

<template>
  <aside class="mrs-sidebar">
    <div class="mrs-header">
      <h2 class="mrs-title">{{ $t('mrs.title') }}</h2>
      <button class="mrs-refresh-btn" :disabled="loading" @click="load" :aria-label="$t('mrs.refresh')">
        {{ $t('mrs.refresh') }}
      </button>
    </div>

    <div v-if="loading" class="mrs-state">
      <span class="mrs-spinner" aria-hidden="true" />
      <p class="codesema-muted">{{ $t('mrs.loading') }}</p>
    </div>
    <div v-else-if="loadError" class="mrs-state">
      <p class="mrs-error">{{ $t('mrs.loadError') }} ({{ loadError }})</p>
    </div>
    <div v-else-if="unavailableReasonKey" class="mrs-state">
      <p class="codesema-muted mrs-reason">{{ $t(unavailableReasonKey) }}</p>
    </div>
    <p v-else-if="mrs.length === 0" class="codesema-muted mrs-reason">{{ $t('mrs.empty') }}</p>
    <ul v-else class="mrs-list">
      <li v-for="mr in mrs" :key="mr.number">
        <button
          class="mrs-item"
          :class="{ 'mrs-item--selected': mr.number === props.selectedNumber }"
          @click="emit('select', mr)"
        >
          <span class="mrs-item-top">
            <span class="mrs-item-number">{{ $t('mrs.number', { n: mr.number }) }}</span>
            <span class="mrs-item-branch">{{ mr.sourceBranch }}</span>
          </span>
          <span class="mrs-item-title">{{ mr.title }}</span>
          <span class="mrs-item-meta codesema-muted">{{ mr.author }} · {{ formatUpdatedAt(mr.updatedAt) }}</span>
          <span v-if="mr.number === props.runningNumber" class="mrs-item-running">{{ $t('mrs.reviewRunning') }}</span>
        </button>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.mrs-sidebar {
  width: 280px;
  flex-shrink: 0;
  border-right: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.mrs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mrs-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--codesema-ink);
  margin: 0;
}

.mrs-refresh-btn {
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

.mrs-refresh-btn:hover {
  border-color: var(--codesema-ink-3);
}

.mrs-refresh-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.mrs-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px 8px;
  font-size: 12.5px;
  text-align: center;
}

.mrs-reason {
  font-size: 12px;
  padding: 8px 4px;
}

.mrs-error {
  color: var(--codesema-risk-high);
  margin: 0;
  font-size: 12px;
}

.mrs-spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2.5px solid var(--codesema-line);
  border-top-color: var(--codesema-accent);
  animation: mrs-spin 0.8s linear infinite;
}

@keyframes mrs-spin {
  to {
    transform: rotate(360deg);
  }
}

.mrs-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mrs-item {
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

.mrs-item:hover {
  border-color: var(--codesema-line);
  background: var(--codesema-bg);
}

.mrs-item--selected {
  border-color: color-mix(in srgb, var(--codesema-accent) 45%, transparent);
  background: var(--codesema-accent-soft);
}

.mrs-item-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.mrs-item-number {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--codesema-accent);
}

.mrs-item-branch {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--codesema-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}

.mrs-item-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--codesema-ink);
  line-height: 1.35;
}

.mrs-item-meta {
  font-size: 11px;
}

.mrs-item-running {
  align-self: flex-start;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--codesema-accent);
}
</style>
