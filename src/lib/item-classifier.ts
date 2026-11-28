/**
 * What is in a listing photo: its CATEGORY, with confidence, and a plain item
 * name to start from (29 Nov 2026). Server-only. Replaces the paid vision call
 * behind /api/ai/identify; the panel asked for categorisation done by the
 * system.
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 *
 * CLIP ViT-B/32 (OpenAI, open-source) turns the photo into 512 numbers in the
 * same space as text. Two readings of those numbers are averaged:
 *   - a logistic-regression classifier TRAINED ON BAYLO'S OWN LISTING PHOTOS
 *     (19 categories), and
 *   - zero-shot matching against a sentence per category ("a photo of a bag,
 *     backpack or luggage"), which carries it for things the listings have
 *     few examples of.
 * Cross-validated on 218 listing photos, through this exact pipeline (quantised
 * model, sharp, onnxruntime-web): the first guess is right 69.7% of the time
 * and the right category is in the top three 84.9% of the time. So the app
 * shows the top three with their confidence and the person confirms or picks.
 *
 * The NAME is the closest of about 160 generic item names ("electric fan",
 * "backpack"); it shares a word with the real title about half the time, so
 * it is a starting point the person edits, never a claim.
 *
 * Weights: models/category-model.json (in git, 2 MB). Vision model:
 * models/clip-vision-q.onnx (downloaded at build, checksum-verified by
 * scripts/fetch-models.mjs). Retrain with the ml/ notebook as listings grow.
 */

import path from "node:path"
import { existsSync, readFileSync } from "node:fs"
import sharp from "sharp"

const MODEL = path.join(process.cwd(), "models", "clip-vision-q.onnx")
const WEIGHTS = path.join(process.cwd(), "models", "category-model.json")
const MEAN = [0.48145466, 0.4578275, 0.40821073]
const STD = [0.26862954, 0.26130258, 0.27577711]

interface Weights {
  cats: string[]
  photo_weight: number
  lr_coef: number[][]
  lr_intercept: number[]
  zs_text: number[][]
  names: string[]
  name_cats: string[]
  name_text: number[][]
}

type Ort = typeof import("onnxruntime-web")
type Session = import("onnxruntime-web").InferenceSession
let loaded: Promise<{ ort: Ort; s: Session; w: Weights } | null> | null = null

function load() {
  if (!loaded) {
    loaded = (async () => {
      if (!existsSync(MODEL) || !existsSync(WEIGHTS)) {
        console.warn("[classifier] model files missing (run npm run models); photo identification is unavailable")
        return null
      }
      const ort = (await import("onnxruntime-web")) as Ort
      ort.env.wasm.numThreads = 1
      const s = await ort.InferenceSession.create(MODEL, { executionProviders: ["wasm"] })
      const w = JSON.parse(readFileSync(WEIGHTS, "utf8")) as Weights
      return { ort, s, w }
    })().catch((err) => {
      console.error("[classifier] could not load:", err)
      loaded = null
      return null
    })
  }
  return loaded
}

/** CLIP's preprocessing: short side to 224 (bicubic), centre crop 224, CLIP mean/std. Two passes: sharp applies one resize per pipeline. */
async function pixels(image: Buffer): Promise<Float32Array> {
  const scaled = await sharp(image).rotate().removeAlpha().resize(224, 224, { fit: "outside", kernel: "cubic" }).toBuffer({ resolveWithObject: true })
  const { width, height } = scaled.info
  const { data } = await sharp(scaled.data)
    .extract({ left: Math.floor((width - 224) / 2), top: Math.floor((height - 224) / 2), width: 224, height: 224 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const out = new Float32Array(3 * 224 * 224)
  for (let i = 0; i < 224 * 224; i++) {
    for (let c = 0; c < 3; c++) out[c * 224 * 224 + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c]
  }
  return out
}

const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, x, i) => s + x * b[i], 0)
function softmax(z: number[]): number[] {
  const m = Math.max(...z)
  const e = z.map((x) => Math.exp(x - m))
  const t = e.reduce((a, b) => a + b, 0)
  return e.map((x) => x / t)
}

export interface Classification {
  category: string
  /** 0..1 */
  confidence: number
  /** Best three, highest first. */
  top3: { category: string; confidence: number }[]
  /** A generic item name to start the title from, e.g. "Electric fan". */
  name: string
}

/** The photo's category and a starting name; null when the model is unavailable. */
export async function classifyPhoto(image: Buffer): Promise<Classification | null> {
  const m = await load()
  if (!m) return null
  const out = await m.s.run({ [m.s.inputNames[0]]: new m.ort.Tensor("float32", await pixels(image), [1, 3, 224, 224]) })
  const raw = Array.from(out[m.s.outputNames[0]].data as Float32Array)
  const norm = Math.hypot(...raw) || 1
  const e = raw.map((x) => x / norm)

  const pLr = softmax(m.w.lr_coef.map((row, k) => dot(row, e) + m.w.lr_intercept[k]))
  const pZs = softmax(m.w.zs_text.map((t) => 100 * dot(t, e)))
  const p = pLr.map((x, k) => m.w.photo_weight * x + (1 - m.w.photo_weight) * pZs[k])
  const order = p.map((x, k) => [x, k] as const).sort((a, b) => b[0] - a[0])
  const top3 = order.slice(0, 3).map(([x, k]) => ({ category: m.w.cats[k], confidence: Math.round(x * 100) / 100 }))

  let bestName = 0
  let bestScore = -Infinity
  m.w.name_text.forEach((t, j) => {
    const s = dot(t, e)
    if (s > bestScore) { bestScore = s; bestName = j }
  })
  const n = m.w.names[bestName]
  return { category: top3[0].category, confidence: top3[0].confidence, top3, name: n.charAt(0).toUpperCase() + n.slice(1) }
}
