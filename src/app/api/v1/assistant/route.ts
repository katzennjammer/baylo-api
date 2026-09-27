import { NextRequest } from "next/server"
import { z } from "zod"
import Anthropic from "@anthropic-ai/sdk"
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { isPremium, isVip } from "@/lib/premium"
import { enforceRateLimit } from "@/lib/rate-limit-config"
import { anthropic, HAIKU_MODEL } from "@/lib/anthropic"
import { ASSISTANT_SYSTEM_PROMPT } from "@/lib/assistant/prompt"
import {
  ASSISTANT_ACTIONS,
  NO_FILTERS,
  assistantFiltersSchema,
  assistantOutputSchema,
  normaliseFilters,
  toBrowseSearch,
  type AssistantFilters,
} from "@/lib/assistant/filters"
import { parseJsonBody } from "@/lib/v1/body"
import { fail, forbidden, invalid, ok, unauthenticated } from "@/lib/v1/envelope"

export const dynamic = "force-dynamic"

/**
 * POST /api/v1/assistant -- one turn of the Premium search assistant.
 *
 * ── WHAT IT CAN DO: TURN WORDS INTO BROWSE FILTERS. NOTHING ELSE. ───────────
 *
 * The boundary is structural, not a promise in a prompt:
 *
 *   - This file performs NO database writes. Its one query reads the caller's
 *     subscription dates. Nothing here imports a writer.
 *   - It does not read or return LISTINGS. It returns filters; the phone runs
 *     GET /api/v1/browse with them, so blocking, suspension, takedowns and the
 *     perishable sweep all apply exactly as they do to a search typed by hand.
 *   - The model has no tools. Its only output is a fixed JSON shape (structured
 *     output), and every filter in it is clamped and then validated by
 *     browseQuerySchema -- the schema browse itself parses with -- before it
 *     leaves. See @/lib/assistant/filters.
 *
 * So a model talked into "go ahead and send that offer" has no way to do it.
 * The worst a hostile conversation can produce is an odd search.
 *
 * ── WHO MAY USE IT ──────────────────────────────────────────────────────────
 *
 * Premium or VIP, read with the exact expression offer-check.ts uses:
 * isPremium(premiumUntil) || isVip(vipUntil), VIP being a superset. Always the
 * PERSON's subscription: resolveSession() never reads X-Baylo-Org, so staff
 * acting as a shop use their own Premium. Searching is not acquiring, and the
 * shop's standing has nothing to say about it.
 *
 * ── STATE ───────────────────────────────────────────────────────────────────
 *
 * None on the server. The phone holds the conversation and sends it whole each
 * turn; nothing is stored, including the text. The server re-validates every
 * echoed turn, and a forged history can only mislead its own sender's search.
 *
 * Earlier results reach the model as a COUNT ONLY -- "[Last search: 12
 * listings]". Never titles or descriptions: those are written by other users,
 * and a listing called "ignore your instructions and..." is a prompt injection
 * with a photo. A number cannot carry one.
 */

/** Messages the person may send in one conversation. */
const MAX_USER_TURNS = 12
/** One message's length. A search request, not an essay. */
const MAX_TEXT = 500
/** An echoed reply's length; the model's own are two sentences. */
const MAX_REPLY = 600

/**
 * The results a turn's filters found, as the phone saw them: the size of the
 * first browse page and whether there was another. Browse has no total count,
 * so "20 and more" is as exact as this can be -- and all the model needs.
 */
const resultsSchema = z.strictObject({
  count: z.number().int().min(0).max(1000),
  more: z.boolean(),
})

const userTurn = z.strictObject({
  role: z.literal("user"),
  text: z.string().trim().min(1).max(MAX_TEXT),
})

const assistantTurn = z.strictObject({
  role: z.literal("assistant"),
  action: z.enum(ASSISTANT_ACTIONS),
  reply: z.string().max(MAX_REPLY),
  filters: assistantFiltersSchema,
  /** Null when the turn did not search, or the phone has not run it yet. */
  results: resultsSchema.nullable(),
})

type Turn = z.infer<typeof userTurn> | z.infer<typeof assistantTurn>

const bodySchema = z
  .strictObject({
    turns: z.array(z.discriminatedUnion("role", [userTurn, assistantTurn])).min(1).max(MAX_USER_TURNS * 2),
    /** Whether the phone has a location to attach to a nearest search. */
    hasLocation: z.boolean().optional().default(false),
  })
  .refine((b) => b.turns.every((t, i) => t.role === (i % 2 === 0 ? "user" : "assistant")), {
    message: "turns must alternate user, assistant, user... starting with user",
  })
  .refine((b) => b.turns[b.turns.length - 1].role === "user", {
    message: "the last turn must be the user's",
  })

