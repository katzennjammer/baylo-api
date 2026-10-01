import { z } from "zod"
import Anthropic from "@anthropic-ai/sdk"
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"
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
  type AssistantOutput,
  type BrowseSearch,
} from "@/lib/assistant/filters"

/**
 * One turn of the search assistant: a validated conversation in, a normalised
 * answer out. Everything between the model and the response lives here.
 *
 * Split from the route so that what runs in production is what the sample
 * harness runs (scripts/verify-assistant-samples.ts). The route adds only
 * who-may-call-it -- session, Premium, rate limits -- and the HTTP shape.
 *
 * WRITES NOTHING AND READS NOTHING. No Prisma import, no listing data: the only
 * I/O is the one Anthropic call. See the note at the top of the route.
 */

/** Messages the person may send in one conversation. */
export const MAX_USER_TURNS = 12
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

export type Turn = z.infer<typeof userTurn> | z.infer<typeof assistantTurn>

export const assistantBodySchema = z
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

export interface AssistantAnswer {
  action: AssistantOutput["action"]
  reply: string
  /** Normalised, in bracket vocabulary. The phone echoes this next turn. */
  filters: AssistantFilters
  /** Ready for GET /api/v1/browse; null when this turn did not search. */
  browse: BrowseSearch | null
}

export type TurnResult =
  | {
      ok: true
      answer: AssistantAnswer
      /** The model's answer BEFORE clamping, or null for a refusal. Diagnostics only. */
      raw: AssistantOutput | null
      usage: { input: number; output: number } | null
    }
  | { ok: false; why: string; usage: { input: number; output: number } | null }

export async function runAssistantTurn(turns: readonly Turn[], hasLocation: boolean): Promise<TurnResult> {
  // The filters in force before this turn: what a clarify, decline or refusal
  // hands back unchanged.
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant")
  const previous: AssistantFilters = lastAssistant?.role === "assistant" ? lastAssistant.filters : NO_FILTERS
  const ctx = { hasLocation }

  let output: AssistantOutput
  let usage: { input: number; output: number } | null = null
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
    usage = { input: message.usage.input_tokens, output: message.usage.output_tokens }

    // Token counts only -- never the conversation. This is the cost signal.
    console.info(`[assistant] stop=${message.stop_reason} in=${usage.input} out=${usage.output}`)

    if (message.stop_reason === "refusal") {
      return {
        ok: true,
        answer: {
          action: "decline",
          reply: "I can only help you search Baylo's listings. What are you looking for?",
          filters: normaliseFilters(previous, ctx),
          browse: null,
        },
        raw: null,
        usage,
      }
    }
    if (message.stop_reason !== "end_turn" || !message.parsed_output) {
      return { ok: false, why: `stop_reason ${message.stop_reason}`, usage }
    }
    output = message.parsed_output
  } catch (e) {
    // Status and class only. An upstream error body is not ours to forward,
    // and the identify route learned that the hard way.
    const status = e instanceof Anthropic.APIError ? e.status : undefined
    const why = `${e instanceof Error ? e.name : "unknown"} ${status ?? ""}`.trim()
    console.error(`[assistant] model call failed: ${why}`)
    return { ok: false, why, usage }
  }

  const reply = output.reply.trim().slice(0, MAX_REPLY)

  if (output.action !== "search") {
    // The prompt tells the model to keep the filters on clarify and decline;
    // this does not rely on it listening.
    return {
      ok: true,
      answer: { action: output.action, reply, filters: normaliseFilters(previous, ctx), browse: null },
      raw: output,
      usage,
    }
  }

  const search = toBrowseSearch(output.filters, ctx)
  if (!search.ok) {
    // A filter set browse would refuse. Not the caller's fault and not worth a
    // confusing grid: the phone answers this turn with the keyword matcher.
    console.error(`[assistant] filters refused by browse schema: ${search.reason}`)
    return { ok: false, why: `browse schema: ${search.reason}`, usage }
  }

  return {
    ok: true,
    answer: { action: "search", reply, filters: search.filters, browse: search.browse },
    raw: output,
    usage,
  }
}
