<script setup lang="ts">
// Autonomous chat composer (fiche 13, sections 1-3): an auto-growing
// textarea with three distinct height caps, a drag-or-keyboard resize handle
// with a reset gesture, a placeholder that doubles as a state display, and a
// toolbar topped by the one control every use of this box needs: the round
// send button. Everything a caller wires (create a task, answer a running
// agent, park a message) stays outside: this component only emits `send`
// and the text itself via v-model, exactly like a native input, so it has no
// branch into our task flow.
//
// Dictation, text improvement and the full attach menu are NOT built here
// (fiche section 7.3): their toolbar slots exist and stay visually inert.
//
// All the height math is pure (ComposerLogic.ts): this component only
// measures the DOM (scrollHeight, pointer/keyboard deltas) and feeds those
// numbers through it, exactly like ForgeSplitter.vue does for panel widths.
import { ArrowUp, Mic, Plus, Sparkles } from '@lucide/vue'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { t } from '../../i18n'
import {
  composerHeight,
  composerHintState,
  heightAfterDrag,
  heightAfterKey,
  nextGrowthMode,
  sendDisabled,
  type ComposerContentEvent,
  type ComposerGrowthMode,
  type ComposerHintState,
  type ComposerMode,
  type ComposerResizeBounds,
} from './ComposerLogic'

