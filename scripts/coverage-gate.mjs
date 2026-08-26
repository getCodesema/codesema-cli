/**
 * Aggregate coverage gate.
 *
 * bunfig.toml already carries a `coverageThreshold`, but bun enforces that one
 * PER FILE — the effective floor is the repo's least-tested module, and no
 * per-file floor can notice the whole suite sliding down a point a month. This
 * script is the other half: it runs the full suite with coverage, reads the
 * "All files" row of bun's table, and fails below the floors declared here.
 *
 * The table is printed on STDERR, not stdout, which is why both streams are
 * captured. Everything the child writes is forwarded as it arrives, so a run
 * here looks exactly like a plain `bun test` run until the verdict at the end.
 *
 * Fail-closed by design: a missing or unparsable "All files" row is an error,
 * never a pass. If bun changes its reporter format, this gate goes red and
 * someone fixes the parser — the alternative is a gate that silently stops
 * measuring, which is worse than having none.
 */
import { spawn } from 'node:child_process'

/**
 * Floors for the whole suite, in percent. Measured baseline at the time of
 * writing: 86.55% functions / 85.94% lines over 3600 tests in 93 files.
 *
 * This is a ratchet. Raise these numbers when coverage improves, in the same
 * pull request that improves it. Never lower one to turn a build green: the
 * point of the gate is that the number cannot quietly go down.
 */
const FLOORS = { functions: 86, lines: 85 }

/**
 * Deliberately serial, unlike the `test:only` script which passes `--parallel`
 * locally. Combining `--parallel` with `--coverage` on the full suite was tried
 * here and did not finish within ten minutes, against roughly a minute serial;
 * the cause was not chased down, because a gate that occasionally hangs is
 * worse than a gate that takes a minute. If you reintroduce it, prove the full
 * suite completes rather than trusting a single-package run.
 */
const TEST_ARGS = [
  'test',
  '--coverage',
  '--timeout=20000',
  'packages/cli',
  'packages/web',
  'packages/contract',
]

/**
 * bun prints `All files      |   86.55 |   85.94 |` — pipe-separated, functions
 * then lines. Anchored on the row label so a source file whose name happens to
 * start with "All" cannot be mistaken for the summary.
 */
function parseSummary(output) {
  const row = output.split('\n').find((line) => /^All files\s*\|/.test(line))
  if (!row) {
    return null
  }
  const [, functions, lines] = row.split('|')
  const parsed = { functions: Number.parseFloat(functions), lines: Number.parseFloat(lines) }
  return Number.isNaN(parsed.functions) || Number.isNaN(parsed.lines) ? null : parsed
}

function runSuite() {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', TEST_ARGS, { stdio: ['inherit', 'pipe', 'pipe'] })
    let captured = ''
    for (const [stream, sink] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on('data', (chunk) => {
        captured += chunk
        sink.write(chunk)
      })
    }
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, captured }))
  })
}

const { code, captured } = await runSuite()

// A failing suite is reported on its own terms: the coverage of a red run says
// nothing, and printing a gate verdict next to it only buries the real failure.
if (code !== 0) {
  process.exit(code)
}

const summary = parseSummary(captured)
if (!summary) {
  console.error(
    '\ncoverage gate ERROR: no parsable "All files" row in the output.\n' +
      'Either coverage did not run (check that bunfig.toml has no `coverage = false`,\n' +
      'which silently overrides --coverage) or bun changed its reporter format.',
  )
  process.exit(1)
}

const below = Object.entries(FLOORS).filter(([metric, floor]) => summary[metric] < floor)
const measured = `${summary.functions.toFixed(2)}% funcs / ${summary.lines.toFixed(2)}% lines`

if (below.length > 0) {
  const expected = `${FLOORS.functions}% funcs / ${FLOORS.lines}% lines`
  console.error(`\ncoverage gate FAILED: ${measured} (floor ${expected})`)
  console.error(`below floor: ${below.map(([metric]) => metric).join(', ')}`)
  process.exit(1)
}

console.log(`\ncoverage gate OK: ${measured}`)
