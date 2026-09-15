import type { ReactNode } from "react"
import { UserAreaGuard } from "@/lib/user-area-guard"

export default function ProfileLayout({ children }: { children: ReactNode }) {
  return <UserAreaGuard>{children}</UserAreaGuard>
}
