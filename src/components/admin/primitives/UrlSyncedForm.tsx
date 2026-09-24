"use client"

import { useRouter } from "next/navigation"
import type { FormEvent, FormHTMLAttributes } from "react"

/**
 * A drop-in replacement for a plain `<form action="...">` GET filter form.
 * The native version works (progressive enhancement: the `action` attribute
 * is still set), but submitting it is a real browser navigation that
 * reloads the whole document -- shell, rail, fonts, everything -- not just
 * the page content. This intercepts submit, builds the same query string
 * from the form's own named fields (nothing added, nothing carried over
 * from the current URL that the form doesn't already have a field for --
 * matching exactly what the native submission would have sent), and does
 * a client-side navigation instead.
 */
export default function UrlSyncedForm({
  action,
  children,
  ...rest
}: FormHTMLAttributes<HTMLFormElement> & { action: string; children: React.ReactNode }) {
  const router = useRouter()

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const params = new URLSearchParams()
    new FormData(e.currentTarget).forEach((value, key) => {
      if (typeof value === "string" && value.trim() !== "") params.set(key, value)
    })
    const query = params.toString()
    router.push(query ? `${action}?${query}` : action, { scroll: false })
  }

  return (
    <form action={action} onSubmit={onSubmit} {...rest}>
      {children}
    </form>
  )
}
