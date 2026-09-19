import { auth } from "@root/auth"
import prisma from "@/lib/prisma"
import LoadingScreen from "./LoadingScreen"

export const dynamic = "force-dynamic"

export default async function LoadingScreenPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const params = await searchParams
  const session = await auth()
  const user = session?.user?.id
    ? await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { role: true },
      })
    : null

  const requested = params.next?.startsWith("/") && !params.next.startsWith("//")
    ? params.next
    : "/dashboard"
  const destination = user?.role === "ADMIN"
    ? "/admin/dashboard"
    : requested

  return <LoadingScreen destination={destination} />
}
