<div align="center">

# 🌿 Baylo

**Barter, not buy.**

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

**Pasa Leaves** are the unit of account. They cannot be bought, sold, or withdrawn — they exist only inside the app, and every Leaf in circulation traces to a ledger entry.

When two items are unequal in value, the difference can be settled three ways:

| | |
|---|---|
| **Even swap** | Nothing to settle |
| **Leaves** | The lower-value party covers the gap from their balance |
| **Deferred Points Agreement** | A recorded promise to settle the difference by a deadline |

The **DPA** is the platform's core mechanism — an in-system IOU that lets an unequal trade happen fairly without money changing hands. Both parties agree before the swap finalises, and the creditor sees the proposer's full record first.

---

## Safety

Trading with strangers means meeting strangers. Baylo is built around that.

- **Safe-Zone Hubs** — 22 curated public meetup points across Lapu-Lapu and Mandaue: malls, barangay halls, police stations, plazas
- **Two-sided confirmation codes** — both traders exchange 6-digit codes in person before a swap settles
- **ID verification** — a government ID, manually reviewed, required before posting or proposing a DPA. One ID, one account.
- **Multi-layered reputation** — trust tiers derived from completed trades and ratings, which gate trade value and DPA eligibility
- **Report, block, and moderation** — with a full admin audit trail
- **Duplicate photo detection** — perceptual hashing catches reposted listings
- **18+** — a declared age gate, checked on both client and server

Seller pickup locations are never published at full precision, and uploaded photos are stripped of EXIF location data before storage.

---

## Where the AI is — and isn't

Claude handles **image classification**: it reads a listing photo and suggests a category and condition, which the seller confirms or corrects. It also acts as a second stage in duplicate detection.

Item **valuation is not AI**. It's a deterministic statistical model — comparable completed trades where enough exist, a fixed per-category band where they don't, scaled by a condition multiplier. Every listing records which path produced its figure.

This is deliberate. A language model gives a different answer to the same question on different days; the valuation needs to be consistent and auditable.

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
                                    │   MySQL     │
                                    │   Prisma    │
                                    └─────────────┘
```

| Repo | What it is |
|---|---|
| [`baylo-app`](https://github.com/katzennjammer/baylo-app) | The Expo mobile client — everything users see |
| [`baylo-api`](https://github.com/katzennjammer/baylo-api) | Next.js API and the web-based admin side |

**Stack** — Expo SDK 57, expo-router, NativeWind, TanStack Query · Next.js 16, Prisma 7.8, MySQL · Cloudinary, Pusher, Claude API, OpenStreetMap

---

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
