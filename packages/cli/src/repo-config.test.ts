import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { saveGlobalConfig, saveRepoConfig } from './config.js'
import {
  readRulesContent,
  readSyncAutoPush,
  rulesFilePath,
  setSyncAutoPush,
  writeRulesContent,
} from './repo-config.js'

describe('repo-config', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let repoDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-repoconfig-'))
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-repoconfig-repo-'))
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

  test('reads empty content when RULES.md does not exist', () => {
    expect(readRulesContent(repoDir)).toBe('')
  })

  test('writes RULES.md, creating .codesema on demand', () => {
    writeRulesContent(repoDir, '- no any\n- errors carry a cause\n')
    expect(readFileSync(rulesFilePath(repoDir), 'utf8')).toBe('- no any\n- errors carry a cause\n')
    expect(readRulesContent(repoDir)).toBe('- no any\n- errors carry a cause\n')
  })

  test('overwrites existing RULES.md content', () => {
    writeRulesContent(repoDir, '- first\n')
    writeRulesContent(repoDir, '- second\n')
    expect(readRulesContent(repoDir)).toBe('- second\n')
  })

  test('syncAutoPush defaults to false', () => {
    expect(readSyncAutoPush(repoDir)).toBe(false)
  })

  test('setSyncAutoPush writes to the global config and is read back as effective', () => {
    setSyncAutoPush(true)
    expect(readSyncAutoPush(repoDir)).toBe(true)
  })

  test('setSyncAutoPush preserves other global config fields', () => {
    saveGlobalConfig({ syncUrl: 'http://localhost:9080', syncWorkspaceId: 'ws-1' })
    setSyncAutoPush(true)
    expect(readSyncAutoPush(repoDir)).toBe(true)
  })

  test('a repo cannot make its own syncAutoPush true: the global value always wins', () => {
    saveRepoConfig(repoDir, { syncAutoPush: true })
    expect(readSyncAutoPush(repoDir)).toBe(false)
  })
})
