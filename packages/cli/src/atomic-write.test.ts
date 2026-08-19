import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  nodeAtomicWriteIo,
  writeFileAtomic,
  writeJsonAtomic,
  type AtomicWriteIo,
} from './atomic-write.js'

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codesema-atomic-'))
  cleanups.push(dir)
  return dir
}

describe('writeFileAtomic', () => {
  test('creates the directory, writes the payload and publishes it under the real name', () => {
    const dir = makeDir()
    const path = join(dir, 'nested', 'deeper', 'file.json')
    writeFileAtomic(path, 'hello\n')
    expect(readFileSync(path, 'utf8')).toBe('hello\n')
    // The temporary name never survives a successful write.
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  test('NO partial state is ever readable: the bytes land in the tmp file, the rename publishes them', () => {
    const dir = makeDir()
    const path = join(dir, 'queue.json')
    writeFileSync(path, 'OLD COMPLETE CONTENT\n')

    // What a reader sees at every step of the write, in order.
    const seen: (string | null)[] = []
    const observe = (): void => {
      seen.push(existsSync(path) ? readFileSync(path, 'utf8') : null)
    }
    const io: AtomicWriteIo = {
      mkdir: (target) => {
        nodeAtomicWriteIo.mkdir(target)
        observe()
      },
      writeFile: (target, contents) => {
        nodeAtomicWriteIo.writeFile(target, contents)
        // The payload went somewhere ELSE than the published path…
        expect(target).toBe(`${path}.tmp`)
        observe()
      },
      rename: (from, to) => {
        nodeAtomicWriteIo.rename(from, to)
        observe()
      },
    }
    writeFileAtomic(path, 'NEW COMPLETE CONTENT\n', io)

    // …so a concurrent reader only ever saw the OLD complete file, then the
    // NEW complete one — never a truncated or half-written state.
    expect(seen).toEqual([
      'OLD COMPLETE CONTENT\n',
      'OLD COMPLETE CONTENT\n',
      'NEW COMPLETE CONTENT\n',
    ])
  })

  test('a crash between the tmp write and the rename leaves the previous file intact', () => {
    const dir = makeDir()
    const path = join(dir, 'projects.json')
    writeFileSync(path, 'previous\n')
    const io: AtomicWriteIo = {
      ...nodeAtomicWriteIo,
      rename: () => {
        throw new Error('crash before publish')
      },
    }
    expect(() => writeFileAtomic(path, 'next\n', io)).toThrow('crash before publish')
    expect(readFileSync(path, 'utf8')).toBe('previous\n')
  })
})

describe('writeJsonAtomic', () => {
  test('writes the two-space indent + trailing newline every codesema store uses', () => {
    const dir = makeDir()
    const path = join(dir, 'task.json')
    writeJsonAtomic(path, { id: 'abc', turns: [] })
    expect(readFileSync(path, 'utf8')).toBe(
      `${JSON.stringify({ id: 'abc', turns: [] }, null, 2)}\n`,
    )
  })
})
