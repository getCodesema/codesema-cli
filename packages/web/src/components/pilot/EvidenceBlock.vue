<script setup lang="ts">
import { computed } from 'vue'
import { CHECK_GLYPH, CHECK_STATUS_KEY, shortSha } from '../../composables/useChecks'
import { activityPhraseKey } from '../../composables/useTaskBoard'
import { evidenceFileUrl } from '../../composables/useTasks'
import { t, type MessageKey } from '../../i18n'
import type {
  EvidenceRecord,
  TaskActivity,
  TaskVerification,
  TaskVerificationStatus,
} from '../../types'

const props = defineProps<{
  taskId: string
  evidence?: EvidenceRecord | null
  verification?: TaskVerification | null
  activity?: TaskActivity | null
}>()

const items = computed(() => props.evidence?.items ?? [])
const isEmpty = computed(() => props.evidence == null || items.value.length === 0)
const failed = computed(() => props.evidence?.status === 'failed')

const RUNNING_GLYPH = '●'

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
        <ul class="evb-verification-tests-list">
          <li v-for="(check, i) in verification.checks" :key="i">
            <span
              class="evb-verification-glyph"
              :class="`evb-verification-glyph--${check.status}`"
              >{{ CHECK_GLYPH[check.status] }}</span
            >
            {{ check.command }} : {{ t(CHECK_STATUS_KEY[check.status]) }}
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

.evb-running {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--cs-muted);
}

.evb-running-glyph {
  color: var(--cs-muted);
  animation: evb-pulse 1.6s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .evb-running-glyph {
    animation: none;
  }
}

@keyframes evb-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
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

.evb-verification {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--cs-line);
}

.evb-verification-title {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cs-ghost);
}

.evb-verification-status {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--cs-muted);
}

.evb-verification-status--pass {
  color: var(--cs-green-text);
}

.evb-verification-status--fail {
  color: var(--cs-red-text);
}

.evb-verification-status--warn {
  color: var(--cs-amber-text);
}

.evb-verification-error {
  margin: 0;
  font-size: 12px;
  color: var(--cs-muted);
}

.evb-verification-files {
  margin: 0;
  padding-left: 18px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--cs-muted);
}

.evb-verification-tests-title {
  margin: 4px 0 2px;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cs-ghost);
}

.evb-verification-tests-list {
  margin: 0;
  padding: 0;
  list-style: none;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--cs-text);
}

.evb-verification-glyph {
  color: var(--cs-muted);
}

.evb-verification-glyph--passed {
  color: var(--cs-green-text);
}

.evb-verification-glyph--failed,
.evb-verification-glyph--timeout {
  color: var(--cs-red-text);
}
</style>
