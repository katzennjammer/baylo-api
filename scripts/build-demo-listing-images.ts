// Finds ONE PHOTO PER DEMO LISTING, matched to its title, and writes them to
// scripts/lib/demo-listing-images.json for seed-demo-population.ts to read.
//
//   npx tsx --tsconfig tsconfig.json scripts/build-demo-listing-images.ts                 # fill in missing titles
//   npx tsx --tsconfig tsconfig.json scripts/build-demo-listing-images.ts --redo "Title"  # re-search one title
//
// Touches NO database -- it only reads the catalogue and writes a JSON file, so
// it needs no live-guard. It is a build step, run by hand; the seed itself
// never goes to the network.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// The first seed used CATEGORY_IMAGES, which is the art behind the Explore
// Categories tiles: ONE mood photo per category. So all ~40 FOOD listings
// showed the same plate, and most photos were not the object at all -- a
// clothing-store interior on a rice cooker, Spider-Man figures on a Hot Wheels
// lot. Not an indexing bug: the pool was the wrong kind of image.
//
// ── WHERE THE PHOTOS COME FROM ──────────────────────────────────────────────
//
// Openverse (api.openverse.org), the keyless public search over openly
// licensed images, taking FLICKR (and the smaller CC0 stock sources) and NOT
// Wikimedia Commons. Commons is an encyclopaedia's library, not product shots
// -- "brownies" found a Costa Rican bird, "vintage denim" an actor at Cannes --
// and on 25 Sep 2026 it answered both this laptop and Cloudinary's fetcher
// with 429s. Flickr is unreachable from the demo laptop's network, which does
// not matter: this machine never downloads a photo (see the mirror script).
// ONLY licences that permit reuse, including commercial: CC0, public domain,
// CC BY, CC BY-SA. Each entry keeps its creator, licence and landing page, so
// the attribution BY and BY-SA require is on record next to the URL.
//
// No photo is used twice. The first unused result wins, and a hand-written
// query in QUERY_OVERRIDES replaces the derived one where the title's own
// words find the wrong thing ("Kindle" is also a verb).
//
// NOTHING HERE IS SHOWN IN THE APP DIRECTLY. The phone must not hotlink
// Commons: on 25 Sep 2026 Wikimedia answered 145 of 150 thumbnail requests
// from the demo laptop with 429 (robot policy), and the phone shares that IP
// through the hotspot. mirror-demo-listing-images.ts copies each photo into
// Baylo's own Cloudinary and writes the copy's URL as `url`; the seed shows
// only that.
//
// Existing entries are KEPT on a re-run, so a reviewed, hand-fixed set is not
// silently replaced by whatever the search returns next week.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { ORGS, PERISHABLE, STANDARD } from "./lib/demo-population-catalogue"

const OUT = resolve(__dirname, "lib/demo-listing-images.json")
const LICENSES = "cc0,pdm,by,by-sa"

/** Title -> the search query, where the title's own words find the wrong photo. */
const QUERY_OVERRIDES: Record<string, string> = {
  "Canon EOS M50 with kit lens": "mirrorless camera",
  "PS4 Slim 500GB + 2 controllers": "PlayStation 4",
  "Yoga mat and blocks set": "yoga mat",
  "LEGO Classic bucket, 900 pcs": "lego bricks",
  "Pokemon cards binder, 200 cards": "pokemon cards",
  "Skincare bundle, unopened": "skincare products",
  "Board game bundle: Catan + Uno": "settlers of catan",
  "Vintage enamel soda sign": "coca-cola sign",
  "Hair dryer + straightener set": "hair dryer",
  "Raincoat and rain boots set": "rain boots",
  "Makeup palette bundle": "eyeshadow palette",
  "Tutoring: high-school math, 4 sessions": "math tutoring",
  "Palabok tray": "pancit palabok",
  "Strawberries from Dalaguete": "strawberries",
  "Okra and eggplant bundle": "okra",
  "Embroidered polo barong, M": "barong tagalog",
  "Refurbished ThinkPad T480": "thinkpad",
  "Harry Potter box set, paperback": "harry potter books",
  "Makita cordless drill": "cordless drill",
  "Acrylic paint set + canvases": "acrylic paint",
  "Programming books bundle": "programming books",
  "Kangkong bundles": "kangkong",
  "Adobo in a jar, 2 jars": "adobo",
  "Banana cake loaf": "banana bread",
  "Refurbished Android phone, Redmi Note 11": "redmi note",
  "Vintage denim bundle, 5 pcs": "jeans",
  "Yamaha acoustic guitar F310": "acoustic guitar",
  "Ripe Guimaras mangoes": "ripe mangoes",
  "Fresh pandesal, 30 pcs": "pandesal",
  "Sinigang vegetables kit": "sinigang",
  "Aircon cleaning, 1 unit": "air conditioner cleaning",
}

