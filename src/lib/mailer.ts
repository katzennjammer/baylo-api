import nodemailer from "nodemailer"
import { TASK_REWARDS, VERIFY_CREDIT_LEAVES } from "@/lib/task-constants"

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_SMTP_HOST,
  port: Number(process.env.EMAIL_SMTP_PORT ?? 587),
  secure: false,
  connectionTimeout: 8000,
  greetingTimeout:   8000,
  socketTimeout:     10000,
  auth: {
    user: process.env.EMAIL_SMTP_USER,
    pass: process.env.EMAIL_SMTP_PASS,
  },
})

/*
 * ── WHY THESE TEMPLATES ARE SMALL ────────────────────────────────────────────
 *
 * Until 11 Sep 2026 every template here inlined public/logo.png as a base64
 * data URI — twice, header and footer. That file is ~297 KB, so each email
 * carried ~800 KB of HTML before any words. Gmail clips a message at ~102 KB
 * and shows "[Message clipped]" with whatever survived the cut, and it refuses
 * `data:` images outright. The cut landed inside the first <img>, so what a
 * Gmail user actually saw was a broken header, no button, and the plain-text
 * part's bare URL — which read as "a raw link and an email nested inside an
 * email". The templates were fine in a browser preview and wrong in every
 * real inbox.
 *
 * So: NO inlined images, ever. The wordmark is text. If EMAIL_LOGO_URL is set
 * to an http(s) URL a small hosted image is placed beside it; anything else
 * (blank, a data URI, a file path) is ignored. One column, one button, the
 * plain URL under it, one "ignore this if it wasn't you" line, an address
 * footer. Each message is a few KB and renders the same in Gmail, Outlook,
 * Apple Mail and the plain-text clients.
 *
 * Every function that takes user-provided text runs it through escapeHtml().
 * The URLs are ours, but they are escaped too — a `&` in a query string is
 * still a `&` that has to be `&amp;` inside an attribute.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"

const COLOR = {
  page: "#f1efe8",
  card: "#ffffff",
  ink: "#14140f",
  body: "#4a4e44",
  muted: "#8c8a7e",
  faint: "#a8a69a",
  line: "#e2e0d6",
  green: "#1e9e63",
  onGreen: "#ffffff",
  wash: "#f6f5ef",
} as const

const POSTAL = "Baylo Labs · Cebu IT Park, Apas · Cebu City 6000, Philippines"

/** A hosted logo, or nothing. Never a data URI — see the note at the top. */
function hostedLogo(): string | null {
  const configured = (process.env.EMAIL_LOGO_URL ?? "").trim()
  return /^https?:\/\//i.test(configured) ? configured : null
}

function paragraph(html: string, extra = ""): string {
  return `<p style="margin:0 0 16px 0;${FONT}font-size:16px;line-height:1.6;color:${COLOR.body};${extra}">${html}</p>`
}

/**
 * The one call-to-action: a bulletproof button (a table cell with a background,
 * which every client paints) and the same URL written out beneath it, for the
 * clients that strip links from buttons and the people who copy-paste.
 */
