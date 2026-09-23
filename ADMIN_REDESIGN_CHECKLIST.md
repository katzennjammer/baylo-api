# Admin Console Redesign — Checklist

Scope: `src/app/admin/**`, `src/components/admin/**`, admin-only blocks of `src/app/globals.css`.
Each item is checked off after its page's commit, confirming the same handler is still called with the same arguments.

## Step 2 — Foundation (done)

- Created `src/app/admin/admin-theme.css` (all `--adm-*` tokens under `.admin-root`, plus all admin-only utility classes migrated from `globals.css` and restyled to the new tokens: `.admin-btn-press`, `.admin-row-collapsing`, `.admin-pulse-dot`, `.admin-row-hover`, `.admin-card-hover`, `.admin-skeleton`, `.admin-chip*`, `.admin-nav-link*`, `.hub-location-map`/`.admin-hub-marker*`/`.hub-location-help`, plus the new `.adm-lift`/`.adm-row-hover`/`.adm-press`/`.adm-shimmer` utilities and reduced-motion overrides).
- Created `src/app/admin/tokens.ts` (the `t` object) verbatim per spec §1.2.
- Wired `Plus_Jakarta_Sans`/`JetBrains_Mono` via `next/font/google` in `src/app/admin/layout.tsx`, added `className="admin-root ${admSans.variable} ${admMono.variable}"` to the shell wrapper. The existing inline `style` on that div (background/color/fontFamily) is untouched and still visually wins for now — the shell rebuild (rail/top bar/drawer) is Step 3, done as its own commit.
- Removed the migrated blocks from `src/app/globals.css` (lines ~103–140 `.hub-location-map`/`.admin-hub-marker*`/`.hub-location-help`, and ~482–609 the "Admin console — motion" block), after grepping every class name to confirm zero usages outside `src/app/admin/**` and `src/components/admin/**`.
- Added `lucide-react` dependency (approved).
- Verified: `npx tsc --noEmit` and `npx eslint src/app/admin src/components/admin` diffed byte-for-byte identical to the saved baseline (`.baseline/tsc.txt`, `.baseline/lint-admin.txt`) — zero new errors/warnings. `npx next build` run to confirm no new build-time errors.

**Manual test steps (Step 2):** none yet — no visual change is expected at this step since the old inline styles on the shell `<div>` still take visual precedence over the new `.admin-root` class. Visual verification starts at the Step 3 commit (shell rebuild).

## Baseline (recorded before any redesign changes)

- `npx tsc --noEmit`: fails, but only on pre-existing errors in `scripts/seed-demo-appeal.ts`, `scripts/verify-id-verification.ts`, `scripts/verify-moderation.ts` (Role union type mismatches — `"SUPER_ADMIN"`/`"MODERATOR"` not in the current `Role` enum). None touch `src/app/admin` or `src/components/admin`.
- `npx eslint src/app/admin src/components/admin`: 5 pre-existing errors, 1 warning, none introduced by this task:
  - `hubs/HubForm.tsx:230` — `setState` in effect (react-hooks/set-state-in-effect)
  - `hubs/HubLocationPicker.tsx:39,67` — ref mutation during render (react-hooks/refs)
  - `id-verification/[id]/page.tsx:122` — `Date.now()` during render (react-hooks/purity)
  - `id-verification/page.tsx:166` — same
  - `hubs/HubForm.tsx:249` — unused eslint-disable warning
- `npx next build`: Turbopack compile succeeds (~75s); the build's whole-project typecheck step then fails on the same `scripts/` files above (pre-existing, unrelated to admin). No test runner/script exists in this repo (`package.json` only has `dev`, `dev:lan`, `build`, `start`, `lint`, `seed`).
- `lucide-react`: not installed — approved for install (spec exception). `next/font`: available.

## Known structural finding — needs a decision before Step 5.5

`app/admin/review-queue/page.tsx` and `review-queue/loading.tsx` are **re-exports** of `app/admin/anomalies/page.tsx` / `anomalies/loading.tsx`, which hold the real implementation. `AdminNav` links only to `/admin/review-queue` (12-item list, matches spec); `/admin/anomalies` has no nav entry but is still a live, reachable route rendering identical content.
**Decision:** restyle `anomalies/page.tsx` and `anomalies/loading.tsx` (the real files); leave `review-queue/page.tsx` and `review-queue/loading.tsx` as untouched re-exports. This preserves both routes' current behavior with one styled implementation, matching "Don't change route paths."

## Out-of-directory dependency — needs a decision

`src/components/AdminListingImage.tsx` (used by `anomalies`/`review-queue`, `appeals`, and `reports/[id]`) lives outside `src/components/admin/`. Flagged for the user before touching it.

---

## Per-route interactive-element inventory

### Shell: `layout.tsx`, `AdminNav.tsx`, `AccountMenu.tsx`
- [ ] Server-side role guard in `layout.tsx` (session → prisma user lookup → deletedAt/suspension → role check) — untouched
- [ ] `AdminNav` longest-href-first active match (`BY_SPECIFICITY`) — reused verbatim, only markup/style around it changes
- [ ] `AccountMenu` toggle button (open/close dropdown), "Switch account" button, "Sign out" button (`signOut({ callbackUrl: "/auth/login" })`)

### `/admin` — Report queue (`page.tsx`)
- [ ] 3× `FilterChips` (`report-status`, `report-target`, `report-category`) — href-based links
- [ ] Per-row `<Link href="/admin/reports/{id}">Review →</Link>`
- [ ] `loading.tsx` (`AdminTableSkeleton` cols=7 rows=10)

