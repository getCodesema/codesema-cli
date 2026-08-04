import { describe, expect, test } from 'bun:test'
import { subprocessEnv } from './git.js'

describe('subprocessEnv', () => {
  test('purges variables that redirect git to a different repo', () => {
    const source = {
      PATH: '/usr/bin',
      GIT_DIR: '/some/other/repo/.git',
      GIT_WORK_TREE: '/some/other/repo',
      GIT_INDEX_FILE: '/some/other/repo/.git/index',
      GIT_OBJECT_DIRECTORY: '/some/other/repo/.git/objects',
      GIT_COMMON_DIR: '/some/other/repo/.git',
      GIT_PREFIX: 'sub/dir/',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/some/other/repo/.git/objects-alt',
      GIT_QUARANTINE_PATH: '/some/other/repo/.git/objects/incoming',
    }
    const result = subprocessEnv(source)
    expect(result.GIT_DIR).toBeUndefined()
    expect(result.GIT_WORK_TREE).toBeUndefined()
    expect(result.GIT_INDEX_FILE).toBeUndefined()
    expect(result.GIT_OBJECT_DIRECTORY).toBeUndefined()
    expect(result.GIT_COMMON_DIR).toBeUndefined()
    expect(result.GIT_PREFIX).toBeUndefined()
    expect(result.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined()
    expect(result.GIT_QUARANTINE_PATH).toBeUndefined()
    expect(result.PATH).toBe('/usr/bin')
  })

  test('keeps legitimate user GIT_* settings untouched, not just non-GIT vars', () => {
    const source = {
      GIT_DIR: '/some/other/repo/.git',
      GIT_SSH_COMMAND: 'ssh -i ~/.ssh/deploy_key',
      GIT_AUTHOR_NAME: 'Ada Lovelace',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada Lovelace',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
      GIT_CONFIG_GLOBAL: '/custom/gitconfig',
      GIT_ASKPASS: '/usr/bin/my-askpass',
    }
    const result = subprocessEnv(source)
    expect(result.GIT_DIR).toBeUndefined()
    expect(result.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/deploy_key')
    expect(result.GIT_AUTHOR_NAME).toBe('Ada Lovelace')
    expect(result.GIT_AUTHOR_EMAIL).toBe('ada@example.com')
    expect(result.GIT_COMMITTER_NAME).toBe('Ada Lovelace')
    expect(result.GIT_COMMITTER_EMAIL).toBe('ada@example.com')
    expect(result.GIT_CONFIG_GLOBAL).toBe('/custom/gitconfig')
    expect(result.GIT_ASKPASS).toBe('/usr/bin/my-askpass')
  })

  test('defaults to process.env when no source is given', () => {
    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = '/some/other/repo/.git'
    try {
      const result = subprocessEnv()
      expect(result.GIT_DIR).toBeUndefined()
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_DIR
      } else {
        process.env.GIT_DIR = previous
      }
    }
  })
})