const props = withDefaults(
  defineProps<{
    modelValue: string
    /** The base invite text ("Describe a task…"): this component owns only
     * the parenthesized shortcut suffix and the four state overrides that
     * replace it. The "message" itself is the caller's, per use case. */
    placeholder: string
    mode?: ComposerMode
    /** A send request is already in flight: the round button disables. */
    sending?: boolean
    offline?: boolean
    stopping?: boolean
    dictating?: boolean
    transcribing?: boolean
    /** Height of whatever stacked banners the caller renders above this box,
     * folded into the manual-resize floor so a dragged-down composer never
     * clips them. Nothing renders them here; see the fiche, section 1. */
    bannersHeight?: number
  }>(),
  {
    mode: 'clean',
    sending: false,
    offline: false,
    stopping: false,
    dictating: false,
    transcribing: false,
    bannersHeight: 0,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: [text: string]
}>()

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const growthMode = ref<ComposerGrowthMode>('typing')
const manualHeight = ref<number | null>(null)
const dragging = ref(false)
const attachOpen = ref(false)

/** True while the very next `modelValue` change is this component's own
 * doing (typed or pasted): tells the prop watch below not to mistake its
 * own edit for an external prefill and re-trigger the burst cap for it. */
let editingLocally = false

function windowHeight(): number {
  return typeof window === 'undefined' ? 0 : window.innerHeight
}

/** The two numbers every manual-resize call needs, read fresh each time so a
 * caller-driven `bannersHeight` change or a window resize is never stale. */
function resizeBounds(): ComposerResizeBounds {
  return { bannersHeight: props.bannersHeight, windowHeight: windowHeight() }
}

/** Re-measures the textarea's natural content height and applies whichever
 * height `composerHeight` decides (manual override, or auto-grow). Relaxing
 * to 'auto' first is required: scrollHeight would otherwise never report a
 * SMALLER height than whatever is currently set (the classic auto-grow
 * textarea trick). No-ops during SSR (no element is ever mounted there). */
async function applyHeight(): Promise<void> {
  await nextTick()
  const el = textareaRef.value
  if (!el) {
    return
  }
  el.style.height = 'auto'
  const next = composerHeight(manualHeight.value, el.scrollHeight, growthMode.value, resizeBounds())
  el.style.height = `${next}px`
}

function onContentEvent(event: ComposerContentEvent): void {
  growthMode.value = nextGrowthMode(growthMode.value, event)
}

function onInput(domEvent: Event): void {
  editingLocally = true
  const value = (domEvent.target as HTMLTextAreaElement).value
  onContentEvent(value === '' ? 'clear' : 'type')
  emit('update:modelValue', value)
  void applyHeight()
}

// The paste event fires BEFORE the browser inserts the pasted text, so the
// mode is already 'burst' by the time the input event above measures it.
function onPaste(): void {
  onContentEvent('paste')
}

// A `modelValue` change this component did NOT just emit itself (the flag
// set by onInput above) is a prefill: content arrived all at once from the
// caller, exactly like a paste, and earns the same 320px burst cap. This is
// also what re-measures the height for that content, since nothing else
// watches an externally-driven v-model change.
watch(
  () => props.modelValue,
  (value) => {
    if (editingLocally) {
      editingLocally = false
      return
    }
    onContentEvent(value === '' ? 'clear' : 'external')
    void applyHeight()
  },
)

function onKeydown(domEvent: KeyboardEvent): void {
  if (domEvent.key === 'Enter' && (domEvent.metaKey || domEvent.ctrlKey)) {
    domEvent.preventDefault()
    trySend()
  }
}

function trySend(): void {
  if (isSendDisabled.value) {
    return
  }
  emit('send', props.modelValue)
}

// ── Resize handle: drag, keyboard, double-click/Enter reset ───────────────

let dragStartY = 0
let dragStartHeight = 0

function currentHeight(): number {
  return textareaRef.value?.getBoundingClientRect().height ?? 0
}

function onHandlePointerDown(domEvent: PointerEvent): void {
  dragging.value = true
  dragStartY = domEvent.clientY
  dragStartHeight = currentHeight()
  ;(domEvent.currentTarget as HTMLElement).setPointerCapture(domEvent.pointerId)
}

function onHandlePointerMove(domEvent: PointerEvent): void {
  if (!dragging.value) {
    return
  }
  // Dragging UP grows the box (the handle sits above the textarea), so the
  // delta fed to heightAfterDrag is inverted from the raw pointer movement.
  const deltaY = dragStartY - domEvent.clientY
  manualHeight.value = heightAfterDrag(dragStartHeight, deltaY, resizeBounds())
  const el = textareaRef.value
  if (el) {
    el.style.height = `${manualHeight.value}px`
  }
}

function onHandlePointerUp(domEvent: PointerEvent): void {
  if (!dragging.value) {
    return
  }
  dragging.value = false
  ;(domEvent.currentTarget as HTMLElement).releasePointerCapture(domEvent.pointerId)
}

/** Clears the manual override and hands control back to auto-grow: the
 * double-click gesture, and also what Enter does on the focused handle. */
function resetHeight(): void {
  manualHeight.value = null
  void applyHeight()
}

function onHandleKeydown(domEvent: KeyboardEvent): void {
  const result = heightAfterKey(
    domEvent.key,
    manualHeight.value ?? currentHeight(),
    resizeBounds(),
    domEvent.shiftKey,
  )
  if (result === null) {
    return
  }
  domEvent.preventDefault()
  if (result.kind === 'reset') {
    resetHeight()
    return
  }
  manualHeight.value = result.height
  const el = textareaRef.value
  if (el) {
    el.style.height = `${result.height}px`
  }
}

// ── Toolbar ─────────────────────────────────────────────────────────────

function toggleAttach(): void {
  attachOpen.value = !attachOpen.value
}

const isSendDisabled = computed(() => sendDisabled(props.modelValue, props.sending))

// ── Status hint (section 2): the placeholder IS the state display ─────────

const HINT_KEY: Record<Exclude<ComposerHintState, null>, string> = {
  offline: 'composer.hintOffline',
  stopping: 'composer.hintStopping',
  dictating: 'composer.hintDictating',
  transcribing: 'composer.hintTranscribing',
}

const hintText = computed(() => {
  const state = composerHintState({
    offline: props.offline,
    stopping: props.stopping,
    dictating: props.dictating,
    transcribing: props.transcribing,
  })
  return state === null ? `${props.placeholder} ${t('composer.hintShortcuts')}` : t(HINT_KEY[state])
})

onMounted(() => {
  void applyHeight()
})

function focus(): void {
  textareaRef.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <div
    class="cc-root"
    :class="{ 'cc-root--temporary': mode === 'temporary', 'cc-root--private': mode === 'private' }"
  >
    <div
      class="cc-handle"
      :class="{ 'cc-handle--active': dragging }"
      role="separator"
      aria-orientation="horizontal"
      tabindex="0"
      :aria-label="t('composer.resizeHandleAria')"
      @pointerdown="onHandlePointerDown"
      @pointermove="onHandlePointerMove"
      @pointerup="onHandlePointerUp"
      @pointercancel="onHandlePointerUp"
      @dblclick="resetHeight"
      @keydown="onHandleKeydown"
    >
      <span class="cc-handle-bar" aria-hidden="true" />
    </div>

    <textarea
      ref="textareaRef"
      class="cc-textarea"
      :value="modelValue"
      :placeholder="hintText"
      spellcheck="true"
      @input="onInput"
      @paste="onPaste"
      @keydown="onKeydown"
    />

    <div class="cc-toolbar">
      <div class="cc-toolbar-start">
        <button
          type="button"
          class="cc-tool cc-tool--attach"
          :class="{ 'cc-tool--open': attachOpen }"
          :aria-expanded="attachOpen"
          :aria-label="t('composer.attachAria')"
          :title="t('composer.attachAria')"
          @click="toggleAttach"
        >
          <Plus class="cc-tool-icon" aria-hidden="true" />
        </button>
        <!-- Dictation: measured slot, no behavior yet (fiche 7.3). -->
        <button
          type="button"
          class="cc-tool cc-tool--placeholder"
          disabled
          :aria-label="t('composer.micAria')"
          :title="t('composer.micAria')"
        >
          <Mic class="cc-tool-icon" aria-hidden="true" />
        </button>
        <!-- Text improvement: measured slot, no behavior yet (fiche 7.3). -->
        <button
          type="button"
          class="cc-tool cc-tool--placeholder"
          disabled
          :aria-label="t('composer.improveAria')"
          :title="t('composer.improveAria')"
        >
          <Sparkles class="cc-tool-icon cc-tool-icon--sm" aria-hidden="true" />
        </button>
      </div>
      <div class="cc-toolbar-end">
        <button
          type="button"
          class="cc-send"
          :disabled="isSendDisabled"
          :aria-label="t('composer.sendAria')"
          :title="t('composer.sendAria')"
          @click="trySend"
        >
          <ArrowUp class="cc-send-icon" aria-hidden="true" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cc-root {
  display: flex;
  flex-direction: column;
  border-style: solid;
  border-width: 1px;
  border-color: var(--cs-line-2);
  border-radius: 16px;
  background: var(--cs-surface);
}

/* The filet itself carries the mode: 2px and colored, no separate badge. */
.cc-root--temporary {
  border-width: 2px;
  border-color: var(--cs-amber-line);
}

.cc-root--private {
  border-width: 2px;
  border-color: var(--cs-water);
}

/* ── Resize handle: invisible at rest, opaque on hover in 200ms ─────────── */
.cc-handle {
  flex: none;
  height: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ns-resize;
  touch-action: none;
}

.cc-handle-bar {
  width: 48px;
  height: 3px;
  border-radius: 999px;
  background: var(--cs-line-3);
  opacity: 0;
  transition: opacity var(--cs-duration-fast) var(--cs-ease-out);
}

.cc-handle:hover .cc-handle-bar,
.cc-handle--active .cc-handle-bar {
  opacity: 1;
  transition: opacity var(--cs-duration-fast) var(--cs-ease-in);
}

/* ── Textarea ─────────────────────────────────────────────────────────── */
.cc-textarea {
  flex: none;
  width: 100%;
  min-height: 44px;
  max-height: 50vh;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--cs-text);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.55;
  padding: 12px 16px 4px;
  overflow-y: auto;
}

.cc-textarea::placeholder {
  color: var(--cs-ghost);
}

/* ── Toolbar: 10px sides, 2px top, 8px bottom, two clusters ─────────────── */
.cc-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 10px 8px;
}

