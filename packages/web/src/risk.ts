// Risk display classes are defined in each consuming component's own scoped <style>, not here.

export type RiskMeta = { label: string; textCls: string; bgCls: string; dotColor: string }

const RISK_META: Record<string, RiskMeta> = {
  high: {
    label: 'reviews.riskHigh',
    textCls: 'chapter-risk--high',
    bgCls: 'chapter-risk-bg--high',
    dotColor: 'var(--nolyra-risk-high)',
  },
  medium: {
    label: 'reviews.riskMedium',
    textCls: 'chapter-risk--med',
    bgCls: 'chapter-risk-bg--med',
    dotColor: 'var(--nolyra-risk-med)',
  },
  low: {
    label: 'reviews.riskLow',
    textCls: 'chapter-risk--low',
    bgCls: 'chapter-risk-bg--low',
    dotColor: 'var(--nolyra-risk-low)',
  },
}

export function riskMeta(risk?: string): RiskMeta | null {
  return RISK_META[risk ?? ''] ?? null
}
