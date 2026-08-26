import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import type { AgentRunOptions } from './agent.js'
import type {
  Finding,
  GroundingReport,
  ReviewRecord,
  SanitizedReview,
  Verdict,
} from './contract.js'
import type { PrepInput } from './prep.js'
import {
  AgentOutputError,
  agentVisibleInput,
  buildFullReviewPrompt,
  buildIncrementalPrompt,
  buildRepeatReviewPrompt,
  extractReviewJson,
  FINDING_REPRO_RULE,
  groundingReportLines,
  missingReviewedFiles,
  reviewGateReason,
  reviewInstructions,
  runAgentJsonWithRetry,
  runDualFlow,
  runSimpleFlow,
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
      server_context: null,
    }
    expect(agentVisibleInput(input)).toEqual({
      branch: 'feature/x',
      target: 'develop',
      commits: ['feat: a'],
      files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
      custom_instructions: null,
      rules: ['[C1] no any'],
      impact_candidates: { note: 'best-effort', symbols: [], imported_by: { 'a.ts': ['b.ts'] } },
      server_context: null,
    })
  })

  test('carries a populated server_context through unchanged', () => {
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
      commits: [],
      files: [],
      custom_instructions: null,
      rules: null,
      impact_candidates: null,
      diff: '',
      server_context: {
        version: 1,
        repo: { remote_url: 'git@github.com:acme/widgets.git' },
        freshness: { scan_sha: 'abc', scanned_at: '2026-08-01T00:00:00.000Z' },
        conventions: [{ id: 'c1', rule: 'no any', category: 'types', scope: null }],
        learned_rules: [{ id: 'l1', rule: 'prefer composables' }],
        facts: ['uses Elysia'],
        stale_warning: null,
      },
    }
    expect(agentVisibleInput(input).server_context).toEqual(input.server_context)
  })
})

