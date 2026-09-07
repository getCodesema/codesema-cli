<script setup lang="ts">
import { computed, ref } from 'vue'
import { CHECK_GLYPH, CHECK_STATUS_KEY, shortSha } from '../../composables/useChecks'
import { activityPhraseKey } from '../../composables/useTaskBoard'
import { evidenceFileUrl } from '../../composables/useTasks'
import { G } from '../../glyphs'
import { t, type MessageKey } from '../../i18n'
import type {
  EvidenceItem,
  EvidenceRecord,
  ProofIntentKind,
  TaskActivity,
  TaskVerification,
  TaskVerificationStatus,
} from '../../types'
import MediaViewer from './MediaViewer.vue'

const props = defineProps<{
  projectId: string
  taskId: string
  evidence?: EvidenceRecord | null
  verification?: TaskVerification | null
  activity?: TaskActivity | null
}>()

const items = computed(() => props.evidence?.items ?? [])

const opened = ref<EvidenceItem | null>(null)

function itemUrl(item: EvidenceItem): string {
  return evidenceFileUrl(props.projectId, props.taskId, item.path)
}

function itemCaption(item: EvidenceItem): string {
  const turn = t('pilot.evidence.turn', { n: item.turn })
  return item.kind === 'video' ? `${t('pilot.evidence.videoLabel')} · ${turn}` : turn
}
const isEmpty = computed(() => props.evidence == null || items.value.length === 0)
const failed = computed(() => props.evidence?.status === 'failed')

const intent = computed(() => props.evidence?.intent ?? null)
const review = computed(() => props.evidence?.review ?? null)

const PROOF_KIND_KEY: Record<ProofIntentKind, MessageKey> = {
  none: 'pilot.proof.kind.none',
  screenshot: 'pilot.proof.kind.screenshot',
  journey: 'pilot.proof.kind.journey',
}

const intentReason = computed(() => {
  if (!intent.value) {
    return ''
  }
  if (props.evidence?.status === 'skipped' && props.evidence?.reason === 'no_target') {
    return t('pilot.proof.noTarget')
  }
  return intent.value.reason
})

const RUNNING_GLYPH = G.dot

/**
 * The evidence zone has nothing captured yet AND no verification record to
 * show in its place: while the agent is mid-capture (verification or proof
 * phase), that state is worth naming rather than reading as the flat
 * "no evidence yet" of a task that never ran one at all.
 */
const showRunningLine = computed(
  () =>
    isEmpty.value &&
    !props.verification &&
    (props.activity?.phase === 'verification' || props.activity?.phase === 'proof'),
)

const runningPhraseKey = computed<MessageKey | null>(() =>
  props.activity ? activityPhraseKey({ activity: props.activity }) : null,
)

/**
 * TaskVerification has no independently-tracked status for the runbook's
 * install/services/healthchecks phases (packages/contract/src/tasks.ts): a
 * failure in any of them collapses the WHOLE run to `status: 'error'` plus a
 * single readable `error` string naming which command failed. Only the
 * `tests` phase carries structured per-command entries (`checks`). So this
 * renders the real per-command rows for tests, and the one combined
 * error/refusal fact for everything before them, rather than fabricating
 * three status rows the data cannot back.
 */
const VERIFICATION_STATUS_KEY: Record<TaskVerificationStatus, MessageKey> = {
  passed: 'pilot.verification.passed',
  failed: 'pilot.verification.failed',
  refused: 'pilot.verification.refused',
  error: 'pilot.verification.error',
}

const VERIFICATION_TONE: Record<TaskVerificationStatus, 'pass' | 'fail' | 'warn'> = {
  passed: 'pass',
  failed: 'fail',
  refused: 'warn',
  error: 'warn',
}
</script>

