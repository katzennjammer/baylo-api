export interface ImagePayload { type: string; url: string; caption?: string | null }
export interface VoicePayload { type: string; url: string; duration: number }

export interface OfferPayload {
  type: "offer"; offerId: string; postId: string;
  postItem: { title: string };
  offeredItems: { id: string; title: string; imageUrl?: string }[];
  offeredLeaves: number | null; userMessage: string | null;
  senderName: string; senderId?: string; status: string;
}

export interface OfferUpdatePayload {
  type: "offer_update"; offerId: string; tradeId?: string | null; status: string; actorName: string
}

export interface SharedPostPayload {
  type: string; postId: string; postItem: string; postUser: string;
  postType?: "offer" | "want" | "complete"; imageUrl?: string | null;
}

export type AnyMsgPayload =
  | OfferPayload | OfferUpdatePayload | SharedPostPayload
  | ImagePayload | VoicePayload
  | { type: string; [k: string]: unknown }

export function tryParseMsg(content: string): AnyMsgPayload | null {
  try {
    const p = JSON.parse(content)
    if (p && typeof p === "object" && p.type) return p as AnyMsgPayload
  } catch { /* plain text */ }
  return null
}

export function describeMessage(content: string): string {
  const payload = tryParseMsg(content)
  if (!payload) {
    const flat = content.replace(/\s+/g, " ").trim()
    return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
  }
  switch (payload.type) {
    case "offer": return "Sent a trade offer"
    case "offer_update": {
      const status = typeof (payload as { status?: unknown }).status === "string" ? (payload as { status: string }).status.toLowerCase() : "updated"
      return status === "accepted" ? "Offer accepted" : status === "declined" ? "Offer declined" : "Offer updated"
    }
    case "trade_completed": return "Trade completed"
    case "image": return "Sent an image"
    case "voice": return "Sent a voice message"
    case "shared_post": return "Shared a listing"
    default: return "Sent a message"
  }
}

export function classifyUploadError(status: number, serverMsg?: string): string {
  if (status === 413) return serverMsg || "File too large"
  if (status === 415) return "Unsupported file format"
  if (status === 401) return "Session expired — please refresh the page"
  if (status === 0 || status >= 500) return "Server error"
  return serverMsg || "Upload failed"
}

export function fmtDur(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
}

export async function uploadChatImage(file: File): Promise<string> {
  const fd = new FormData()
  fd.append("file", file)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch("/api/upload", { method: "POST", body: fd, signal: controller.signal })
    clearTimeout(timeoutId)
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(classifyUploadError(res.status, body.error))
    }
    const { url } = await res.json() as { url: string }
    return url
  } catch (err) {
    clearTimeout(timeoutId)
    if (err instanceof DOMException && err.name === "AbortError") throw new Error("Upload timed out")
    if (err instanceof Error) throw err
    throw new Error("Network error")
  }
}
