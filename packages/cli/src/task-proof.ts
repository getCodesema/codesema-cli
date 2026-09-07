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

export type CaptureScreenshotsOptions = {
  pages: string[]
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

async function ensureProofDir(
  handle: SandboxHandle,
  guestProofDir: string,
  timeoutMs: number,
): Promise<void> {
  await handle.shell(`mkdir -p ${guestProofDir}`, { timeoutMs })
}

async function finalizeCapture(
  handle: SandboxHandle,
  guestProofDir: string,
  hostIncomingDir: string,
  result: ProofCaptureResult,
): Promise<ProofCaptureResult> {
  try {
    await handle.copyToHost(guestProofDir, hostIncomingDir)
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
  await ensureProofDir(handle, opts.guestProofDir, opts.timeoutMs)

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

  return finalizeCapture(handle, opts.guestProofDir, opts.hostIncomingDir, result)
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

async function captureScreenshotsUnsafe(
  handle: SandboxHandle,
  opts: CaptureScreenshotsOptions,
): Promise<ProofCaptureResult> {
  await ensureProofDir(handle, opts.guestProofDir, opts.timeoutMs)

  const execOpts: SandboxExecOptions = { timeoutMs: opts.timeoutMs, cwd: opts.guestWorkDir }
  let passedCount = 0
  const tails: string[] = []
  for (const [index, page] of opts.pages.entries()) {
    const resolvedUrl = new URL(page, opts.url).toString()
    const quotedUrl = shellQuote(resolvedUrl)
    if (quotedUrl === null) {
      tails.push(
        `refusing to screenshot ${page}: resolved URL contains a single quote, which cannot be safely quoted for the shell`,
      )
      continue
    }
    const target = `${opts.guestProofDir}/p${index}.png`
    const shot = await handle.shell(
      `npx playwright screenshot --full-page ${quotedUrl} ${target}`,
      execOpts,
    )
    if (!shot.timedOut && shot.code === 0) {
      passedCount += 1
    } else {
      tails.push(
        shot.timedOut
          ? `${page}: screenshot timed out after ${opts.timeoutMs}ms`
          : `${page}: ${shot.stdout}${shot.stderr}`,
      )
    }
  }

  const result: ProofCaptureResult =
    passedCount > 0
      ? { status: 'passed', reason: null }
      : { status: 'failed', reason: tail(tails.join('\n')) }

  return finalizeCapture(handle, opts.guestProofDir, opts.hostIncomingDir, result)
}

export async function captureScreenshots(
  handle: SandboxHandle,
  opts: CaptureScreenshotsOptions,
): Promise<ProofCaptureResult> {
  try {
    return await captureScreenshotsUnsafe(handle, opts)
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}
