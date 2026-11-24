<div align="center">

# 🌿 Baylo

**Buy less, Baylo.**

A mobile marketplace where people trade what they no longer use for what they actually need — no money, anywhere in the app.

![Platform](https://img.shields.io/badge/platform-Android-3DBE5A?style=flat-square)
![Expo](https://img.shields.io/badge/Expo-SDK%2057-000?style=flat-square&logo=expo)
![React Native](https://img.shields.io/badge/React%20Native-0.86-61DAFB?style=flat-square&logo=react)
![Next.js](https://img.shields.io/badge/Next.js-16-000?style=flat-square&logo=nextdotjs)
![Prisma](https://img.shields.io/badge/Prisma-7.8-2D3748?style=flat-square&logo=prisma)
![Status](https://img.shields.io/badge/status-in%20development-C56A4B?style=flat-square)

</div>

---

## What it is

Baylo is a peer-to-peer bartering platform for thrifters and budget-conscious shoppers in Lapu-Lapu and Mandaue City, Cebu.

People list secondhand items and swap them directly with neighbours. There is no cash, no checkout, and no payment processor — the platform is **purely non-monetary** by design.

It exists because the two things that kill local bartering are trust and matching: you don't know who you're meeting, and you can rarely find someone who wants exactly what you have. Baylo addresses both.

---

## How trading works

**Pasa Leaves** are the unit of account. They cannot be bought, sold, or withdrawn — they exist only inside the app, and every Leaf in circulation traces to a ledger entry. Item values are counted on the peso scale (1 Leaf = ₱1 of value), which is not an exchange rate.

Every listing sits in one of **10 value brackets**, from Bracket 1 (up to 100 Leaves) to Bracket 10 (above 12,000). Listings show the bracket, not the exact figure.

| | |
|---|---|
| **Same bracket** | An even swap. Nothing to settle |
| **One bracket apart** | Allowed. The person moving **up** pays a small **bridging fee** in Leaves: 10 per bracket of their own item (8 with Premium). It goes to the other trader when the swap completes |
| **Two or more apart** | Not allowed. You trade up one bracket at a time |

**Bracket 7 and above** needs a Premium subscription to acquire.

> Deferred Points Agreements (an IOU for settling the difference later) were retired on 16 Sep 2026. Their endpoints now answer `410 Gone`.

---

## Safety

Trading with strangers means meeting strangers. Baylo is built around that.

- **Safe-Zone Hubs** — curated public meetup points across Lapu-Lapu and Mandaue: malls, barangay halls, police stations, plazas
- **Two-sided confirmation codes** — both traders exchange 6-digit codes in person before a swap settles
- **ID verification** — a government ID, manually reviewed, required before posting. One ID, one account. Verified traders carry a checkmark on their trust tier
- **Reputation** — a trust tier (New, Rising, Trusted, Top) earned from completed trades and review ratings, shown on profiles and offers and used to rank offers. Since Nov 2026 it no longer caps which items a trader may trade for
- **Report, block, and moderation** — with a full admin audit trail
- **Duplicate photo detection** — perceptual hashing catches reposted listings
- **18+** — a declared age gate, checked on both client and server

Seller pickup locations are never published at full precision, and uploaded photos are stripped of EXIF location data before storage.

---

## Where the AI is — and isn't

Claude handles **image classification**: it reads a listing photo and suggests a category and condition, which the seller confirms or corrects. It also acts as a second stage in duplicate detection.

Item **valuation is AI-assisted**. Claude looks up current online listings for the item and the median of their peso prices (at least two verified sources) becomes the suggested value. The server signs that suggestion, so the app cannot submit a value the server did not produce, and the listing records where its value came from (`valuationSource`).

A seller can set a different value; one far from the suggestion is held for a moderator's review before the listing goes live.

---

## Architecture

```
┌─────────────────────┐         ┌──────────────────────┐
│   Baylo mobile      │         │   Baylo API          │
│   Expo / RN         │ ──────▶ │   Next.js App Router │
│   the user side     │  HTTPS  │   + web admin        │
└─────────────────────┘         └──────────┬───────────┘
                                           │
                                    ┌──────▼──────┐
                                    │  Postgres   │
                                    │   Prisma    │
                                    └─────────────┘
```

| Repo | What it is |
|---|---|
| [`baylo-app`](https://github.com/katzennjammer/baylo-app) | The Expo mobile client — everything users see |
| [`baylo-api`](https://github.com/katzennjammer/baylo-api) | Next.js API and the web-based admin side |

**Stack** — Expo SDK 57, expo-router, NativeWind, TanStack Query · Next.js 16, Prisma 7.8, Postgres (Supabase) · Cloudinary, Pusher, Claude API, OpenStreetMap

---

## Cloudflare deployment

Put the production API behind Cloudflare's proxy before enabling trusted client
IP handling. Set `TRUST_PROXY="cloudflare"` only when direct public access to the
origin is blocked; the API then uses Cloudflare's `CF-Connecting-IP` header for
rate limiting. Keep `TRUST_PROXY="0"` during local development and direct
deployments, because forwarding headers can otherwise be forged by callers.

Cloudflare should provide DNS, HTTPS, WAF, DDoS protection, and edge rate limits.
Baylo must still enforce authentication, authorization, validation, and
application-level limits at the origin.

## Getting started

Both repos are needed — the app is not usable without the API.

```bash
git clone https://github.com/katzennjammer/baylo-api.git
git clone https://github.com/katzennjammer/baylo-app.git
```

Full setup steps are in **[SETUP.md](./SETUP.md)**.

---

## The team

**LoomLoop Labs** — BS Information Technology, University of Cebu Lapu-Lapu and Mandaue

| | |
|---|---|
| Mary Frances Rizon | Project Manager |
| Jamaica Mae Jumuad | Developer |
| John Vincent Saplad | Developer |
| Nicole Sandoval | Developer |

Adviser: Ms. Analou S. Cag-ong

---

<div align="center">

*Capstone project · 2026*

</div>
