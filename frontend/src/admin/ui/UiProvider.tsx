import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import Modal from './Modal'

type Tone = 'info' | 'success' | 'warning' | 'error'

interface ToastItem {
  id: number
  message: string
  tone: Tone
}

interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
}

interface Ui {
  toast: (message: string, tone?: Tone) => void
  confirm: (options: ConfirmOptions) => Promise<boolean>
}

const UiContext = createContext<Ui | null>(null)

export function useUi(): Ui {
  const ui = useContext(UiContext)
  if (!ui) throw new Error('useUi must be used inside UiProvider')
  return ui
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (value: boolean) => void } | null>(null)
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setToasts((items) => items.filter((item) => item.id !== id)), [])

  const toast = useCallback(
    (message: string, tone: Tone = 'info') => {
      const id = nextId.current++
      setToasts((items) => [...items, { id, message, tone }])
      window.setTimeout(() => dismiss(id), 4500)
    },
    [dismiss],
  )

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ options, resolve })),
    [],
  )

  const answer = (value: boolean) => {
    pending?.resolve(value)
    setPending(null)
  }

  return (
    <UiContext.Provider value={{ toast, confirm }}>
      {children}
      <div className="ad-toasts" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`ad-toast ad-toast-${item.tone}`} role="status">
            <span>{item.message}</span>
            <button aria-label="Dismiss notification" onClick={() => dismiss(item.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
      {pending && (
        <Modal
          title={pending.options.title}
          onClose={() => answer(false)}
          footer={
            <>
              <button className="ad-btn" onClick={() => answer(false)}>
                Cancel
              </button>
              <button
                className={`ad-btn ${pending.options.danger ? 'ad-btn-danger' : 'ad-btn-primary'}`}
                onClick={() => answer(true)}
              >
                {pending.options.confirmLabel ?? 'Confirm'}
              </button>
            </>
          }
        >
          <p>{pending.options.message}</p>
        </Modal>
      )}
    </UiContext.Provider>
  )
}
