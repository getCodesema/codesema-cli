/**
 * The pre-push test run: only the test files affected by what is about to be
 * pushed, rather than all 93 of them.
 *
 * This is a speed trade, and it is only safe because it is not the last word.
 * CI still runs the whole suite with the coverage gate on every pull request —
 * if `--changed` misses an affected file, the pull request goes red, not the
 * merge. What this buys is that the common case (a change to two modules) stops
 * paying for the uncommon one.
 *
 * Coverage is deliberately absent here: `--coverage` combined with `--parallel`
 * does not terminate on the full suite (see scripts/coverage-gate.mjs), and a
 * serial coverage run is exactly the minute this script exists to avoid.
 */
import { execFileSync, spawn } from 'node:child_process'

/** Compared against when the branch has no push destination yet — a first push. */
const FALLBACK_BASE = 'origin/develop'

function revParse(ref) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * `@{push}` is where this branch would push, which is exactly the boundary we
 * want: everything past it is new to the remote. It does not resolve on a
 * branch that has never been pushed, hence the fallback to the trunk — and if
 * even that is missing (a fresh clone with no remote, a renamed default
 * branch), we say so and run everything rather than quietly test nothing.
 */
function resolveBase() {
  return revParse('@{push}') ?? revParse(FALLBACK_BASE)
}

/** Same policy as the `test:only` script: half the cores locally, serial in CI. */
function parallelArgs() {
  if (process.env.CI) {
    return []
  }
  return [`--parallel=${Math.max(1, navigator.hardwareConcurrency >> 1)}`]
}

const base = resolveBase()
if (!base) {
  console.log(
    `no push destination and no ${FALLBACK_BASE} to compare against — running the full suite`,
  )
}

const args = [
  'test',
  '--timeout=20000',
  ...parallelArgs(),
  ...(base ? [`--changed=${base}`] : []),
  'packages/cli',
  'packages/web',
  'packages/contract',
]

const child = spawn('bun', args, { stdio: 'inherit' })
child.on('error', (err) => {
  console.error(err)
  process.exit(1)
})
child.on('close', (code) => process.exit(code ?? 1))
