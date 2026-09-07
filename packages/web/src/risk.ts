// Risk display classes are defined in each consuming component's own scoped <style>, not here.

export type RiskMeta = { label: string; textCls: string; bgCls: string; dotColor: string }

const RISK_META: Record<string, RiskMeta> = {
  high: {
    label: 'reviews.riskHigh',
    textCls: 'step-risk--high',
    bgCls: 'step-risk-bg--high',
    dotColor: 'var(--err)',
  },
  medium: {
    label: 'reviews.riskMedium',
    textCls: 'step-risk--med',
    bgCls: 'step-risk-bg--med',
    dotColor: 'var(--warn)',
  },
  low: {
    label: 'reviews.riskLow',
    textCls: 'step-risk--low',
    bgCls: 'step-risk-bg--low',
    dotColor: 'var(--ok)',
  },
}

export function riskMeta(risk?: string): RiskMeta | null {
  return RISK_META[risk ?? ''] ?? null
}
