import type { ReactNode } from "react"
import { POLICY_EFFECTIVE_DATE, POLICY_IS_DRAFT } from "@/lib/support"

/**
 * The frame the pages under /policy share with /policy/trading: one narrow
 * column, no app shell, readable on a phone browser — which is where the app's
 * Settings rows open them.
 *
 * `legal` pages (Terms, Privacy) carry the draft notice while
 * POLICY_IS_DRAFT is true; Help does not, because it promises nothing.
 */
/** Navbar.tsx's bar height. It is `position: fixed`, so the page starts under it. */
const NAVBAR_HEIGHT = 68

const PROSE_CSS = `
.policy-doc p { margin: 12px 0; }
.policy-doc ul { margin: 12px 0; padding-left: 22px; list-style: disc; }
.policy-doc li { margin: 6px 0; }
.policy-doc a { text-decoration: underline; }
`

export function PolicyDocument({
  title,
  legal = false,
  meta,
  children,
}: {
  title: string
  legal?: boolean
  /** A line under the title in place of the draft/effective line: the trading policy's version. */
  meta?: string
  children: ReactNode
}) {
  return (
    <main
      className="policy-doc"
      style={{
        maxWidth: 680,
        margin: "0 auto",
        // 68 px of that is the site's fixed Navbar, which sits OVER the page:
        // with the 40 px /policy/trading uses, the title is drawn under the logo.
        padding: `${NAVBAR_HEIGHT + 40}px 24px 80px`,
        fontSize: 16,
        lineHeight: 1.6,
      }}
    >
      {/* globals.css resets every margin, every list's padding and every
          link's underline to nothing, which is right for the marketing pages
          and leaves a document as one unbroken block of text. Scoped to this
          frame; the CSP allows inline styles. */}
      <style>{PROSE_CSS}</style>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>{title}</h1>
      {meta ? <p style={{ color: "#666", fontSize: 13, marginTop: 0 }}>{meta}</p> : null}
      {legal ? (
        POLICY_IS_DRAFT ? (
          <p
            style={{
              border: "1px solid #d97706",
              background: "#fffbeb",
              color: "#92400e",
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: 14,
              marginTop: 12,
            }}
          >
            Draft for review. This page describes how Baylo works today and is not yet final.
          </p>
        ) : (
          <p style={{ color: "#666", fontSize: 13, marginTop: 0 }}>Effective {POLICY_EFFECTIVE_DATE}</p>
        )
      ) : null}
      {children}
    </main>
  )
}

export function PolicySection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section>
      <h2 id={id} style={{ fontSize: 20, marginTop: 32 }}>
        {title}
      </h2>
      {children}
    </section>
  )
}
