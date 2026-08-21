// Atomic file write, the ONE recipe (invariant 5: tmp + rename everywhere).
// The store used to carry three byte-identical copies of it (task.json,
// checks.json, projects.json); a fourth writer — the persisted task queue —
// was the moment to extract it instead of copying it again.
//
// Why tmp + rename and not a plain write: rename(2) is atomic within a
// filesystem, so a reader opening the target path during a write sees either
// the previous complete file or the new complete one, never the half-written
// bytes in between, and a crash mid-write leaves the previous file intact
// rather than a truncated one. The temporary file is created NEXT TO its
// target (same directory, hence same filesystem) — a rename across
// filesystems is not atomic and would degrade to a copy.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Filesystem seam of the helper (§ 0.4). The default drives node:fs; a test
 * injects its own to observe the ORDER of the three operations, which is the
 * whole point of the recipe and is invisible from the outside once it worked.
 */
export type AtomicWriteIo = {
  /** Recursive: the target directory may not exist yet (a task's first write). */
  mkdir: (dir: string) => void
  writeFile: (path: string, contents: string) => void
  rename: (from: string, to: string) => void
}

export const nodeAtomicWriteIo: AtomicWriteIo = {
  mkdir: (dir) => {
    mkdirSync(dir, { recursive: true })
  },
  writeFile: (path, contents) => {
    writeFileSync(path, contents)
  },
  rename: (from, to) => {
    renameSync(from, to)
  },
}

/**
 * Writes `contents` to `path` atomically: the bytes land in `<path>.tmp` and
 * only a rename publishes them. Never partial, never a half-file for a reader.
 */
export function writeFileAtomic(
  path: string,
  contents: string,
  io: AtomicWriteIo = nodeAtomicWriteIo,
): void {
  io.mkdir(dirname(path))
  const tmp = `${path}.tmp`
  io.writeFile(tmp, contents)
  io.rename(tmp, path)
}

/**
 * Same, for a JSON document, in the exact shape every codesema store has
 * always written: two-space indent and a trailing newline (so the files stay
 * diffable and `cat`-able by hand).
 */
export function writeJsonAtomic(
  path: string,
  value: unknown,
  io: AtomicWriteIo = nodeAtomicWriteIo,
): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, io)
}
