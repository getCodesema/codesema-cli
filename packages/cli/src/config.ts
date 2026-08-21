import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENT_WATCHDOG_DEFAULTS, type WatchdogBudgets } from './agent.js'
import { isSupportedLanguage, t, type SupportedLanguage } from './i18n.js'

export type CodesemaConfig = {
  /** Full headless agent shell command (e.g. "claude -p --model opus"). */
  agent?: string | undefined
  /** Wizard metadata, used to re-edit without starting over. */
  agentId?: string | undefined
  model?: string | undefined
  effort?: string | undefined
  target?: string | undefined
  port?: number | undefined
  timeout?: number | undefined
  /**
   * DEPRECATED (T1.3): superseded by `maxConcurrentAgents`. Still READ and
   * HONORED as its alias — never ignored in silence (invariant § 0.3 n°2) —
   * with a named boot warning (workspace.ts's maxParallelNotice) whenever it
   * is set. When BOTH keys are present, `maxConcurrentAgents` wins the value
   * (design.md Decision 5) and the warning still fires.
   *
   * GLOBAL-ONLY (T1.4), same as `maxConcurrentAgents`: a repo file that sets
   * it is stripped and warned about.
   */
  maxParallelTasks?: number | undefined
  /**
   * How many of the most-recently-updated TERMINATED (shipped/failed) tasks
   * PER PROJECT survive the retention pass untouched (T1.9); everything past
   * that has its worktree, HOME volume and .codesema/tasks/<id>/ directory
   * removed. Absent means DEFAULT_TASK_RETENTION (task-retention.ts).
   * Active tasks and 'interrupted' (reprenable) ones are NEVER candidates,
   * whatever this is set to.
   *
   * GLOBAL-ONLY (T1.4 review A2), same doctrine as the load cap: one
   * `applyRetention()` pass reads ONE value and applies it to EVERY registered
   * project, so a cloned repo that set `taskRetentionCount: 0` in its
   * `.codesema/config.json` would purge the finished tasks of all the OTHERS
   * at the next boot — worktree, HOME volume and `.codesema/tasks/<id>/`
   * included. The resource it governs is the workspace, not the repository.
   * A repo file that sets it is stripped here and NAMED by
   * `repoGlobalOnlyIgnoredNotices` — never dropped in silence.
   */
  taskRetentionCount?: number | undefined
  /**
   * Machine-wide load cap (T1.3, D4): the maximum number of heavy processes
   * — agent turns, end-of-turn reviews and containerized checks confounded in
   * ONE budget — this workspace runs at once, across every project.
   * Undefined applies DEFAULT_MAX_CONCURRENT_AGENTS (load-cap.ts, currently
   * 4). See `maxParallelTasks` for the key this replaces.
   *
   * GLOBAL-ONLY (T1.4): a repo `.codesema/config.json` that sets this is
   * stripped and warned about — the resource being capped is the machine, not
   * the repository. Same doctrine as `syncUrl` / `syncSecret` / `syncAutoPush`.
   */
  maxConcurrentAgents?: number | undefined
  /**
   * Semantic watchdog budgets (D3), in SECONDS like `timeout`. Absent means the
   * D3 defaults apply (30 min of silence, 2 h of one tool in flight, a 30 s
   * heartbeat) — see AGENT_WATCHDOG_DEFAULTS and resolveWatchdogBudgets.
   *
   * Resolved per project (T1.4) with the same flag > repo > global precedence
   * as `timeout`. A project that does not set them inherits the global file,
   * then the D3 defaults — never the launch repo's values.
   */
  watchdogInactivitySeconds?: number | undefined
  watchdogToolBudgetSeconds?: number | undefined
  watchdogHeartbeatSeconds?: number | undefined
  /**
   * How workspace tasks are contained. 'auto' (default) runs them in a
   * per-task container when a container runtime is available and the agent
   * image builds, and falls back to the host policy hardening otherwise;
   * 'container' requires the cage (task creation 409s without it); 'policy'
   * always runs on the host.
   */
  isolation?: IsolationMode | undefined
  /** Domains the caged agent may reach through the egress proxy (CONNECT only). */
  isolationAllowedDomains?: string[] | undefined
  /**
   * T3.7 / decision D15: whether this project mirrors the cycle of its tasks
   * onto the forge issues they are bound to, as `codesema:*` labels.
   *
   * OPT-IN, and the honest default is OFF — absence means "write nothing".
   * Posting labels into someone else's repository without being asked is a
   * pollution, and a native monitoring channel is not worth that price by
   * default: a user who merely upgrades the CLI must not find five new labels
   * in a shared repo.
   *
   * Repo-settable on purpose, like `isolation` and `checks`, and for a
   * stronger reason than either: the price of the pollution is paid in ONE
   * repository, so that repository is the right place to accept it. A cloned
   * repo that sets this can only ever cause writes to ITS OWN issues, under
   * the `codesema:` prefix and nothing else (task-labels.ts) — it widens no
   * trust, reaches no sibling project, and carries no credential of its own
   * (the authentication stays whatever `gh auth`/`glab auth` set up, D5).
   *
   * Read through `resolveProjectConfig`, so a repo `false` DEFEATS a global
   * `true`. That is why the parse below tests the TYPE and not the value:
   * dropping a `false` would silently promote the global opt-in back onto a
   * project that had just refused it.
   */
  forgeCycleLabels?: boolean | undefined
  /** UI and review language (ISO 639-1). */
  language?: SupportedLanguage | undefined
  /**
   * Which flow the END-OF-TURN review of a workspace task runs (T3.2):
   * 'simple' (one reviewer) or 'dual' (two independent reviewers plus a
   * judge). Absent means 'simple', which is exactly what every task ran
   * before this key existed — the observed behaviour of an unconfigured
   * project is unchanged.
   *
   * Repo-settable on purpose, like `isolation` and `checks`: how thoroughly a
   * repository wants its own branches reviewed is a property of that
   * repository. What it costs is bounded by the machine-wide load cap (D4),
   * which a repo cannot raise — `dual` doubles the review turns, so it
   * queues, it does not oversubscribe.
   */
  reviewMode?: ReviewMode | undefined
  /**
   * How many AUTOMATIC fix turns a task may chain after a blocking end-of-turn
   * review before the loop gives up and hands it back to a human (T3.3,
   * decision D14). Absent means DEFAULT_MAX_AUTO_FIX_ROUNDS (2).
   *
   * Repo-settable, same argument as `reviewMode`: how many times a repository
   * wants its own branches re-worked without a human is a property of that
   * repository, and what those turns cost in parallelism is bounded by the
   * machine-wide load cap (D4), which a repo cannot raise.
   */
  maxAutoFixRounds?: number | undefined
  /**
   * Whether the workspace merges a task's branch on its own once D12's four
   * conditions hold (T3.6): `'auto'`, or `'human'` — the DEFAULT — which
   * evaluates and journals the same four conditions and then stops before the
   * call. Nobody who merely updated the CLI wakes up to a workspace merging
   * for them.
   *
   * GLOBAL-ONLY, and this one is not about a machine resource: "may this tool
   * merge without me" is a statement its OWNER makes, and a cloned repo whose
   * `.codesema/config.json` could turn it on would be making it for them. A
   * repo file that sets it is stripped here and NAMED by
   * `repoGlobalOnlyIgnoredNotices` — never dropped in silence.
   */
  mergePolicy?: MergePolicy | undefined
  /**
   * Merge strategy passed to the forge CLI (D13). ABSENT means the forge's
   * own convention: no strategy option is added to the argv at all, which is
   * more honest than picking one on the project's behalf — how a repository
   * merges belongs to that repository. GLOBAL-ONLY, like `mergePolicy`.
   */
  mergeStrategy?: MergeStrategy | undefined
  /**
   * Whether the branch is deleted on the forge once the merge lands (D13).
   * DEFAULT `false`: a branch is a deliverable, not processing waste (T1.6),
   * and deleting one is an explicit choice. GLOBAL-ONLY, like `mergePolicy`.
   */
  deleteBranchAfterMerge?: boolean | undefined
  /**
   * Explicit, prior consent to merge automatically on a repository that
   * legitimately configures NO checks (DP1). DEFAULT `false`.
   *
   * It covers `unconfigured` and nothing else: "I know this repo has no
   * checks" is a statement a person can make, "I consent in advance to my
   * checks runtime breaking" is not. GLOBAL-ONLY, like `mergePolicy` — and
   * for the same reason: it is a consent, and a consent is given by whoever
   * owns the machine, not by a repository they cloned.
   */
  allowMergeWithoutChecks?: boolean | undefined
  /** Cloud sync (codesema.com): base URL override and workspace credentials. */
  syncUrl?: string | undefined
  syncWorkspaceId?: string | undefined
  syncSecret?: string | undefined
  /** Explicit opt-in for pushing every completed review; credentials alone never auto-push. */
  syncAutoPush?: boolean | undefined
}

