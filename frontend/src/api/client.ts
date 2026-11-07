import type { Summary } from './types'

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, init)
  } catch {
    throw new ApiError(0, 'Cannot reach the Ledgerwatch API. Is the server running?')
  }

  if (!response.ok) {
    let detail = ''
    try {
      const body: unknown = await response.json()
      if (body && typeof body === 'object' && 'detail' in body && typeof body.detail === 'string') {
        detail = body.detail
      }
    } catch {
      // the body was not JSON; fall through to the generic messages below
    }
    if (!detail) {
      detail =
        response.status >= 500
          ? 'The Ledgerwatch API is not responding. Is the server running?'
          : response.statusText || 'Request failed'
    }
    throw new ApiError(response.status, detail)
  }

  return (await response.json()) as T
}

export const api = {
  health: () => request<{ status: string }>('/health'),
  summary: () => request<Summary>('/summary'),
}
