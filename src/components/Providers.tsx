"use client"

import { usePathname } from "next/navigation"
import { SessionProvider } from "next-auth/react"
import { Toaster } from "react-hot-toast"

export default function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  // The admin console's own spec: toasts slide in from the bottom-right and
  // auto-dismiss after 4s. Everywhere else keeps the original top-right,
  // no-fixed-duration behaviour, so this is scoped to /admin rather than
  // changed globally.
  const isAdmin = pathname?.startsWith("/admin") ?? false

  return (
    <SessionProvider>
      {children}
      <Toaster position={isAdmin ? "bottom-right" : "top-right"} toastOptions={isAdmin ? { duration: 4000 } : undefined} />
    </SessionProvider>
  )
}
