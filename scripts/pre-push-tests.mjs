/**
 * The pre-push test run: the whole suite, in parallel, under a hard deadline.
 *
 * It used to be `--changed=@{push}` instead, to pay only for the files a push
 * touches. Measured on this repo, that trade does not exist: a change to two
 * core modules selects 73 of the 93 test files, and the run costs 20s against
 * 21s for all 93. The narrowing bought a rounding error and a way to miss an
 * affected file, so the suite now runs whole.
 *
 * `--parallel` is what actually pays: 21s against 66s serial. It also carries
 * the hang documented in CONTRIBUTING: `--parallel` implies `--isolate`, and a
 * worker that keeps a handle open never gives the runner back. It is
 * intermittent (one run in four during the measurements), and it does not fail:
 * it sits there until someone notices. Hence the deadline below, and the serial
 * retry after it. The push is never blocked by the runner going quiet, and it
 * is never let through on a run that did not finish either.
 *
 * Coverage is deliberately absent: `--coverage` combined with `--parallel` does
 * not terminate on the full suite (see scripts/coverage-gate.mjs), and CI runs
 * the gate on every pull request anyway.
 */
import { spawn } from 'node:child_process'

const PACKAGES = ['packages/cli', 'packages/web', 'packages/contract']

/**
 * Four times the measured parallel run (21s). Long enough that a slow machine
 * or a cold filesystem cache never trips it, short enough that a hung runner
 * costs a minute and a half rather than an afternoon.
 */
const PARALLEL_DEADLINE_MS = 90_000

/** Same policy as the `test:only` script: half the cores locally, serial in CI. */
function parallelArgs() {
  if (process.env.CI) {
    return []
  }
  return [`--parallel=${Math.max(1, navigator.hardwareConcurrency >> 1)}`]
}

/**
 * Resolves to the exit code, or to null when the deadline killed the run. The
 * caller needs to tell "the tests failed" from "the runner stopped answering",
 * because only the second one deserves a retry.
 */
function runTests({ extraArgs, deadlineMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['test', '--timeout=20000', ...extraArgs, ...PACKAGES], {
      stdio: 'inherit',
    })

    const deadline =
      deadlineMs === undefined
        ? undefined
        : setTimeout(() => {
            // SIGKILL rather than SIGTERM: the thing being killed is a runner
            // that has already stopped making progress, and its workers are
            // children of it. A signal it might handle is a signal it might
            // also ignore.
            child.kill('SIGKILL')
          }, deadlineMs)

    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (deadline !== undefined) {
        clearTimeout(deadline)
      }
      resolve(signal === 'SIGKILL' ? null : (code ?? 1))
    })
  })
}

const parallel = parallelArgs()

if (parallel.length === 0) {
  process.exit(await runTests({ extraArgs: [], deadlineMs: undefined }))
}

const code = await runTests({
  extraArgs: parallel,
  deadlineMs: PARALLEL_DEADLINE_MS,
})

if (code !== null) {
  process.exit(code)
}

console.error(
  `\nthe parallel test run went quiet for ${PARALLEL_DEADLINE_MS / 1000}s. This is the known --parallel hang, not a failure. Running the suite serially instead; expect about a minute.\n`,
)
process.exit(await runTests({ extraArgs: [], deadlineMs: undefined }))