/**
 * Which review flow a task's end-of-turn review runs (see
 * CodesemaConfig.reviewMode). Declared HERE and not in task-review.ts, which
 * imports this module: `TaskReviewMode` is an alias of this type, so the
 * config layer and the reviewer can never end up with two enums to keep in
 * step.
 */
export type ReviewMode = 'simple' | 'dual'

const REVIEW_MODES: ReadonlySet<string> = new Set(['simple', 'dual'])

export function isReviewMode(value: unknown): value is ReviewMode {
  return typeof value === 'string' && REVIEW_MODES.has(value)
}

/**
 * The review flow a resolved config selects. `undefined` — the key absent, or
 * present with a value outside the enum, which `parseConfig` already dropped —
 * means 'simple': the pre-T3.2 behaviour, never an error and never 'dual',
 * which would silently double a project's review cost.
 */
export function resolveReviewMode(config: CodesemaConfig): ReviewMode {
  return config.reviewMode ?? 'simple'
}

/**
 * D14, answered: TWO automatic fix turns after a blocking review, then the
 * task goes back to a human. Declared HERE, beside the key it defaults, for
 * the same reason `ReviewMode` is: the config layer and the loop must never
 * end up with two numbers to keep in step.
 */
export const DEFAULT_MAX_AUTO_FIX_ROUNDS = 2

