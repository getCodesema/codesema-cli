import type { Finding } from '../src/contract.js'

export type ExpectedBug = { id: string; file: string; pattern: string }
export type FixtureScore = { found: ExpectedBug[]; missed: ExpectedBug[]; extras: number }

/**
 * An expected bug is found when one still-unclaimed finding sits on the same
 * file and its title or message matches the bug's pattern; each finding can
 * claim a single bug. Unclaimed findings count as extras (the noise proxy).
 */
export function scoreFindings(expected: ExpectedBug[], findings: Finding[]): FixtureScore {
  const found: ExpectedBug[] = []
  const missed: ExpectedBug[] = []
  const claimed = new Set<Finding>()
  for (const bug of expected) {
    const pattern = new RegExp(bug.pattern, 'i')
    const hit = findings.find(
      (finding) =>
        !claimed.has(finding) &&
        finding.file === bug.file &&
        pattern.test(`${finding.title ?? ''} ${finding.message}`),
    )
    if (hit) {
      claimed.add(hit)
      found.push(bug)
    } else {
      missed.push(bug)
    }
  }
  return { found, missed, extras: findings.length - claimed.size }
}
