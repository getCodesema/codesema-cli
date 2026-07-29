<script setup lang="ts">
import { onMounted, ref } from 'vue'

type RepoConfigSnapshot = { rulesContent: string; syncAutoPush: boolean }

const isClient = typeof window !== 'undefined'
const configToken = isClient ? (window as { __CODESEMA_CONFIG_TOKEN__?: string }).__CODESEMA_CONFIG_TOKEN__ : undefined

const loading = ref(true)
const loadError = ref<string | null>(null)
const rulesContent = ref('')
const syncAutoPush = ref(false)

const savingRules = ref(false)
const rulesSaved = ref(false)
const rulesError = ref<string | null>(null)
let rulesSavedTimer: ReturnType<typeof setTimeout> | undefined

const togglingSync = ref(false)
const syncError = ref<string | null>(null)

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const res = await fetch('/api/config')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const snapshot = (await res.json()) as RepoConfigSnapshot
    rulesContent.value = snapshot.rulesContent
    syncAutoPush.value = snapshot.syncAutoPush
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function saveRules() {
  if (!configToken || savingRules.value) return
  savingRules.value = true
  rulesError.value = null
  try {
    const res = await fetch('/api/config/rules', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-codesema-config-token': configToken },
      body: JSON.stringify({ content: rulesContent.value }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    rulesSaved.value = true
    if (rulesSavedTimer) clearTimeout(rulesSavedTimer)
    rulesSavedTimer = setTimeout(() => {
      rulesSaved.value = false
    }, 2000)
  } catch (e) {
    rulesError.value = e instanceof Error ? e.message : String(e)
  } finally {
    savingRules.value = false
  }
}

async function toggleAutoSync() {
  if (!configToken || togglingSync.value) return
  const next = !syncAutoPush.value
  togglingSync.value = true
  syncError.value = null
  try {
    const res = await fetch('/api/config/sync-auto-push', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-codesema-config-token': configToken },
      body: JSON.stringify({ enabled: next }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    syncAutoPush.value = next
  } catch (e) {
    syncError.value = e instanceof Error ? e.message : String(e)
  } finally {
    togglingSync.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="cfg-root">
    <h1 class="cfg-title">{{ $t('settings.title') }}</h1>

    <div v-if="loading" class="cfg-state">
      <span class="cfg-spinner" aria-hidden="true" />
      <p class="codesema-muted">{{ $t('settings.loading') }}</p>
    </div>
    <div v-else-if="loadError" class="cfg-state">
      <p class="cfg-error">{{ $t('settings.loadError') }} ({{ loadError }})</p>
      <button class="cfg-retry" @click="load">{{ $t('app.retry') }}</button>
    </div>
    <template v-else>
      <section class="cfg-section">
        <h2 class="cfg-section-title">{{ $t('settings.rulesTitle') }}</h2>
        <p class="cfg-hint codesema-muted">{{ $t('settings.rulesHint') }}</p>
        <textarea
          v-model="rulesContent"
          class="cfg-textarea"
          rows="14"
          spellcheck="false"
        />
        <div class="cfg-section-actions">
          <button
            class="cfg-save-btn"
            :class="{ 'cfg-save-btn--done': rulesSaved }"
            :disabled="!configToken || savingRules"
            @click="saveRules"
          >
            {{ rulesSaved ? $t('settings.saved') : $t('settings.save') }}
          </button>
          <p v-if="rulesError" class="cfg-error">{{ $t('settings.saveError') }} ({{ rulesError }})</p>
        </div>
      </section>

      <section class="cfg-section">
        <h2 class="cfg-section-title">{{ $t('settings.autoSyncTitle') }}</h2>
        <p class="cfg-hint codesema-muted">{{ $t('settings.autoSyncHint') }}</p>
        <div class="cfg-section-actions">
          <button
            class="cfg-toggle-btn"
            :class="{ 'cfg-toggle-btn--on': syncAutoPush }"
            :disabled="!configToken || togglingSync"
            @click="toggleAutoSync"
          >
            {{ syncAutoPush ? $t('settings.autoSyncOn') : $t('settings.autoSyncOff') }}
          </button>
          <p v-if="syncError" class="cfg-error">{{ $t('settings.autoSyncError') }} ({{ syncError }})</p>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.cfg-root {
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 20px 60px;
}

.cfg-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--codesema-ink);
  margin: 0 0 24px;
}

.cfg-state {
  min-height: 40vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  font-size: 14px;
}

.cfg-error {
  color: var(--codesema-risk-high);
  margin: 0;
  font-size: 12.5px;
}

.cfg-retry {
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 7px 14px;
  border-radius: 8px;
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  color: var(--codesema-ink-2);
  cursor: pointer;
}

.cfg-spinner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2.5px solid var(--codesema-line);
  border-top-color: var(--codesema-accent);
  animation: cfg-spin 0.8s linear infinite;
}

@keyframes cfg-spin {
  to {
    transform: rotate(360deg);
  }
}

.cfg-section {
  background: var(--codesema-panel);
  border: 1px solid var(--codesema-line);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
}

.cfg-section-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--codesema-ink);
  margin: 0 0 6px;
}

.cfg-hint {
  font-size: 12.5px;
  margin: 0 0 14px;
}

.cfg-textarea {
  width: 100%;
  min-height: 260px;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--codesema-ink);
  background: var(--codesema-bg);
  border: 1px solid var(--codesema-line);
  border-radius: 8px;
  padding: 12px;
  resize: vertical;
}

.cfg-section-actions {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.cfg-save-btn,
.cfg-toggle-btn {
  flex-shrink: 0;
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 7px 14px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--codesema-accent) 45%, transparent);
  background: var(--codesema-accent-soft);
  color: var(--codesema-accent);
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.cfg-save-btn:hover,
.cfg-toggle-btn:hover {
  border-color: var(--codesema-accent);
}

.cfg-save-btn:disabled,
.cfg-toggle-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.cfg-save-btn--done {
  color: var(--codesema-risk-low);
  border-color: var(--codesema-risk-low);
  background: var(--codesema-risk-low-soft);
}

.cfg-toggle-btn--on {
  color: var(--codesema-risk-low);
  border-color: var(--codesema-risk-low);
  background: var(--codesema-risk-low-soft);
}
</style>
