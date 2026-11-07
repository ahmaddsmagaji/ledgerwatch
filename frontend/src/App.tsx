import { useEffect, useState } from 'react'
import { api, ApiError } from './api/client'
import type { Summary } from './api/types'
import Logo from './components/Logo'
import Overview from './components/Overview'

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; summary: Summary }

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
    <>
      <header className="topbar">
        <div className="brand">
          <Logo size={30} />
          <span className="wordmark">Ledgerwatch</span>
        </div>
      </header>
      <main className="page">
        {load.state === 'loading' && <p className="muted">Loading…</p>}
        {load.state === 'error' && (
          <div className="notice notice-error" role="alert">
            {load.message}
          </div>
        )}
        {load.state === 'ready' && <Overview summary={load.summary} />}
      </main>
    </>
  )
}

export default App
