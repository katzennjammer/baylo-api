/**
 * Offline checks for the search assistant's guardrails (@/lib/assistant/filters).
 *
 * Pure functions only: no server, no database query, no Anthropic call. Run with
 *   npx tsx scripts/verify-assistant-filters.ts
 * Exits 1 on the first failed group.
 */
import "dotenv/config"
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"
import {
  NO_FILTERS,
  assistantOutputSchema,
  normaliseQ,
  toBrowseSearch,
  type AssistantFilters,
} from "@/lib/assistant/filters"
import { ASSISTANT_SYSTEM_PROMPT } from "@/lib/assistant/prompt"

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}`, detail ?? "")
  }
}
const f = (over: Partial<AssistantFilters>): AssistantFilters => ({ ...NO_FILTERS, ...over })
const noLoc = { hasLocation: false }

console.log("brackets -> Leaves (bracket edges only)")
{
  const r = toBrowseSearch(f({ maxBracket: 1 }), noLoc)
  check("maxBracket 1 -> maxLeaves 100, not 50", r.ok && r.browse.maxLeaves === 100 && r.browse.minLeaves === null, r)
  const r2 = toBrowseSearch(f({ minBracket: 3, maxBracket: 3 }), noLoc)
  check("bracket 3 -> 251..500", r2.ok && r2.browse.minLeaves === 251 && r2.browse.maxLeaves === 500, r2)
  const r3 = toBrowseSearch(f({ minBracket: 11, maxBracket: -4 }), noLoc)
  check("out-of-range brackets clamped and swapped (-4,11 -> 1..10 -> unbounded)",
    r3.ok && r3.filters.minBracket === null && r3.filters.maxBracket === null && r3.browse.minLeaves === null && r3.browse.maxLeaves === null, r3)
  const r4 = toBrowseSearch(f({ minBracket: 6, maxBracket: 2 }), noLoc)
  check("inverted range swapped (6,2 -> 2..6)", r4.ok && r4.filters.minBracket === 2 && r4.filters.maxBracket === 6, r4)
  const r5 = toBrowseSearch(f({ minBracket: 2.6 }), noLoc)
  check("fractional bracket rounded (2.6 -> 3 -> minLeaves 251)", r5.ok && r5.browse.minLeaves === 251, r5)
  const r6 = toBrowseSearch(f({ minBracket: 10 }), noLoc)
  check("bracket 10 open top -> minLeaves 12001, no max", r6.ok && r6.browse.minLeaves === 12001 && r6.browse.maxLeaves === null, r6)
  const leafKeys = Object.keys(assistantOutputSchema.shape.filters.shape).filter((k) => /leaves/i.test(k))
  check("model schema has NO Leaves field", leafKeys.length === 0, leafKeys)
}

console.log("q stays a short substring")
check("sentence cut to two words", normaliseQ("red mountain bike for my kid") === "red mountain")
check("punctuation stripped", normaliseQ("  PS5!!! ") === "PS5")
check("empty -> null", normaliseQ("  ?! ") === null && normaliseQ(null) === null)
check("length capped at 40", (normaliseQ("a".repeat(90)) ?? "").length === 40)

console.log("lists and composition")
{
  const r = toBrowseSearch(
    f({ categories: ["TOYS", "TOYS", "BOOKS", "GAMING", "ART", "MUSIC", "SPORTS", "PETS"] }),
    noLoc,
  )
  check("categories deduped and capped at 5", r.ok && r.browse.categories.length === 5 && r.browse.categories[0] === "TOYS", r)
  const r2 = toBrowseSearch(f({ businessCategories: ["SARI_SARI"] }), noLoc)
  check("shop type implies orgsOnly (browse would 400 otherwise)", r2.ok && r2.browse.orgsOnly && r2.browse.businessCategories[0] === "SARI_SARI", r2)
  const r3 = toBrowseSearch(f({ perishable: true, categories: ["FOOD"] }), noLoc)
  check("perishable + FOOD passes browse schema", r3.ok && r3.browse.perishable === true, r3)
  const r4 = toBrowseSearch(f({ perishable: false }), noLoc)
  check("perishable=false kept (tri-state)", r4.ok && r4.browse.perishable === false, r4)
}

console.log("nearest needs a location")
{
  const r = toBrowseSearch(f({ sort: "nearest" }), noLoc)
  check("no location -> recent", r.ok && r.browse.sort === "recent", r)
  const r2 = toBrowseSearch(f({ sort: "nearest" }), { hasLocation: true })
  check("with location -> nearest, and passes the schema", r2.ok && r2.browse.sort === "nearest", r2)
}

console.log("structured output schema (what the API is sent)")
{
  const fmt = zodOutputFormat(assistantOutputSchema) as unknown as { type: string; schema: Record<string, unknown> }
  const json = JSON.stringify(fmt.schema)
  check("format type is json_schema", fmt.type === "json_schema", fmt.type)
  check("no minimum/maximum/minLength left in the sent schema", !/"(minimum|maximum|minLength|maxLength)"/.test(json))
  check("every object is additionalProperties:false", !/"additionalProperties":(?!false)/.test(json))
  console.log(`  schema is ${json.length} chars`)
}

console.log("system prompt")
{
  check("names all 20 categories", (ASSISTANT_SYSTEM_PROMPT.match(/^[A-Z_]+ = /gm) ?? []).length >= 20 + 11)
  check("has the real bracket edges", ASSISTANT_SYSTEM_PROMPT.includes("1: up to 100") && ASSISTANT_SYSTEM_PROMPT.includes("10: above 12000"))
  check("no volatile content (date/time)", !/20\d\d-\d\d-\d\d/.test(ASSISTANT_SYSTEM_PROMPT))
  // ~4 chars per token for English prose; the real count comes from the API.
  console.log(`  prompt is ${ASSISTANT_SYSTEM_PROMPT.length} chars, roughly ${Math.round(ASSISTANT_SYSTEM_PROMPT.length / 4)} tokens`)
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log("\nall checks passed")
process.exit(0)
