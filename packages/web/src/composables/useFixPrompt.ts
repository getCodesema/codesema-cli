import type { ReviewRecord } from '../types'
import type { Finding } from './useDiff'

const INSTRUCTION =
  'Fix the following code review findings. Change only what each finding requires.'

export function isActionable(f: Finding): boolean {
  if (f.kind === 'praise' || f.kind === 'why') {
    return false
  }
  return f.severity !== 'info'
}

export function buildFixPrompt(record: ReviewRecord, onlyIds?: number[]): string {
  const wanted = onlyIds ? new Set(onlyIds) : null
  const findings = record.review.findings
    .map((f, id) => ({ f, id }))
    .filter(({ f, id }) => isActionable(f) && (wanted === null || wanted.has(id)))
    .map(({ f }) => ({
      file: f.file,
      ...(f.line !== undefined ? { line: f.line } : {}),
      ...(f.endLine !== undefined ? { endLine: f.endLine } : {}),
      severity: f.severity,
      ...(f.kind !== undefined ? { kind: f.kind } : {}),
      ...(f.title !== undefined ? { title: f.title } : {}),
      message: f.message,
      ...(f.suggestion !== undefined ? { suggestion: f.suggestion } : {}),
    }))
  return JSON.stringify(
    {
      instruction: INSTRUCTION,
      branch: record.meta.branch,
      target: record.meta.target,
      findings,
    },
    null,
    2,
  )
}
