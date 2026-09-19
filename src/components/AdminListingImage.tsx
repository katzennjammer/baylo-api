"use client"

import { useEffect, useState } from "react"

export function AdminListingImage({
  src,
  alt,
  size = 52,
}: {
  src: string | null
  alt: string
  size?: number
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open])

  return (
    <>
      <button
        type="button"
        aria-label={`Zoom image for ${alt}`}
        onClick={() => setOpen(true)}
        style={{
          width: size,
          height: size,
          borderRadius: 10,
          overflow: "hidden",
          background: "#eef2f1",
          border: "1px solid rgba(0,0,0,.08)",
          padding: 0,
          cursor: "zoom-in",
          flexShrink: 0,
        }}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={alt}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "grid",
              placeItems: "center",
              color: "#7a827d",
              fontSize: 18,
            }}
          >
            •
          </div>
        )}
      </button>

      {open && src && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${alt} image viewer`}
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0, 0, 0, 0.82)",
            padding: 24,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "100%",
              height: "100%",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={alt}
              onDoubleClick={() => setOpen(false)}
              onClick={(event) => event.stopPropagation()}
              style={{
                maxWidth: "90vw",
                maxHeight: "90vh",
                objectFit: "contain",
                borderRadius: 12,
                boxShadow: "0 20px 50px rgba(0,0,0,.4)",
                cursor: "zoom-out",
              }}
            />
          </div>
        </div>
      )}
    </>
  )
}