type Entry = {
  /** The Wikimedia Commons original. Credit and re-mirroring only -- NEVER displayed. */
  sourceUrl: string
  /** The Cloudinary copy, written by mirror-demo-listing-images.ts. The ONLY URL the seed shows. */
  url?: string
  query: string
  photoTitle: string
  creator: string | null
  license: string
  licenseUrl: string | null
  landing: string | null
  source: string
}

/** "iPhone 12, 128GB, blue" -> "iPhone 12". Words before the first comma, minus sizes and counts. */
function deriveQuery(title: string): string {
  return title
    .split(",")[0]
    .replace(/[():]/g, " ")
    .replace(/\b\d+(\.\d+)?\s*(pcs|kg|l|ml|gb|cu|ft|inch|x\d+kg|gallons)?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * A Commons original can be 20 MB; ask for the 500 px rendition instead.
 * Commons serves thumbnails only at its standard widths (an 800 px request is
 * a 400 "use thumbnail steps"); 500 is one, and ~30-60 KB keeps a feed quick
 * over a phone hotspot.
 */
function sized(url: string, source: string): string {
  const m = source === "wikimedia" && url.match(/^(https:\/\/upload\.wikimedia\.org\/wikipedia\/commons)\/(\w)\/(\w\w)\/(.+)$/)
  if (!m) return url
  const [, base, a, ab, name] = m
  const thumb = /\.(svg|tif|tiff)$/i.test(name) ? `${name}.png` : name
  return `${base}/thumb/${a}/${ab}/${name}/500px-${thumb}`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function search(q: string): Promise<any[]> {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license=${LICENSES}&source=flickr,stocksnap,wordpress&page_size=20&mature=false`
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": "baylo-demo-seed/1.0 (thesis demo; build-time only)" } })
    if (res.status === 429) { await sleep(30_000); continue }
    if (!res.ok) throw new Error(`openverse ${res.status} for "${q}"`)
    return ((await res.json()) as { results: any[] }).results
  }
  throw new Error(`openverse kept rate-limiting "${q}"`)
}

async function main() {
  const redoAt = process.argv.indexOf("--redo")
  const redo = redoAt > -1 ? process.argv[redoAt + 1] : null

  const titles = [...STANDARD, ...PERISHABLE, ...ORGS.flatMap((o) => o.items)].map((r) => r[0])
  const dupes = titles.filter((t, i) => titles.indexOf(t) !== i)
  if (dupes.length) throw new Error(`titles must be unique, they key the image map: ${dupes.join(", ")}`)

  const map: Record<string, Entry> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {}
  for (const k of Object.keys(map)) if (!titles.includes(k)) delete map[k] // listings that no longer exist
  if (redo) {
    if (!titles.includes(redo)) throw new Error(`no listing titled "${redo}"`)
    delete map[redo]
  }
  const used = new Set(Object.values(map).map((e) => e.sourceUrl))

  let found = 0
  const missing: string[] = []
  for (const title of titles) {
    if (map[title]) continue
    const query = QUERY_OVERRIDES[title] ?? deriveQuery(title)
    const results = await search(query)
    await sleep(1500) // anonymous Openverse is rate-limited; be a polite client
    const pick = results.find((r) =>
      r.source !== "wikimedia" &&
      (r.width ?? 0) >= 500 &&
      /\.(jpe?g|png)$/i.test(r.url ?? "") &&
      !used.has(sized(r.url, r.source)))
    if (!pick) { missing.push(`${title}  (query "${query}")`); continue }
    const url = sized(pick.url, pick.source)
    used.add(url)
    map[title] = {
      sourceUrl: url, query,
      photoTitle: pick.title ?? "",
      creator: pick.creator ?? null,
      license: `${pick.license}${pick.license_version ? " " + pick.license_version : ""}`,
      licenseUrl: pick.license_url ?? null,
      landing: pick.foreign_landing_url ?? null,
      source: pick.source,
    }
    found++
    console.log(`  ${title.padEnd(44).slice(0, 44)}  <- "${query}"  ${pick.source} ${pick.license}`)
  }

  // Stable order: catalogue order, so a diff of the file reads listing by listing.
  const ordered = Object.fromEntries(titles.filter((t) => map[t]).map((t) => [t, map[t]]))
  writeFileSync(OUT, JSON.stringify(ordered, null, 2) + "\n")
  console.log(`\n  ${found} found this run, ${Object.keys(ordered).length}/${titles.length} titles have a photo, ${new Set(Object.values(ordered).map((e) => e.sourceUrl)).size} distinct`)
  if (missing.length) console.log(`  NO PHOTO (will fall back to the category tile):\n    ${missing.join("\n    ")}`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
