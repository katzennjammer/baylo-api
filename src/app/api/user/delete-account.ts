import bcrypt from "bcryptjs"
import prisma from "@/lib/prisma"

/**
 * Account deletion, as one transaction.
 *
 * The account is ANONYMISED rather than removed. That is not a soft-delete
 * reflex — it is forced by the ledger. `LeafTransaction.userId` is a foreign key
 * declared `onDelete: Cascade`, so `prisma.user.delete()` would take the user's
 * entire Leaf history with it, and
 *
 *     SUM(User.leaves) == SUM(LeafTransaction.amount)
 *
 * would stop holding the moment anyone deleted an account with a balance. Both
 * sides of that equation have to move together or neither may move, and the
 * simplest way to satisfy that is to move neither: the row stays, carrying its
 * balance and its history, with every piece of personal data overwritten.
 *
 * What that leaves behind is a tombstone — an account with no name, no email
 * anyone can reach, no password, and no way back in. What it does NOT leave
 * behind is anything that identifies a person.
 */

/** Personal data is overwritten with these, not merely nulled where nullable. */
const DELETED_NAME = "Deleted user"

export type DeleteOutcome =
  | {
      ok: true
      summary: DeletionSummary
      /**
       * Cloudinary public_ids of any ID photo still awaiting review.
       *
       * Handed to the CALLER rather than destroyed here, so the deletion
       * transaction never holds open across a network round trip to a third
       * party. See the note beside the deleteMany that produces them.
       */
      pendingIdImages: string[]
    }
  | { ok: false; status: number; error: string }

export interface DeletionSummary {
  userId: string
  itemsRemoved: number
  pickupsCleared: number
  refreshTokensRevoked: number
  offersDeclined: number
  messagesRedacted: number
  ledgerRowsPreserved: number
  ledgerRowsAnonymised: number
  /** IdVerification rows removed. Removed, not scrubbed -- see below. */
  idSubmissionsRemoved: number
  leavesRetained: number
}

