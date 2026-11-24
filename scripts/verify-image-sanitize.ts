// sanitizeImage(): what an upload may be, decided from its bytes.
//
// No server, no database, no network -- it calls the function every image
// upload route uses (/api/upload, ID verification, organisation documents).
//
//   npx tsx scripts/verify-image-sanitize.ts

import sharp from "sharp"
import { sanitizeImage, sniffImageFormat } from "../src/lib/image-sanitize"

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}  ${JSON.stringify(detail)}`) }
}

async function refusal(input: Buffer): Promise<string> {
  try { await sanitizeImage(input); return "accepted" } catch (e) { return e instanceof Error ? e.message : String(e) }
}

async function main() {
  const base = sharp({ create: { width: 64, height: 48, channels: 3, background: "#3a7" } })

  // Accepted, and re-encoded to a concrete format.
  for (const [fmt, buf, out] of [
    ["jpeg", await base.clone().jpeg().toBuffer(), "jpeg"],
    ["png", await base.clone().png().toBuffer(), "png"],
    ["webp", await base.clone().webp().toBuffer(), "jpeg"],
    ["gif", await base.clone().gif().toBuffer(), "webp"],
  ] as const) {
    check(`${fmt}: sniffed as ${fmt}`, sniffImageFormat(buf) === fmt, sniffImageFormat(buf))
    const r = await sanitizeImage(buf).catch((e: Error) => e)
    check(`${fmt}: accepted, re-encoded to ${out}`, !(r instanceof Error) && r.format === out, r instanceof Error ? r.message : r.format)
  }

  // EXIF (GPS included) does not survive.
  const withExif = await base.clone().jpeg().withExif({ IFD0: { Copyright: "home address" } }).toBuffer()
  check("fixture really carries EXIF", !!(await sharp(withExif).metadata()).exif)
  const stripped = await sanitizeImage(withExif)
  check("EXIF stripped from the output", !(await sharp(stripped.buffer).metadata()).exif)

  // Refused BEFORE sharp parses anything: no longer on the allow-list.
  const tiff = await base.clone().tiff().toBuffer()
  const avif = await base.clone().avif().toBuffer()
  check("tiff: not sniffed", sniffImageFormat(tiff) === null)
  check("tiff: refused", (await refusal(tiff)) === "unsupported_format", await refusal(tiff))
  check("avif: not sniffed", sniffImageFormat(avif) === null)
  check("avif: refused", (await refusal(avif)) === "unsupported_format", await refusal(avif))

  // HEIC: recognised, refused with its own reason (no HEVC decoder in sharp's
  // prebuilt libvips). A real HEIC's leading box, enough for the sniff.
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic\0\0\0\0mif1heic", "latin1"), Buffer.alloc(64)])
  check("heic: sniffed as heic", sniffImageFormat(heic) === "heic", sniffImageFormat(heic))
  check("heic: refused as heic_unsupported", (await refusal(heic)) === "heic_unsupported", await refusal(heic))
  // The other way phones write it: major brand mif1, heic only as compatible.
  const mif1 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmif1\0\0\0\0mif1heic", "latin1"), Buffer.alloc(64)])
  check("heic (mif1 major, heic compatible): sniffed as heic", sniffImageFormat(mif1) === "heic", sniffImageFormat(mif1))

  // Not images at all, whatever a client claims.
  check("a script refused", (await refusal(Buffer.from("<?php system($_GET['c']); ?>          "))) === "unsupported_format")
  check("an SVG refused", (await refusal(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))) === "unsupported_format")
  check("too short to sniff refused", (await refusal(Buffer.from([0xff, 0xd8]))) === "unsupported_format")

  // Right signature, garbage after it: sharp gets it, and refuses it.
  const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)])
  check("jpeg signature over garbage refused", (await refusal(fakeJpeg)) !== "accepted", await refusal(fakeJpeg))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
