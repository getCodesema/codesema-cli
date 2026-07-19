import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const RULES_MAX = 50
const RULE_LENGTH_MAX = 1000

/**
 * One rule per non-empty line, author order preserved: the author puts the
 * highest-yield rules first, and the positional ids stay stable across runs.
 * Headings and HTML comments keep the file readable without becoming rules.
 * An author-written leading [Cn] is stripped so ids are always positional and
 * never collide.
 */
export function parseRules(content: string): string[] {
  const rules: string[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('<!--')) continue
    const rule = line
      .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\[C\d+\]\s*/, '')
      .slice(0, RULE_LENGTH_MAX)
      .trim()
    if (!rule) continue
    rules.push(rule)
    if (rules.length >= RULES_MAX) break
  }
  return rules
}

/** [C1] is the file's first rule; findings cite these ids. */
export function formatRules(rules: string[]): string[] {
  return rules.map((rule, index) => `[C${index + 1}] ${rule}`)
}

export function loadRules(cwd: string): string[] | null {
  const file = join(cwd, '.codesema', 'RULES.md')
  if (!existsSync(file)) return null
  const rules = parseRules(readFileSync(file, 'utf8'))
  return rules.length > 0 ? formatRules(rules) : null
}