export async function deleteAccount(
  userId: string,
  suppliedPassword: string | undefined,
): Promise<DeleteOutcome> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, password: true, deletedAt: true, leaves: true, name: true },
  })
  if (!user) return { ok: false, status: 404, error: "User not found" }
  if (user.deletedAt) return { ok: false, status: 410, error: "Account is already deleted" }

  // An account with a password must prove ownership with it. A stolen access
  // token should not be enough to destroy someone's account. Google-only
  // accounts have no password to check, so the bearer token is the proof there.
  if (user.password) {
    if (!suppliedPassword) {
      return { ok: false, status: 400, error: "Your password is required to delete this account" }
    }
    const valid = await bcrypt.compare(suppliedPassword, user.password)
    if (!valid) return { ok: false, status: 403, error: "Password is incorrect" }
  }

  const now = new Date()
  // Unique, unroutable, and not derived from the old address — the email column
  // is UNIQUE, so it needs a value, and that value must not be a way to
  // recognise who the account belonged to.
  const tombstoneEmail = `deleted-${userId}@deleted.invalid`

  return prisma.$transaction(async (tx) => {
    const leavesBefore = user.leaves

    // ── Listings ────────────────────────────────────────────────────────────
    // Soft-deleted, and the pickup point goes with them. A REMOVED listing is
    // already unreadable by anyone but its owner, and its owner no longer exists.
    const pickupsCleared = await tx.item.count({
      where: { userId, OR: [{ pickupLat: { not: null } }, { pickupAddress: { not: null } }] },
    })
    const itemsRemoved = await tx.item.updateMany({
      where: { userId },
      data: { status: "REMOVED", pickupLat: null, pickupLng: null, pickupAddress: null },
    })

    // ── Sessions ────────────────────────────────────────────────────────────
    const revoked = await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    })

    // ── Open commitments ────────────────────────────────────────────────────
    // Pending offers are declined rather than left hanging: each one holds
    // Leaves against a counterparty who can no longer complete anything.
    const offersDeclined = await tx.offer.updateMany({
      where: { senderId: userId, status: "PENDING" },
      data: { status: "DECLINED" },
    })
    await tx.tradeRequest.updateMany({
      where: { OR: [{ senderId: userId }, { receiverId: userId }], status: { in: ["PENDING", "ACCEPTED", "CONFIRMING"] } },
      data: { status: "CANCELLED" },
    })

    // Unused confirmation codes are credentials; they go.
    await tx.swapConfirmationCode.deleteMany({ where: { userId } })

    // ── Personal content ────────────────────────────────────────────────────
    // Message bodies are the user's own words. The rows stay so the other
    // party's thread does not develop holes, but the content does not.
    const messagesRedacted = await tx.message.updateMany({
      where: { senderId: userId },
      data: { content: "[deleted]" },
    })
    await tx.postComment.updateMany({ where: { userId }, data: { content: "[deleted]" } })
    await tx.review.updateMany({ where: { reviewerId: userId }, data: { comment: null } })

    // Social graph and notification history carry no value once the account is
    // gone, and notifications embed the user's name in their text.
    await tx.follow.deleteMany({ where: { OR: [{ followerId: userId }, { followeeId: userId }] } })
    await tx.notification.deleteMany({ where: { OR: [{ userId }, { actorId: userId }] } })
    await tx.postLike.deleteMany({ where: { userId } })
    await tx.commentLike.deleteMany({ where: { userId } })
    // Reset tokens are keyed by email, so they are removed by the OLD address
    // before that address is overwritten below.
    await tx.passwordResetToken.deleteMany({ where: { email: user.email } })

    // ── Government ID submissions ───────────────────────────────────────────
    //
    // ROWS REMOVED, NOT ANONYMISED — the only table in this function treated
    // that way, and the exception is the point. Everything else here is
    // retained-and-scrubbed because a ledger row or a message thread has a
    // counterparty whose record would develop a hole. An IdVerification row has
    // no counterparty: it is a digest of a government ID belonging solely to
    // the person who has just asked to be forgotten, and RA 10173 does not
    // leave much room for keeping it.
    //
    // AND THIS IS WHAT FREES THE ID. The spec's rule is that deletion releases
    // the hash and suspension does not, and this delete is the whole
    // implementation of the first half — the claimKey goes with the row, so the
    // unique index no longer holds a slot for that ID and a genuine person who
    // deleted their account can register again with the same document. A
    // SUSPENDED account keeps its rows and therefore keeps its claim, which is
    // what stops a banned user re-presenting the same ID on a fresh signup.
    //
    // THE AUDIT TRAIL SURVIVES. AdminAction rows point at these ids by plain
    // string (targetId), with no foreign key back — so "who approved this, and
    // when" is still answerable after the row it describes is gone, which is
    // exactly the split the retention rule wants: keep the decision, drop the
    // document.
    const idImages = await tx.idVerification.findMany({
      where: { userId },
      select: { imagePublicId: true },
    })
    const idSubmissionsRemoved = await tx.idVerification.deleteMany({ where: { userId } })

    // ── Ledger ──────────────────────────────────────────────────────────────
    // Rows are PRESERVED — count and amounts untouched, so the invariant holds
    // — but their descriptions are free text that names counterparties, so the
    // text is replaced with the transaction type. Amount, type, timestamps and
    // userId are exactly what they were.
    const ledgerRowsPreserved = await tx.leafTransaction.count({ where: { userId } })
    const ledgerRows = await tx.leafTransaction.findMany({
      where: { userId },
      select: { id: true, type: true },
    })
    for (const row of ledgerRows) {
      await tx.leafTransaction.update({
        where: { id: row.id },
        data: { description: `${row.type} (account deleted)` },
      })
    }
    // The counterparty's side of a settled trade names THIS user by name.
    await tx.leafTransaction.updateMany({
      where: { description: { contains: user.name }, userId: { not: userId } },
      data: { description: "Leaves moved in a completed trade" },
    })

    // ── The account itself ──────────────────────────────────────────────────
    // `leaves` and `lifetimeLeaves` are deliberately NOT zeroed. Zeroing them
    // would subtract from SUM(User.leaves) while the ledger rows above still
    // sum to the same total, which is precisely the breakage this whole
    // approach exists to avoid.
    await tx.user.update({
      where: { id: userId },
      data: {
        deletedAt: now,
        name: DELETED_NAME,
        email: tombstoneEmail,
        password: null,
        avatar: null,
        bio: null,
        location: null,
        isVerified: false,
      },
    })

    return {
      ok: true as const,
      summary: {
        userId,
        itemsRemoved: itemsRemoved.count,
        pickupsCleared,
        refreshTokensRevoked: revoked.count,
        offersDeclined: offersDeclined.count,
        messagesRedacted: messagesRedacted.count,
        ledgerRowsPreserved,
        ledgerRowsAnonymised: ledgerRows.length,
        idSubmissionsRemoved: idSubmissionsRemoved.count,
        leavesRetained: leavesBefore,
      },
      // Handed OUT of the transaction rather than destroyed inside it. A
      // Cloudinary call in here would hold a database transaction open across a
      // network round trip to a third party — and a third party having a bad
      // afternoon would then roll back an account deletion the user asked for.
      // Same rule as the decision route: the database commits, the file is
      // dealt with afterwards, and a decided row with a live publicId is the
      // retry set. (There is almost never anything here: only a PENDING
      // submission still has an image, and only if the account is deleted
      // before it is reviewed.)
      pendingIdImages: idImages
        .map((r) => r.imagePublicId)
        .filter((v): v is string => v !== null),
    }
  })
}
