import type { Finding, FindingSeverity, NarrativeRisk, ReviewRecord, Verdict } from './contract.js'
import { t } from './i18n.js'
import { ACCENT, AMBER, GRAY, GREEN, RED, bold, dim, fieldLabel, paint } from './ui.js'

const VERDICT_COLORS: Record<Verdict, number> = {
  approve: GREEN,
  request_changes: RED,
  comment: AMBER,
}

const RISK_COLORS: Record<NarrativeRisk, number> = {
  high: RED,
  medium: AMBER,
  low: GRAY,
}

const SEVERITY_COLORS: Partial<Record<FindingSeverity, number>> = {
  critical: RED,
  major: AMBER,
}

const POINT_MAX = 96

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function formatFindingCounts(findings: Finding[]): string {
  const praise = findings.filter((f) => f.kind === 'praise').length
  const countOf = (severity: FindingSeverity) =>
    findings.filter((f) => f.severity === severity && f.kind !== 'praise').length

  const severityKeys = {
    critical: 'summary.sevCritical',
    major: 'summary.sevMajor',
    minor: 'summary.sevMinor',
    info: 'summary.sevInfo',
  } as const

  const parts: string[] = []
  for (const severity of ['critical', 'major', 'minor', 'info'] as const) {
    const count = countOf(severity)
    if (count === 0) continue
    const text = t(severityKeys[severity], { n: count })
    const color = SEVERITY_COLORS[severity]
    parts.push(color ? paint(text, color) : text)
  }
  if (praise > 0) parts.push(paint(t('summary.praiseCount', { n: praise }), GREEN))
  return parts.length > 0 ? parts.join(' · ') : t('summary.none')
}

export function printReviewSummary(record: ReviewRecord): void {
  const { review } = record
  console.log('')
  console.log(`  ${fieldLabel(t('field.verdict'))}${bold(paint(t(`verdict.${review.verdict}`), VERDICT_COLORS[review.verdict]))}`)
  console.log(`  ${fieldLabel(t('field.findings'))}${formatFindingCounts(review.findings)}`)

  const hotspots = review.narrative?.review_first ?? []
  if (hotspots.length === 0) return
  console.log(`  ${paint(t('summary.checkFirst'), ACCENT)}`)
  hotspots.forEach((item, index) => {
    const risk = paint(t(`risk.${item.risk}`).padEnd(6), RISK_COLORS[item.risk])
    const file = item.file ? `  ${dim(item.file)}` : ''
    console.log(`    ${dim(`${index + 1}.`)} ${risk} ${truncate(item.point, POINT_MAX)}${file}`)
  })
}