/**
 * The bound a resolved config selects for the automatic fix loop. Absent,
 * malformed, zero or negative all land on the D14 default, and NONE of them
 * throws — a repository must never lose its reviewer to a typo.
 *
 * `0` is deliberately NOT a switch that turns the loop off: giving that value
 * its own meaning is an arbitrage this ticket does not carry (design decision
 * 4's own non-binding note), so it is treated exactly like `-1` or `"two"` —
 * an unusable bound, and the default applies. The day `0` is specified, it
 * becomes ONE branch here rather than a behaviour that was never decided.
 */
export function resolveMaxAutoFixRounds(config: CodesemaConfig): number {
  const value = config.maxAutoFixRounds
  return Number.isInteger(value) && (value as number) >= 1
    ? (value as number)
    : DEFAULT_MAX_AUTO_FIX_ROUNDS
}

// --- Merge policy (T3.6, D12 / D13 / DP1) ---------------------------------
//
// Declared HERE and not in task-merge.ts, which imports this module, for the
// same reason `ReviewMode` is: the config layer and the merge gate must never
// end up with two enums to keep in step.

/** Whether the workspace ever merges by itself (see CodesemaConfig.mergePolicy). */
export type MergePolicy = 'auto' | 'human'

/** Merge strategy asked of the forge CLI (see CodesemaConfig.mergeStrategy). */
export type MergeStrategy = 'merge' | 'squash' | 'rebase'

const MERGE_POLICIES: ReadonlySet<string> = new Set(['auto', 'human'])
const MERGE_STRATEGIES: ReadonlySet<string> = new Set(['merge', 'squash', 'rebase'])

export function isMergePolicy(value: unknown): value is MergePolicy {
  return typeof value === 'string' && MERGE_POLICIES.has(value)
}

export function isMergeStrategy(value: unknown): value is MergeStrategy {
  return typeof value === 'string' && MERGE_STRATEGIES.has(value)
}

/**
 * The four merge settings in force, resolved from a config. An ABSENT
 * `strategy` is meaningful and is therefore kept absent rather than defaulted:
 * it is what makes the argv carry no strategy option at all (D13).
 */
export type MergeSettings = {
  policy: MergePolicy
  strategy?: MergeStrategy
  deleteBranch: boolean
  allowMergeWithoutChecks: boolean
}

/**
 * What an unconfigured workspace does: it does not merge, it does not pick a
 * strategy for the repository, it does not delete the branch, and it consents
 * to nothing. Every one of the four defaults is the inert one, because the
 * merge is the single irreversible action this product takes.
 */
export const DEFAULT_MERGE_SETTINGS: MergeSettings = {
  policy: 'human',
  deleteBranch: false,
  allowMergeWithoutChecks: false,
}

/**
 * The merge settings a resolved config selects. A key that is absent — or was
 * present with a value outside its enum, which `parseConfig` already dropped —
 * lands on `DEFAULT_MERGE_SETTINGS`. Never throws: a typo in a config file
 * must not be able to stop a workspace, and it must certainly not be able to
 * turn merging ON.
 */
export function resolveMergeSettings(config: CodesemaConfig): MergeSettings {
  return {
    policy: config.mergePolicy ?? DEFAULT_MERGE_SETTINGS.policy,
    ...(config.mergeStrategy ? { strategy: config.mergeStrategy } : {}),
    deleteBranch: config.deleteBranchAfterMerge ?? DEFAULT_MERGE_SETTINGS.deleteBranch,
    allowMergeWithoutChecks:
      config.allowMergeWithoutChecks ?? DEFAULT_MERGE_SETTINGS.allowMergeWithoutChecks,
  }
}

/** Configured isolation policy for workspace tasks (see CodesemaConfig.isolation). */
export type IsolationMode = 'auto' | 'container' | 'policy'

