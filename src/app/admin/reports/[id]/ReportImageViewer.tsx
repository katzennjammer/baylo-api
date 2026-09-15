"use client"

import { useEffect, useState } from "react"

export default function ReportImageViewer({
  images,
  title,
}: {
  images: string[]
  title: string
}) {
  const [active, setActive] = useState<number | null>(null)

  useEffect(() => {
    if (active === null) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setActive(null)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [active])

  function open(index: number) {
    setActive(index)
  }

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10 }}>
        {images.map((image, index) => (
          <button
            key={`${image}-${index}`}
            type="button"
            onClick={() => open(index)}
            aria-label={`View ${title} image ${index + 1}`}
            style={{ padding: 0, border: 0, background: "transparent", cursor: "zoom-in" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image}
              alt={`${title} image ${index + 1}`}
              style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 10, border: "1px solid rgba(0,0,0,.08)" }}
            />
          </button>
        ))}
      </div>

      {active !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${title} image viewer`}
          style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "rgba(0,0,0,.82)" }}
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, maxWidth: "95vw", maxHeight: "95vh" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ color: "#fff", fontSize: 13 }}>Press Escape to close</span>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={images[active]}
              alt={`${title} image ${active + 1}`}
              style={{ maxWidth: "90vw", maxHeight: "90vh", objectFit: "contain" }}
            />
          </div>
        </div>
      )}
    </>
  )
}
