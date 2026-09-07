import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { EvidenceItem, EvidenceRecord } from './contract.js'
import {
  EVIDENCE_MAX_BYTES,
  evidenceDir,
  ingestEvidenceFiles,
  readTaskEvidence,
  writeTaskEvidence,
} from './task-evidence.js'
import { taskDir } from './tasks-store.js'

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codesema-task-evidence-'))
  cleanups.push(dir)
  return dir
}

const TASK_ID = 'abcdef123456'

function baseRecord(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    version: 1,
    status: 'passed',
    reason: null,
    head_sha: null,
    items: [],
    ...overrides,
  }
}

describe('readTaskEvidence / writeTaskEvidence', () => {
  test('a task with no evidence.json reads as null', () => {
    const repo = makeDir()
    expect(readTaskEvidence(repo, TASK_ID)).toBeNull()
  })

  test('write then read round-trips the sanitized record', () => {
    const repo = makeDir()
    const item: EvidenceItem = {
      kind: 'screenshot',
      path: 'shot.png',
      bytes: 12,
      turn: 1,
      created_at: '2026-08-01T00:00:00.000Z',
    }
    const written = writeTaskEvidence(repo, TASK_ID, baseRecord({ items: [item] }))
    expect(written).toEqual(baseRecord({ items: [item] }))
    expect(readTaskEvidence(repo, TASK_ID)).toEqual(baseRecord({ items: [item] }))
  })

  test('an unknown task id reads as null and refuses to write', () => {
    const repo = makeDir()
    expect(readTaskEvidence(repo, 'not-a-task-id')).toBeNull()
    expect(() => writeTaskEvidence(repo, 'not-a-task-id', baseRecord())).toThrow()
  })

  test('a malformed file on disk reads back as null rather than throwing', () => {
    const repo = makeDir()
    mkdirSync(taskDir(repo, TASK_ID), { recursive: true })
    writeFileSync(join(taskDir(repo, TASK_ID), 'evidence.json'), 'not json')
    expect(readTaskEvidence(repo, TASK_ID)).toBeNull()
  })
})

describe('ingestEvidenceFiles', () => {
  function makeIncoming(): string {
    const dir = mkdtempSync(join(tmpdir(), 'codesema-evidence-incoming-'))
    return dir
  }

  test('png and webm are ingested, including from a subfolder, other extensions are ignored', () => {
    const repo = makeDir()
    const incoming = makeIncoming()
    writeFileSync(join(incoming, 'shot.png'), 'png-bytes')
    writeFileSync(join(incoming, 'notes.txt'), 'not evidence')
    mkdirSync(join(incoming, 'videos'), { recursive: true })
    writeFileSync(join(incoming, 'videos', 'clip.webm'), 'webm-bytes')

    const record = ingestEvidenceFiles(repo, TASK_ID, incoming, {
      turn: 3,
      status: 'passed',
      reason: null,
      head_sha: 'deadbeef',
      keep: null,
    })

    expect(record.status).toBe('passed')
    expect(record.head_sha).toBe('deadbeef')
    expect(record.items).toHaveLength(2)
    const kinds = record.items.map((item) => item.kind).toSorted()
    expect(kinds).toEqual(['screenshot', 'video'])
    for (const item of record.items) {
      expect(item.turn).toBe(3)
      expect(existsSync(join(evidenceDir(repo, TASK_ID), item.path))).toBe(true)
    }
  })

  test('a file over the size limit is ignored', () => {
    const repo = makeDir()
    const incoming = makeIncoming()
    writeFileSync(join(incoming, 'huge.png'), Buffer.alloc(EVIDENCE_MAX_BYTES + 1))
    writeFileSync(join(incoming, 'small.png'), 'ok')

    const record = ingestEvidenceFiles(repo, TASK_ID, incoming, {
      turn: 1,
      status: 'passed',
      reason: null,
      head_sha: null,
      keep: null,
    })

    expect(record.items).toHaveLength(1)
    expect(record.items[0]?.path.endsWith('.png')).toBe(true)
  })

  test('empty incoming yields zero items while status and reason are still applied', () => {
    const repo = makeDir()
    const incoming = makeIncoming()

    const record = ingestEvidenceFiles(repo, TASK_ID, incoming, {
      turn: 1,
      status: 'failed',
      reason: 'the checkout journey timed out',
      head_sha: null,
      keep: null,
    })

    expect(record.items).toEqual([])
    expect(record.status).toBe('failed')
    expect(record.reason).toBe('the checkout journey timed out')
  })

  test('incomingDir is removed once ingestion completes', () => {
    const repo = makeDir()
    const incoming = makeIncoming()
    writeFileSync(join(incoming, 'shot.png'), 'png-bytes')

    ingestEvidenceFiles(repo, TASK_ID, incoming, {
      turn: 1,
      status: 'passed',
      reason: null,
      head_sha: null,
      keep: null,
    })

    expect(existsSync(incoming)).toBe(false)
  })

  test('keep-N purges the oldest items and drops them from disk and from the record', () => {
    const repo = makeDir()
    const dir = evidenceDir(repo, TASK_ID)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'old-0.png'), 'a')
    writeFileSync(join(dir, 'old-1.png'), 'b')
    writeFileSync(join(dir, 'old-2.png'), 'c')
    writeTaskEvidence(
      repo,
      TASK_ID,
      baseRecord({
        items: [
          {
            kind: 'screenshot',
            path: 'old-0.png',
            bytes: 1,
            turn: 1,
            created_at: '2020-01-01T00:00:00.000Z',
          },
          {
            kind: 'screenshot',
            path: 'old-1.png',
            bytes: 1,
            turn: 1,
            created_at: '2020-01-01T00:00:01.000Z',
          },
          {
            kind: 'screenshot',
            path: 'old-2.png',
            bytes: 1,
            turn: 1,
            created_at: '2020-01-01T00:00:02.000Z',
          },
        ],
      }),
    )

    const incoming = makeIncoming()
    writeFileSync(join(incoming, 'new-0.png'), 'x')
    writeFileSync(join(incoming, 'new-1.png'), 'y')
    writeFileSync(join(incoming, 'new-2.webm'), 'z')

    const record = ingestEvidenceFiles(repo, TASK_ID, incoming, {
      turn: 2,
      status: 'passed',
      reason: null,
      head_sha: null,
      keep: 4,
    })

    expect(record.items).toHaveLength(4)
    const paths = record.items.map((item) => item.path)
    expect(paths).toContain('old-2.png')
    expect(paths).not.toContain('old-0.png')
    expect(paths).not.toContain('old-1.png')
    expect(existsSync(join(dir, 'old-0.png'))).toBe(false)
    expect(existsSync(join(dir, 'old-1.png'))).toBe(false)
    expect(existsSync(join(dir, 'old-2.png'))).toBe(true)
  })
})