### `/admin/dashboard` — Overview
- [ ] `OverviewCards`: per-metric `<Link href>` card, `PulsingDot`, `CountUp`
- [ ] "View audit log →" link
- [ ] `loading.tsx` (`AdminCardSkeleton` count=8)

### `/admin/reports` — Overall report
- [ ] `ReportControls`: period chips (`selectWindow(days)`), Live toggle (`setLive`, 30s `router.refresh()`), Refresh now (`router.refresh()`)
- [ ] `ExportReportButton`: `window.print()`
- [ ] `ReportCharts` exports (`BarChart`, `StatTile`, `RankTable`) — presentational only
- [ ] Print stylesheet (`<style dangerouslySetInnerHTML>`) — must keep working with any markup/class changes
- [ ] `loading.tsx`

### `/admin/reports/[id]` — Report detail
- [ ] `ModerationActions`: reason textarea (required), Claim/reviewing button, Hide/Restore listing button, days input + Suspend/Unsuspend (admin-gated), Mark actioned / Dismiss buttons
- [ ] `ReportImageViewer`: thumbnail buttons → lightbox dialog, Escape-to-close

### `/admin/review-queue` + `/admin/anomalies` — Review queue
- [ ] `ValueReviewActions` (shared with Listings) per value-review row
- [ ] Repeat Trade Pairs table — intentionally has no action buttons
- [ ] `loading.tsx` (two `AdminTableSkeleton`s)

### `/admin/appeals`
- [ ] `FilterChips` (`status`: Open/Decided)
- [ ] `AppealActions`: Uphold/Overturn toggle buttons, `Expandable` reason input, double-confirm when `sameReviewer && armed`, `collapseRowThen` on success
- [ ] `AdminListingImage` thumbnail (external component — see decision above)

### `/admin/users`
- [ ] Search `<form action="/admin/users">` (`name="q"`, native GET)
- [ ] `FilterChips` ×2 (status, role)
- [ ] Pagination Previous/Next links (`aria-disabled` at bounds)
- [ ] `UserActions`: reason input, conditional days input, Suspend/Unsuspend, `collapseRowThen`

### `/admin/listings`
- [ ] Search `<form action="/admin/listings">`
- [ ] `FilterChips` (status, 8 values)
- [ ] `ListingActions`: reason input + Hide/Restore
- [ ] `TakedownDisclosure`: toggle wrapping `ListingActions` in `Expandable`
- [ ] `ValueReviewActions`: Approve/Reject toggle, reason input / rejection-reason select + note

### `/admin/hubs`
- [ ] `FilterChips` (status, dynamic city list)
- [ ] `HubForm` per row: name, type select, place-search input + Find button (debounced + explicit search), candidate buttons, address/city/landmark inputs, `HubLocationPicker` (Leaflet map, drag/click marker), lat/lng display, isActive checkbox (edit), reason textarea, Save (gated by `canSaveHub()`), Cancel (`closeAndReset`)
- [ ] `Modal` open/close/backdrop/Escape
- [ ] `hub-form-rules.ts` (`hasCoordinates`, `canSaveHub`, `NO_COORDINATES_MESSAGE`) — untouched, pure logic

### `/admin/achievements`
- [ ] `AchievementForm`: key (locked in edit), name, description, badge-art upload + Remove, fallback icon, criterion select, conditional threshold, points, sortOrder, create-only backfill checkbox, reason textarea, Save
- [ ] `AchievementToggle`: Deactivate/Reactivate → `Expandable` reason confirm/cancel
- [ ] `Modal` open/close

### `/admin/audit`
- [ ] Filter `<form action="/admin/audit">` (native GET): actorId select, targetType select, targetId input, from/to date inputs, Filter submit, Clear link

### `/admin/access`
- [ ] Own extra role redirect (untouched)
- [ ] `AccessActions`: client-side search input (not URL-backed), shared reason input, per-row role select (draft state), per-row Save button (disabled unless changed + reason present), green-flash success (no row removal)

### `/admin/id-verification`
- [ ] `FilterChips` (`id-status`: PENDING/APPROVED/REJECTED)
- [ ] Whole-row `<Link>` to detail
- [ ] `loading.tsx` (custom skeleton, not `AdminTableSkeleton`)

### `/admin/id-verification/[id]`
- [ ] `IdDecisionActions`: Approve path (idNumber input required), Reject path (closed reasons select + `window.confirm()`), shared optional note textarea

---

## Shared primitives (`src/components/admin/`)
- [ ] `AdminTableSkeleton` / `AdminCardSkeleton`
- [ ] `AnimatedBarFill` (scroll-into-view grow, print-safe, reduced-motion safe)
- [ ] `CountUp` (rAF animation, skips at 0 / reduced-motion)
- [ ] `Expandable` (height/opacity open-close, hydration-safe)
- [ ] `FilterChips` (`layoutId` sliding pill, URL-param driven)
- [ ] `Modal` (portal, Escape, backdrop, scroll-lock)
- [ ] `PulsingDot` (plain CSS keyframes, intentionally not Framer)
- [ ] `Stagger` (`StaggerGroup`/`StaggerItem`, first-mount-only entrance)
- [ ] `rowCollapse.ts` (`collapseRowThen`, DOM `closest("tr")` walk, reduced-motion safe)

## Success-pattern semantics to preserve (not just copy the nearest one)
- Row leaves the list → `collapseRowThen` (Appeals, Users, Listings, Value review)
- Row stays, updates in place → green-flash + `router.refresh()` (Access)
- Local re-collapse, no navigation → `Expandable` closes (Achievement toggle)