describe('groundingReportLines', () => {
  const finding: Finding = { file: 'a.ts', severity: 'major', message: 'm' }

  test('untouched review: no lines', () => {
    const report: GroundingReport = {
      dropped: [],
      deanchored: [],
      merged: 0,
      verdict_escalated: false,
    }
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

  test('describes server_context and its precedence under the local rules', () => {
    const p = reviewInstructions()
    expect(p).toContain('server_context')
    expect(p).toContain('rules wins')
    expect(p).toContain('stale_warning')
  })

  test('scopes the verdict to what the input can prove', () => {
    const p = reviewInstructions()
    expect(p).toContain('weighs ONLY what you could verify in the provided input')
    expect(p).toContain('never lowers the verdict')
    expect(p).toContain('raise it as a step "check" question')
  })

  // D24: the repro rule is shared with dual.ts's prosecutorInstructions
  // (dual.test.ts asserts the same constant there) — one source, never two
  // rules drifting apart.
  test('states the D24 repro rule and documents the optional repro field', () => {
    const p = reviewInstructions()
    expect(p).toContain(FINDING_REPRO_RULE)
    expect(p).toContain('"repro"')
    expect(p).toContain('"command"')
    expect(p).toContain('"expected"')
  })

  // D15: the reviewer may now be handed a bounded read-only tool
  // (boundedReadOnlyReviewCommand), so the prompt can no longer forbid tools
  // outright — it must stay correct whether a tool was granted or not.
  test('is neutral about tools instead of forbidding them outright', () => {
    const p = reviewInstructions()
    expect(p).not.toContain('Do NOT use any tools')
    expect(p).toContain('Base your review primarily on the provided input')
    expect(p).toContain('never to explore broadly, never to run, write, or install anything')
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
  const opts: AgentRunOptions = { command: 'noop', prompt: 'P', cwd: '/', absoluteCapMs: 1000 }

  test('valid output parses on the first run, no retry', async () => {
    const calls: string[] = []
    const runner = async (o: AgentRunOptions) => {
      calls.push(o.prompt)
      return '{"n":1}'
    }
    const value = await runAgentJsonWithRetry(
      opts,
      (raw) => JSON.parse(raw) as { n: number },
      runner,
    )
    expect(value).toEqual({ n: 1 })
    expect(calls).toHaveLength(1)
  })

  test('unparseable output retried once with a corrective note appended', async () => {
    const calls: string[] = []
    const runner = async (o: AgentRunOptions) => {
      calls.push(o.prompt)
      return calls.length === 1 ? 'garbage' : '{"n":2}'
    }
    const value = await runAgentJsonWithRetry(
      opts,
      (raw) => JSON.parse(raw) as { n: number },
      runner,
    )
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
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
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
      server_context: null,
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
    if (!outcome.ok) {
      return
    }
    expect(outcome.reportLines.filter((line) => line.includes('did not examine'))).toHaveLength(2)
  }, 20000)

  test('identical lane findings merge deterministically into a consensus finding', async () => {
    const finding =
      '{"file":"a.ts","line":1,"severity":"major","kind":"design","title":"t","message":"broken"}'
    const payload = `{"verdict":"comment","summary":"ok","findings":[${finding}],"decisions":[{"id":"A0","action":"keep"}]}`
    const fixture = setupDualRepo(payload)

    const outcome = await runDualFlow(flowOpts(fixture))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    expect(outcome.record.review.findings).toHaveLength(1)
    expect(outcome.record.review.findings[0]?.consensus).toBe(true)
    expect(outcome.record.meta.dual).toEqual({ merged: 1, rejected: 0, added_by_b: 0 })
  }, 20000)

  // T1.2 re-review round 9: the abort has THREE propagation sites in this
  // module — the simple flow, each dual LANE, and the judge — and only the
  // first was held by a test. With the lane's signal dropped, a Ctrl-C during
  // a dual review measured 120 s instead of 202 ms, whole suite green. Dual
  // mode is opt-in, so this is a latent hole rather than a live bug; it is
  // also, word for word, the defect just fixed on the sibling path.
  // T3.2: the criteria chapter has to reach BOTH lanes, and the per-criterion
  // verdicts have to come back out — `assembleDualReview` arbitrates findings
  // only, so a list left to it is dropped silently, and a dropped list reads
  // downstream as "nothing was judged", which blocks the task forever.
  test('the criteria chapter reaches both lanes and their verdicts survive the assembly', async () => {
    const criterionId = 'ac-0123456789ab'
    const payload =
      `{"verdict":"approve","summary":"ok","findings":[],` +
      `"criteria":[{"criterion_id":"${criterionId}","status":"met","evidence":"a.ts:1 the new line"}]}`
    const fixture = setupDualRepo(payload)
    // One file per spawn, created atomically: the two lanes run concurrently,
    // so appending to a shared file interleaves their bytes.
    const promptsDir = join(fixture.repo, 'prompts')
    mkdirSync(promptsDir)
    writeFileSync(
      fixture.agentScript,
      [
        '#!/bin/sh',
        `f=$(mktemp "${promptsDir}/p.XXXXXX")`,
        'cat > "$f"',
        `printf '%s' '${payload}'`,
        '',
      ].join('\n'),
    )

    const outcome = await runDualFlow({
      ...flowOpts(fixture),
      criteriaChapter: `Acceptance criteria — MANDATORY chapter:\n- [${criterionId}] it works`,
    })

    // Zero findings means no judge is spawned: exactly the two lanes.
    const lanes = readdirSync(promptsDir).map((name) =>
      readFileSync(join(promptsDir, name), 'utf8'),
    )
    expect(lanes).toHaveLength(2)
    for (const lane of lanes) {
      expect(lane).toContain(criterionId)
    }
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    expect(outcome.record.review.criteria).toEqual([
      { criterion_id: criterionId, status: 'met', evidence: 'a.ts:1 the new line' },
    ])
  }, 20000)

  // --- T3.2 round 2, majeur 2: the two dual branches nothing was guarding ---
  //
  // The dual criteria path had ONE integration test, and it drove BOTH lanes
  // with the SAME agent script — so lane B's list was byte-identical to lane
  // A's and the fixture could not tell a reconciliation from a
  // non-reconciliation. Two mutants lived there, both green on the whole
  // suite: dropping `criteria` from the surviving lane when the other dies,
  // and replacing lane B's list with `undefined` in the merge.
  //
  // The script below BRANCHES on the `prosecutor` marker that only lane B's
  // prompt carries, which is what makes the two lanes discriminable at all.

  /** An agent that answers one payload as lane A and another as the prosecutor. */
  function twoLaneAgent(
    fixture: ReturnType<typeof setupDualRepo>,
    laneA: string,
    laneB: string,
  ): void {
    writeFileSync(
      fixture.agentScript,
      [
        '#!/bin/sh',
        'prompt=$(cat)',
        'case "$prompt" in',
        `  *prosecutor*) printf '%s' '${laneB}' ;;`,
        `  *) printf '%s' '${laneA}' ;;`,
        'esac',
        '',
      ].join('\n'),
    )
  }

  const CRITERION = 'ac-0123456789ab'
  /** Both lanes answer with zero findings, so no judge is ever spawned. */
  const laneReview = (criteria: string): string =>
    `{"verdict":"approve","summary":"ok","findings":[],"criteria":[${criteria}]}`

  test('a lane that dies does not take the surviving lane’s criteria with it', async () => {
    // Blast radius of the unguarded branch: a timeout or an unreadable answer
    // on ONE lane made the record carry no `criteria` at all, the gate read
    // that as "nothing was judged", and every ticketed task in dual mode
    // blocked forever. It is, word for word, the failure mode this ticket
    // claims to have closed on the simple path.
    const fixture = setupDualRepo(REVIEW)
    twoLaneAgent(
      fixture,
      laneReview(`{"criterion_id":"${CRITERION}","status":"met","evidence":"a.ts:1 the new line"}`),
      'not a review at all',
    )

    const outcome = await runDualFlow(flowOpts(fixture))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    // The prosecutor really did die — otherwise this proves nothing.
    expect(outcome.reportLines.some((line) => line.includes('reviewer'))).toBe(true)
    expect(outcome.record.review.criteria).toEqual([
      { criterion_id: CRITERION, status: 'met', evidence: 'a.ts:1 the new line' },
    ])
  }, 30000)

  test('lane a says met, lane b says unmet: the record says unmet', async () => {
    // The reconciliation is CLI-side and pessimistic; the judge only ever
    // arbitrates findings. With lane B's list dropped from the merge, this
    // record reads `met` and the task ships on one reviewer's word.
    const fixture = setupDualRepo(REVIEW)
    twoLaneAgent(
      fixture,
      laneReview(`{"criterion_id":"${CRITERION}","status":"met","evidence":"a.ts:1 the new line"}`),
      laneReview(`{"criterion_id":"${CRITERION}","status":"unmet"}`),
    )

    const outcome = await runDualFlow(flowOpts(fixture))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    expect(outcome.record.review.criteria).toEqual([{ criterion_id: CRITERION, status: 'unmet' }])
  }, 30000)

  test('…and symmetrically: lane b alone can also be the one that proves it', async () => {
    // The mirror image, so neither lane's list can be dropped unnoticed: only
    // the PROSECUTOR judged this criterion, on a surviving anchor, and that
    // verdict has to reach the record.
    const fixture = setupDualRepo(REVIEW)
    twoLaneAgent(
      fixture,
      laneReview(`{"criterion_id":"${CRITERION}","status":"unmet"}`),
      laneReview(`{"criterion_id":"${CRITERION}","status":"met","evidence":"a.ts:1 the new line"}`),
    )

    const outcome = await runDualFlow(flowOpts(fixture))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    // Pessimistic: the named failure still wins over the proven success.
    expect(outcome.record.review.criteria).toEqual([{ criterion_id: CRITERION, status: 'unmet' }])
  }, 30000)

  test('an aborted signal cuts the dual LANES, not just the simple flow', async () => {
    const fixture = setupDualRepo(REVIEW)
    // Lanes that would hold the review for a full minute if left alone.
    writeFileSync(fixture.agentScript, `#!/bin/sh\ncat > /dev/null\nsleep 60\n`)
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 50)

    // The agents' OWN budget is far out of reach on purpose: ending within
    // the bound below must be the abort's doing, never a timeout's.
    const outcome = await runDualFlow({
      ...flowOpts(fixture),
      timeoutMs: 120_000,
      signal: controller.signal,
    })

    expect(Date.now() - started).toBeLessThan(10_000)
    expect(outcome.ok).toBe(false)
  }, 30000)

  test('an aborted signal cuts the JUDGE too, once the lanes have answered', async () => {
    const finding =
      '{"file":"a.ts","line":1,"severity":"major","kind":"design","title":"t","message":"broken"}'
    const payload = `{"verdict":"comment","summary":"ok","findings":[${finding}],"decisions":[{"id":"A0","action":"keep"}]}`
    const fixture = setupDualRepo(payload)
    // Both lanes answer normally; the THIRD spawn — the judge — is the one
    // that hangs. Its signal is a separate forwarding site from the lanes'.
    writeFileSync(
      fixture.agentScript,
      `#!/bin/sh\ncat > /dev/null\nprintf 'run\\n' >> "${fixture.callsPath}"\n` +
        `if [ "$(wc -l < "${fixture.callsPath}")" -ge 3 ]; then sleep 60; fi\n` +
        `printf '%s' '${payload}'\n`,
    )
    const controller = new AbortController()
    const started = Date.now()
    // Late enough that the two lanes have finished and the judge is running.
    setTimeout(() => controller.abort(), 700)

    const outcome = await runDualFlow({
      ...flowOpts(fixture),
      timeoutMs: 120_000,
      signal: controller.signal,
    })

    // The judge really was reached — otherwise this test would prove nothing
    // about the judge's own forwarding site.
    expect(
      readFileSync(fixture.callsPath, 'utf8').trim().split('\n').length,
    ).toBeGreaterThanOrEqual(3)
    expect(Date.now() - started).toBeLessThan(20_000)
    void outcome
  }, 40000)
})

describe('buildFullReviewPrompt', () => {
  test('embeds the reviewer instructions, the input and the diff', () => {
    const input: PrepInput = {
      version: 1,
      generated_by: 'codesema prep',
      title: 'feature/x',
      branch: 'feature/x',
      target: 'develop',
      target_source: 'heuristic',
      merge_base: 'abc123',
      head_sha: 'def456',
      repo_root: '/tmp/x',
      commits: ['feat: a'],
      files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
      custom_instructions: null,
      rules: null,
      impact_candidates: null,
      diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      server_context: null,
    }
    const prompt = buildFullReviewPrompt(input)
    expect(prompt).toContain('You are a senior code reviewer')
    expect(prompt).toContain('"branch": "feature/x"')
    expect(prompt).toContain('-old\\n+new')
    expect(prompt).toContain('Output ONLY the JSON object now.')
  })
})

// D24: both prompts need a REAL git repo — findPreviousReview reads
// .codesema/reviews off disk, and isAncestor/mrDiff shell out to real git.
describe('buildIncrementalPrompt / buildRepeatReviewPrompt (D24)', () => {
  const tempDirs: string[] = []

  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function gitRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), 'codesema-review-git-'))
    tempDirs.push(repo)
    const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    run(['init', '-b', 'main'])
    run(['config', 'user.email', 't@t'])
    run(['config', 'user.name', 't'])
    writeFileSync(join(repo, 'a.ts'), 'old\n')
    run(['add', '-A'])
    run(['commit', '-m', 'feat: base'])
    return repo
  }

  function headSha(repo: string): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim()
  }

  function archivePreviousReview(repo: string, headSha1: string): ReviewRecord {
    const previous: ReviewRecord = {
      version: 1,
      meta: {
        title: 'feature/x',
        branch: 'feature/x',
        target: 'main',
        merge_base: headSha1,
        head_sha: headSha1,
        repo_root: repo,
        created_at: new Date().toISOString(),
      },
      commits: ['feat: base'],
      diff: '',
      review: {
        verdict: 'request_changes',
        summary: 'previous pass had issues',
        findings: [{ file: 'a.ts', message: 'looks wrong', severity: 'major' }],
        narrative: null,
      },
    }
    const reviewsDir = join(repo, '.codesema', 'reviews')
    mkdirSync(reviewsDir, { recursive: true })
    writeFileSync(join(reviewsDir, 'feature-x-20260101-000000.json'), JSON.stringify(previous))
    return previous
  }

  function inputAt(repo: string, headSha2: string): PrepInput {
    return {
      version: 1,
      generated_by: 'codesema prep',
      title: 'feature/x',
      branch: 'feature/x',
      target: 'main',
      target_source: 'heuristic',
      merge_base: headSha2,
      head_sha: headSha2,
      repo_root: repo,
      commits: ['feat: base', 'feat: change'],
      files: [{ path: 'a.ts', additions: 1, deletions: 1 }],
      custom_instructions: null,
      rules: null,
      impact_candidates: null,
      diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      server_context: null,
    }
  }

  describe('buildIncrementalPrompt', () => {
    function setup() {
      const repo = gitRepo()
      const head1 = headSha(repo)
      archivePreviousReview(repo, head1)
      const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
      writeFileSync(join(repo, 'a.ts'), 'new\n')
      run(['add', '-A'])
      run(['commit', '-m', 'feat: change'])
      return { repo, input: inputAt(repo, headSha(repo)) }
    }

    test('2-arg call: no chapter, ends on the closing line, unchanged from before this ticket', () => {
      const { repo, input } = setup()

      const result = buildIncrementalPrompt(input, repo)

      expect(result).not.toBeNull()
      expect(result?.prompt).toContain('You are a senior code reviewer')
      expect(result?.prompt).toContain('<previous_review>')
      expect(result?.prompt).toContain('<incremental_diff>')
      expect(result?.prompt.endsWith('Output ONLY the JSON object now.')).toBe(true)
    })

    test('3rd arg folds a chapter in right before the closing line, nothing else changes', () => {
      const { repo, input } = setup()
      const chapter = '### EXTRA CHAPTER ###'

      const withoutChapter = buildIncrementalPrompt(input, repo)
      const withChapter = buildIncrementalPrompt(input, repo, chapter)

      expect(withChapter?.prompt).toContain(chapter)
      expect(withChapter?.prompt.replace(`\n\n${chapter}`, '')).toBe(withoutChapter?.prompt)
    })
  })

  describe('buildRepeatReviewPrompt', () => {
    test('anchors on the previous verdict and instructs confirm-or-say-what-changed', () => {
      const repo = gitRepo()
      const head1 = headSha(repo)
      const previous = archivePreviousReview(repo, head1)
      const input = inputAt(repo, head1)

      const prompt = buildRepeatReviewPrompt(input, previous)

      expect(prompt).toContain('You are a senior code reviewer')
      expect(prompt).toContain('EXACT SAME commit')
      expect(prompt).toContain('Previous review verdict: request_changes')
      expect(prompt).toContain('<previous_review>')
      expect(prompt).toContain('CONFIRM the previous review stands')
      expect(prompt).toContain('must not reappear unless you have a NEW fact')
      expect(prompt.endsWith('Output ONLY the JSON object now.')).toBe(true)
    })

    test('folds an optional chapter in right before the closing line', () => {
      const repo = gitRepo()
      const previous = archivePreviousReview(repo, headSha(repo))
      const input = inputAt(repo, headSha(repo))
      const chapter = '### EXTRA CHAPTER ###'

      const withoutChapter = buildRepeatReviewPrompt(input, previous)
      const withChapter = buildRepeatReviewPrompt(input, previous, chapter)

      expect(withChapter).toContain(chapter)
      expect(withChapter.replace(`\n\n${chapter}`, '')).toBe(withoutChapter)
    })
  })
})

