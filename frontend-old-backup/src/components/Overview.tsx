import type { ExceptionType, Summary } from '../api/types'
import { TYPE_COLORS, TYPE_LABELS } from '../lib/labels'
import { formatNaira } from '../lib/money'

type Row = [ExceptionType, { count: number; amount_at_risk_kobo: number }]

function share(part: number, whole: number): string {
  if (whole <= 0) return '0%'
  return `${Math.round((part * 1000) / whole) / 10}%`
}

export default function Overview({ summary }: { summary: Summary }) {
  if (summary.orders_total === 0) {
    return (
      <section className="hero">
        <h1 className="hero-title">Nothing to reconcile yet</h1>
        <p className="hero-sub">
          Load the sample dataset to see Ledgerwatch at work: send <code>POST /api/demo/load-sample</code>{' '}
          from the API docs page at <code>/docs</code>.
        </p>
      </section>
    )
  }

  const rows = (Object.entries(summary.by_type) as Row[])
    .filter(([, totals]) => totals.count > 0)
    .sort((a, b) => b[1].amount_at_risk_kobo - a[1].amount_at_risk_kobo)
  const exposure = rows.reduce((sum, [, totals]) => sum + totals.amount_at_risk_kobo, 0)

  if (summary.exceptions_total === 0) {
    return (
      <section className="hero">
        <h1 className="hero-title">Everything reconciles</h1>
        <p className="hero-sub">All {summary.orders_total.toLocaleString('en-NG')} orders matched with no exceptions.</p>
      </section>
    )
  }

  return (
    <>
      <section className="hero">
        <h1 className="hero-title">
          {formatNaira(exposure)} flagged across {summary.exceptions_total} exceptions
        </h1>
        <p className="hero-sub">
          {summary.by_status.resolved} resolved. {summary.unresolved_at_risk_display} still unresolved.
        </p>

        <div className="bar" role="img" aria-label="Flagged money by exception type">
          {rows.map(([type, totals]) => (
            <span
              key={type}
              className="seg"
              title={`${TYPE_LABELS[type]}: ${formatNaira(totals.amount_at_risk_kobo)}`}
              style={{ flex: `${totals.amount_at_risk_kobo} 1 0%`, background: TYPE_COLORS[type] }}
            />
          ))}
        </div>

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Exception type</th>
                <th className="num">Count</th>
                <th className="num">Amount flagged</th>
                <th className="num">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([type, totals]) => (
                <tr key={type}>
                  <td>
                    <span className="chip" style={{ background: TYPE_COLORS[type] }} aria-hidden="true" />
                    {TYPE_LABELS[type]}
                  </td>
                  <td className="num">{totals.count}</td>
                  <td className="num">{formatNaira(totals.amount_at_risk_kobo)}</td>
                  <td className="num">{share(totals.amount_at_risk_kobo, exposure)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="facts">
        <div className="fact">
          <div className="fact-label">Orders matched</div>
          <div className="fact-value">{summary.match_rate_percent}%</div>
          <div className="fact-note">
            {summary.orders_matched.toLocaleString('en-NG')} of {summary.orders_total.toLocaleString('en-NG')} orders
          </div>
        </div>
        <div className="fact">
          <div className="fact-label">Order value reviewed</div>
          <div className="fact-value">{formatNaira(summary.total_order_value_kobo)}</div>
          <div className="fact-note">{summary.settlement_lines_total.toLocaleString('en-NG')} settlement lines</div>
        </div>
        <div className="fact">
          <div className="fact-label">Awaiting review</div>
          <div className="fact-value">{summary.by_status.open + summary.by_status.escalated}</div>
          <div className="fact-note">{summary.by_status.escalated} escalated</div>
        </div>
      </section>
    </>
  )
}
