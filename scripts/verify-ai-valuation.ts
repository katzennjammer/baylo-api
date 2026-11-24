/**
 * Offline checks for AI-assisted valuation (@/lib/ai-valuation, @/lib/price-levels) and the write
 * path's use of it (judgeValue in @/lib/valuation-server).
 *
 * No server, no database query, no Anthropic call. Run with
 *   npx tsx scripts/verify-ai-valuation.ts
 * Exits 1 if any check fails.
 */
import {
  AI_TICKET_TTL_MS,
  AI_VALUATION_SOURCE,
  decideAiValuation,
  issueTicket,
  parseAiValuationAnswer,
  verifiedListings,
  verifyTicket,
} from "@/lib/ai-valuation"
import { PRICE_CUTOFFS_PHP, leavesForLevel, levelOf, medianPhp } from "@/lib/price-levels"
import { bracketOf } from "@/lib/brackets"
import { valueCap } from "@/lib/trade-rules"
import { CATEGORY_BANDS, overrideBounds, valueItem } from "@/lib/valuation"
import { judgeValue } from "@/lib/valuation-server"

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}`, detail ?? "")
  }
}

const SECRET = "test-secret-not-real"
const NOW = 1_800_000_000_000
const range = { min: 120, max: 4800 } // Electronics, Like New
const results = [
  { url: "https://shop.example.ph/iphone-13", title: "iPhone 13 128GB" },
  { url: "https://market.example.com/listing/42", title: "Used iPhone 13" },
  { url: "https://third.example.org/p/9", title: "iPhone 13 mini" },
  { url: "https://fourth.example.org/p/1", title: "iPhone 13 Pro" },
  { url: "http://insecure.example.com/x", title: "insecure" },
]
const L = (url: string, pricePhp: number) => ({ url, pricePhp })
const answer = (listings: { url: string; pricePhp: number }[], note = "Like-new iPhone 13 listings.") => ({ listings, note })

console.log("price levels (the Baylo rule)")
{
  let ordered = true
  for (const [cat, c] of Object.entries(PRICE_CUTOFFS_PHP)) {
    if (!(c[0] > 0 && c[0] < c[1] && c[1] < c[2])) { ordered = false; console.log("   bad cut-offs:", cat, c) }
  }
  check("every category has three increasing cut-offs", ordered)
  check("all 19 categories have cut-offs", Object.keys(PRICE_CUTOFFS_PHP).length === Object.keys(CATEGORY_BANDS).length)
  check("₱1,999 is Low for electronics", levelOf("ELECTRONICS", 1999) === 0)
  check("₱2,000 (on the cut-off) is Typical", levelOf("ELECTRONICS", 2000) === 1)
  check("₱23,000 is High", levelOf("ELECTRONICS", 23000) === 2)
  check("₱25,000 is Premium", levelOf("ELECTRONICS", 25000) === 3)
  check("same ₱23,000 is Premium for books", levelOf("BOOKS", 23000) === 3)
  check("High in 120-4,800 is 3,396", leavesForLevel(2, range) === 3396, leavesForLevel(2, range))
  check("levels are 822 / 1,992 / 3,396 / 4,332",
    [0, 1, 2, 3].map((i) => leavesForLevel(i as 0 | 1 | 2 | 3, range)).join() === "822,1992,3396,4332")
  check("a one-point range gives that point", leavesForLevel(3, { min: 50, max: 50 }) === 50)
  check("never below 1", leavesForLevel(0, { min: 1, max: 1 }) === 1)
  check("median of odd count", medianPhp([25000, 21000, 23000]) === 23000)
  check("median of even count rounds", medianPhp([100, 201]) === 151)
  check("median of none is null", medianPhp([]) === null)
}

console.log("parsing Claude's answer")
{
  const a = parseAiValuationAnswer(
    'Here you go:\n{"listings":[{"url":"https://shop.example.ph/iphone-13","pricePhp":21000}],"note":"x"}',
  )
  check("JSON inside surrounding prose is read", a?.listings[0]?.pricePhp === 21000, a)
  check("note is optional", parseAiValuationAnswer('{"listings":[]}')?.note === "")
  check("no JSON -> null", parseAiValuationAnswer("I could not find anything.") === null)
  check("broken JSON -> null", parseAiValuationAnswer('{"listings": [') === null)
  check("wrong types -> null", parseAiValuationAnswer('{"listings":[{"url":1,"pricePhp":"cheap"}]}') === null)
}

console.log("listings")
{
  const two = verifiedListings([L(results[0].url, 21000), L(results[1].url, 23000)], results)
  check("two real search results verify, with titles from the search", two.length === 2 && two[0].title === "iPhone 13 128GB", two)
  const invented = verifiedListings([L("https://made-up.example.net/fake", 100), L(results[0].url, 21000)], results)
  check("a URL not returned by the search tool is dropped", invented.length === 1 && invented[0].url.includes("shop."), invented)
  check("http:// is dropped even if it was a search result", verifiedListings([L("http://insecure.example.com/x", 5)], results).length === 0)
  check("javascript: and junk are dropped", verifiedListings([L("javascript:alert(1)", 5), L("not a url", 5)], results).length === 0)
  check("duplicates collapse (first price kept)",
    verifiedListings([L(results[0].url, 21000), L(results[0].url, 99000)], results).map((x) => x.pricePhp).join() === "21000")
  check("zero, negative, NaN and absurd prices are dropped",
    verifiedListings([L(results[0].url, 0), L(results[1].url, -5), L(results[2].url, NaN), L(results[3].url, 99_000_000)], results).length === 0)
  check("same page with tracking query / trailing slash / www. still verifies",
    verifiedListings([L("https://www.shop.example.ph/iphone-13/?sp_atk=abc#top", 21000)], results)[0]?.url === results[0].url)
  check("the search tool's URL is kept, not Claude's spelling",
    verifiedListings([L("https://m.market.example.com/listing/42?ref=x", 23000)], results)[0]?.url === results[1].url)
  check("a different path on the same host is still dropped",
    verifiedListings([L("https://shop.example.ph/iphone-14", 21000)], results).length === 0)
  check("fractional pesos are rounded", verifiedListings([L(results[0].url, 20999.6)], results)[0]?.pricePhp === 21000)
}

console.log("deciding on the answer")
{
  const listings = verifiedListings([L(results[0].url, 21000), L(results[1].url, 23000), L(results[2].url, 24999)], results)
  const ok = decideAiValuation(answer([]), listings, "ELECTRONICS", range)
  check("median ₱23,000 -> 23,000 Leaves (1 Leaf = ₱1)", ok.ok && ok.market.typicalPhp === 23000 && ok.suggestedLeaves === 23000, ok)
  check("the level is still reported for older clients", ok.ok && ok.level.name === "High")
  check("price summary is low/high/count", ok.ok && ok.market.lowPhp === 21000 && ok.market.highPhp === 24999 && ok.market.listingCount === 3)
  check("level table is returned for the track", ok.ok && ok.table.levels.length === 4 && ok.table.cutoffsPhp.join() === "2000,8000,25000")

  const again = decideAiValuation(answer([], "different words"), listings, "ELECTRONICS", range)
  check("same prices give the same Leaves whatever Claude writes", again.ok && ok.ok && again.suggestedLeaves === ok.suggestedLeaves)

  const four = verifiedListings(results.slice(0, 4).map((r, i) => L(r.url, 20000 + i * 1000)), results)
  const capped = decideAiValuation(answer([]), four, "ELECTRONICS", range)
  check("all 4 feed the median, 3 are shown", capped.ok && capped.market.listingCount === 4 && capped.sources.length === 3, capped)

  check("1 verified listing -> INSUFFICIENT_SOURCES", (() => { const r = decideAiValuation(answer([]), listings.slice(0, 1), "ELECTRONICS", range); return !r.ok && r.reason === "INSUFFICIENT_SOURCES" })())
  check("none -> INSUFFICIENT_SOURCES", (() => { const r = decideAiValuation(answer([]), [], "ELECTRONICS", range); return !r.ok && r.reason === "INSUFFICIENT_SOURCES" })())
  check("unreadable answer -> INVALID_AI_RESPONSE", (() => { const r = decideAiValuation(null, listings, "ELECTRONICS", range); return !r.ok && r.reason === "INVALID_AI_RESPONSE" })())

  // 1 Leaf = ₱1: the suggestion is the median price, whatever the category or
  // condition, and the slider band drawn around it always contains it.
  let onePeso = true
  for (const cat of Object.keys(PRICE_CUTOFFS_PHP)) {
    for (const cond of ["NEW", "LIKE_NEW", "GOOD", "FAIR", "POOR"]) {
      const v = valueItem({ category: cat, condition: cond, comparables: [] })
      for (const price of [1, 150, 999, 5000, 50000, 9_000_000]) {
        const d = decideAiValuation(answer([]), [
          { url: "https://a.example/1", title: "a", pricePhp: price },
          { url: "https://b.example/2", title: "b", pricePhp: price },
        ], cat, { min: v.min, max: v.max })
        const band = d.ok ? overrideBounds(d.suggestedLeaves) : null
        if (!d.ok || d.suggestedLeaves !== price || !band || d.suggestedLeaves < band.min || d.suggestedLeaves > band.max) { onePeso = false; console.log("   off:", cat, cond, price, d) }
      }
    }
  }
  check("every category x condition x price: Leaves = pesos, inside its own band", onePeso)
}

console.log("tickets")
{
  const claims = {
    userId: "user_1",
    title: "iPhone 13  128GB",
    category: "ELECTRONICS",
    condition: "GOOD",
    suggestedLeaves: 2400,
    min: 100,
    max: 4000,
  }
  const expect = { userId: "user_1", title: "iphone 13 128gb", category: "ELECTRONICS", condition: "GOOD" }
  const t = issueTicket(claims, NOW, SECRET)!
  check("issued with a secret", !!t)
  check("no secret -> no ticket", issueTicket(claims, NOW, "") === null)

  const v = verifyTicket(t.ticket, expect, NOW + 1000, SECRET)
  check("round-trips; title match ignores case and spacing", v.ok && v.suggestedLeaves === 2400 && v.min === 100 && v.max === 4000, v)

  const expired = verifyTicket(t.ticket, expect, NOW + AI_TICKET_TTL_MS + 1, SECRET)
  check("expired -> EXPIRED", !expired.ok && expired.reason === "EXPIRED", expired)

  const other = verifyTicket(t.ticket, { ...expect, userId: "user_2" }, NOW, SECRET)
  check("someone else's ticket -> WRONG_USER", !other.ok && other.reason === "WRONG_USER", other)

  const retitled = verifyTicket(t.ticket, { ...expect, title: "phone case" }, NOW, SECRET)
  check("different title -> MISMATCH", !retitled.ok && retitled.reason === "MISMATCH", retitled)
  const recat = verifyTicket(t.ticket, { ...expect, category: "GAMING" }, NOW, SECRET)
  check("different category -> MISMATCH", !recat.ok && recat.reason === "MISMATCH", recat)
  const recond = verifyTicket(t.ticket, { ...expect, condition: "NEW" }, NOW, SECRET)
  check("different condition -> MISMATCH", !recond.ok && recond.reason === "MISMATCH", recond)

  const wrongKey = verifyTicket(t.ticket, expect, NOW, "another-secret")
  check("signed with another secret -> BAD_SIGNATURE", !wrongKey.ok && wrongKey.reason === "BAD_SIGNATURE", wrongKey)

  // Raise the number inside the ticket and keep the old signature.
  const [body, sig] = t.ticket.split(".")
  const raised = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
  raised.s = 4000
  const forged = `${Buffer.from(JSON.stringify(raised)).toString("base64url")}.${sig}`
  const f = verifyTicket(forged, expect, NOW, SECRET)
  check("edited value with the old signature -> BAD_SIGNATURE", !f.ok && f.reason === "BAD_SIGNATURE", f)

  check("garbage -> MALFORMED", (() => { const r = verifyTicket("nope", expect, NOW, SECRET); return !r.ok && r.reason === "MALFORMED" })())
  check("unset secret verifies nothing", !verifyTicket(t.ticket, expect, NOW, "").ok)
}

console.log("bracket rules on an AI suggestion (server-side)")
{
  const suggested = 2400
  const ai = {
    suggestedLeaves: suggested,
    min: 100,
    max: 4000,
    valuationSource: AI_VALUATION_SOURCE,
    sampleSize: 0,
    allowed: overrideBounds(suggested),
  }
  const none = judgeValue(ai, null)
  check(
    "no value -> the AI suggestion stands, source ai_market, not user-set",
    none.decision === "suggested" && none.data.valueLeaves === suggested &&
      none.data.suggestedLeaves === suggested && none.data.valuationSource === "ai_market" &&
      none.data.valueSetByUser === false,
    none,
  )
  const lower = judgeValue(ai, 300)
  check("lower -> allowed, user-set, live", lower.decision === "lowered" && !lower.needsReview && lower.data.valueSetByUser, lower)

  const cap = valueCap(suggested)
  const withinCap = cap.maxValueWithoutReview ?? suggested
  const raised = judgeValue(ai, withinCap)
  check(
    `raise to the cap (${withinCap}, bracket ${bracketOf(withinCap)}) -> live`,
    raised.decision === "raisedWithinCap" && !raised.needsReview,
    raised,
  )
  if (cap.maxValueWithoutReview !== null) {
    const over = judgeValue(ai, cap.maxValueWithoutReview + 1)
    check("one Leaf past the cap -> needs review", over.decision === "needsReview" && over.needsReview, over)
  }
  check(
    "the bracket follows the AI number, not the standard one",
    judgeValue(ai, null).cap.suggestedBracket === bracketOf(suggested),
  )

  // The standard path is untouched: the same function on valueItem()'s output.
  const standard = valueItem({ category: "ELECTRONICS", condition: "GOOD", comparables: [] })
  const std = judgeValue(standard, null)
  check(
    "standard path still records its own source",
    std.data.valuationSource === "category_band" && std.data.suggestedLeaves === standard.suggestedLeaves,
    std,
  )
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