function ctaBlock(url: string, label: string): string {
  const safeUrl = escapeHtml(url)
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px 0;">
  <tr>
    <td align="center" bgcolor="${COLOR.green}" style="border-radius:10px;background-color:${COLOR.green};">
      <a href="${safeUrl}" target="_blank" style="display:inline-block;padding:15px 32px;${FONT}font-size:16px;font-weight:700;color:${COLOR.onGreen};text-decoration:none;border-radius:10px;">${label}</a>
    </td>
  </tr>
</table>
<p style="margin:0 0 4px 0;${FONT}font-size:13px;line-height:1.5;color:${COLOR.muted};">If the button doesn&rsquo;t work, copy this link into your browser:</p>
<p style="margin:0 0 24px 0;${FONT}font-size:13px;line-height:1.5;word-break:break-all;"><a href="${safeUrl}" style="color:${COLOR.green};text-decoration:underline;">${safeUrl}</a></p>`
}

/** The muted "ignore this if it wasn't you" line. Same place in every message. */
function ignoreBlock(html: string): string {
  return `<p style="margin:0;${FONT}font-size:14px;line-height:1.6;color:${COLOR.muted};">${html}</p>`
}

/**
 * The shell every message is poured into. `body` is already-safe HTML.
 *
 * Width is 520 rather than the 600 these used to be: the messages are a
 * headline, two sentences and a button, and a narrower column keeps the line
 * length readable on desktop without any media queries, which several clients
 * strip anyway.
 */
function shell(opts: { title: string; preheader: string; headline: string; body: string; footerReason: string }): string {
  const logo = hostedLogo()
  const wordmark = logo
    ? `<img src="${escapeHtml(logo)}" alt="" width="28" height="28" style="display:inline-block;width:28px;height:28px;vertical-align:middle;border:0;margin-right:10px;" /><span style="${FONT}font-size:22px;font-weight:800;letter-spacing:-0.3px;color:${COLOR.ink};vertical-align:middle;">Baylo</span>`
    : `<span style="${FONT}font-size:22px;font-weight:800;letter-spacing:-0.3px;color:${COLOR.ink};">Baylo</span>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>${escapeHtml(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${COLOR.page};-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${COLOR.page};">${escapeHtml(opts.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLOR.page}" style="background-color:${COLOR.page};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:100%;">
          <tr>
            <td style="padding:0 8px 18px 8px;">${wordmark}</td>
          </tr>
          <tr>
            <td bgcolor="${COLOR.card}" style="background-color:${COLOR.card};border:1px solid ${COLOR.line};border-radius:14px;padding:32px 32px 28px 32px;">
              <h1 style="margin:0 0 18px 0;${FONT}font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-0.3px;color:${COLOR.ink};">${opts.headline}</h1>
              ${opts.body}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 8px 0 8px;">
              <p style="margin:0 0 4px 0;${FONT}font-size:12px;line-height:1.6;color:${COLOR.faint};">${opts.footerReason}</p>
              <p style="margin:0;${FONT}font-size:12px;line-height:1.6;color:${COLOR.faint};">${POSTAL}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

const FROM = () => process.env.EMAIL_FROM ?? "Baylo <no-reply@baylo.ph>"

// ── Password reset ────────────────────────────────────────────────────────────

const RESET_EXPIRY = "30 minutes"

function buildResetHtml(resetUrl: string, name?: string | null): string {
  const greeting = name ? `Hi ${escapeHtml(name)},` : "Hi there,"
  return shell({
    title: "Reset your Baylo password",
    preheader: `Choose a new password for your Baylo account. This link expires in ${RESET_EXPIRY}.`,
    headline: "Reset your password",
    body: [
      paragraph(greeting),
      paragraph(`Someone asked to reset the password for your Baylo account. Choose a new one with the button below. The link expires in <strong style="color:${COLOR.ink};">${RESET_EXPIRY}</strong> and works once.`),
      ctaBlock(resetUrl, "Choose a new password"),
      ignoreBlock("Didn&rsquo;t ask for this? Ignore this email &mdash; your password stays exactly as it is."),
    ].join("\n"),
    footerReason: "You received this because a password reset was requested for this address.",
  })
}

function buildResetText(resetUrl: string, name?: string | null): string {
  return [
    "Reset your Baylo password",
    "",
    name ? `Hi ${name},` : "Hi there,",
    "",
    `Someone asked to reset the password for your Baylo account. Open the link below to choose a new one. It expires in ${RESET_EXPIRY} and works once.`,
    "",
    resetUrl,
    "",
    "Didn't ask for this? Ignore this email — your password stays exactly as it is.",
    "",
    POSTAL,
  ].join("\n")
}

export async function sendPasswordResetEmail(to: string, resetUrl: string, name?: string | null) {
  await transporter.sendMail({
    from: FROM(),
    to,
    subject: "Reset your Baylo password",
    html: buildResetHtml(resetUrl, name),
    text: buildResetText(resetUrl, name),
  })
}

// ── Swap confirmation code ────────────────────────────────────────────────────

function buildSwapCodeHtml(
  code: string,
  recipientName: string | null | undefined,
  otherUserName: string,
  items: { yours: string; theirs: string },
): string {
  const greeting   = recipientName ? `Hi ${escapeHtml(recipientName)},` : "Hi there,"
  const safeOther  = escapeHtml(otherUserName)
  const safeYours  = escapeHtml(items.yours)
  const safeTheirs = escapeHtml(items.theirs)

  // Table cells, not flexboxes — flex is unsupported in Outlook and half the
  // webmail clients, and a code the recipient cannot read defeats the email.
  const digits = code
    .split("")
    .map((d) =>
      `<td style="padding:0 3px;"><div style="width:42px;height:54px;line-height:54px;border:2px solid ${COLOR.green};border-radius:10px;background-color:${COLOR.wash};${FONT}font-size:26px;font-weight:800;color:${COLOR.ink};text-align:center;">${escapeHtml(d)}</div></td>`,
    )
    .join("")

  return shell({
    title: "Your Baylo swap code",
    preheader: `Your swap confirmation code — read it to ${otherUserName} when you meet.`,
    headline: "Your swap confirmation code",
    body: [
      paragraph(greeting),
      paragraph(`You&rsquo;re meeting <strong style="color:${COLOR.ink};">${safeOther}</strong> to complete your swap: <strong style="color:${COLOR.ink};">${safeYours}</strong> &harr; <strong style="color:${COLOR.ink};">${safeTheirs}</strong>.`),
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 12px 0;"><tr>${digits}</tr></table>`,
      `<p style="margin:0 0 20px 0;${FONT}font-size:13px;line-height:1.5;color:${COLOR.muted};">Expires in <strong style="color:${COLOR.body};">15 minutes</strong> &middot; single use.</p>`,
      paragraph(`<strong style="color:${COLOR.ink};">Read your code to ${safeOther}</strong> &mdash; they type it into the app. Then they read theirs to you and you type it in. Both correct means the swap is confirmed.`),
      ignoreBlock("Not meeting anyone? Ignore this email &mdash; the code expires on its own and nothing is confirmed without it."),
    ].join("\n"),
    footerReason: "You received this because a swap you are part of reached its meetup step.",
  })
}

function buildSwapCodeText(
  code: string,
  recipientName: string | null | undefined,
  otherUserName: string,
  items: { yours: string; theirs: string },
): string {
  return [
    "Your Baylo swap confirmation code",
    "",
    recipientName ? `Hi ${recipientName},` : "Hi there,",
    "",
    `You're meeting ${otherUserName} to complete your swap: ${items.yours} ↔ ${items.theirs}`,
    "",
    `Your code: ${code}`,
    "",
    `Read this code to ${otherUserName} — they enter it in the app. Then they read their code to you — you enter it. Both correct means the swap is confirmed.`,
    "",
    "The code expires in 15 minutes and works once.",
    "",
    POSTAL,
  ].join("\n")
}

export async function sendSwapConfirmationCode(
  to: string,
  name: string | null | undefined,
  code: string,
  otherUserName: string,
  items: { yours: string; theirs: string },
) {
  await transporter.sendMail({
    from:    FROM(),
    to,
    subject: `Your Baylo swap code: ${code}`,
    html:    buildSwapCodeHtml(code, name, otherUserName, items),
    text:    buildSwapCodeText(code, name, otherUserName, items),
  })
}

// ── Email verification ────────────────────────────────────────────────────────

const VERIFY_EXPIRY = "24 hours"

/**
 * What verifying is worth, in the user's own terms.
 *
 * Read from task-constants rather than typed here, because this number has
 * already drifted once: the copy said "50" while the ledger credited 60 (the
 * grant plus the VERIFY_ACCOUNT task, paid together by markVerified()). The
 * sentence quotes the total the user will see land, and nothing else.
 */
const verifyWorth = () =>
  `${VERIFY_CREDIT_LEAVES} welcome Leaves (a ${VERIFY_CREDIT_LEAVES - TASK_REWARDS.VERIFY_ACCOUNT}-Leaf signup grant plus ${TASK_REWARDS.VERIFY_ACCOUNT} for verifying)`

function buildVerifyHtml(verifyUrl: string, name?: string | null): string {
  const greeting = name ? `Hi ${escapeHtml(name)},` : "Hi there,"
  return shell({
    title: "Verify your Baylo email",
    preheader: `Confirm your email to collect your ${VERIFY_CREDIT_LEAVES} welcome Leaves. This link expires in ${VERIFY_EXPIRY}.`,
    headline: "Confirm your email",
    body: [
      paragraph(greeting),
      paragraph(`Welcome to Baylo. Tap the button to confirm this address. Verifying credits your <strong style="color:${COLOR.ink};">${verifyWorth()}</strong>. You can browse, message and accept trades in the meantime.`),
      ctaBlock(verifyUrl, "Verify my email"),
      paragraph(`This link expires in <strong style="color:${COLOR.ink};">${VERIFY_EXPIRY}</strong> and can be used once. Need another? Sign in and ask for a new one.`, "font-size:14px;"),
      ignoreBlock("Didn&rsquo;t sign up for Baylo? Ignore this email &mdash; nothing happens and the account stays unverified."),
    ].join("\n"),
    footerReason: "You received this because this address was used to create a Baylo account.",
  })
}

function buildVerifyText(verifyUrl: string, name?: string | null): string {
  return [
    "Confirm your Baylo email",
    "",
    name ? `Hi ${name},` : "Hi there,",
    "",
    `Welcome to Baylo. Open the link below to confirm this address. Verifying credits your ${verifyWorth()}. You can browse, message and accept trades in the meantime.`,
    "",
    verifyUrl,
    "",
    `This link expires in ${VERIFY_EXPIRY} and can be used once. Need another? Sign in and ask for a new one.`,
    "",
    "Didn't sign up for Baylo? Ignore this email — nothing happens and the account stays unverified.",
    "",
    POSTAL,
  ].join("\n")
}

export async function sendVerificationEmail(to: string, verifyUrl: string, name?: string | null) {
  await transporter.sendMail({
    from: FROM(),
    to,
    subject: "Verify your Baylo email",
    html: buildVerifyHtml(verifyUrl, name),
    text: buildVerifyText(verifyUrl, name),
  })
}
