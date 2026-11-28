import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import sharp from "sharp"
import { fetchAllowedImage, isAllowedImageUrl } from "@/lib/safe-image-url"
import { enforceRateLimit } from "@/lib/rate-limit-config"
import { imageUrlSchema, parseBody } from "@/lib/validation"
import { BLOCK_CONFIDENCE, NOTE_CONFIDENCE, embedImage } from "@/lib/image-embedding"
import { findSimilarPhotos } from "@/lib/photo-similarity"
import type { Prisma } from "@/generated/prisma/client"

/** Every HASHED photo matching `where` -- the duplicate pool. Unhashed photos (hash NULL) are not in it. */
async function hashedPhotos(where: Prisma.ItemImageWhereInput): Promise<{ itemId: string; position: number; hash: string }[]> {
  const rows = await prisma.itemImage.findMany({
    where: { ...where, hash: { not: null } },
    select: { itemId: true, position: true, hash: true },
  })
  return rows.filter((r): r is { itemId: string; position: number; hash: string } => r.hash !== null)
}

// ── Config ────────────────────────────────────────────────────────────────────
// Hamming distance ceiling (out of 64 bits) for Stage 1 to flag a candidate.
// dHash ranges: renamed/recompressed ≈ 0–8, completely different image ≈ 20+.
// Default 10 gives a comfortable gap; tune down if you get false positives.
const THRESHOLD = parseInt(process.env.PHASH_THRESHOLD ?? "10", 10)

// What to do when Stage 2 (AI) confirms a duplicate: "block" | "warn" | "flag"
// "block" → status:"failed" (wizard blocks Next button)
// "warn"  → status:"warned" (wizard can show a softer warning)
// "flag"  → status:"passed" (allow but include flagged:true in response)
const DUPLICATE_ACTION = process.env.DUPLICATE_ACTION ?? "block"

// WHICH LISTINGS ARE IN THE DUPLICATE POOL — DELIBERATELY ALL OF THEM.
//
// This used to read `status: "AVAILABLE"`, and that was the bug. The moment a
// listing was traded it became OWNED or TRADED, left the pool, and its photo
// was free for anyone to post again with no warning. The check was strongest
// for listings nobody had wanted yet and silent for the ones that had actually
// changed hands — exactly backwards, since a stranger reusing the photo of an
// item that has already been traded away is the strongest signal there is.
//
// Measured on the live table when this was found: every identical-image pair
// but one had at least one side out of the pool. Two of three real images,
// re-uploaded from a second account, published unchallenged; with the filter
// gone all three match at Hamming distance 0.
//
// NOTHING IS EXCLUDED, INCLUDING TAKEDOWNS. Two different things hide a
// listing: `status = REMOVED`, which its OWNER sets and can undo via
// /api/items/[id]/relist, and `moderationHiddenAt`, which a moderator sets and
// the owner cannot. Neither is consulted here. A photo a moderator took down is
// the last one that should quietly become re-postable by a stranger, and an
// owner who delisted their own item is not blocked by their own row either —
// Stage 1B runs first and answers "self", which is allowed.
//
// So the rule is simply "every image this app has accepted", and no status
// column is read at all.

// ── dHash ─────────────────────────────────────────────────────────────────────
// Resize to 9×8, compare each pixel to its right neighbour per row → 64-bit
// binary string. Encodes local gradients, so JPEG recompression / minor resizes
// / brightness shifts don't flip bits — far more robust than aHash.
async function computeDHash(buffer: Buffer): Promise<string> {
  const { data } = await sharp(buffer)
    .resize(9, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const pixels = Array.from(data as Uint8Array)
  const bits: string[] = []
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      bits.push(pixels[row * 9 + col] > pixels[row * 9 + col + 1] ? "1" : "0")
    }
  }
  return bits.join("")
}

function hammingDistance(a: string, b: string): number {
  let d = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) d++
  return d
}

// ── Stage 2: our own image model (29 Nov 2026) ───────────────────────────────
// The paid vision call that used to confirm Stage 1 hits is gone. DINOv2
// (open-source, run on this server: @/lib/image-embedding) compares the new
// photo with EVERY embedded photo, so it also catches edits the pixel hash
// misses, and it answers with a calibrated confidence the user is shown:
//   another trader's photo  ≥ 95%  → "failed" (blocked), with the %
//                           80–95% → "warned" (allowed; "X% similar to another
//                                    listing" here and on the listing)
//   own active listing, same item  → "self" with `sameItem` (a warning only)
// No model available (file missing): Stage 1 alone decides, as before.

