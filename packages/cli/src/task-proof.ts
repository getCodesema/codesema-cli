import type { SandboxExecOptions, SandboxHandle } from './microsandbox-driver.js'

export type ProofCaptureResult = {
  status: 'passed' | 'failed'
  reason: string | null
}

export type CaptureProofOptions = {
  journey: string
  url: string
  timeoutMs: number
  guestWorkDir: string
  guestProofDir: string
  hostIncomingDir: string
}

const PROOF_REASON_TAIL_MAX = 2_000

function shellQuote(value: string): string | null {
  if (value.includes("'")) {
    return null
  }
  return `'${value}'`
}

function tail(text: string): string {
  return text.slice(-PROOF_REASON_TAIL_MAX)
}

async function runReplay(
  handle: SandboxHandle,
  opts: CaptureProofOptions,
  quotedJourney: string,
  quotedUrl: string,
): Promise<ProofCaptureResult> {
  const execOpts: SandboxExecOptions = { timeoutMs: opts.timeoutMs, cwd: opts.guestWorkDir }
  const replayCommand = `CODESEMA_BASE_URL=${quotedUrl} CODESEMA_PROOF_DIR=${opts.guestProofDir} npx playwright test ${quotedJourney} --output=${opts.guestProofDir}`
  const replay = await handle.shell(replayCommand, execOpts)
  if (!replay.timedOut && replay.code === 0) {
    return { status: 'passed', reason: null }
  }
  const reason = replay.timedOut
    ? `replay timed out after ${opts.timeoutMs}ms`
    : tail(replay.stdout + replay.stderr)
  await handle
    .shell(
      `npx playwright screenshot --full-page ${quotedUrl} ${opts.guestProofDir}/fallback.png`,
      execOpts,
    )
    .catch(() => undefined)
  return { status: 'failed', reason }
}

async function captureProofUnsafe(
  handle: SandboxHandle,
  opts: CaptureProofOptions,
): Promise<ProofCaptureResult> {
  await handle.shell(`mkdir -p ${opts.guestProofDir}`, { timeoutMs: opts.timeoutMs })

  const quotedJourney = shellQuote(opts.journey)
  const quotedUrl = shellQuote(opts.url)

  let result: ProofCaptureResult
  if (quotedJourney === null || quotedUrl === null) {
    const badField = quotedJourney === null ? 'journey' : 'url'
    result = {
      status: 'failed',
      reason: `refusing to run the replay: ${badField} contains a single quote, which cannot be safely quoted for the shell`,
    }
  } else {
    result = await runReplay(handle, opts, quotedJourney, quotedUrl)
  }

  try {
    await handle.copyToHost(opts.guestProofDir, opts.hostIncomingDir)
  } catch {
    if (result.status === 'passed') {
      return {
        status: 'failed',
        reason: 'proof capture passed but copying the evidence to the host failed',
      }
    }
  }

  return result
}

export async function captureProof(
  handle: SandboxHandle,
  opts: CaptureProofOptions,
): Promise<ProofCaptureResult> {
  try {
    return await captureProofUnsafe(handle, opts)
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}
