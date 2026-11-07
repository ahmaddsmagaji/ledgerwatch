import type { ExceptionType } from '../api/types'

export const TYPE_LABELS: Record<ExceptionType, string> = {
  missing_settlement: 'Missing settlement',
  amount_mismatch: 'Amount mismatch',
  duplicate: 'Duplicate',
  fee_discrepancy: 'Fee discrepancy',
  timing_break: 'Timing break',
  orphan_bank_credit: 'Orphan bank credit',
  needs_review: 'Needs review',
}

// Brand green is reserved for "matched / resolved", so no risk type uses it.
export const TYPE_COLORS: Record<ExceptionType, string> = {
  missing_settlement: '#b8432f',
  amount_mismatch: '#d9902b',
  fee_discrepancy: '#7a6ad8',
  duplicate: '#3f7f9e',
  timing_break: '#9aa1a8',
  orphan_bank_credit: '#7b6f8e',
  needs_review: '#111111',
}
