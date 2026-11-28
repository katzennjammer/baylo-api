/**
 * Photo embeddings for the similar-photo check (29 Nov 2026). Server-only.
 *
 * DINOv2-small (open-source, Meta) turns a photo into 384 numbers that describe
 * what is in it; two photos of the same thing land close together even after
 * cropping, filters, recompression or (less strongly) a new angle. Runs inside
 * this server with onnxruntime-web (WebAssembly): no paid API, nothing leaves
 * Baylo, about 0.3 s a photo after a 0.6 s load per server instance.
 *
 * The model file is downloaded and checksum-verified at build time
 * (scripts/fetch-models.mjs). If it is missing the functions here return null
 * and callers fall back to the pixel-hash check alone.
 *
 * ── FROM SIMILARITY TO A CONFIDENCE ─────────────────────────────────────────
 *
 * Cosine similarity is turned into "how sure are we this is a re-used photo"
 * by a logistic curve fitted on Baylo's own photos (ml notebook, 28 Nov 2026):
 * pairs of a photo and an edited copy of it (crop, brightness, contrast,
 * mirror, JPEG) against pairs of different listings. AUC 0.9998.
 *   confidence = 1 / (1 + e^-(16.89 x cosine - 11.70))
 *   95% ⇔ cosine 0.867, 80% ⇔ cosine 0.775
 * Re-measured on THIS pipeline (sharp + onnxruntime-web, 29 Nov 2026), on the
 * same 1,725 photos: at 95% (cosine 0.867) about 0.013% of pairs of different
 * listings match, while 83% of lightly and 62% of heavily edited copies are
 * caught; at 80% (cosine 0.775) about 0.04% of different pairs, 94% / 88% of
 * edited copies. The few "different" pairs that high are demo listings sharing
 * one stock photo under different titles, so the true rate is lower still.
 *
 * ── SAME ITEM, ANOTHER ANGLE ────────────────────────────────────────────────
 *
 * Measured on COIL-100 (100 objects photographed every 5° on a turntable)
 * against different Baylo listings: at cosine 0.70 a new photo of the same
 * object 30° round is caught 93% of the time (90° round: 82%), while 0.07% of
 * pairs of different Baylo listings reach it. Same numbers on this pipeline. Used only against the SAME
 * owner's listings, where there are few candidates, and only to WARN: a shop
 * can honestly sell two identical items.
 */

import path from "node:path"
import { existsSync } from "node:fs"
import sharp from "sharp"

export const EMBEDDING_DIM = 384
export const SIMILARITY_LOGIT = { coef: 16.89, intercept: -11.7 }
/** Block another trader's photo at or above this confidence. */
export const BLOCK_CONFIDENCE = 0.95
/** At or above this, allow but say "X% similar to another listing". */
export const NOTE_CONFIDENCE = 0.8
/** Own active listing at or above this cosine: "is this the same item?" */
export const SAME_ITEM_OWN_COSINE = 0.7

const MODEL = path.join(process.cwd(), "models", "dinov2-small.onnx")

type Ort = typeof import("onnxruntime-web")
type Session = import("onnxruntime-web").InferenceSession
let session: Promise<{ ort: Ort; s: Session } | null> | null = null

function getSession() {
  if (!session) {
    session = (async () => {
      if (!existsSync(MODEL)) {
        console.warn(`[embedding] ${MODEL} is missing (run npm run models); similar-photo check falls back to the pixel hash`)
        return null
      }
      const ort = (await import("onnxruntime-web")) as Ort
      ort.env.wasm.numThreads = 1
      const s = await ort.InferenceSession.create(MODEL, { executionProviders: ["wasm"] })
      return { ort, s }
    })().catch((err) => {
      console.error("[embedding] could not load the model:", err)
      session = null
      return null
    })
  }
  return session
}

/**
 * Resize the short side to 256 (bicubic), centre-crop 224, ImageNet-normalise:
 * DINOv2's own preprocessing. Two sharp passes, because sharp applies only the
 * LAST resize in one pipeline.
 */
async function pixels(image: Buffer): Promise<Float32Array> {
  const scaled = await sharp(image)
    .rotate()
    .removeAlpha()
    .resize(256, 256, { fit: "outside", kernel: "cubic" })
    .toBuffer({ resolveWithObject: true })
  const { width, height } = scaled.info
  const { data } = await sharp(scaled.data)
    .extract({ left: Math.floor((width - 224) / 2), top: Math.floor((height - 224) / 2), width: 224, height: 224 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]
  const out = new Float32Array(3 * 224 * 224)
  for (let i = 0; i < 224 * 224; i++) {
    for (let c = 0; c < 3; c++) out[c * 224 * 224 + i] = (data[i * 3 + c] / 255 - mean[c]) / std[c]
  }
  return out
}

/** The photo's 384-number embedding, unit length; null when the model is unavailable. */
export async function embedImage(image: Buffer): Promise<number[] | null> {
  const loaded = await getSession()
  if (!loaded) return null
  const input = new loaded.ort.Tensor("float32", await pixels(image), [1, 3, 224, 224])
  const out = await loaded.s.run({ [loaded.s.inputNames[0]]: input })
  const hidden = out[loaded.s.outputNames[0]].data as Float32Array // [1, 257, 384]: token 0 is the CLS summary
  const v = Array.from(hidden.subarray(0, EMBEDDING_DIM))
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / norm)
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Calibrated confidence (0..1) that two photos are the same photo, from their cosine. */
export function reuseConfidence(cos: number): number {
  return 1 / (1 + Math.exp(-(SIMILARITY_LOGIT.coef * cos + SIMILARITY_LOGIT.intercept)))
}
