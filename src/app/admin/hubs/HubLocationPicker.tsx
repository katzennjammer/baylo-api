"use client"

import { useEffect, useRef } from "react"
import type { Map as LeafletMap, Marker } from "leaflet"

interface Props {
  latitude: number
  longitude: number
  hubType: string
  isActive: boolean
  onChange: (latitude: number, longitude: number) => void
}

const DEFAULT_CENTER: [number, number] = [10.3157, 123.8854]
const DEFAULT_ZOOM = 12

const GLYPHS: Record<string, string> = {
  MALL: "M3 6.5 4.5 3h7L13 6.5M3 6.5V13h10V6.5M3 6.5h10M6.5 13V9.5h3V13",
  BARANGAY_HALL: "M2.5 6.5 8 3l5.5 3.5M4 7.5v4.5M6.5 7.5v4.5M9.5 7.5v4.5M12 7.5v4.5M3 13h10",
  POLICE_STATION: "M8 2.5 13 4.5v4c0 3.1-2.2 4.7-5 5.6-2.8-.9-5-2.5-5-5.6v-4L8 2.5Z",
  PUBLIC_PLAZA: "M8 2.5 4.5 8H7l-2.5 3.5h7L9 8h2.5L8 2.5ZM8 11.5V14",
  TRANSPORT_HUB: "M3.5 3.5h9V11h-9V3.5ZM3.5 7h9M5.5 11v1.5M10.5 11v1.5",
}

function markerHtml(hubType: string, isActive: boolean) {
  const body = isActive ? "#1B4D2B" : "#A8A69A"
  const disc = isActive ? "#FAFAF7" : "#F1EFE8"
  const glyph = isActive ? "#1B4D2B" : "#8C8A7E"
  const path = GLYPHS[hubType] ?? "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"

  return `<div class="admin-hub-marker" style="--marker-body:${body};--marker-disc:${disc};--marker-glyph:${glyph}"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="var(--marker-body)"/><circle cx="8" cy="8" r="5.5" fill="var(--marker-disc)"/><path d="${path}" fill="none" stroke="var(--marker-glyph)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`
}

export default function HubLocationPicker({ latitude, longitude, hubType, isActive, onChange }: Props) {
  const elementRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const hasCoordinates =
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    !(latitude === 0 && longitude === 0)
  const center: [number, number] = hasCoordinates ? [latitude, longitude] : DEFAULT_CENTER
  /**
   * The coordinates to initialize at, read at INIT TIME rather than captured.
   *
   * This is the same trick as onChangeRef above, and it is here for the same
   * reason: the mount effect below cannot depend on `center`. It runs once and
   * then awaits `import("leaflet")`, which is a real network-and-parse hop —
   * long enough that a search result can land, or a parent can re-render with
   * fresh coordinates, before the promise resolves. Closing over `center`
   * freezes the value from the render that started the import, so the map would
   * come up centered on wherever the coordinates were when the user first
   * opened the form, and the `[latitude, longitude]` effect below would find a
   * marker already sitting at the stale spot and pan to the correct one a frame
   * later — a visible jump, or, if the values arrived before the marker existed,
   * no correction at all because that effect bails when markerRef is null.
   *
   * Reading through the ref means the init always uses the LATEST coordinates,
   * whichever render is current when Leaflet finally resolves.
   */
  const centerRef = useRef<{ center: [number, number]; hasCoordinates: boolean }>({
    center,
    hasCoordinates,
  })
  centerRef.current = { center, hasCoordinates }

  useEffect(() => {
    let disposed = false
    void import("leaflet").then(({ default: L }) => {
      if (disposed || !elementRef.current || mapRef.current) return
      // Read the ref, not the `center` this effect closed over. See above.
      const { center: initialCenter, hasCoordinates: hasInitial } = centerRef.current
      const map = L.map(elementRef.current, { scrollWheelZoom: true }).setView(initialCenter, hasInitial ? 16 : DEFAULT_ZOOM)
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(map)

      const marker = L.marker(initialCenter, {
        draggable: true,
        icon: L.divIcon({
          className: "admin-hub-marker-host",
          html: markerHtml(hubType, isActive),
          iconSize: [38, 38],
          iconAnchor: [19, 19],
        }),
      }).addTo(map)
      marker.on("dragend", () => {
        const position = marker.getLatLng()
        onChangeRef.current(position.lat, position.lng)
      })
      map.on("click", (event) => {
        marker.setLatLng(event.latlng)
        onChangeRef.current(event.latlng.lat, event.latlng.lng)
      })

      mapRef.current = map
      markerRef.current = marker
      // 260ms, not 0. The panel this map lives in now opens via Expandable's
      // 200ms height animation (see HubForm.tsx) rather than mounting already
      // open, so at 0ms the container is still mid-animation and Leaflet
      // measures whatever partial height it has that frame. invalidateSize()
      // alone does not fix this -- it recomputes size but does not
      // re-guarantee the marker sits at the container's true center once the
      // size settles -- so the view is explicitly re-set afterwards too.
      window.setTimeout(() => {
        map.invalidateSize()
        map.setView(initialCenter, hasInitial ? 16 : DEFAULT_ZOOM)
      }, 260)
    })

    return () => {
      disposed = true
      mapRef.current?.remove()
      mapRef.current = null
      markerRef.current = null
    }
    // The map is intentionally initialized once. Coordinate updates move the
    // existing marker below instead of rebuilding the tile layer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const marker = markerRef.current
    if (!marker) return

    void import("leaflet").then(({ default: L }) => {
      marker.setIcon(L.divIcon({
        className: "admin-hub-marker-host",
        html: markerHtml(hubType, isActive),
        iconSize: [38, 38],
        iconAnchor: [19, 19],
      }))
    })
  }, [hubType, isActive])

  useEffect(() => {
    const map = mapRef.current
    const marker = markerRef.current
    if (!map || !marker || !hasCoordinates) return

    const next: [number, number] = [latitude, longitude]
    const current = marker.getLatLng()
    if (Math.abs(current.lat - latitude) < 0.0000001 && Math.abs(current.lng - longitude) < 0.0000001) return
    marker.setLatLng(next)
    map.panTo(next)
  }, [latitude, longitude, hasCoordinates])

  return (
    <div>
      <div ref={elementRef} className="hub-location-map" />
      <p className="hub-location-help">
        Search for an approximate place, then drag the pin or click the map to set the exact hub location.
      </p>
    </div>
  )
}
