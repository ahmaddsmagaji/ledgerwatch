export type ExceptionType =
  | 'missing_settlement'
  | 'amount_mismatch'
  | 'duplicate'
  | 'fee_discrepancy'
  | 'timing_break'
  | 'orphan_bank_credit'
  | 'needs_review'

export type ExceptionStatus = 'open' | 'escalated' | 'resolved'

export interface TypeTotals {
  count: number
  amount_at_risk_kobo: number
}

export interface Summary {
  orders_total: number
  orders_matched: number
  match_rate_percent: number
  settlement_lines_total: number
  bank_credits_total: number
  total_order_value_kobo: number
  exceptions_total: number
  by_type: Record<ExceptionType, TypeTotals>
  by_status: Record<ExceptionStatus, number>
  unresolved_at_risk_kobo: number
  unresolved_at_risk_display: string
}
