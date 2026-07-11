<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ReviewRecord } from './types'
import ReviewShell from './components/ReviewShell.vue'

const record = ref<ReviewRecord | null>(null)
const error = ref<string | null>(null)

async function load() {
  error.value = null
  try {
    const res = await fetch('/api/review')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    record.value = (await res.json()) as ReviewRecord
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(load)
</script>

<template>
  <ReviewShell v-if="record" :record="record" />
  <div v-else class="app-state">
    <template v-if="error">
      <p class="app-error">{{ $t('app.loadError') }} ({{ error }})</p>
      <button class="app-retry" @click="load">{{ $t('app.retry') }}</button>
    </template>
    <template v-else>
      <span class="app-spinner" aria-hidden="true" />
      <p class="nolyra-muted">{{ $t('app.loading') }}</p>
    </template>
  </div>
</template>

<style scoped>
.app-state {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  font-size: 14px;
}

.app-error {
  color: var(--nolyra-risk-high);
  margin: 0;
}

.app-retry {
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 7px 14px;
  border-radius: 8px;
  border: 1px solid var(--nolyra-line);
  background: var(--nolyra-panel);
  color: var(--nolyra-ink-2);
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.app-retry:hover {
  border-color: var(--nolyra-ink-3);
}

.app-spinner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2.5px solid var(--nolyra-line);
  border-top-color: var(--nolyra-accent);
  animation: app-spin 0.8s linear infinite;
}

@keyframes app-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