<template>
  <section class="evb-root">
    <h3 class="evb-title">{{ t('pilot.evidence.title') }}</h3>
    <p v-if="intent" class="evb-intent">
      {{ t('pilot.proof.declared') }} {{ t(PROOF_KIND_KEY[intent.kind])
      }}<template v-if="intentReason"> · {{ intentReason }}</template>
    </p>
    <p v-if="intent?.kind === 'screenshot' && intent.pages?.length" class="evb-intent-detail">
      {{ t('pilot.proof.pages', { list: intent.pages.join(', ') }) }}
    </p>
    <p v-if="intent?.kind === 'journey' && intent.journey" class="evb-intent-detail">
      <code>{{ intent.journey }}</code>
    </p>
    <p v-if="failed" class="evb-failed">
      {{ t('pilot.evidence.failed') }}
      <span v-if="evidence?.reason" class="evb-reason">{{ evidence.reason }}</span>
    </p>
    <p v-if="showRunningLine" class="evb-running">
      <span class="evb-running-glyph" aria-hidden="true">{{ RUNNING_GLYPH }}</span>
      {{ t(runningPhraseKey ?? 'pilot.evidence.none') }}
    </p>
    <p v-else-if="isEmpty" class="evb-empty">{{ t('pilot.evidence.none') }}</p>
    <div v-else class="evb-items">
      <figure v-for="item in items" :key="item.path" class="evb-item">
        <button
          v-if="item.kind === 'screenshot'"
          type="button"
          class="evb-open"
          :aria-label="t('pilot.media.open')"
          @click.stop="opened = item"
          @keydown.stop
        >
          <img class="evb-media" :src="itemUrl(item)" :alt="t('pilot.evidence.screenshotAlt')" />
        </button>
        <video
          v-else
          class="evb-media"
          controls
          preload="metadata"
          :src="itemUrl(item)"
          @click.stop
        />
        <figcaption class="evb-caption">
          <span>{{ itemCaption(item) }}</span>
          <button
            v-if="item.kind === 'video'"
            type="button"
            class="evb-enlarge"
            @click.stop="opened = item"
            @keydown.stop
          >
            {{ t('pilot.media.open') }}
          </button>
        </figcaption>
      </figure>
    </div>
    <MediaViewer
      v-if="opened"
      :src="itemUrl(opened)"
      :kind="opened.kind"
      :caption="itemCaption(opened)"
      @close="opened = null"
    />
    <p v-if="review" class="evb-verdict">
      <span
        class="evb-verdict-dot"
        :class="review.coherent ? 'evb-verdict-dot--coherent' : 'evb-verdict-dot--incoherent'"
        aria-hidden="true"
        >{{ review.coherent ? G.ok : G.fail }}</span
      >
      <span>{{
        review.coherent
          ? t('pilot.proof.coherent')
          : t('pilot.proof.incoherent', { reason: review.reason })
      }}</span>
    </p>
    <div v-if="verification" class="evb-verification">
      <h4 class="evb-verification-title">{{ t('pilot.verification.title') }}</h4>
      <p
        class="evb-verification-status"
        :class="`evb-verification-status--${VERIFICATION_TONE[verification.status]}`"
      >
        {{ t(VERIFICATION_STATUS_KEY[verification.status])
        }}<template v-if="verification.head_sha">
          · {{ t('workspace.checksHeadVerified', { sha: shortSha(verification.head_sha) }) }}
        </template>
      </p>
      <p
        v-if="verification.status === 'error' && verification.error"
        class="evb-verification-error"
      >
        {{ verification.error }}
      </p>
      <ul
        v-if="verification.status === 'refused' && verification.changed_dependency_files.length > 0"
        class="evb-verification-files"
      >
        <li v-for="file in verification.changed_dependency_files" :key="file">{{ file }}</li>
      </ul>
      <div v-if="verification.checks.length > 0" class="evb-verification-tests">
        <h5 class="evb-verification-tests-title">{{ t('pilot.recap.tests') }}</h5>
        <ul class="evb-verification-tests-list checks">
          <li
            v-for="(check, i) in verification.checks"
            :key="i"
            class="evb-verification-row check-row"
            :data-s="check.status"
          >
            <span class="evb-verification-glyph g" aria-hidden="true">{{
              CHECK_GLYPH[check.status]
            }}</span>
            <span class="evb-verification-command">{{ check.command }}</span>
            <span class="evb-verification-result r">{{ t(CHECK_STATUS_KEY[check.status]) }}</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.evb-root {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}

.evb-title {
  margin: 0;
  font-size: var(--fs);
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.evb-empty {
  margin: 0;
  color: var(--fg-dim);
}

.evb-intent {
  margin: 0;
  color: var(--fg-dim);
}

.evb-intent-detail {
  margin: 0;
  font-size: 12px;
  color: var(--fg-dim);
}

.evb-verdict {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 1ch;
  color: var(--fg);
}

.evb-verdict-dot {
  flex: none;
}

.evb-verdict-dot--coherent {
  color: var(--ok);
}

.evb-verdict-dot--incoherent {
  color: var(--err);
}

.evb-running {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 1ch;
  color: var(--fg-dim);
}

.evb-running-glyph {
  color: var(--info);
  animation: blink 1.2s steps(2) infinite;
}

.evb-failed {
  margin: 0;
  padding: 2px 1ch;
  border: 1px solid var(--err);
  background: color-mix(in srgb, var(--err) 12%, transparent);
  color: var(--err);
}

.evb-reason {
  display: block;
}

.evb-items {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(32ch, 1fr));
  gap: var(--row) 2ch;
}

.evb-item {
  margin: 0;
  display: flex;
  flex-direction: column;
}

.evb-media {
  width: 100%;
  border: 1px solid var(--line);
  background: var(--bg-raised);
}

.evb-open {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
}

.evb-open:hover .evb-media {
  border-color: var(--accent);
}

.evb-caption {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1ch;
  font-size: 12px;
  color: var(--fg-dim);
}

.evb-enlarge {
  border: 0;
  padding: 0;
  background: transparent;
  font: inherit;
  font-size: 12px;
  color: var(--fg-dim);
  cursor: pointer;
  text-decoration: underline;
}

.evb-enlarge:hover {
  color: var(--fg);
}

.evb-verification {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
  padding-top: calc(var(--row) / 2);
  border-top: 1px solid var(--line);
}

.evb-verification-title,
.evb-verification-tests-title {
  margin: 0;
  font-size: 12px;
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.evb-verification-status {
  margin: 0;
  font-weight: 700;
  color: var(--fg-dim);
}

.evb-verification-status--pass {
  color: var(--ok);
}

.evb-verification-status--fail {
  color: var(--err);
}

.evb-verification-status--warn {
  color: var(--warn);
}

.evb-verification-error {
  margin: 0;
  font-size: 12px;
  color: var(--fg-dim);
}

.evb-verification-files {
  margin: 0;
  padding-left: 2ch;
  font-size: 12px;
  color: var(--fg-dim);
}

.evb-verification-tests-list {
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--fg);
}

.evb-verification-row {
  grid-template-columns: 2ch 1fr auto;
}

.evb-verification-command {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
