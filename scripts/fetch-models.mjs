// Downloads the open-source image models (29 Nov 2026): photo similarity and photo category.
//
//   node scripts/fetch-models.mjs        (run by `npm run build`; safe to re-run)
//
// DINOv2-small (Meta, Apache-2.0), the ONNX export published as
// Xenova/dinov2-small, PINNED to one commit and checked against its SHA-256,
// so every build runs exactly the model the thresholds were measured on. 88 MB,
// so it is fetched at build time instead of living in git. A file already
// present with the right checksum is kept.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const MODELS = [
  {
    file: "models/dinov2-small.onnx",
    url: "https://huggingface.co/Xenova/dinov2-small/resolve/c2bb04a51fab207c420665f1946016107bffc701/onnx/model.onnx",
    sha256: "83141175ec78b4ff9a2bb58a4c7c264ba0054d1c2e122e5a8114b79a8d4179ea",
  },
  // CLIP ViT-B/32 image half (OpenAI, MIT), quantised ONNX export, for the
  // category of a photo (@/lib/item-classifier). 89 MB.
  {
    file: "models/clip-vision-q.onnx",
    url: "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/6b7c523703ae26e39be4b03774966f8571c7f523/onnx/vision_model_quantized.onnx",
    sha256: "583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299",
  },
]

// fileURLToPath, not URL.pathname: on Windows the latter is "/D:/..." and
// path.resolve turns it into "D:\\D:\\...".
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sha = (buf) => createHash("sha256").update(buf).digest("hex")

for (const m of MODELS) {
  const dest = path.join(root, m.file)
  if (existsSync(dest) && sha(readFileSync(dest)) === m.sha256) {
    console.log(`[models] ${m.file} present and verified`)
    continue
  }
  mkdirSync(path.dirname(dest), { recursive: true })
  console.log(`[models] downloading ${m.file} ...`)
  const res = await fetch(m.url)
  if (!res.ok) throw new Error(`[models] ${m.url} answered ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = sha(buf)
  if (got !== m.sha256) throw new Error(`[models] checksum mismatch for ${m.file}: ${got}`)
  writeFileSync(`${dest}.part`, buf)
  renameSync(`${dest}.part`, dest)
  console.log(`[models] ${m.file} verified (${(buf.length / 1e6).toFixed(1)} MB)`)
}
