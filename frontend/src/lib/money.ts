/** Format integer kobo as naira using integer math only (no floating-point money). */
export function formatNaira(kobo: number): string {
  if (!Number.isSafeInteger(kobo)) return '—'
  const sign = kobo < 0 ? '-' : ''
  const abs = Math.abs(kobo)
  const naira = Math.floor(abs / 100)
  const remainder = abs % 100
  return `${sign}₦${naira.toLocaleString('en-NG')}.${String(remainder).padStart(2, '0')}`
}
