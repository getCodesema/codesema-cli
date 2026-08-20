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
  /** UI and review language (ISO 639-1). */
  language?: SupportedLanguage | undefined
  /** Cloud sync (codesema.com): base URL override and workspace credentials. */
  syncUrl?: string | undefined
  syncWorkspaceId?: string | undefined
  syncSecret?: string | undefined
  /** Explicit opt-in for pushing every completed review; credentials alone never auto-push. */
  syncAutoPush?: boolean | undefined
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
      // 0 is a legitimate choice (purge every terminated task at the next
      // boot, keep none); a negative or non-integer value is not, and the
      // DEFAULT_TASK_RETENTION default applies instead of a value that would
      // mean nothing sliced against an array.
      ...(Number.isInteger(raw.taskRetentionCount) && (raw.taskRetentionCount as number) >= 0
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
 */
export type ProjectConfigFlags = {
  isolation?: IsolationMode | undefined
  isolationAllowedDomains?: string[] | undefined
  timeout?: number | undefined
  agent?: string | undefined
  agentId?: string | undefined
  model?: string | undefined
  effort?: string | undefined
}

export type ResolvedProjectConfig = {
  config: CodesemaConfig
  /** Named degradations (global-only keys stripped from a repo file). */
  warnings: string[]
}

const LOAD_CAP_KEYS = ['maxConcurrentAgents', 'maxParallelTasks'] as const

/**
 * Load-cap keys PRESENT in a repo `.codesema/config.json`, raw — including
 * values parseConfig would drop. Presence is what we warn about (T1.4): the
 * key is global-only, so a well-formed `3` is ignored just as a `0` is.
 * Never throws: unreadable JSON is "nothing to warn about".
 */
export function presentRepoLoadCapKeys(repoRoot: string): Array<(typeof LOAD_CAP_KEYS)[number]> {
  try {
    const raw = JSON.parse(readFileSync(repoConfigPath(repoRoot), 'utf8')) as Record<
      string,
      unknown
    >
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return []
    }
    return LOAD_CAP_KEYS.filter((key) => raw[key] !== undefined)
  } catch {
    return []
  }
}

export function repoLoadCapIgnoredNotices(repoRoot: string | null): string[] {
  if (repoRoot === null) {
    return []
  }
  return presentRepoLoadCapKeys(repoRoot).map((key) => t('config.globalOnlyIgnored', { key }))
}

/**
 * Per-project configuration (T1.4). Precedence is the documented one:
 * CLI flags > repo `.codesema/config.json` > `~/.config/codesema/config.json`.
 * `maxConcurrentAgents` / `maxParallelTasks` never come from the repo file
 * (stripped in parseConfig); if they were written there, `warnings` says so.
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
  const warnings = repoLoadCapIgnoredNotices(projectPath)
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
      ...flagged('agent', flags.agent),
      ...flagged('agentId', flags.agentId),
      ...flagged('model', flags.model),
      ...flagged('effort', flags.effort),
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
