import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRunOptions } from './agent.js'
import type { Finding, GroundingReport, SanitizedReview, Verdict } from './contract.js'
import type { PrepInput } from './prep.js'
import {
  AgentOutputError,
  agentVisibleInput,
  extractReviewJson,
  groundingReportLines,
  missingReviewedFiles,
  reviewGateReason,
  reviewInstructions,
  runAgentJsonWithRetry,
  runDualFlow,
} from './review.js'
import { createSession } from './serve.js'

const REVIEW = '{"verdict":"approve","summary":"ok","findings":[]}'

function reviewWith(verdict: Verdict, severities: Finding['severity'][]): SanitizedReview {
  return {
    verdict,
    summary: '',
    findings: severities.map((severity) => ({ file: 'a.ts', message: 'm', severity })),
    narrative: null,
  }
}

describe('extractReviewJson', () => {
  test('plain JSON', () => {
    expect(extractReviewJson(REVIEW)).toBe(REVIEW)
  })

  test('prose around the JSON', () => {
    expect(extractReviewJson(`Here is the review:\n${REVIEW}\nHope this helps!`)).toBe(REVIEW)
  })

  test('markdown fence', () => {
    expect(extractReviewJson('Sure!\n```json\n' + REVIEW + '\n```\ndone')).toBe(REVIEW)
  })

  test('prefers the object with verdict when multiple valid objects exist', () => {
    const raw = `Example input: {"branch":"x"} and the result ${REVIEW} end`
    expect(extractReviewJson(raw)).toBe(REVIEW)
  })

  test('braces inside strings respected', () => {
    const tricky = '{"verdict":"comment","summary":"code: if (a) { b() }","findings":[]}'
    expect(extractReviewJson(`note ${tricky} bye`)).toBe(tricky)
  })

  test('object without verdict accepted as last resort', () => {
    expect(extractReviewJson('x {"summary":"only"} y')).toBe('{"summary":"only"}')
  })

  test('no JSON: error', () => {
    expect(() => extractReviewJson('no json here')).toThrow(/did not return a JSON review/)
    expect(() => extractReviewJson('[1,2,3]')).toThrow(/did not return a JSON review/)
  })
})

describe('agentVisibleInput', () => {
  test('keeps only what the agent needs; local path, SHAs and plumbing never leak', () => {
    const input: PrepInput = {
      version: 1,
      generated_by: 'codesema prep',
      title: 'feature/x',
      branch: 'feature/x',
      target: 'develop',
      target_source: 'heuristic',
      merge_base: 'abc123',
      head_sha: 'def456',
      repo_root: '/home/someone/secret-project',
      commits: ['feat: a'],
      files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
      custom_instructions: null,
      rules: ['[C1] no any'],
      impact_candidates: { note: 'best-effort', symbols: [], imported_by: { 'a.ts': ['b.ts'] } },
      diff: 'diff --git a/a.ts b/a.ts',
    }
    expect(agentVisibleInput(input)).toEqual({
      branch: 'feature/x',
      target: 'develop',
      commits: ['feat: a'],
      files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
      custom_instructions: null,
      rules: ['[C1] no any'],
      impact_candidates: { note: 'best-effort', symbols: [], imported_by: { 'a.ts': ['b.ts'] } },
    })
  })
})

describe('groundingReportLines', () => {
  const finding: Finding = { file: 'a.ts', severity: 'major', message: 'm' }

  test('untouched review: no lines', () => {
    const report: GroundingReport = { dropped: [], deanchored: [], merged: 0, verdict_escalated: false }
    expect(groundingReportLines(report)).toEqual([])
  })

  test('one line per correction, carrying the counts', () => {
    const report: GroundingReport = {
      dropped: [finding, finding],
      deanchored: [finding],
      merged: 3,
      verdict_escalated: true,
    }
    const lines = groundingReportLines(report)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('2')
    expect(lines[1]).toContain('1')
    expect(lines[2]).toContain('3')
    expect(lines[3]).toContain('request_changes')
  })
})

