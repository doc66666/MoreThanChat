import { useSyncExternalStore } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
const storageKey = 'more-than-chat.appearance'
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()
let preference: ThemePreference = 'light'
try {
  const saved = localStorage.getItem(storageKey)
  if (saved === 'light' || saved === 'dark' || saved === 'system') preference = saved
} catch { /* Appearance remains usable when storage is unavailable. */ }

const resolve = (): ResolvedTheme => preference === 'system'
  ? systemTheme.matches ? 'dark' : 'light'
  : preference
let snapshot = { preference, resolved: resolve() }

function applyTheme() {
  const resolved = resolve()
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
  snapshot = { preference, resolved }
  void window.moreThanChat?.setAppearance?.(resolved).catch(() => undefined)
  for (const listener of listeners) listener()
}

export function setThemePreference(value: ThemePreference) {
  preference = value
  try { localStorage.setItem(storageKey, value) } catch { /* Keep the current session usable. */ }
  applyTheme()
}

systemTheme.addEventListener('change', () => {
  if (preference === 'system') applyTheme()
})
window.addEventListener('storage', event => {
  if (event.key !== storageKey) return
  preference = event.newValue === 'dark' || event.newValue === 'system' ? event.newValue : 'light'
  applyTheme()
})
applyTheme()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function useAppearance() {
  return useSyncExternalStore(subscribe, () => snapshot)
}
