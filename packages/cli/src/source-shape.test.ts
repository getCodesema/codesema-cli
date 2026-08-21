import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * A raw NUL byte in a source file is legal TypeScript — it is just a character
 * in a template literal, and three of our map keys used one as a separator. It
 * is also a silent trap: `rg` classes a file holding one as BINARY and stops at
 * the first match, so `rg -l aSymbol` prints nothing for a file that defines
 * it. The failure is silent AND in the reassuring direction, which is the worst
 * pair — a reconnaissance reads "this symbol does not exist" and moves on.
 *
 * `'\u0000'` is the same character to the runtime (same map key, same sha256
 * digest) and leaves the file plain text. So the rule is on the SOURCE BYTES,
 * not on the string value, and the guard has to read the bytes to see it.
 */
const PACKAGES = join(import.meta.dir, '..', '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue
      }
      out.push(...sourceFiles(full))
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.vue')) {
      out.push(full)
    }
  }
  return out
}

describe('source shape', () => {
  test('no source file carries a raw NUL byte, which would hide it from rg', () => {
    const offenders = sourceFiles(PACKAGES)
      .filter((file) => readFileSync(file).includes(0))
      .map((file) => file.slice(PACKAGES.length + 1))
    expect(offenders).toEqual([])
  })
})