.cc-toolbar-start,
.cc-toolbar-end {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cc-tool {
  flex: none;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: var(--cs-text-2);
  cursor: pointer;
  transition:
    background var(--cs-duration-fast) var(--cs-ease-out),
    color var(--cs-duration-fast) var(--cs-ease-out);
}

.cc-tool:hover:not(:disabled) {
  background: var(--cs-hover);
  color: var(--cs-text);
}

.cc-tool:disabled {
  opacity: 0.45;
  cursor: default;
}

.cc-tool-icon {
  width: 18px;
  height: 18px;
}

.cc-tool-icon--sm {
  width: 16px;
  height: 16px;
}

/* Open is a state, so it wears a neutral elevation, not a semaphore color:
   nothing in the sémaphore trio (green/amber/red) names "a menu is open". */
.cc-tool--attach.cc-tool--open {
  background: var(--cs-hover);
  color: var(--cs-text);
}

.cc-tool--attach .cc-tool-icon {
  transition: transform var(--cs-duration-base) var(--cs-ease-out);
}

/* The plus becomes a cross: same glyph, no swap needed. */
.cc-tool--attach.cc-tool--open .cc-tool-icon {
  transform: rotate(45deg);
}

/* ── Send: 32px exact circle, 30% opacity when disabled ──────────────────── */
.cc-send {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--cs-green);
  color: var(--cs-on-green);
  cursor: pointer;
  transition:
    background var(--cs-duration-fast) var(--cs-ease-out),
    opacity var(--cs-duration-fast) var(--cs-ease-out);
}

.cc-send:hover:not(:disabled) {
  background: var(--cs-green-hover);
}

.cc-send:disabled {
  opacity: 0.3;
  cursor: default;
}

.cc-send-icon {
  width: 18px;
  height: 18px;
}
</style>
