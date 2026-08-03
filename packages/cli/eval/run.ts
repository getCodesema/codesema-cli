import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { agentEnv, hardenedReviewCommand, runAgent } from '../src/agent.js'
import { groundReview, sanitizeReview, type SanitizedReview } from '../src/contract.js'
import { prosecutorInstructions } from '../src/dual.js'
import { extractReviewJson, reviewInstructions } from '../src/review.js'
import { scoreFindings, type ExpectedBug } from './score.js'

type Fixture = {
  name: string
  expected: ExpectedBug[]
  input: {
    branch: string
    target: string
    commits: string[]
    files: { path: string; additions: number; deletions: number }[]
    custom_instructions: string | null
    impact_candidates: unknown
    diff: string
  }
}

const LANES = { a: 'reviewer', b: 'prosecutor' } as const
type Lane = keyof typeof LANES

async function runLane(
  agent: string,
  lane: Lane,
  fixture: Fixture,
  timeoutMs: number,
): Promise<SanitizedReview> {
  const instructions = lane === 'a' ? reviewInstructions() : prosecutorInstructions('English')
  const prompt = [
    instructions,
    `<input>\n${JSON.stringify(fixture.input, null, 2)}\n</input>`,
    'Output ONLY the JSON object now.',
  ].join('\n\n')
  const raw = await runAgent({
    command: hardenedReviewCommand(agent),
    env: agentEnv(agent),
    prompt,
    cwd: process.cwd(),
    timeoutMs,
  })
  return groundReview(sanitizeReview(JSON.parse(extractReviewJson(raw))), fixture.input.diff).review
}

const { values } = parseArgs({
  options: {
    agent: { type: 'string' },
    lane: { type: 'string', default: 'both' },
    timeout: { type: 'string', default: '300' },
  },
})

if (!values.agent || (values.lane !== 'both' && values.lane !== 'a' && values.lane !== 'b')) {
  console.error(
    'usage: bun eval/run.ts --agent "<agent command>" [--lane a|b|both] [--timeout seconds]',
  )
  process.exit(1)
}

const lanes: Lane[] = values.lane === 'both' ? ['a', 'b'] : [values.lane]
const fixturesDir = join(import.meta.dir, 'fixtures')
const fixtures = readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.json'))
  .toSorted()
  .map((name) => JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as Fixture)

let totalExpected = 0
let totalFound = 0
let totalExtras = 0
for (const fixture of fixtures) {
  for (const lane of lanes) {
    const review = await runLane(values.agent, lane, fixture, Number(values.timeout) * 1000)
    const score = scoreFindings(fixture.expected, review.findings)
    totalExpected += fixture.expected.length
    totalFound += score.found.length
    totalExtras += score.extras
    const missed = score.missed.map((bug) => bug.id).join(', ')
    console.log(
      `${fixture.name} · ${LANES[lane]} · found ${score.found.length}/${fixture.expected.length}` +
        `${missed ? ` · missed: ${missed}` : ''} · extras ${score.extras}`,
    )
  }
}
console.log(`\nrecall ${totalFound}/${totalExpected} · extras ${totalExtras}`)
