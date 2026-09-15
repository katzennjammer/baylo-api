"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"

export default function LoadingScreen({ destination }: { destination: string }) {
  const router = useRouter()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoFailed, setVideoFailed] = useState(false)

  function proceed() {
    router.replace(destination)
  }

  useEffect(() => {
    const timer = setTimeout(proceed, 6000)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination])

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "#0a0a0c" }}>
      <div style={{
        position: "absolute", inset: 0, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: 20,
        opacity: videoFailed ? 1 : 0.999,
      }}>
        <img src="/logo.png" alt="Baylo" style={{ height: 64, objectFit: "contain" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "rgba(255,255,255,.6)", fontSize: 15, fontWeight: 600 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
               style={{ animation: "spin .7s linear infinite" }}>
            <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" stroke="rgba(124,92,255,.9)" />
            <path d="M12 3a9 9 0 0 1 9 9" stroke="rgba(255,255,255,.9)" />
          </svg>
          Loading Baylo…
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
      {!videoFailed && (
        <video
          ref={videoRef}
          src="https://res.cloudinary.com/dm7ctbxq7/video/upload/v1781215991/baylo_loading_rqb28k.mp4"
          autoPlay
          playsInline
          muted
          onEnded={proceed}
          onError={() => setVideoFailed(true)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
    </div>
  )
}
