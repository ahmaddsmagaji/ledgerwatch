import { useEffect, useState } from 'react'
import { api, ApiError } from './api/client'
import type { ExceptionType, Summary } from './api/types'
import { formatNaira } from './lib/money'

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; summary: Summary }

const TYPE_LABELS: Record<ExceptionType, string> = {
  missing_settlement: 'Missing settlement',
  amount_mismatch: 'Amount mismatch',
  duplicate: 'Duplicate',
  fee_discrepancy: 'Fee discrepancy',
  timing_break: 'Timing break',
  orphan_bank_credit: 'Orphan bank credit',
  needs_review: 'Needs review',
}

function App() {
  const [load, setLoad] = useState<Load>({ state: 'loading' })

  useEffect(() => {
    let cancelled = false
    api
      .summary()
      .then((summary) => {
        if (!cancelled) setLoad({ state: 'ready', summary })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message = error instanceof ApiError ? error.message : 'Something went wrong.'
        setLoad({ state: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="page">
      <header className="header">
        <h1>Ledgerwatch</h1>
        <p className="muted">Settlement exception desk</p>
      </header>

      {load.state === 'loading' && <p className="muted">Loading…</p>}

      {load.state === 'error' && (
        <div className="notice notice-error" role="alert">
          {load.message}
        </div>
      )}

      {load.state === 'ready' && <Overview summary={load.summary} />}
    </main>
  )
}

function Overview({ summary }: { summary: Summary }) {
  if (summary.orders_total === 0) {
    return (
      <div className="notice">
        No data loaded yet. Load the sample dataset with <code>POST /api/demo/load-sample</code> from
        the API docs page.
      </div>
    )
  }

  const rows = (Object.entries(summary.by_type) as [ExceptionType, { count: number; amount_at_risk_kobo: number }][])
    .filter(([, totals]) => totals.count > 0)
    .sort((a, b) => b[1].amount_at_risk_kobo - a[1].amount_at_risk_kobo)

  return (
    <>
      <section className="tiles">
        <Tile label="Orders" value={summary.orders_total.toLocaleString('en-NG')} />
        <Tile label="Match rate" value={`${summary.match_rate_percent}%`} />
        <Tile label="Open exceptions" value={String(summary.by_status.open)} />
        <Tile label="Unresolved at risk" value={summary.unresolved_at_risk_display} />
      </section>

      <section>
        <h2>Exceptions by type</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th className="num">Count</th>
              <th className="num">Amount at risk</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([type, totals]) => (
              <tr key={type}>
                <td>{TYPE_LABELS[type]}</td>
                <td className="num">{totals.count}</td>
                <td className="num">{formatNaira(totals.amount_at_risk_kobo)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  )
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
    </div>
  )
}

export default App
