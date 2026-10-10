import { NextRequest, NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import prisma from "@/lib/prisma"
import { parseBody, resetPasswordSchema } from "@/lib/validation"
import { hashResetToken } from "@/lib/reset-token"
import { revokeUserFamilies } from "@/lib/auth-tokens"

export async function POST(req: NextRequest) {
  // resetPasswordSchema applies the same 8-character minimum as registration.
  // This route previously checked only that a password was present, so the one
  // flow that exists specifically to replace a compromised password was also
  // the one flow that would accept a single character.
  const parsed = await parseBody(req, resetPasswordSchema)
  if (!parsed.ok) return parsed.response
  const { token, password } = parsed.data

  // Only the hash is stored (schema v2), so the presented token is hashed and
  // looked up; a hash of any other token type is not a reset link.
  const record = await prisma.authToken.findUnique({ where: { tokenHash: hashResetToken(token) } })

  if (!record || record.type !== "PASSWORD_RESET" || record.expiresAt < new Date()) {
    return NextResponse.json({ error: "Reset link is invalid or has expired" }, { status: 400 })
  }

  const hashed = await bcrypt.hash(password, 12)

  await prisma.user.update({
    where: { id: record.userId },
    data: { password: hashed },
  })

  await prisma.authToken.delete({ where: { id: record.id } })

  // Every device is signed out. A reset is what someone does when they think
  // the password is known to someone else, and a session that person already
  // holds would otherwise outlive the new password by up to thirty days. The
  // caller here holds no session to keep: they came in through an email link.
  await revokeUserFamilies(record.userId)

  return NextResponse.json({ ok: true })
}
