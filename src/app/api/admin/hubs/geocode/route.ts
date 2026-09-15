import { NextRequest } from "next/server"
import { z } from "zod"
import { requireRole } from "@/lib/api-auth"
import { ok, invalid } from "@/lib/v1/envelope"
import { parseQuery } from "@/lib/v1/query"
import { enforceRateLimit } from "@/lib/rate-limit-config"

export const dynamic = "force-dynamic"

const querySchema = z.strictObject({
  q: z.string().trim().min(3).max(240),
})

interface NominatimResult {
  place_id: number
  display_name: string
  lat: string
  lon: string
  type?: string
  category?: string
  importance?: number
  address?: {
    road?: string
    house_number?: string
    neighbourhood?: string
    suburb?: string
    city?: string
    town?: string
    municipality?: string
    state?: string
    country?: string
  }
}

export async function GET(req: NextRequest) {
  const gate = await requireRole("MODERATOR")
  if (gate.response) return gate.response

  const limited = enforceRateLimit("hubGeocode", gate.actor.id)
  if (limited) return limited

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response

  const url = new URL("https://nominatim.openstreetmap.org/search")
  url.searchParams.set("q", parsed.data.q)
  url.searchParams.set("format", "jsonv2")
  url.searchParams.set("addressdetails", "1")
  url.searchParams.set("limit", "5")
  url.searchParams.set("countrycodes", "ph")

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Baylo-admin-hub-geocoder/1.0 (admin contact configured in deployment)",
      },
      signal: controller.signal,
      cache: "no-store",
    })

    if (!response.ok) {
      return invalid("The location service did not respond. Try again or enter coordinates manually.")
    }

    const results = (await response.json()) as NominatimResult[]
    const candidates = results
      .map((result) => ({
        id: String(result.place_id),
        label: result.display_name,
        latitude: Number(result.lat),
        longitude: Number(result.lon),
        type: result.type ?? result.category ?? "place",
        importance: result.importance ?? null,
        city:
          result.address?.city ??
          result.address?.town ??
          result.address?.municipality ??
          result.address?.suburb ??
          "",
        address: [
          result.address?.house_number,
          result.address?.road,
          result.address?.neighbourhood,
          result.address?.suburb,
        ]
          .filter(Boolean)
          .join(", "),
      }))
      .filter(
        (candidate) =>
          Number.isFinite(candidate.latitude) &&
          Number.isFinite(candidate.longitude) &&
          candidate.latitude >= 4 &&
          candidate.latitude <= 22 &&
          candidate.longitude >= 116 &&
          candidate.longitude <= 127,
      )

    return ok({ candidates })
  } catch {
    return invalid("The location search timed out. Try again or enter coordinates manually.")
  } finally {
    clearTimeout(timer)
  }
}
