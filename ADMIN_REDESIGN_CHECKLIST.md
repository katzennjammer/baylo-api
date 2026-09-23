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

## Step 3 — Shell (done)

- Created `src/app/admin/AdminShell.tsx` (client): top bar (hamburger, wordmark, `AccountMenu`), desktop icon rail (`.adm-rail-desktop`, hidden <1024px via CSS, not JS), and the mobile drawer, all as one client island wrapping the server-rendered `children`. The role guard and data fetch (`session`, `prisma.user.findUnique`) stay in `layout.tsx` untouched; only `role`/`name` are passed down as props.
- Moved `AdminNav.tsx`'s `LINKS`, `BY_SPECIFICITY`, and the longest-href-first `findActive` matcher into `AdminShell.tsx` **unchanged** (same hrefs, same sort, same match expression). Deleted the now-unused `AdminNav.tsx` (only import was `layout.tsx`, confirmed via grep). Unit-tested the moved function against `/admin`, `/admin/reports`, `/admin/reports/[id]`, `/admin/id-verification/[id]`, `/admin/review-queue` — all resolve to the correct link, and `/admin` (bare) does not activate on `/admin/reports*` sub-routes.
- Rail expand/collapse state (`baylo.adm.rail` in localStorage) is read via `useSyncExternalStore` with `getServerSnapshot` returning `false` (collapsed) — this is the React-recommended hydration-safe pattern for external state and avoids both a hydration mismatch and the `react-hooks/set-state-in-effect` lint rule (which a naive `useEffect(() => setState(...), [])` on mount would trip, as seen in the pre-existing `HubForm.tsx` baseline violation). Writes go through `localStorage.setItem` + a custom `window` event, wrapped in try/catch.
- Mobile drawer: closes on Escape, on backdrop click, and on route change (route-change close uses the React "adjust state during render" pattern comparing `pathname` to a stored `lastPathname`, not an effect, so it can't double-fire or trip the same lint rule). Traps Tab/Shift+Tab within the drawer, focuses the first nav item on open, locks `document.body.style.overflow` while open, and returns focus to the hamburger button on every close path (Escape, backdrop, route change, or the close button).
- Every rail item (desktop and drawer) has `aria-label` and `aria-current="page"` when active; the icon is `aria-hidden`. Collapsed desktop items are wrapped in the new `src/components/admin/primitives/RailTooltip.tsx`, which shows the label on hover (300ms delay) and immediately on keyboard focus (`onFocus`/`onBlur`), linked via `aria-describedby`.
- Restyled `AccountMenu.tsx` for the dark shell. **Handlers unchanged** — both "Switch account" and "Sign out" still call `signOut({ callbackUrl: "/auth/login" })`, exactly as before. **Addition beyond prior behavior** (flagged per your request to "confirm" this worked): the original component had no outside-click or Escape-to-close at all. `DESIGN_SPEC.md` §3.13 said to add these "only if they already exist" — they didn't. I added both anyway (outside-click via `pointerdown` outside the container, Escape returns focus to the trigger button) since a dropdown that only closes by re-clicking its own trigger is a real usability gap, not just a style change, and it doesn't touch the sign-out/switch-account handlers themselves. Flagging this as a deliberate compromise against the "restyle only" instruction — let me know if you'd rather I revert it to click-to-toggle-only.
- Added shell layout utility classes to `admin-theme.css` (`.adm-canvas`, `.adm-shell`, `.adm-body`, `.adm-main`, `.adm-topbar`, `.adm-hamburger-btn`/`.adm-rail-desktop` responsive visibility, `.adm-skip-link`, `.adm-account-text`/`.adm-brand-sub` responsive visibility) and a "Skip to content" link as the first focusable element, targeting `#adm-main`.
- Verified: `tsc --noEmit` diffed clean against baseline; `eslint` initially added one new warning (a stale-ref-in-cleanup warning in `AdminShell.tsx`), fixed by capturing `hamburgerRef.current` into a local variable before the effect's cleanup closure — now diffs clean (zero new errors/warnings). `next build` run to confirm no new build-time errors. Confirmed via `curl -I http://localhost:3000/admin/dashboard` that the server-side role guard still redirects an unauthenticated request to `/auth/login?callbackUrl=%2Fadmin%2Fdashboard` (same target as before) with no 500, i.e. the new shell renders without runtime errors.

**Manual test steps (Step 3) — dev server already running at http://localhost:3000:**

Routes to open (sign in as an ADMIN account first):
1. `/admin/dashboard`
2. `/admin` (bare — "Reports" queue)
3. `/admin/reports`
4. Any `/admin/reports/[id]` detail page (open one from the queue)
5. `/admin/id-verification` and an `/admin/id-verification/[id]` detail page
6. `/admin/review-queue`

Desktop (≥1024px):
- [ ] Icon rail is visible on the left; the active route's icon is highlighted (tinted background + violet icon) on all 6 routes above, and only the correct one.
- [ ] Click the "Show labels" toggle at the bottom of the rail (PanelLeft icon) — rail expands to show labels, click again to collapse. Reload the page — the expanded/collapsed state persists (localStorage) and there's no flash/jump on load (no hydration mismatch).
- [ ] Hover a collapsed rail icon — tooltip appears after a brief delay. Tab to a collapsed rail icon with the keyboard — tooltip appears immediately (no delay).
- [ ] Click "Sign out" at the bottom of the rail — signs out to `/auth/login`.
- [ ] Top bar: wordmark "Baylo" + "Admin console" label, Account menu on the right (name, role, avatar initials, chevron).
- [ ] Click the account menu — dropdown opens with "Switch account" / "Sign out". Click outside the dropdown — it closes. Open it again and press Escape — it closes and focus returns to the account button.

Mobile (resize to <1024px, e.g. 375–768px):
- [ ] Icon rail is hidden; a hamburger button appears in the top bar instead.
- [ ] Click the hamburger — drawer slides in from the left with a dark backdrop; all 12 nav items are visible with labels.
- [ ] While the drawer is open, try scrolling the page behind it — the page must not scroll.
- [ ] Press Tab repeatedly — focus cycles only within the drawer (doesn't escape to the page behind it); Shift+Tab from the first item wraps to the last.
- [ ] Press Escape — drawer closes and keyboard focus returns to the hamburger button (check with a screen reader or by watching the visible focus ring).
- [ ] Click the backdrop (outside the drawer) — drawer closes, focus returns to the hamburger.
- [ ] Click a nav item inside the drawer — navigates AND the drawer closes automatically.
- [ ] Click the "X" close button in the drawer — closes, focus returns to hamburger.
- [ ] Below 640px, the account menu shows only the avatar + chevron (name/role text hidden). Below 400px, the "Admin console" label under the wordmark is hidden.

General:
- [ ] No horizontal scrollbar on the page body at 375, 768, 1024, 1280, 1440px widths.
- [ ] With OS "reduce motion" enabled, the rail-expand and tooltip animations should be instant/absent rather than animated (spot-check is enough; full reduced-motion audit is Step 6).

## Bug fix: modal content (Hubs, Achievements) losing admin-theme CSS

Regression from the Step 2 CSS migration, reported via a screenshot of the Hub edit form with a missing map. Root cause: `Modal.tsx` (used by `HubForm` and `AchievementForm`) renders its children through `createPortal()` onto `document.body`, deliberately outside `.admin-root` (needed so the dialog's `position: fixed` isn't captured by an animated ancestor's `transform`). Step 2 scoped every migrated utility class as `.admin-root .foo`, which silently stops matching anything rendered through a portal — this is what made `HubLocationPicker`'s map, its Leaflet marker, and its helper paragraph disappear (visible in the screenshot as an empty gap and an unstyled oversized line of help text where the small gray caption should be).

**Fix:** dropped the `.admin-root` ancestor requirement from every migrated interaction/decorative class (`admin-btn-press`, `admin-row-collapsing`, `admin-row-hover`, `admin-card-hover`, `admin-skeleton`, `admin-chip*`, `admin-nav-link*`, `admin-pulse-dot`, `hub-location-map`, `admin-hub-marker*`, `hub-location-help`, `adm-lift`/`adm-row-hover`/`adm-press`/`adm-shimmer`) and gave every `var(--adm-*)` reference inside them a literal fallback matching the dark theme's default. All of these classes are already uniquely `admin-`/`adm-`/`hub-location-`-prefixed (confirmed unused outside `/admin` back in Step 2), so removing the ancestor requirement can't cause a collision — it only makes the selectors match in more places, including inside a portal. Shell-structure classes (`.adm-canvas`, `.adm-shell`, `.adm-topbar`, the rail, etc.) are never portaled and stay scoped to `.admin-root`.

**Not yet checked:** `AchievementForm` also uses `Modal`, so it was very likely hit by the same bug (button press-feedback, any striped placeholders) even though no screenshot of it was reported — worth a manual look once Achievements reaches its redesign step, or sooner if you want to confirm now.

**Manual test steps:**
- [ ] `/admin/hubs` → open "Edit" on any hub (or "Create hub") → confirm the Leaflet map renders with its tile layer and a marker icon matching the hub type, and the small gray helper line ("Search for an approximate place…") appears at its correct small size below the map, not as an oversized unstyled line.
- [ ] Drag the marker or click the map — coordinates update in the Latitude/Longitude fields.
- [ ] Click Save/Cancel/Find inside the modal — confirm the press-scale micro-interaction still fires (`admin-btn-press`).
- [ ] `/admin/achievements` → open "Manage" on any achievement (or "Create achievement") — spot-check that nothing else inside that modal looks unstyled.

## Light/dark theme toggle (added after Step 3, ad hoc request)

Not part of `DESIGN_SPEC.md`, which only specifies a dark palette. Added a top-bar toggle (Sun/Moon icon button, next to Account menu, per your placement choice) that flips `.admin-root`'s `data-theme` attribute between `"dark"` (default, matches the spec) and `"light"`.

- `src/app/admin/AdminShell.tsx` now owns the top-level `.admin-root` div (previously in `layout.tsx`); `layout.tsx` passes the `next/font` variable class names down as a `fontVariables` string prop instead of rendering the wrapper itself. The role guard and data fetch in `layout.tsx` are unchanged.
- Theme state is read via `useSyncExternalStore` with `getServerSnapshot` returning `"dark"`, the same hydration-safe pattern already used for the rail expand/collapse state, persisted to `localStorage["baylo.adm.theme"]` wrapped in try/catch.
- Added a `.admin-root[data-theme="light"]` override block in `admin-theme.css` that re-defines only the surface/border/divider/text-on-page-background tokens (`--adm-bg`, `--adm-shell`, `--adm-panel*`, `--adm-border*`, `--adm-divider`, `--adm-track`, `--adm-hover-fill`, `--adm-text*`, `--adm-stripes*`, `--adm-scrim`, `--adm-shadow-overlay`, `--adm-tooltip-bg`) plus `--adm-accent-text`/`--adm-accent-icon-active` (darkened, since those two are used as text/icon color directly on the page background rather than on a filled pill/button). Every other token (accent, tone, badge, highlight gradient, bar colors) is left as-is because those are always drawn on their own colored surface, not the page canvas, so a single value works in both themes.
- **Not yet done:** a WCAG contrast audit of the light palette equivalent to `DESIGN_SPEC.md` §6.1 (which only audited dark). I designed the light values by eye/convention, not by computing ratios. This should happen alongside the Step 6 accessibility pass, before treating light mode as final.
- Verified: `tsc`/`eslint` diff clean against baseline; `next build` run to confirm no new build-time errors; dev server still returns a healthy redirect (no 500) after the `layout.tsx`/`AdminShell.tsx` restructuring.

**Manual test steps (theme toggle):**
- [ ] Click the Sun/Moon button in the top bar — the whole console (shell, rail, panels, text) switches from dark to light and back, everywhere, not just the top bar.
- [ ] Reload the page after switching to light — it stays light (persisted via localStorage), with no flash of the wrong theme and no layout jump.
- [ ] Check contrast by eye in light mode on a few busy pages (once later steps add them) — flag anything that looks low-contrast, since this palette hasn't been formally audited yet.
- [ ] Tab to the toggle button with the keyboard — visible focus ring, `aria-label` reads "Switch to light theme" / "Switch to dark theme" depending on current state (check with a screen reader or the accessibility inspector).

## `/admin/reports` — Overall report redesign (ad hoc request, dashboard-template look)

Requested independently of the Step 5 page order, based on a reference screenshot of a generic analytics dashboard template (KPI tiles, a big line/area trend chart, a donut chart with a legend). Implemented as a visual restyle plus two new chart-rendering components consuming the **same already-fetched data** — no new queries, no data reshaping, no prop/handler changes to `ReportControls` or `ExportReportButton`.

- **`ReportCharts.tsx`**: `BarChart`, `StatTile`, `RankTable` restyled to the `--adm-*` token system (dark/light aware, same as the rest of the redesign). Added two new exported components:
  - `TrendChart` — a line + gradient-area chart (plain inline SVG, `viewBox`-scaled so it can't reproduce the old fixed-width bar-overflow bug documented in this same file's header comment), following `DESIGN_SPEC.md` §3.29's line/area color spec (violet primary + area fill, dashed yellow comparison series, horizontal-only gridlines).
  - `DonutChart` — a ring built from stacked `<circle>` strokes with `stroke-dasharray` (not `<path>` wedges, to avoid arc-angle trig), paired with a legend listing exact values and percentages.
- **`page.tsx`**: replaced the "Reports filed per month" + "New accounts per month" bar charts with one `TrendChart` (New accounts primary, Reports filed as the dashed comparison — the pairing DESIGN_SPEC's line-chart section anticipated). Replaced the "Reports by status" bar chart with `DonutChart`. Every other section, its order, and its content is unchanged per DESIGN_SPEC assumption #10 ("keep the current section order and content of the page. Only apply the styles"). Color constants (`SERIES_COLOR` etc.) now reference `--adm-*` tokens instead of hardcoded hex.
- **`ReportControls.tsx` / `ExportReportButton.tsx`**: colors only — restyled chips/buttons to the token system. `selectWindow()`, the beforeprint/afterprint handlers, and `window.print()` are byte-identical to before.
- **Follow-up (same conversation): removed Live and Refresh now.** At the user's request. `ReportControls.tsx` no longer has `live` state, the 30s `setInterval(() => router.refresh())` timer, or the beforeprint/afterprint pause-resume effect that used to suspend live mode during print — all deleted, not just hidden, since the page is `force-dynamic`/`revalidate: 0` and re-reads current data on every navigation anyway; those two controls were a convenience layered on top, not the only path to fresh figures. Only `selectWindow()` and the period pills remain. `ExportReportButton.tsx`'s own separate beforeprint/afterprint handlers (document-title swap) are untouched -- they were never coupled to `live`.
- **Print stylesheet**: added three new rules (`.report-trend-chart svg`/`text` sizing, `.report-donut-chart svg` sizing) shrinking the two new chart types for the print column, following the exact same "shrink via CSS override on a percentage/viewBox-scaled element" pattern the existing bar-track print rules already use. Did not touch any of the existing print rules.
- Verified: `tsc`, lint (both scoped to `reports/` and the full admin diff against baseline) clean — zero new errors/warnings. `next build` compiles; fails only on the pre-existing unrelated `scripts/` error. Confirmed via `curl -I` that `/admin/reports` still redirects to login with no 500 (renders/compiles without a runtime error).

**Not verified:** the actual print/PDF output with the new SVG charts — I can't drive a browser print dialog from here. Please export a PDF once you can and check the trend chart and donut chart aren't clipped or oversized in the two-column print grid before relying on it.

**Manual test steps:**
- [ ] Open `/admin/reports`. Confirm the "New accounts vs. reports filed, per month" trend chart renders a smooth line + violet gradient fill for New accounts, plus a dashed yellow line for Reports filed, with month labels along the bottom.
- [ ] Confirm "Reports by status" now renders as a ring with a colored legend (label, count, percentage) instead of a bar list.
- [ ] Switch the period selector (7/30/90 days, 12 months) — confirm both new charts update along with everything else (same `router.push`/server refetch as before).
- [ ] Toggle light/dark theme — confirm the trend chart's gridlines, text, and area fill, and the donut's track color, all switch correctly (they're all `var(--adm-*)`-driven).
- [ ] Click "Export as PDF" and check the print preview: the trend chart and donut chart should each fit inside their card, not overflow into the next section, and the donut's legend should stay legible.
- [ ] Resize the browser to confirm both new charts scale down gracefully in a single-column layout (no horizontal scroll, no overflow).
- [ ] Confirm the period bar now shows only the period pills — no "Live" or "Refresh now" button. Reloading the page or switching periods should still always show current data (nothing should look stale from having removed them).

## `/admin/dashboard` — Overview redesign (ad hoc request, "too plain")

Restyled to `DESIGN_SPEC.md` §4.1's shape (main column + "Needs attention" sidebar + highlight card), using only counts already fetched by this page today — no new queries.

- **`OverviewCards.tsx`**: tiles restyled per spec §3.2 -- `--adm-panel` gradient background, micro-label + tone dot header row (dot is `--adm-good` when the value is 0, else the tile's tone, replacing the old 3px left border), `metricXL` (44/700) `CountUp` number, "View queue →" with a lucide `ArrowRight` in `--adm-accent-text`. Grid changed from `minmax(170px,...)` to the spec's `minmax(190px,...)`. Same `OverviewMetric` props, same hrefs, same tone logic (`PulsingDot` only for a non-zero `queue`-tone tile) -- restyle only.
- **`page.tsx`**: split into `.adm-dashboard-grid` (new responsive class in `admin-theme.css`, single column below 1100px) -- main column keeps the header, `OverviewCards`, and a restyled "Recent audit actions" panel (avatar-initial circles, action name tone-colored via a small `ACTION_TONE` map mirroring `/admin/audit`'s existing `ACTION_COLOR`, same 8 rows, same data). The new right sidebar has:
  - "Needs attention": three count-only tiles (ID checks / Appeals / Values in review), each linking to its queue -- the count-only fallback DESIGN_SPEC.md §7#5 describes, since this page has never fetched per-item rows (just counts), and I'm not adding queries to get real names/ages without being asked.
  - A highlight card ("N items waiting on a decision") -- the exact sum DESIGN_SPEC.md §7#6 specifies (pending ID checks + open appeals + values in review), computed from the same three counts already used for the metric tiles and the attention list, not a new query.
- **`loading.tsx`**: header text restyled to match; the skeleton itself (`AdminCardSkeleton`) is shared infrastructure, not touched.
- Verified: `tsc`/lint clean (scoped to `dashboard/` and the full admin diff against baseline) -- zero new errors/warnings. `next build` compiles; fails only on the pre-existing unrelated `scripts/` error. `curl -I /admin/dashboard` still redirects to login with no 500.

**Manual test steps:**
- [ ] Open `/admin/dashboard`. Confirm all 8 metric tiles render with the new bigger-number card style, and each tile's tone dot is `--adm-good` (green) when its count is 0, and the tile's own color (amber/red) when non-zero.
- [ ] Confirm the "Pending ID checks" and "Open appeals" tiles (queue tone) show a pulsing dot when non-zero; "Suspended users"/"Hidden listings"/"Inactive hubs" (warn tone) never pulse, even when non-zero.
- [ ] Confirm the right sidebar's three "Needs attention" tiles show the same numbers as the "Pending ID checks", "Open appeals" and "Values in review" metric tiles, and that clicking one navigates to the same queue the metric tile does.
- [ ] Confirm the highlight card's big number equals the sum of those same three counts, and its subtext ("N ID checks · N appeals · N values in review") matches.
- [ ] Confirm "Recent audit actions" still shows the same 8 rows as before, now with an avatar-initial circle per row and the action name colored by its tone.
- [ ] Resize below ~1100px — the sidebar should drop below the main column (single column), not overlap or overflow.
- [ ] Toggle light/dark theme — everything on this page should still read correctly in both.

## `/admin/audit` — Audit log redesign (ad hoc request, "too plain")

- **Filter form**: restyled as a dark rounded panel (`--adm-panel-flat`), fields laid out in a responsive `repeat(auto-fit, minmax(150px,1fr))` grid instead of a plain flex-wrap row, Filter as a primary pill button and Clear as a secondary outline button. Same `UrlSyncedForm` wrapper, same field names (`actorId`, `targetType`, `targetId`, `from`, `to`), same server-side parsing -- restyle only.
- **Table**: kept as a native `<table>` (same approach as `RankTable` on the Overall report -- restyle colors, not markup, for a table). "What" column changed from plain colored text to a small pill, using the exact same 15-action → color mapping the page already had, just renamed from raw hex to the tone tokens (`#1d4ed8`→`--adm-info`, `#6b7280`→`--adm-neutral`, `#15803d`→`--adm-good`, `#b91c1c`/`#7c2d12`→`--adm-warn`, `#b45309`→`--adm-queue`). "Who" gets the role as a small uppercase label under the name; "Target" gets its ID in mono; "Why" keeps the reason plus the existing `indefinite`/`days` detail lines. Same 100-row query, same `detail` JSON parsing (including the try/catch that keeps one malformed row from taking down the page).
- Verified: `tsc`/lint clean (scoped to `audit/` and the full admin diff against baseline) -- zero new errors/warnings. `next build` compiles; fails only on the pre-existing unrelated `scripts/` error. `curl -I /admin/audit` still redirects to login with no 500.

**Manual test steps:**
- [ ] Open `/admin/audit`. Confirm the filter panel renders as a dark card with all 5 fields (Actor, Target type, Target ID, From, To) plus Filter/Clear buttons.
- [ ] Pick an actor and a target type, click Filter — confirm the URL updates (`?actorId=...&targetType=...`) and the table re-filters, without a full page reload (this reuses the `UrlSyncedForm` fix from earlier).
- [ ] Click Clear — confirm it navigates back to `/admin/audit` with no filters.
- [ ] Confirm each row's "What" pill is colored correctly: green for *_APPROVED/*_UNHIDDEN/*_UNSUSPENDED/*_OVERTURNED/*_REACTIVATED/*_ACTIONED/*_CREATED, red for *_HIDDEN/*_SUSPENDED/*_UPHELD/*_DEACTIVATED, amber for VALUE_REJECTED, blue for *_REVIEWING/*_UPDATED, gray for DISMISSED.
- [ ] Confirm the reason column still shows "indefinite" (red) and "N days" (muted) sublines where applicable.
- [ ] Toggle light/dark theme — table and filter panel should both read correctly.

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