const ISOLATION_MODES: ReadonlySet<string> = new Set(['auto', 'container', 'policy'])

export function isIsolationMode(value: unknown): value is IsolationMode {
  return typeof value === 'string' && ISOLATION_MODES.has(value)
}

/** Enough for a handful of provider endpoints; a longer list is a proxy, not an allowlist. */
const ALLOWED_DOMAINS_MAX = 32
const ALLOWED_DOMAIN_MAX_CHARS = 253

/**
 * A domain goes verbatim into the generated squid allowlist: only plain
 * hostnames survive (letters, digits, dots, dashes), everything else is
 * dropped rather than escaped. An empty result means "no override", not "deny
 * everything" — the isolation defaults apply.
 */
export function sanitizeAllowedDomains(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const domains: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue
    }
    const domain = entry.trim().toLowerCase()
    if (
      !domain ||
      domain.length > ALLOWED_DOMAIN_MAX_CHARS ||
      !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain) ||
      domains.includes(domain)
    ) {
      continue
    }
    domains.push(domain)
    if (domains.length >= ALLOWED_DOMAINS_MAX) {
      break
    }
  }
  return domains.length > 0 ? domains : undefined
}

type ConfigScope = 'global' | 'repo'

function parseConfig(path: string, scope: ConfigScope): CodesemaConfig {
  if (!existsSync(path)) {
    return {}
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
    // A budget is a whole number of seconds, at least one: anything else is
    // dropped so the D3 default applies, never a 0 that would kill on sight.
    const secs = (v: unknown) =>
      Number.isInteger(v) && (v as number) >= 1 ? (v as number) : undefined
    const allowedDomains = sanitizeAllowedDomains(raw.isolationAllowedDomains)
    return {
      ...(str(raw.agent) ? { agent: str(raw.agent) } : {}),
      ...(str(raw.agentId) ? { agentId: str(raw.agentId) } : {}),
      ...(str(raw.model) ? { model: str(raw.model) } : {}),
      ...(str(raw.effort) ? { effort: str(raw.effort) } : {}),
      ...(str(raw.target) ? { target: str(raw.target) } : {}),
      ...(isSupportedLanguage(raw.language) ? { language: raw.language } : {}),
      // Sync fields are global-only: a cloned repo's .codesema/config.json must
      // never be able to redirect where reviews (diff included) are sent.
      ...(scope === 'global' && str(raw.syncUrl) ? { syncUrl: str(raw.syncUrl) } : {}),
      ...(scope === 'global' && str(raw.syncWorkspaceId)
        ? { syncWorkspaceId: str(raw.syncWorkspaceId) }
        : {}),
      ...(scope === 'global' && str(raw.syncSecret) ? { syncSecret: str(raw.syncSecret) } : {}),
      ...(scope === 'global' && typeof raw.syncAutoPush === 'boolean'
        ? { syncAutoPush: raw.syncAutoPush }
        : {}),
      ...(Number.isInteger(raw.port) ? { port: raw.port as number } : {}),
      // Since T1.7 this is the run's LAST-RESORT ceiling and nothing else is
      // watching the wall clock, so a 0 or a negative would mean "kill on
      // sight": same guard as the watchdog budgets, the default applies.
      ...(secs(raw.timeout) !== undefined ? { timeout: secs(raw.timeout) } : {}),
      // Machine-wide load cap (T1.3) is GLOBAL-ONLY (T1.4): a repo file that
      // sets either key is stripped here and named by resolveProjectConfig —
      // never silently, never applied. The resource being capped is the
      // machine, not the repository (D4).
      ...(scope === 'global' &&
      Number.isInteger(raw.maxParallelTasks) &&
      (raw.maxParallelTasks as number) >= 1
        ? { maxParallelTasks: raw.maxParallelTasks as number }
        : {}),
      // GLOBAL-ONLY (T1.4 review A2): retention is applied by ONE pass over
      // EVERY registered project, so a repo file that set it would decide how
      // long the OTHER projects keep their finished tasks. Stripped here, and
      // named by `repoGlobalOnlyIgnoredNotices` rather than dropped silently.
      // On the global file: 0 is a legitimate choice (purge every terminated
      // task at the next boot, keep none); a negative or non-integer value is
      // not, and DEFAULT_TASK_RETENTION applies instead of a value that would
      // mean nothing sliced against an array.
      ...(scope === 'global' &&
      Number.isInteger(raw.taskRetentionCount) &&
      (raw.taskRetentionCount as number) >= 0
        ? { taskRetentionCount: raw.taskRetentionCount as number }
        : {}),
      ...(scope === 'global' &&
      Number.isInteger(raw.maxConcurrentAgents) &&
      (raw.maxConcurrentAgents as number) >= 1
        ? { maxConcurrentAgents: raw.maxConcurrentAgents as number }
        : {}),
      ...(secs(raw.watchdogInactivitySeconds) !== undefined
        ? { watchdogInactivitySeconds: secs(raw.watchdogInactivitySeconds) }
        : {}),
      ...(secs(raw.watchdogToolBudgetSeconds) !== undefined
        ? { watchdogToolBudgetSeconds: secs(raw.watchdogToolBudgetSeconds) }
        : {}),
      ...(secs(raw.watchdogHeartbeatSeconds) !== undefined
        ? { watchdogHeartbeatSeconds: secs(raw.watchdogHeartbeatSeconds) }
        : {}),
      // Repo-settable on purpose: like `checks`, the cage is a property of the
      // project (its devcontainer, the endpoints its agent needs), and a repo
      // can only ever narrow what the agent reaches — never widen its host
      // rights, since the host path is the policy fallback either way.
      ...(isIsolationMode(raw.isolation) ? { isolation: raw.isolation } : {}),
      ...(allowedDomains !== undefined ? { isolationAllowedDomains: allowedDomains } : {}),
      // T3.2, repo-settable: a value outside 'simple' | 'dual' is DROPPED
      // here, so `resolveReviewMode` falls back to 'simple' — a typo must
      // never leave a project with no reviewer, nor promote it to the flow
      // that costs twice as much.
      ...(isReviewMode(raw.reviewMode) ? { reviewMode: raw.reviewMode } : {}),
      // T3.3 (D14), repo-settable: only an integer >= 1 is kept, so a typo, a
      // negative and a `0` alike are DROPPED here and
      // `resolveMaxAutoFixRounds` answers with the D14 default. Never a throw
      // (invariant n° 1), and never a bound of zero nobody specified.
      ...(Number.isInteger(raw.maxAutoFixRounds) && (raw.maxAutoFixRounds as number) >= 1
        ? { maxAutoFixRounds: raw.maxAutoFixRounds as number }
        : {}),
      // T3.6, GLOBAL-ONLY: whether this workspace merges without asking, how,
      // what happens to the branch, and whether a repo without checks was
      // consented to. All four are stripped from a repo file (and NAMED by
      // `repoGlobalOnlyIgnoredNotices`), and a value outside its enum or type
      // is DROPPED here so `resolveMergeSettings` answers with the inert
      // default — a typo never throws, and never turns merging on.
      ...(scope === 'global' && isMergePolicy(raw.mergePolicy)
        ? { mergePolicy: raw.mergePolicy }
        : {}),
      ...(scope === 'global' && isMergeStrategy(raw.mergeStrategy)
        ? { mergeStrategy: raw.mergeStrategy }
        : {}),
      ...(scope === 'global' && typeof raw.deleteBranchAfterMerge === 'boolean'
        ? { deleteBranchAfterMerge: raw.deleteBranchAfterMerge }
        : {}),
      ...(scope === 'global' && typeof raw.allowMergeWithoutChecks === 'boolean'
        ? { allowMergeWithoutChecks: raw.allowMergeWithoutChecks }
        : {}),
      // Repo-settable (T3.7/D15, see the field's own comment), and kept on the
      // TYPE rather than on the value: `forgeCycleLabels: false` in a repo file
      // is a project SAYING NO, and it only outranks a global `true` if it
      // survives this parse as a present `false`. `raw.x ? … : {}` here would
      // drop it and hand the project straight back to the global opt-in.
      ...(typeof raw.forgeCycleLabels === 'boolean'
        ? { forgeCycleLabels: raw.forgeCycleLabels }
        : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Whether `key` is PRESENT in the raw JSON at `path` but not usable as a
 * positive integer — as opposed to simply absent. `parseConfig` drops such a
 * value in silence, the same whitelist-and-truncate doctrine every other
 * malformed numeric field in this file gets (a bad `port` or `timeout`
 * quietly falls back to its own default too). The two machine-cap keys
 * (`maxConcurrentAgents`, `maxParallelTasks`, T1.3) are the one place this
 * distinction is surfaced to a caller that wants to WARN about it
 * (workspace.ts's boot notices) rather than merely absorb it: adversarial
 * review, MINEUR — a user who typed `maxConcurrentAgents: 0` meant to size
 * their machine's parallelism, and silently getting
 * DEFAULT_MAX_CONCURRENT_AGENTS instead is exactly the silent failure mode
 * invariant § 0.3 n°2 forbids elsewhere. Never throws: unreadable or
 * unparsable JSON reads as "nothing to warn about" — parseConfig's own catch
 * already degrades that case to defaults, and this must not double-report it.
 */
export function hasInvalidPositiveIntKey(
  path: string,
  key: 'maxConcurrentAgents' | 'maxParallelTasks',
): boolean {
  if (!existsSync(path)) {
    return false
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const value = raw[key]
    return value !== undefined && !(Number.isInteger(value) && (value as number) >= 1)
  } catch {
    return false
  }
}

/**
 * The four merge keys, each with the predicate that makes a value USABLE. One
 * table so the parser's guards above and the boot warning below can never
 * describe different sets of values as valid (T3.6).
 */
const MERGE_KEY_VALIDATORS = {
  mergePolicy: isMergePolicy,
  mergeStrategy: isMergeStrategy,
  deleteBranchAfterMerge: (v: unknown) => typeof v === 'boolean',
  allowMergeWithoutChecks: (v: unknown) => typeof v === 'boolean',
} as const satisfies Record<string, (value: unknown) => boolean>

export type MergeConfigKey = keyof typeof MERGE_KEY_VALIDATORS

/**
 * Merge keys PRESENT in the raw JSON at `path` but not usable — `"Auto"`, `1`,
 * `"yes"` — as opposed to simply absent. `parseConfig` drops such a value in
 * silence, the doctrine every other malformed key gets; these four are
 * surfaced instead, for the reason `hasInvalidPositiveIntKey` exists: a user
 * who typed `mergePolicy: "Auto"` meant to authorize automatic merging, and
 * silently NOT getting it is exactly the kind of silence invariant n° 2
 * forbids. Never throws — unreadable or unparsable JSON reads as "nothing to
 * warn about", since `parseConfig`'s own catch already degraded that case.
 */
export function invalidMergeKeys(path: string): MergeConfigKey[] {
  if (!existsSync(path)) {
    return []
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return []
    }
    const keys = Object.keys(MERGE_KEY_VALIDATORS) as MergeConfigKey[]
    return keys.filter((key) => raw[key] !== undefined && !MERGE_KEY_VALIDATORS[key](raw[key]))
  } catch {
    return []
  }
}

/** The same reading, on the GLOBAL file — the only one these four keys are read from. */
export function invalidGlobalMergeKeys(): MergeConfigKey[] {
  return invalidMergeKeys(globalConfigPath())
}

function writeConfig(path: string, config: CodesemaConfig, options?: { mode: number }): string {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, options)
  return path
}

export function globalConfigDir(): string {
  if (process.env.CODESEMA_CONFIG_DIR) {
    return process.env.CODESEMA_CONFIG_DIR
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'codesema')
}

export function globalConfigPath(): string {
  return join(globalConfigDir(), 'config.json')
}

export function loadGlobalConfig(): CodesemaConfig {
  return parseConfig(globalConfigPath(), 'global')
}

export function saveGlobalConfig(config: CodesemaConfig): string {
  mkdirSync(globalConfigDir(), { recursive: true })
  // The global config can hold the sync workspace secret: owner-only permissions,
  // re-tightened on every save because the mode option only applies at creation.
  const path = writeConfig(globalConfigPath(), config, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export function repoConfigPath(repoRoot: string): string {
  return join(repoRoot, '.codesema', 'config.json')
}

export function loadRepoConfig(repoRoot: string): CodesemaConfig {
  return parseConfig(repoConfigPath(repoRoot), 'repo')
}

export function saveRepoConfig(repoRoot: string, config: CodesemaConfig): string {
  ensureWorkDir(repoRoot)
  return writeConfig(repoConfigPath(repoRoot), config)
}

/** Effective config: repo overrides global, field by field. */
export function loadConfig(repoRoot: string | null): CodesemaConfig {
  const global = loadGlobalConfig()
  const repo = repoRoot ? loadRepoConfig(repoRoot) : {}
  return { ...global, ...repo }
}

/**
 * CLI flags that win over both config files (documented precedence:
 * flag > `.codesema/config.json` > `~/.config/codesema/config.json`).
 * Process-wide: a flag applies to every registered project.
 *
 * Deliberately four keys, not seven (T1.4 review P8): `agentId`, `model` and
 * `effort` are WIZARD METADATA — `wizard.ts` composes them into `agent` and
 * writes all four to a config FILE. No CLI flag ever produces them, so a flag
 * layer for them was output no caller could reach. They still get the
 * repo > global precedence every other config key gets, through the merge in
 * `resolveProjectConfig` below; what they do not get is a third layer that
 * nothing can fill.
 */
export type ProjectConfigFlags = {
  isolation?: IsolationMode | undefined
  isolationAllowedDomains?: string[] | undefined
  timeout?: number | undefined
  agent?: string | undefined
}

export type ResolvedProjectConfig = {
  config: CodesemaConfig
  /** Named degradations (global-only keys stripped from a repo file). */
  warnings: string[]
}

/**
 * Every key a repo `.codesema/config.json` may hold that is stripped by
 * `parseConfig` AND named out loud when it is. Deliberately NOT called
 * LOAD_CAP_KEYS any more (T1.4 review A2): the list stopped being about the
 * machine load cap the day `taskRetentionCount` joined it, and an identifier
 * that says less than it contains is how a key ends up stripped in silence.
 *
 * The sync keys (`syncUrl`, `syncSecret`, `syncAutoPush`) are stripped too but
 * stay OUT of this list on purpose: they are credentials, and echoing back
 * that a repo tried to redirect where reviews are sent is not a warning a
 * human can act on. These three govern a resource that belongs to the MACHINE
 * or to the WHOLE workspace, so a human who set one meant something real and
 * has to be told it did not happen.
 */
const REPO_IGNORED_GLOBAL_ONLY_KEYS = [
  'maxConcurrentAgents',
  'maxParallelTasks',
  'taskRetentionCount',
  // T3.6: the four merge settings. They join the list under a DIFFERENT
  // argument from the three above — nothing about them is a machine resource.
  // What they govern is whether this tool performs the one irreversible
  // action it knows, and on whose say-so; a cloned repository that could turn
  // `mergePolicy: "auto"` on, or open `allowMergeWithoutChecks`, would be
  // giving a consent on behalf of the person running the workspace. Ignored,
  // and NAMED — a repo that meant something real has to be told it did not
  // happen.
  'mergePolicy',
  'mergeStrategy',
  'deleteBranchAfterMerge',
  'allowMergeWithoutChecks',
] as const

/**
 * Global-only keys PRESENT in a repo `.codesema/config.json`, raw — including
 * values parseConfig would drop. Presence is what we warn about (T1.4): the
 * key is global-only, so a well-formed `3` is ignored just as a `0` is.
 * Never throws: unreadable JSON is "nothing to warn about".
 */
export function presentRepoGlobalOnlyKeys(
  repoRoot: string,
): Array<(typeof REPO_IGNORED_GLOBAL_ONLY_KEYS)[number]> {
  try {
    const raw = JSON.parse(readFileSync(repoConfigPath(repoRoot), 'utf8')) as Record<
      string,
      unknown
    >
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return []
    }
    return REPO_IGNORED_GLOBAL_ONLY_KEYS.filter((key) => raw[key] !== undefined)
  } catch {
    return []
  }
}

export function repoGlobalOnlyIgnoredNotices(repoRoot: string | null): string[] {
  if (repoRoot === null) {
    return []
  }
  return presentRepoGlobalOnlyKeys(repoRoot).map((key) => t('config.globalOnlyIgnored', { key }))
}

/**
 * Per-project configuration (T1.4). Precedence is the documented one:
 * CLI flags > repo `.codesema/config.json` > `~/.config/codesema/config.json`.
 * `reviewMode` (T3.2) rides the repo > global merge like every other
 * repo-settable key; it has no flag layer, for the same reason `agentId` /
 * `model` / `effort` have none — no CLI flag produces it.
 * `maxConcurrentAgents` / `maxParallelTasks` / `taskRetentionCount` never come
 * from the repo file (stripped in parseConfig); if they were written there,
 * `warnings` names each of them.
 *
 * `projectPath` null is the no-repo launch: only the global file (and flags)
 * apply, which is the pre-T1.4 behaviour of `loadConfig(null)`.
 */
export function resolveProjectConfig(
  projectPath: string | null,
  flags: ProjectConfigFlags = {},
): ResolvedProjectConfig {
  const global = loadGlobalConfig()
  const repo = projectPath ? loadRepoConfig(projectPath) : {}
  const warnings = repoGlobalOnlyIgnoredNotices(projectPath)
  const merged: CodesemaConfig = { ...global, ...repo }
  const flagged = <K extends keyof ProjectConfigFlags>(
    key: K,
    value: ProjectConfigFlags[K],
  ): Partial<CodesemaConfig> =>
    value !== undefined ? ({ [key]: value } as Partial<CodesemaConfig>) : {}
  return {
    config: {
      ...merged,
      ...flagged('isolation', flags.isolation),
      ...flagged('isolationAllowedDomains', flags.isolationAllowedDomains),
      ...flagged('timeout', flags.timeout),
      // `--agent` is applied here even though the command a project RUNS is
      // resolved by `resolveProjectAgentCommand` (which owns the TOFU rules
      // this merge has no business replaying): a resolved view whose `agent`
      // still named the config file while the flag overrode it would be a
      // trap for the next reader, not an economy.
      ...flagged('agent', flags.agent),
    },
    warnings,
  }
}

/**
 * Whether a repo-provided agent command may run unattended (workspace TOFU).
 * `none` = the repo did not set `agent`; the caller uses its fallback.
 * Only the value from `.codesema/config.json` is a TOFU surface — never the
 * merged/global agent (T1.4 review: a global `agent` is not "repo-provided").
 */
export function trustedProjectAgentCommand(
  projectPath: string,
  configured: string | undefined,
):
  { kind: 'trusted'; command: string } | { kind: 'untrusted'; command: string } | { kind: 'none' } {
  if (!configured) {
    return { kind: 'none' }
  }
  return isRepoAgentTrusted(projectPath, configured)
    ? { kind: 'trusted', command: configured }
    : { kind: 'untrusted', command: configured }
}

/**
 * Agent command this project will actually run (T1.4). Precedence:
 * CLI `--agent` (bypasses TOFU) > this repo's `.codesema/config.json` (TOFU)
 * > global `agent` (no TOFU) > `fallback` (detected at boot, never another
 * project's repo-provided command).
 */
export function resolveProjectAgentCommand(
  projectPath: string | null,
  flags: ProjectConfigFlags,
  fallback: string,
): { command: string; warning?: string } {
  if (flags.agent) {
    return { command: flags.agent }
  }
  if (projectPath) {
    const repoAgent = trustedProjectAgentCommand(projectPath, loadRepoConfig(projectPath).agent)
    if (repoAgent.kind === 'trusted') {
      return { command: repoAgent.command }
    }
    if (repoAgent.kind === 'untrusted') {
      return {
        command: loadGlobalConfig().agent ?? fallback,
        warning: t('config.untrustedRepoAgent', { command: repoAgent.command }),
      }
    }
  }
  return { command: loadGlobalConfig().agent ?? fallback }
}

/**
 * The three watchdog budgets in force, in milliseconds: what the config says
 * where it says something usable, D3's defaults everywhere else. parseConfig
 * already dropped anything that was not a positive whole number of seconds, so
 * a hand-mangled config degrades to the defaults instead of to a run that dies
 * instantly.
 */
export function resolveWatchdogBudgets(config: CodesemaConfig): WatchdogBudgets {
  const ms = (seconds: number | undefined, fallback: number): number =>
    seconds !== undefined ? seconds * 1000 : fallback
  return {
    inactivityMs: ms(config.watchdogInactivitySeconds, AGENT_WATCHDOG_DEFAULTS.inactivityMs),
    toolBudgetMs: ms(config.watchdogToolBudgetSeconds, AGENT_WATCHDOG_DEFAULTS.toolBudgetMs),
    heartbeatMs: ms(config.watchdogHeartbeatSeconds, AGENT_WATCHDOG_DEFAULTS.heartbeatMs),
  }
}

// Trust store (TOFU) for repo-provided agent commands. Kept in the GLOBAL config,
// out of reach of any cloned repo: an agent command coming from .codesema/config.json
// only runs after explicit approval, and is re-approved whenever it changes.

export function trustStorePath(): string {
  return join(globalConfigDir(), 'trusted-agents.json')
}

function readTrustStore(): Record<string, string> {
  const path = trustStorePath()
  if (!existsSync(path)) {
    return {}
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') {
        out[key] = value
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Whether this exact agent command was already approved for this repo. */
export function isRepoAgentTrusted(repoRoot: string, command: string): boolean {
  return readTrustStore()[repoRoot] === command
}

/** Records approval of a repo-provided agent command (TOFU). */
export function trustRepoAgent(repoRoot: string, command: string): void {
  const store = readTrustStore()
  store[repoRoot] = command
  mkdirSync(globalConfigDir(), { recursive: true })
  writeFileSync(trustStorePath(), `${JSON.stringify(store, null, 2)}\n`)
}

/**
 * Directory EVERY task worktree of `repoRoot` is materialized under, and the
 * one the per-repository worktree lock lives in.
 *
 * Here rather than in task-worktree.ts, which is where it started (T2.6):
 * worktree-lock.ts needs it too — it mkdir's that very directory before
 * taking the lock, and names its lockfile inside it — and it cannot import
 * task-worktree.ts, which imports IT. The two spelled the literal out by hand
 * instead, which is exactly the drift a shared helper exists to prevent.
 * config.ts already owns the .codesema/ layout (`ensureWorkDir` below), and
 * both modules already import it.
 */
export function taskWorktreesDir(repoRoot: string): string {
  return join(repoRoot, '.codesema', 'worktrees')
}

/** Creates .codesema/ with its own auto .gitignore (no impact on the host repo). */
export function ensureWorkDir(repoRoot: string): string {
  const dir = join(repoRoot, '.codesema')
  mkdirSync(dir, { recursive: true })
  const selfIgnore = join(dir, '.gitignore')
  if (!existsSync(selfIgnore)) {
    writeFileSync(selfIgnore, '*\n')
  }
  return dir
}
