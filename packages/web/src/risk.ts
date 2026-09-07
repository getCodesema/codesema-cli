export type RiskLevel = 'high' | 'medium' | 'low'

export type RiskMeta = { label: string; r: RiskLevel }

const RISK_META: Record<string, RiskMeta> = {
  high: { label: 'reviews.riskHigh', r: 'high' },
  medium: { label: 'reviews.riskMedium', r: 'medium' },
  low: { label: 'reviews.riskLow', r: 'low' },
}

export function riskMeta(risk?: string): RiskMeta | null {
  return RISK_META[risk ?? ''] ?? null
}