describe('reviewGateReason', () => {
  test('request_changes gate trips only on a request_changes verdict', () => {
    expect(reviewGateReason(reviewWith('request_changes', []), 'request_changes')).not.toBeNull()
    expect(reviewGateReason(reviewWith('approve', ['critical']), 'request_changes')).toBeNull()
  })

  test('severity gate trips at or above the threshold, not below', () => {
    expect(reviewGateReason(reviewWith('comment', ['major']), 'major')).not.toBeNull()
    expect(reviewGateReason(reviewWith('comment', ['critical']), 'major')).not.toBeNull()
    expect(reviewGateReason(reviewWith('comment', ['minor']), 'major')).toBeNull()
  })

  test('a clean review passes every gate', () => {
    const clean = reviewWith('approve', ['info'])
    expect(reviewGateReason(clean, 'critical')).toBeNull()
    expect(reviewGateReason(clean, 'request_changes')).toBeNull()
  })
})

describe('reviewInstructions', () => {
  test('carries sweep, self-check, severity definitions and files_reviewed', () => {
    const p = reviewInstructions()
    expect(p).toContain('files_reviewed')
    expect(p).toContain('file by file, hunk by hunk')
    expect(p).toContain('failure scenario')
    expect(p).toContain('no maximum number of findings')
    expect(p).toContain('critical = data loss')
    expect(p).toContain('omit "line" rather than guessing')
    expect(p).toContain('"verdict", "summary", "findings", "narrative", "files_reviewed"')
    expect(p).toContain('settle EVERY file explicitly')
    expect(p).toContain('"status": "clean" | "findings"')
    expect(p).toContain('REFUTE every finding')
    expect(p).toContain('HUNT them first')
    expect(p).toContain('[Cn]')
  })

  test('scopes the verdict to what the input can prove', () => {
    const p = reviewInstructions()
    expect(p).toContain('weighs ONLY what you could verify in the provided input')
    expect(p).toContain('never lowers the verdict')
    expect(p).toContain('raise it as a step "check" question')
  })
})

describe('missingReviewedFiles', () => {
  const files = [{ path: 'a.ts' }, { path: 'b.ts' }]

  test('null when the reviewer reported nothing', () => {
    expect(missingReviewedFiles(files, undefined)).toBeNull()
  })

  test('empty when every diff file was examined', () => {
    const reviewed = [
      { path: 'a.ts', status: 'clean' as const },
      { path: 'b.ts', status: 'findings' as const },
      { path: 'extra.ts', status: 'clean' as const },
    ]
    expect(missingReviewedFiles(files, reviewed)).toEqual([])
  })

  test('lists diff files the reviewer skipped', () => {
    expect(missingReviewedFiles(files, [{ path: 'a.ts', status: 'clean' }])).toEqual(['b.ts'])
  })
})

describe('runAgentJsonWithRetry', () => {
  const opts: AgentRunOptions = { command: 'noop', prompt: 'P', cwd: '/', timeoutMs: 1000 }

  test('valid output parses on the first run, no retry', async () => {
    const calls: string[] = []
    const runner = async (o: AgentRunOptions) => {
      calls.push(o.prompt)
      return '{"n":1}'
    }
    const value = await runAgentJsonWithRetry(opts, (raw) => JSON.parse(raw) as { n: number }, runner)
    expect(value).toEqual({ n: 1 })
    expect(calls).toHaveLength(1)
  })

  test('unparseable output retried once with a corrective note appended', async () => {
    const calls: string[] = []
    const runner = async (o: AgentRunOptions) => {
      calls.push(o.prompt)
      return calls.length === 1 ? 'garbage' : '{"n":2}'
    }
    const value = await runAgentJsonWithRetry(opts, (raw) => JSON.parse(raw) as { n: number }, runner)
    expect(value).toEqual({ n: 2 })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('P')
    expect(calls[1]).toContain('not a valid JSON review')
  })

  test('second unparseable output raises AgentOutputError carrying the raw text', async () => {
    const runner = async () => 'still garbage'
    const failure = runAgentJsonWithRetry(opts, (raw) => JSON.parse(raw), runner)
    await expect(failure).rejects.toBeInstanceOf(AgentOutputError)
    await failure.catch((err: AgentOutputError) => expect(err.raw).toBe('still garbage'))
  })

  test('agent run errors are not retried', async () => {
    let calls = 0
    const runner = async (): Promise<string> => {
      calls++
      throw new Error('spawn failed')
    }
    await expect(runAgentJsonWithRetry(opts, (raw) => raw, runner)).rejects.toThrow('spawn failed')
    expect(calls).toBe(1)
  })
})

