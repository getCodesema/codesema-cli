import type { Finding, FindingSeverity, NarrativeRisk, ReviewRecord, Verdict } from './contract.js'
import { t } from './i18n.js'
import { ACCENT, AMBER, bold, dim, GRAY, GREEN, paint, RED, renderFieldRows } from './ui.js'

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
    if (count === 0) {
      continue
    }
    const text = t(severityKeys[severity], { n: count })
    const color = SEVERITY_COLORS[severity]
    parts.push(color ? paint(text, color) : text)
  }
  if (praise > 0) {
    parts.push(paint(t('summary.praiseCount', { n: praise }), GREEN))
  }
  return parts.length > 0 ? parts.join(' · ') : t('summary.none')
}

export function printReviewSummary(record: ReviewRecord): void {
  const { review } = record
  renderFieldRows([
    {
      label: t('field.verdict'),
      value: bold(paint(t(`verdict.${review.verdict}`), VERDICT_COLORS[review.verdict])),
    },
    { label: t('field.findings'), value: formatFindingCounts(review.findings) },
  ]).forEach((line) => console.log(line))

  const hotspots = review.narrative?.review_first ?? []
  if (hotspots.length === 0) {
    return
  }
  console.log('')
  console.log(`  ${paint(t('summary.checkFirst'), ACCENT)}`)

  const riskColumnWidth =
    hotspots.reduce((max, item) => Math.max(max, t(`risk.${item.risk}`).length), 0) + 2
  const fileIndent = ' '.repeat(3 + riskColumnWidth)
  hotspots.forEach((item, index) => {
    const number = dim(`${index + 1}.`.padEnd(3))
    const risk = paint(t(`risk.${item.risk}`).padEnd(riskColumnWidth), RISK_COLORS[item.risk])
    console.log(`    ${number}${risk}${truncate(item.point, POINT_MAX)}`)
    if (item.file) {
      console.log(`    ${fileIndent}${dim(item.file)}`)
    }
  })
}
