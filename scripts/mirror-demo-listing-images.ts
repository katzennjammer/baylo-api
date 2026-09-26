// Copies each demo listing photo from Wikimedia Commons into Baylo's own
// Cloudinary, and writes the copy's URL into scripts/lib/demo-listing-images.json
// as `url` -- the only URL seed-demo-population.ts will show.
//
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/mirror-demo-listing-images.ts
//
// Touches NO database. Writes to Cloudinary only, under ONE folder:
//
//     baylo/demo-listings/<slug-of-title>     tagged `baylo-demo`
//
// so the whole set is recognisable and deletable in bulk (by prefix or tag)
// without going near a real user's upload, which live under `baylo/` directly.
//
// ── WHY MIRROR AT ALL ───────────────────────────────────────────────────────
//
// On 25 Sep 2026, preparing a thesis-panel demo: live.staticflickr.com timed out
// from the demo laptop, and upload.wikimedia.org answered 145 of 150 thumbnail
// requests with 429 (robot policy). The demo phone reaches the internet through
// that laptop's hotspot, so a hotlinked feed would have been a grid of broken
// tiles. Real listings are served from Cloudinary; demo listings now are too.
//
// ── HOW, WITHOUT THIS MACHINE DOWNLOADING ANYTHING ─────────────────────────
//
// The upload is given the Commons URL, not bytes: Cloudinary's servers fetch
// it. Nothing is downloaded from this IP, which is the one Wikimedia limited.
// An incoming transformation caps the STORED copy at 1000 px wide, so a 20 MB
// Commons original never sits in the account at full size.
//
// Source order per photo: the 960 px Commons thumbnail (a standard step, and
// small enough for any plan's upload limit), then the original if the file is
// narrower than 960 (Commons refuses to upscale), then the 500 px thumbnail.
//
// Idempotent: an entry that already has a Cloudinary `url` is skipped. The
// JSON is saved after EVERY upload, so an interrupted run resumes.

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { v2 as cloudinary } from "cloudinary"

const FILE = resolve(__dirname, "lib/demo-listing-images.json")
const FOLDER = "baylo/demo-listings"
const TAG = "baylo-demo"

type Entry = { sourceUrl: string; url?: string } & Record<string, unknown>

/** "iPhone 12, 128GB, blue" -> "iphone-12-128gb-blue" */
const slug = (t: string) =>
  t.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 80)

function candidates(sourceUrl: string): string[] {
  const m = sourceUrl.match(/^(.*)\/thumb\/(\w\/\w\w\/[^/]+)\/500px-[^/]+$/)
  if (!m) return [sourceUrl]
  const [, base, path] = m
  const name = path.split("/").pop()!
  return [`${base}/thumb/${path}/960px-${name}`, `${base}/${path}`, sourceUrl]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  for (const k of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) {
    if (!process.env[k]) throw new Error(`${k} is not set -- run with --env-file=.env`)
  }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  })

  const map: Record<string, Entry> = JSON.parse(readFileSync(FILE, "utf8"))
  const slugs = Object.keys(map).map(slug)
  const clash = slugs.filter((s, i) => slugs.indexOf(s) !== i)
  if (clash.length) throw new Error(`two titles share a public id: ${clash.join(", ")}`)

  let done = 0
  const failed: string[] = []
  for (const [title, e] of Object.entries(map)) {
    if (e.url?.includes("res.cloudinary.com")) continue
    let ok = false
    let lastErr = ""
    for (const src of candidates(e.sourceUrl)) {
      try {
        const r = await cloudinary.uploader.upload(src, {
          folder: FOLDER,
          public_id: slug(title),
          overwrite: true,
          resource_type: "image",
          tags: [TAG],
          transformation: [{ width: 1000, crop: "limit" }],
        })
        e.url = r.secure_url
        writeFileSync(FILE, JSON.stringify(map, null, 2) + "\n")
        console.log(`  ${title.padEnd(44).slice(0, 44)}  ${r.width}x${r.height}  ${Math.round(r.bytes / 1024)} KB`)
        ok = true
        done++
        break
      } catch (err: any) {
        lastErr = err?.error?.message ?? err?.message ?? String(err)
      }
    }
    if (!ok) failed.push(`${title}: ${lastErr}`)
    await sleep(700)
  }

  const mirrored = Object.values(map).filter((e) => e.url?.includes("res.cloudinary.com")).length
  console.log(`\n  ${done} uploaded this run; ${mirrored}/${Object.keys(map).length} mirrored into ${FOLDER}`)
  if (failed.length) console.log(`  FAILED:\n    ${failed.join("\n    ")}`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