describe('runDualFlow', () => {
  const tempDirs: string[] = []

  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  })

  function setupDualRepo(agentPayload: string) {
    const repo = mkdtempSync(join(tmpdir(), 'codesema-dual-'))
    tempDirs.push(repo)
    const workDir = join(repo, '.codesema')
    mkdirSync(workDir)
    const callsPath = join(repo, 'calls.txt')
    const agentScript = join(repo, 'agent.sh')
    writeFileSync(
      agentScript,
      `#!/bin/sh\ncat > /dev/null\nprintf 'run\\n' >> "${callsPath}"\nprintf '%s' '${agentPayload}'\n`,
    )
    const input: PrepInput = {
      version: 1,
      generated_by: 'codesema prep',
      title: 'feature/x',
      branch: 'feature/x',
      target: 'develop',
      target_source: 'heuristic',
      merge_base: 'abc123',
      head_sha: 'def456',
      repo_root: repo,
      commits: ['feat: a'],
      files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
      custom_instructions: null,
      rules: null,
      impact_candidates: null,
      diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
    }
    writeFileSync(join(workDir, 'input.json'), JSON.stringify(input))
    return { repo, workDir, callsPath, agentScript, input }
  }

  const flowOpts = (fixture: ReturnType<typeof setupDualRepo>) => ({
    agentCommand: `sh "${fixture.agentScript}"`,
    input: fixture.input,
    dir: fixture.workDir,
    timeoutMs: 15000,
    session: createSession(),
    spinner: { update: () => {} },
  })

  test('judge agent is not spawned when both lanes return zero findings', async () => {
    const fixture = setupDualRepo(REVIEW)

    const outcome = await runDualFlow(flowOpts(fixture))

    expect(outcome.ok).toBe(true)
    expect(readFileSync(fixture.callsPath, 'utf8').trim().split('\n')).toHaveLength(2)
  }, 20000)

  test('lanes reporting incomplete coverage produce a coverage warning line each', async () => {
    const payload = '{"verdict":"approve","summary":"ok","findings":[],"files_reviewed":[]}'
    const fixture = setupDualRepo(payload)

    const outcome = await runDualFlow(flowOpts(fixture))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.reportLines.filter((line) => line.includes('did not examine'))).toHaveLength(2)
  }, 20000)

  test('identical lane findings merge deterministically into a consensus finding', async () => {
    const finding = '{"file":"a.ts","line":1,"severity":"major","kind":"design","title":"t","message":"broken"}'
    const payload = `{"verdict":"comment","summary":"ok","findings":[${finding}],"decisions":[{"id":"A0","action":"keep"}]}`
    const fixture = setupDualRepo(payload)

    const outcome = await runDualFlow(flowOpts(fixture))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.review.findings).toHaveLength(1)
    expect(outcome.record.review.findings[0]?.consensus).toBe(true)
    expect(outcome.record.meta.dual).toEqual({ merged: 1, rejected: 0, added_by_b: 0 })
  }, 20000)
})
