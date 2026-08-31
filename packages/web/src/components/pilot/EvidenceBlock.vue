<script setup lang="ts">
import { computed } from 'vue'
import { evidenceFileUrl } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { EvidenceRecord } from '../../types'

const props = defineProps<{
  taskId: string
  evidence?: EvidenceRecord | null
}>()

const items = computed(() => props.evidence?.items ?? [])
const isEmpty = computed(() => props.evidence == null || items.value.length === 0)
const failed = computed(() => props.evidence?.status === 'failed')
</script>

<template>
  <section class="evb-root">
    <h3 class="evb-title">{{ t('pilot.evidence.title') }}</h3>
    <p v-if="failed" class="evb-failed">
      {{ t('pilot.evidence.failed') }}
      <span v-if="evidence?.reason" class="evb-reason">{{ evidence.reason }}</span>
    </p>
    <p v-if="isEmpty" class="evb-empty">{{ t('pilot.evidence.none') }}</p>
    <div v-else class="evb-items">
      <figure v-for="item in items" :key="item.path" class="evb-item">
        <img
          v-if="item.kind === 'screenshot'"
          class="evb-media"
          :src="evidenceFileUrl(taskId, item.path)"
          :alt="t('pilot.evidence.screenshotAlt')"
        />
        <video
          v-else
          class="evb-media"
          controls
          preload="metadata"
          :src="evidenceFileUrl(taskId, item.path)"
        />
        <figcaption class="evb-caption">
          <span v-if="item.kind === 'video'">{{ t('pilot.evidence.videoLabel') }} · </span
          >{{ t('pilot.evidence.turn', { n: item.turn }) }}
        </figcaption>
      </figure>
    </div>
  </section>
</template>

<style scoped>
.evb-root {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.evb-title {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--cs-ghost);
}

.evb-empty {
  margin: 0;
  font-size: 12.5px;
  color: var(--cs-muted);
}

.evb-failed {
  margin: 0;
  padding: 8px 11px;
  border: 1px solid var(--cs-red-line);
  border-radius: 8px;
  background: var(--cs-red-soft);
  color: var(--cs-red-text);
  font-size: 12.5px;
  line-height: 1.5;
}

.evb-reason {
  display: block;
  margin-top: 4px;
  font-weight: 400;
}

.evb-items {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
}

.evb-item {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.evb-media {
  width: 100%;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  background: var(--cs-inset);
}

.evb-caption {
  font-size: 10.5px;
  color: var(--cs-muted);
}
</style>
