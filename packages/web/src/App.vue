<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from 'vue'
import ReviewLive from './components/ReviewLive.vue'
import ReviewShell from './components/ReviewShell.vue'
import type { JudgeLive, LiveStatus, PartialReview, ReviewRecord } from './types'

// shallowRef: the record is written once then never mutated; deep reactivity over
// its diff + findings would only add proxy overhead on every read during render.
const record = shallowRef<ReviewRecord | null>(null)
const status = ref<LiveStatus | null>(null)
const partial = ref<PartialReview | null>(null)
const partialB = ref<PartialReview | null>(null)
const judge = ref<JudgeLive | null>(null)
const error = ref<string | null>(null)
let events: EventSource | null = null

async function loadRecord(): Promise<boolean> {
  const res = await fetch('/api/review')
  if (res.status === 202) {
    return false
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  record.value = (await res.json()) as ReviewRecord
  return true
}

function closeEvents() {
  events?.close()
  events = null
}

function openEvents() {
  events = new EventSource('/api/events')
  events.addEventListener('status', (e) => {
    status.value = JSON.parse((e as MessageEvent).data) as LiveStatus
  })
  events.addEventListener('partial', (e) => {
    partial.value = JSON.parse((e as MessageEvent).data) as PartialReview
  })
  events.addEventListener('partial_b', (e) => {
    partialB.value = JSON.parse((e as MessageEvent).data) as PartialReview
  })
  events.addEventListener('judge', (e) => {
    judge.value = JSON.parse((e as MessageEvent).data) as JudgeLive
  })
  events.addEventListener('done', async () => {
    closeEvents()
    try {
      await loadRecord()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  })
  // Server stopped (Ctrl+C): keep the last state shown, EventSource retries on its own.
}

async function load() {
  error.value = null
  try {
    if (await loadRecord()) {
      return
    }
    openEvents()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(load)
onUnmounted(closeEvents)
</script>

<template>
  <ReviewShell v-if="record" :record="record" />
  <ReviewLive
    v-else-if="status && !error"
    :status="status"
    :partial="partial"
    :partial-b="partialB"
    :judge="judge"
  />
  <div v-else class="app-state">
    <template v-if="error">
      <p class="app-error">{{ $t('app.loadError') }} ({{ error }})</p>
      <button class="app-retry" @click="load">{{ $t('app.retry') }}</button>
    </template>
    <template v-else>
      <span class="app-spinner" aria-hidden="true" />
      <p class="codesema-muted">{{ $t('app.loading') }}</p>
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
  color: var(--codesema-risk-high);
  margin: 0;
}

.app-retry {
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 7px 14px;
  border-radius: 8px;
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  color: var(--codesema-ink-2);
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.app-retry:hover {
  border-color: var(--codesema-ink-3);
}

.app-spinner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2.5px solid var(--codesema-line);
  border-top-color: var(--codesema-accent);
  animation: app-spin 0.8s linear infinite;
}

@keyframes app-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
