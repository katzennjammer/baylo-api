import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import { fetchAllowedImage, isAllowedImageUrl } from "@/lib/safe-image-url"
import { enforceRateLimit } from "@/lib/rate-limit-config"
import { imageUrlSchema, parseBody } from "@/lib/validation"
import { classifyPhoto } from "@/lib/item-classifier"

export const dynamic = "force-dynamic"

/**
 * POST /api/ai/identify — what is in a listing photo (29 Nov 2026: Baylo's own model).
 *
 * The category is decided by the SYSTEM from the photo (@/lib/item-classifier:
 * CLIP image embeddings, a classifier trained on Baylo's own listing photos,
 * and zero-shot prompts), run on this server. No paid API and no third party
 * sees the photo. It replaces the paid vision call, which also suggested a
 * condition, tags and a brand; those are now the person's to fill in.
 *
 * The response keeps the shape older app builds read:
 *   name        a generic item name to start the title from ("Electric fan").
 *               Never empty on success: an empty name is the app's "could not
 *               identify" signal.
 *   category    the first guess
 *   condition   "GOOD", a neutral default the person changes
 *   perishable  true for FOOD, as a suggestion
 * and adds, for the new app:
 *   categoryConfidence  0..100 for the first guess
 *   categoryTop3        the three best, with confidence: the app offers them
 *                       as one-tap choices (the right one is in the top three
 *                       about 85% of the time)
 *   source              "baylo-model"
 *
 * A model that cannot run answers 503 AI_UNAVAILABLE, as before: the app then
 * asks the person to type, and the outage is visible in logs.
 */
export async function POST(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // The model runs on our CPU; the limit keeps one account from hogging it.
  const limited = enforceRateLimit("aiIdentify", session.user.id)
  if (limited) return limited

  const parsed = await parseBody(req, imageUrlSchema)
  if (!parsed.ok) return parsed.response
  const { imageUrl } = parsed.data

  // The allowlist runs BEFORE the fetch: a blocked URL is a bad request, and
  // without it this endpoint would fetch any host it is given.
  const allowed = isAllowedImageUrl(imageUrl)
  if (!allowed.ok) return NextResponse.json({ error: allowed.reason }, { status: 400 })

  try {
    const result = await classifyPhoto(await fetchAllowedImage(imageUrl))
    if (!result) throw new Error("model unavailable")
    return NextResponse.json({
      name: result.name,
      category: result.category,
      condition: "GOOD",
      tags: [],
      brand: null,
      brandEvidence: null,
      perishable: result.category === "FOOD",
      quantity: null,
      unit: null,
      categoryConfidence: Math.round(result.confidence * 100),
      categoryTop3: result.top3.map((t) => ({ category: t.category, confidence: Math.round(t.confidence * 100) })),
      source: "baylo-model",
    })
  } catch (e) {
    // Neither the URL nor the upstream error goes back to the caller; see the
    // note on the 503 below.
    console.error("[identify] classification failed:", e instanceof Error ? e.message : "unknown error")
    // A 503, NOT a 200 with empty defaults (27 Sep 2026): an outage must be
    // visible. The phone treats a thrown identify call like an empty name and
    // asks the person to type what it is.
    return NextResponse.json(
      { error: "Photo identification is unavailable right now", code: "AI_UNAVAILABLE" },
      { status: 503 },
    )
  }
}
