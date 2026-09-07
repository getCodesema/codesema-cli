<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { G } from '../../glyphs'
import { t } from '../../i18n'
import type { EvidenceKind } from '../../types'
import {
  panBy,
  toggleZoom,
  wheelZoom,
  ZOOM_MIN,
  ZOOM_RESET,
  zoomIn,
  zoomOut,
  zoomPercent,
  type ZoomState,
} from './MediaViewerLogic'

defineProps<{
  src: string
  kind: EvidenceKind
  caption: string
}>()

const emit = defineEmits<{ close: [] }>()

const zoom = ref<ZoomState>(ZOOM_RESET)
const zoomed = computed(() => zoom.value.scale > ZOOM_MIN)
const percent = computed(() => zoomPercent(zoom.value))
const mediaStyle = computed(() => ({
  transform: `translate(${zoom.value.x}px, ${zoom.value.y}px) scale(${zoom.value.scale})`,
}))

const closeButton = ref<HTMLButtonElement | null>(null)

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  } else if (e.key === '+' || e.key === '=') {
    zoom.value = zoomIn(zoom.value)
  } else if (e.key === '-') {
    zoom.value = zoomOut(zoom.value)
  } else if (e.key === '0') {
    zoom.value = ZOOM_RESET
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  closeButton.value?.focus()
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
})

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  zoom.value = wheelZoom(zoom.value, e.deltaY)
}

let dragging = false
let moved = false
let lastX = 0
let lastY = 0

function onPointerDown(e: PointerEvent): void {
  dragging = true
  moved = false
  lastX = e.clientX
  lastY = e.clientY
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging) {
    return
  }
  const dx = e.clientX - lastX
  const dy = e.clientY - lastY
  if (Math.abs(dx) + Math.abs(dy) > 2) {
    moved = true
  }
  lastX = e.clientX
  lastY = e.clientY
  zoom.value = panBy(zoom.value, dx, dy)
}

function onPointerUp(): void {
  dragging = false
}

function onMediaClick(): void {
  if (moved) {
    moved = false
    return
  }
  zoom.value = toggleZoom(zoom.value)
}
</script>

<template>
  <Teleport to="body">
    <div
      class="mv-root"
      role="dialog"
      aria-modal="true"
      :aria-label="t('pilot.media.aria')"
      @click="emit('close')"
    >
      <div class="mv-bar" @click.stop>
        <button ref="closeButton" class="mv-btn btn" type="button" @click="emit('close')">
          {{ t('pilot.media.close') }}
        </button>
        <span class="mv-caption">{{ caption }}</span>
        <span class="mv-spacer" />
        <button
          class="mv-btn btn mv-btn--icon"
          type="button"
          :aria-label="t('pilot.media.zoomOut')"
          :disabled="!zoomed"
          @click="zoom = zoomOut(zoom)"
        >
          {{ G.minus }}
        </button>
        <span class="mv-percent">{{ percent }}</span>
        <button
          class="mv-btn btn mv-btn--icon"
          type="button"
          :aria-label="t('pilot.media.zoomIn')"
          @click="zoom = zoomIn(zoom)"
        >
          +
        </button>
        <button class="mv-btn btn" type="button" :disabled="!zoomed" @click="zoom = ZOOM_RESET">
          {{ t('pilot.media.reset') }}
        </button>
      </div>
      <div
        class="mv-stage"
        :class="{ 'mv-stage--zoomed': zoomed }"
        @click.stop
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <img
          v-if="kind === 'screenshot'"
          class="mv-media"
          :src="src"
          :alt="caption"
          :style="mediaStyle"
          draggable="false"
          @click="onMediaClick"
        />
        <video
          v-else
          class="mv-media"
          :src="src"
          :style="mediaStyle"
          controls
          autoplay
          preload="auto"
        />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mv-root {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: grid;
  grid-template-rows: calc(var(--row) * 2) 1fr;
  background: color-mix(in srgb, var(--bg) 96%, transparent);
}

.mv-bar {
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: 0 2ch;
  color: var(--fg-dim);
}

.mv-btn {
  color: var(--fg-dim);
}

.mv-btn:hover:not(:disabled) {
  color: var(--fg);
}

.mv-btn--icon {
  padding: 2px 1ch;
}

.mv-caption {
  color: var(--fg);
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mv-spacer {
  flex: 1;
}

.mv-percent {
  min-width: 6ch;
  text-align: center;
  font-size: 12px;
  color: var(--fg-dim);
}

.mv-stage {
  min-height: 0;
  overflow: hidden;
  display: grid;
  place-items: center;
  padding: 0 2ch var(--row);
  cursor: zoom-in;
  touch-action: none;
}

.mv-stage--zoomed {
  cursor: grab;
}

.mv-stage--zoomed:active {
  cursor: grabbing;
}

.mv-media {
  max-width: 100%;
  max-height: 100%;
  border: 1px solid var(--line);
  background: var(--bg-raised);
  transform-origin: center;
  transition: transform 150ms ease;
  user-select: none;
}

.mv-stage--zoomed .mv-media {
  transition: none;
}
</style>