describe('runSimpleFlow', () => {
  const tempDirs: string[] = []

  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function setupSimpleRepo(agentPayload: string, exitCode = 0) {
    const repo = mkdtempSync(join(tmpdir(), 'codesema-simple-'))
    tempDirs.push(repo)
    const workDir = join(repo, '.codesema')
    mkdirSync(workDir)
    const agentScript = join(repo, 'agent.sh')
    writeFileSync(
      agentScript,
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${agentPayload}'\nexit ${exitCode}\n`,
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
      server_context: null,
    }
    writeFileSync(join(workDir, 'input.json'), JSON.stringify(input))
    return { repo, workDir, agentScript, input }
  }

  const flowOpts = (fixture: ReturnType<typeof setupSimpleRepo>) => ({
    agentCommand: `sh "${fixture.agentScript}"`,
    input: fixture.input,
    dir: fixture.workDir,
    timeoutMs: 15000,
    session: createSession(),
    prompt: buildFullReviewPrompt(fixture.input),
    incremental: false,
  })

  test('returns the grounded record on a valid agent response', async () => {
    const fixture = setupSimpleRepo(REVIEW)

    const outcome = await runSimpleFlow(flowOpts(fixture))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    expect(outcome.record.review.verdict).toBe('approve')
    expect(readFileSync(join(fixture.workDir, 'review.json'), 'utf8')).toContain('"verdict"')
  }, 20000)

  // T3.2: the whole path from the model's JSON to the archived record —
  // extract, sanitize, ground, resolveRecord — has to carry `criteria`. It is
  // what T3.6 reads back off disk.
  test('per-criterion verdicts survive the parse-ground-record pipeline', async () => {
    const criterionId = 'ac-0123456789ab'
    const payload =
      `{"verdict":"approve","summary":"ok","findings":[],` +
      `"criteria":[{"criterion_id":"${criterionId}","status":"met","evidence":"a.ts:1 the new line"}]}`
    const fixture = setupSimpleRepo(payload)

    const outcome = await runSimpleFlow({
      ...flowOpts(fixture),
      prompt: buildFullReviewPrompt(fixture.input, `- [${criterionId}] it works`),
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    expect(outcome.record.review.criteria).toEqual([
      { criterion_id: criterionId, status: 'met', evidence: 'a.ts:1 the new line' },
    ])
    // …and the chapter really did travel in the prompt handed to the agent.
    expect(buildFullReviewPrompt(fixture.input, `- [${criterionId}] it works`)).toContain(
      criterionId,
    )
  }, 20000)

  test('reports a coverage gap line when files_reviewed omits a diffed file', async () => {
    const payload = '{"verdict":"approve","summary":"ok","findings":[],"files_reviewed":[]}'
    const fixture = setupSimpleRepo(payload)

    const outcome = await runSimpleFlow(flowOpts(fixture))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    expect(outcome.reportLines.some((line) => line.includes('did not examine'))).toBe(true)
  }, 20000)

  test('an incremental run never reports a coverage gap', async () => {
    const payload = '{"verdict":"approve","summary":"ok","findings":[],"files_reviewed":[]}'
    const fixture = setupSimpleRepo(payload)

    const outcome = await runSimpleFlow({ ...flowOpts(fixture), incremental: true })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    expect(outcome.reportLines.some((line) => line.includes('did not examine'))).toBe(false)
  }, 20000)

  test('a crashing agent surfaces a run failure', async () => {
    const fixture = setupSimpleRepo('', 1)

    const outcome = await runSimpleFlow(flowOpts(fixture))

    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.failure).toBe('run')
  }, 20000)

  test('unparseable agent output surfaces an output failure with the raw text', async () => {
    const fixture = setupSimpleRepo('not json at all')

    const outcome = await runSimpleFlow(flowOpts(fixture))

    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.failure).toBe('output')
    expect(outcome.rawOutput).toContain('not json at all')
  }, 20000)

  // T1.2: the shutdown's cut-off has to reach the review agent's SUBPROCESS,
  // not merely be accepted as an option. That forwarding is what turns a
  // Ctrl-C during an end-of-turn review from a 15-minute wait into an
  // immediate stop — and until this test it was only ever asserted on the
  // seams above it, never on the process that actually has to die.
  test('an aborted signal cuts the agent subprocess instead of waiting out its budget', async () => {
    // An agent that would hold the review for a full minute if left alone.
    const fixture = setupSimpleRepo(REVIEW)
    writeFileSync(fixture.agentScript, `#!/bin/sh\ncat > /dev/null\nsleep 60\n`)
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 50)

    // The agent's OWN budget is set far out of reach on purpose: if the flow
    // ended within the bound below because of the timeout rather than the
    // abort, this test would pass with the signal thrown away — which is
    // exactly how a first version of it proved nothing.
    const outcome = await runSimpleFlow({
      ...flowOpts(fixture),
      timeoutMs: 120_000,
      signal: controller.signal,
    })

    expect(Date.now() - started).toBeLessThan(10_000)
    expect(outcome.ok).toBe(false)
  }, 30000)
})