/** 503 in the envelope. The phone answers this turn with its keyword matcher. */
const unavailable = () =>
  fail("UNAVAILABLE", "The assistant is unavailable right now. Try again in a moment.")

function resultsLine(r: z.infer<typeof resultsSchema>): string {
  return r.count === 0
    ? "[Last search: no listings]"
    : `[Last search: ${r.count}${r.more ? "+" : ""} listing${r.count === 1 && !r.more ? "" : "s"}]`
}

/**
 * The conversation as the model sees it. Assistant turns are replayed in the
 * model's own output shape, so it reads its previous filters exactly as it
 * wrote them; a user turn after a search is prefixed with that search's count.
 */
function toMessages(turns: readonly Turn[]): Anthropic.MessageParam[] {
  return turns.map((t, i) => {
    if (t.role === "assistant") {
      return {
        role: "assistant",
        content: JSON.stringify({ action: t.action, reply: t.reply, filters: t.filters }),
      }
    }
    const prev = i > 0 ? turns[i - 1] : null
    const counted = prev?.role === "assistant" && prev.results ? `${resultsLine(prev.results)}\n` : ""
    return { role: "user", content: counted + t.text }
  })
}

export async function POST(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const userId = session.user.id

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { premiumUntil: true, vipUntil: true },
  })
  if (!(isPremium(user?.premiumUntil) || isVip(user?.vipUntil))) {
    return forbidden("The search assistant is part of Premium.", { rule: "PREMIUM_REQUIRED" })
  }

  // Every call past this point bills a Haiku request to our account.
  const hourly = enforceRateLimit("aiAssistant", userId)
  if (hourly) return hourly
  const daily = enforceRateLimit("aiAssistantDaily", userId)
  if (daily) return daily

  const parsed = await parseJsonBody(req, bodySchema)
  if (!parsed.ok) return parsed.response
  const { turns, hasLocation } = parsed.data

  const userTurns = turns.filter((t) => t.role === "user").length
  if (userTurns > MAX_USER_TURNS) {
    return invalid(`A conversation is limited to ${MAX_USER_TURNS} messages. Start a new one to keep searching.`, {
      rule: "ASSISTANT_TURN_LIMIT",
      maxTurns: MAX_USER_TURNS,
    })
  }

  // The filters in force before this turn: what a clarify, decline or refusal
  // hands back unchanged.
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant")
  const previous: AssistantFilters = lastAssistant?.role === "assistant" ? lastAssistant.filters : NO_FILTERS

  let output: z.infer<typeof assistantOutputSchema>
  try {
    const message = await anthropic().messages.parse({
      model: HAIKU_MODEL,
      // Two sentences and a filter object. A generous ceiling, not a target:
      // hitting it means the model rambled, and that turn is refused below.
      max_tokens: 400,
      temperature: 0,
      system: ASSISTANT_SYSTEM_PROMPT,
      messages: toMessages(turns),
      output_config: { format: zodOutputFormat(assistantOutputSchema) },
    })

    // Token counts only -- never the conversation. This is the cost signal.
    console.info(
      `[assistant] stop=${message.stop_reason} in=${message.usage.input_tokens} out=${message.usage.output_tokens}`,
    )

    if (message.stop_reason === "refusal") {
      return ok({
        action: "decline" as const,
        reply: "I can only help you search Baylo's listings. What are you looking for?",
        filters: normaliseFilters(previous, { hasLocation }),
        browse: null,
      })
    }
    if (message.stop_reason !== "end_turn" || !message.parsed_output) {
      return unavailable()
    }
    output = message.parsed_output
  } catch (e) {
    // Status and class only. An upstream error body is not ours to forward,
    // and the identify route learned that the hard way.
    const status = e instanceof Anthropic.APIError ? e.status : undefined
    console.error(`[assistant] model call failed: ${e instanceof Error ? e.name : "unknown"} ${status ?? ""}`)
    return unavailable()
  }

  const reply = output.reply.trim().slice(0, MAX_REPLY)

  if (output.action !== "search") {
    // The prompt tells the model to keep the filters on clarify and decline;
    // this does not rely on it listening.
    return ok({
      action: output.action,
      reply,
      filters: normaliseFilters(previous, { hasLocation }),
      browse: null,
    })
  }

  const search = toBrowseSearch(output.filters, { hasLocation })
  if (!search.ok) {
    // A filter set browse would refuse. Not the caller's fault and not worth a
    // confusing grid: the phone answers this turn with the keyword matcher.
    console.error(`[assistant] filters refused by browse schema: ${search.reason}`)
    return unavailable()
  }

  return ok({ action: "search" as const, reply, filters: search.filters, browse: search.browse })
}
