import type { ReactNode } from "react"
import { UserAreaGuard } from "@/lib/user-area-guard"

export default function ListingsLayout({ children }: { children: ReactNode }) {
  return <UserAreaGuard>{children}</UserAreaGuard>
}
