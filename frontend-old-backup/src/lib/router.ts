import { useSyncExternalStore } from 'react'

function subscribe(callback: () => void) {
  window.addEventListener('hashchange', callback)
  return () => window.removeEventListener('hashchange', callback)
}

function snapshot() {
  return window.location.hash.replace(/^#/, '') || '/'
}

/** The current hash path, e.g. '/admin/users'. Re-renders on navigation. */
export function useHashPath(): string {
  return useSyncExternalStore(subscribe, snapshot)
}