// ── Route ─────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
  const session = await resolveSession()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Two vision calls per request, plus a full-catalogue scan.
  const limited = enforceRateLimit("aiPhash", session.user.id)
  if (limited) return limited

  const parsed = await parseBody(req, imageUrlSchema)
  if (!parsed.ok) return parsed.response
  const { imageUrl } = parsed.data

  // The allowlist runs BEFORE the fetch below and returns 400 without making a
  // request. Falling through to the fetch and letting it fail would still have
  // performed the fetch, which is the whole of the SSRF.
  const allowed = isAllowedImageUrl(imageUrl)
  if (!allowed.ok) return NextResponse.json({ error: allowed.reason }, { status: 400 })

  // ── Stage 1A: dHash and the embedding of the new upload ───────────────────
  let hash: string
  let embedding: number[] | null = null
  try {
    const buffer = await fetchAllowedImage(imageUrl)
    ;[hash, embedding] = await Promise.all([
      computeDHash(buffer),
      embedImage(buffer).catch((err) => {
        console.error("[phash] embedding failed; Stage 1 alone decides:", err instanceof Error ? err.message : err)
        return null
      }),
    ])
  } catch {
    // Neither the URL nor the error is logged. Both are attacker-controlled, and
    // a log that distinguishes "connection refused" from "404" is the readout
    // that turns a blocked SSRF back into a working port scanner.
    console.error("[phash] Stage 1A failed — item will be posted without imageHash.")
    return NextResponse.json({ hash: null, status: "passed" })
  }

  // ── Stage 1B: the same photo as one of your own (pixel hash) ──────────────
  // Re-posting your own photo is allowed: "self", a grey box.
  const ownHashes = await hashedPhotos({ item: { userId: session.user.id } })
  for (const row of ownHashes) {
    const dist = hammingDistance(hash, row.hash)
    if (dist <= THRESHOLD) {
      return NextResponse.json({ hash, status: "self", matchedItemId: row.itemId, distance: dist })
    }
  }

  // ── Stage 1C: the same photo as someone else's (pixel hash) ───────────────
  const otherHashes = await hashedPhotos({ item: { userId: { not: session.user.id } } })
  let hashHit: { id: string; distance: number } | null = null
  for (const row of otherHashes) {
    const dist = hammingDistance(hash, row.hash)
    if (dist <= THRESHOLD && (!hashHit || dist < hashHit.distance)) hashHit = { id: row.itemId, distance: dist }
  }

  // ── No model: Stage 1 alone, as before ────────────────────────────────────
  if (!embedding) {
    if (!hashHit) return NextResponse.json({ hash, status: "passed" })
    const status = DUPLICATE_ACTION === "block" ? "failed" : DUPLICATE_ACTION === "warn" ? "warned" : "passed"
    return NextResponse.json({ hash, status, matchedItemId: hashHit.id, distance: hashHit.distance, stage: 1 })
  }

  // ── Stage 2: similarity on our own model ──────────────────────────────────
  const matches = await findSimilarPhotos(embedding, session.user.id)
  // A pixel-hash hit is the same picture, whatever the model says.
  let confidence = matches.other?.confidence ?? 0
  let matchedItemId = matches.other?.itemId
  if (hashHit && confidence < 0.99) {
    confidence = 0.99
    matchedItemId = hashHit.id
  }
  const confidencePct = Math.round(confidence * 100)

  if (confidence >= BLOCK_CONFIDENCE && DUPLICATE_ACTION !== "flag") {
    return NextResponse.json({
      hash, status: DUPLICATE_ACTION === "warn" ? "warned" : "failed",
      matchedItemId, confidencePct, distance: hashHit?.distance, stage: 2,
    })
  }
  if (confidence >= NOTE_CONFIDENCE) {
    return NextResponse.json({ hash, status: "warned", matchedItemId, confidencePct, stage: 2 })
  }
  if (matches.ownSameItem) {
    return NextResponse.json({
      hash, status: "self", matchedItemId: matches.ownSameItem.itemId, stage: 2,
      sameItem: { itemId: matches.ownSameItem.itemId, title: matches.ownSameItem.title, similarityPct: Math.round(matches.ownSameItem.cosine * 100) },
    })
  }
  return NextResponse.json({ hash, status: "passed", confidencePct, stage: 2 })

  } catch (e) {
    // Stages 1B/1C Prisma queries and resolveSession() have no individual try-catch.
    // Without this outer catch, any DB error returns HTML 500, the wizard's
    // r.json() throws, phashRes becomes "rejected", and imageHash is silently dropped.
    console.error(
      "[phash] ⚠ UNHANDLED ERROR in phash route — item will be posted without imageHash.",
      "\n  Root cause: likely a transient DB error in Stage 1B/1C Prisma query, or resolveSession() failure.",
      "\n  error:", e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : e,
    )
    return NextResponse.json({ hash: null, status: "passed" })
  }
}
