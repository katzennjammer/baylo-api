"use client"

import { useSyncExternalStore } from "react"
import { THEME_KEY } from "./pref-keys"

/**
 * The signed-in admin's own preferences. They live in this browser, not the
 * database: nothing here changes how Baylo behaves for anyone else.
 *
 * Two stores, by who has to read the value:
 *   localStorage -- theme and density, which only the client shell applies.
 *   a cookie     -- the landing page and the default report period, which a
 *                   SERVER component has to read before it renders or redirects.
 *
 * The key and cookie names are in pref-keys.ts, which the server can import.
 */

const PREF_EVENT = "adm-pref-change"

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback)
  window.addEventListener(PREF_EVENT, callback)
  return () => {
    window.removeEventListener("storage", callback)
    window.removeEventListener(PREF_EVENT, callback)
  }
}

/** A localStorage preference. Hydration-safe: the server renders `fallback`. */
export function usePref(key: string, fallback: string): string {
  return useSyncExternalStore(
    subscribe,
    () => {
      try {
        return window.localStorage.getItem(key) ?? fallback
      } catch {
        return fallback
      }
    },
    () => fallback,
  )
}

export function writePref(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
    window.dispatchEvent(new Event(PREF_EVENT))
  } catch {
    // localStorage unavailable (private mode) -- the choice won't persist.
  }
}

/** A year-long cookie scoped to the console, so only /admin requests carry it. */
export function writePrefCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/admin; max-age=31536000; samesite=lax`
}

const DARK_QUERY = "(prefers-color-scheme: dark)"

function subscribeSystemTheme(callback: () => void) {
  const media = window.matchMedia(DARK_QUERY)
  media.addEventListener("change", callback)
  return () => media.removeEventListener("change", callback)
}

/** The theme to draw: the stored choice, or the computer's when it is "system". */
export function useResolvedTheme(): "dark" | "light" {
  const choice = usePref(THEME_KEY, "dark")
  const systemDark = useSyncExternalStore(subscribeSystemTheme, () => window.matchMedia(DARK_QUERY).matches, () => true)
  if (choice === "system") return systemDark ? "dark" : "light"
  return choice === "light" ? "light" : "dark"
}
