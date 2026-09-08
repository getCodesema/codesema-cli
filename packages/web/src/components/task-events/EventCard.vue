<script setup lang="ts">
// Shared card gabarit for foldable journal events (fiche 15, sections 2-3): a
// full-width header row (chevron, state icon, title, truncated detail, an
// optional right-pinned token) that discloses a monospace body on click.
//
// The source repeats this shell across eleven near-identical files, two of
// them byte-for-byte the same container (fiche 15 section 2). Every future
// event card composes THIS one instead of copying a twelfth: the mapping
// (which tone, which icon, which body text) is the card-specific part, the
// shell is not.
import { ChevronRight } from '@lucide/vue'
import { computed, ref, type Component } from 'vue'
import { EVENT_CARD_DATA_TONE, type EventCardTone } from './EventCard'

const props = defineProps<{
  tone?: EventCardTone
  /**
   * State icon (14px). WHICH glyph is the caller's judgment, see fiche 15
   * section 3 names a triangle for the anomalous, an arrow for the routine,
   * layers for a synthesis, information otherwise. This template only
   * colors whatever icon it is given, by tone; it does not choose one.
   */
  icon?: Component
  /** Bold, never truncated (fiche 15 section 3): keep it short at the call
   * site instead of relying on this template to clip it. */
  title: string
  detail?: string | null
  /** Right-pinned monospace chip, e.g. a short id or a count. */
  token?: string | null
  /**
   * Initial fold state, decided by the CALLER from the outcome it is about
   * to render (fiche 15 section 6): a card announcing a failure passes
   * `true` so it opens itself; one announcing success passes `false` (the
   * default) and stays folded. The fold is the reader's own toggle from
   * then on: this prop only seeds the first render.
   */
  defaultOpen?: boolean
}>()

const open = ref(props.defaultOpen ?? false)

const dataTone = computed(() => EVENT_CARD_DATA_TONE[props.tone ?? 'neutral'])
</script>

<template>
  <div class="ec-root" :data-tone="dataTone">
    <button
      v-if="$slots.default"
      type="button"
      class="ec-head"
      :aria-expanded="open"
      @click="open = !open"
    >
      <ChevronRight class="ec-chevron" :class="{ 'ec-chevron--open': open }" aria-hidden="true" />
      <component :is="icon" v-if="icon" class="ec-icon" aria-hidden="true" />
      <span class="ec-title">{{ title }}</span>
      <span v-if="detail" class="ec-detail">{{ detail }}</span>
      <span v-if="token" class="ec-token">{{ token }}</span>
    </button>
    <!-- No body to disclose: a static row, never a button that could open
         nothing (fiche 15's cards are all foldable, but a shared shell must
         also serve a caller with no expanded content to offer). -->
    <div v-else class="ec-head ec-head--static">
      <component :is="icon" v-if="icon" class="ec-icon" aria-hidden="true" />
      <span class="ec-title">{{ title }}</span>
      <span v-if="detail" class="ec-detail">{{ detail }}</span>
      <span v-if="token" class="ec-token">{{ token }}</span>
    </div>
    <!-- Only the chevron animates; the body mounts/unmounts outright (fiche
         15 section 6): animating the height of a card inserted mid-thread
         would shove everything below it while the reader is scrolling. -->
    <div v-if="$slots.default && open" class="ec-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* A rail is a claim on the reader: only a card that carries a real state
   keeps one. Routine, in-flight and successful cards separate by whitespace,
   and let their icon alone carry the tone. */
.ec-root[data-tone='warn'],
.ec-root[data-tone='err'] {
  border-left: 2px solid var(--tone);
  padding-left: 1ch;
}

.ec-head {
  display: flex;
  align-items: center;
  gap: 1ch;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.ec-head--static {
  cursor: default;
}

.ec-chevron {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--fg-muted);
  transition: transform 150ms ease;
}

.ec-chevron--open {
  transform: rotate(90deg);
}

.ec-icon {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--tone);
}

.ec-root[data-tone='idle'] .ec-icon {
  color: var(--fg-dim);
}

.ec-title {
  flex: none;
  font-weight: 700;
  color: var(--fg);
}

/* Truncated and dimmed, unlike the title beside it. */
.ec-detail {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ec-token {
  flex: none;
  margin-left: auto;
  font-size: 12px;
  color: var(--fg-dim);
}

.ec-body {
  padding: calc(var(--row) / 2) 0 0;
  font-size: 12px;
  color: var(--fg-dim);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
