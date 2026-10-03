import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import prisma from "@/lib/prisma"
import { sendPasswordResetEmail } from "@/lib/mailer"
import { publicBaseUrl } from "@/lib/public-url"
import { clientIp, enforceRateLimit } from "@/lib/rate-limit-config"
import { forgotPasswordSchema, parseBody } from "@/lib/validation"
import { hashResetToken } from "@/lib/reset-token"

export async function POST(req: NextRequest) {
  const parsed = await parseBody(req, forgotPasswordSchema)
  if (!parsed.ok) return parsed.response
  const { email } = parsed.data

  // Limited on BOTH axes. Per-email alone lets one caller flood many different
  // mailboxes from one machine; per-IP alone lets a distributed caller flood a
  // single victim. Each sends mail on our SMTP quota, so both are capped.
  const byEmail = enforceRateLimit("forgotPassword", `email:${email}`)
  if (byEmail) return byEmail
  const byIp = enforceRateLimit("forgotPassword", `ip:${clientIp(req)}`)
  if (byIp) return byIp

  try {
    const user = await prisma.user.findUnique({ where: { email } })

    if (user) {
      // Delete any existing reset token for this account. AuthToken (schema v2)
      // keys it on the user, not the email, and stores only its SHA-256.
      await prisma.authToken.deleteMany({ where: { userId: user.id, type: "PASSWORD_RESET" } })

      const token = crypto.randomBytes(32).toString("hex")
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000) // 30 min

      await prisma.authToken.create({
        data: { type: "PASSWORD_RESET", userId: user.id, tokenHash: hashResetToken(token), expiresAt },
      })

      const resetUrl = `${publicBaseUrl(req)}/auth/reset-password?token=${token}`
      await sendPasswordResetEmail(email, resetUrl, user.name)
    }

    // Always return 200 — don't reveal whether account exists
    return NextResponse.json({ ok: true })
  } catch (err) {
    // The exception stays server-side. Returning err.message handed the caller
    // SMTP host details and internal failure text.
    console.error("forgot-password error:", err instanceof Error ? err.message : "unknown error")
    return NextResponse.json({ error: "Could not send the reset email" }, { status: 500 })
  }
}
