import { createContext, useCallback, useContext, useMemo, useReducer, useRef, type ReactNode } from 'react'

export const ADMIN_ACTOR = 'Ahmad Magaji'

export interface AuditEntry {
  id: number
  at: string
  actor: string
  action: string
  target: string
  details: string
}

// Later steps add organizations, users, workspaces, invoices, runs, flags and tickets here.
interface State {
  audit: AuditEntry[]
  query: string
}

type Action = { type: 'audit'; entry: AuditEntry } | { type: 'query'; value: string }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'audit':
      return { ...state, audit: [action.entry, ...state.audit] }
    case 'query':
      return { ...state, query: action.value }
  }
}

interface Store {
  state: State
  logAudit: (action: string, target: string, details: string) => void
  setQuery: (value: string) => void
}

const StoreContext = createContext<Store | null>(null)

export function AdminStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { audit: [], query: '' })
  const nextId = useRef(1)

  const logAudit = useCallback((action: string, target: string, details: string) => {
    dispatch({
      type: 'audit',
      entry: { id: nextId.current++, at: new Date().toISOString(), actor: ADMIN_ACTOR, action, target, details },
    })
  }, [])
  const setQuery = useCallback((value: string) => dispatch({ type: 'query', value }), [])

  const value = useMemo(() => ({ state, logAudit, setQuery }), [state, logAudit, setQuery])
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useAdminStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useAdminStore must be used inside AdminStoreProvider')
  return store
}
