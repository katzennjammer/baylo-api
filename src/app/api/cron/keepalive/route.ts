import { NextRequest, NextResponse } from "next/server"
import prisma from "@/lib/prisma"

/**
 * Daily Supabase keep-alive, called by the Vercel cron in vercel.json.
 *
 * The free tier pauses a project after about a week with no activity, and a
 * paused database makes the whole app look broken to anyone opening it cold
 * (a reviewer, a panel). One read-only `SELECT 1` a day counts as activity.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when that env var is set.
 * Without it the route refuses, so it cannot be used to hammer the database.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await prisma.$queryRaw`SELECT 1`
  return NextResponse.json({ ok: true })
}
