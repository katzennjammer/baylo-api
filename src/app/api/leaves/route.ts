import { NextResponse } from "next/server";
import { resolveSession } from "@/lib/api-auth";
import prisma from "@/lib/prisma";
import { availableLeaves } from "@/lib/leaves";
import { expireStaleOffers } from "@/lib/offers";

export async function GET() {
  const session = await resolveSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  // Before the balance is read, and NOT inside the Promise.all below: the sweep
  // writes, and `availableLeaves()` has to see the result of it. Racing the two
  // would report the stale figure about half the time, which is worse than not
  // sweeping at all — an intermittently wrong balance is the kind nobody can
  // reproduce. See the note on expireStaleOffers().
  await expireStaleOffers(prisma, { senderId: userId });

  const [user, transactions, available] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { leaves: true },
    }),
    prisma.leafTransaction.findMany({
      where: { userId },
      // eventAt, not createdAt: this list shows the user when things HAPPENED,
      // and createdAt is when the row was written. For the backfilled rows those
      // differ by over two months, so ordering on write time shuffles a user's
      // history into the order the backfill happened to process it in.
      orderBy: { eventAt: "desc" },
      take: 50,
    }),
    availableLeaves(prisma, userId),
  ]);

  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  return NextResponse.json({ total: user.leaves, available, transactions });
}
