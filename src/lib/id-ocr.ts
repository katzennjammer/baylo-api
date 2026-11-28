/**
 * Reads an ID photo: sharpness and text (28 Nov 2026). Server-only.
 *
 * OCR is Tesseract (tesseract.js, Apache-2.0), an open-source model that runs
 * inside this server process. No paid API and no third party sees the ID. The
 * English model ships in the deployment (@tesseract.js-data/eng, "best_int",
 * about 3 MB), so nothing is downloaded at request time.
 *
 * One Tesseract worker is kept per server instance and reused; the first ID
 * after a cold start pays a second or two to load it.
 *
 * Sharpness is the variance of the Laplacian (an edge filter) on a greyscale
 * copy 1000 px wide: a sharp photo has strong edges, so a high variance; a
 * blurred one does not. The threshold lives in @/lib/id-auto-check.
 */

import path from "node:path"
import sharp from "sharp"
import { PSM, createWorker, type Worker } from "tesseract.js"

/** Fewer characters than this on the first pass triggers the sparse-text pass. */
const SPARSE_RETRY_CHARS = 120

const LANG_DIR = path.join(process.cwd(), "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int")

let workerPromise: Promise<Worker> | null = null

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker("eng", 1, {
      langPath: LANG_DIR,
      gzip: true,
      cacheMethod: "none",
    }).catch((err) => {
      workerPromise = null
      throw err
    })
  }
  return workerPromise
}

/** Variance of the Laplacian on a 1000 px greyscale copy. */
export async function measureSharpness(image: Buffer): Promise<number> {
  const { data, info } = await sharp(image)
    .rotate()
    .greyscale()
    .resize({ width: 1000, withoutEnlargement: false })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  let sum = 0
  let sumSq = 0
  let n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const v = data[i - w] + data[i + w] + data[i - 1] + data[i + 1] - 4 * data[i]
      sum += v
      sumSq += v * v
      n++
    }
  }
  const mean = sum / n
  return sumSq / n - mean * mean
}

export interface OcrResult {
  text: string
  /** Mean word confidence, 0..100. */
  confidence: number
  ms: number
}

/**
 * Text on the photo. The image is straightened by its EXIF orientation,
 * turned grey, contrast-stretched and sized to about 2000 px wide, which is
 * where Tesseract reads card-sized print best.
 */
export async function readIdText(image: Buffer): Promise<OcrResult> {
  const t0 = Date.now()
  const prepared = await sharp(image)
    .rotate()
    .greyscale()
    .normalise()
    .resize({ width: 2000, withoutEnlargement: false })
    .png()
    .toBuffer()
  const worker = await getWorker()
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK })
  const first = await worker.recognize(prepared)
  let text = first.data.text ?? ""
  let confidence = first.data.confidence ?? 0
  // A card read as only a few words usually means the layout analysis lost a
  // block. A second pass in "sparse text" mode finds scattered words; the two
  // readings are joined, and the better confidence is kept.
  if (text.replace(/[^A-Za-z0-9]/g, "").length < SPARSE_RETRY_CHARS) {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT })
    const second = await worker.recognize(prepared)
    text = `${text}\n${second.data.text ?? ""}`
    confidence = Math.max(confidence, second.data.confidence ?? 0)
  }
  return { text, confidence, ms: Date.now() - t0 }
}
