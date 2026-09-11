"use client"

import Link from "next/link"
import { Suspense } from "react"
import { useSearchParams } from "next/navigation"

function ArrowIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  )
}

function VerifyEmailContent() {
  const params = useSearchParams()
  const status = params.get("status")
  const reason = params.get("reason")
  const email = params.get("email")
  const sent = params.get("sent") === "1"

  const isSuccess = status === "success"
  const isError = status === "error"

  return (
    <div style={{
      minHeight: "100svh",
      display: "grid",
      placeItems: "center",
      padding: "40px 20px",
      background: "radial-gradient(circle at top, rgba(57,161,90,0.12), transparent 35%), var(--bg)",
    }}>
      <div style={{
        width: "100%",
        maxWidth: 560,
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: 24,
        boxShadow: "0 24px 80px rgba(17,24,15,0.12)",
        padding: "clamp(28px, 5vw, 52px)",
      }}>
        <div style={{
          width: 66,
          height: 66,
          borderRadius: 18,
          display: "grid",
          placeItems: "center",
          marginBottom: 22,
          background: isSuccess ? "var(--accent)" : isError ? "#d95a5a" : "var(--card-alt)",
          color: isSuccess ? "var(--on-accent)" : "#fff",
        }}>
          {isSuccess ? (
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12 5 5L19 3" />
            </svg>
          ) : (
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v6" />
              <path d="M12 17h.01" />
            </svg>
          )}
        </div>

        <p className="kicker" style={{ marginBottom: 10 }}>
          {isSuccess ? "Email verified" : isError ? "Verification issue" : sent ? "Check your inbox" : "Verify your email"}
        </p>

        <h1 style={{
          margin: 0,
          fontFamily: "var(--ff)",
          fontWeight: 800,
          fontStretch: "125%",
          fontSize: "clamp(28px, 4vw, 48px)",
          lineHeight: 0.96,
          letterSpacing: "-0.03em",
          textTransform: "uppercase",
          color: "var(--text)",
        }}>
          {isSuccess ? (
            <>
              You&rsquo;re all<br />
              <span style={{ color: "var(--accent)" }}>set.</span>
            </>
          ) : isError ? (
            <>
              That link<br />
              <span style={{ color: "var(--accent)" }}>didn&rsquo;t work.</span>
            </>
          ) : (
            <>
              Check your<br />
              <span style={{ color: "var(--accent)" }}>inbox.</span>
            </>
          )}
        </h1>

        <p style={{
          marginTop: 18,
          fontSize: 15,
          lineHeight: 1.6,
          color: "var(--muted)",
        }}>
          {isSuccess ? (
            <>Your email is now confirmed. You can continue to Baylo and start trading.</>
          ) : isError ? (
            reason === "expired"
              ? "This link expired. Send a fresh verification email and we’ll walk you back through the setup step."
              : "This link is invalid or has already been used. You can request a new one and continue from there."
          ) : email ? (
            <>We sent a verification email to <strong style={{ color: "var(--text)" }}>{email}</strong>. Open it and follow the link to finish creating your account.</>
          ) : (
            <>We sent a verification email. Open it and follow the link to finish creating your account.</>
          )}
        </p>

        <div style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          marginTop: 28,
        }}>
          {isSuccess ? (
            <Link href="/dashboard" className="btn solid" style={{ fontSize: 14 }}>
              <span>Go to Baylo</span>
              <span className="arrow"><ArrowIcon /></span>
            </Link>
          ) : (
            <Link href="/auth/login" className="btn solid" style={{ fontSize: 14 }}>
              <span>Back to Baylo</span>
              <span className="arrow"><ArrowIcon /></span>
            </Link>
          )}

          {isError && (
            <Link href="/auth/register" className="btn" style={{ fontSize: 14 }}>
              <span>Create account again</span>
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  )
}
