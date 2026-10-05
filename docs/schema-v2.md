# Schema v2: 34 tables → 25

Status: **week 1 complete (3 Oct 2026)**. Designed, built and verified on a scratch copy of the live data. No app code has changed, nothing has touched the live database, and nothing has been merged.
Branch: `feature/schema-v2` (API repo, from `feature/stories-v1` @ `8c0277f`).

| Week | What | Gate |
|---|---|---|
| 1 | Backup, design, new schema, migrations, data migration, all on a copy | **this document** |
| 2 | App code (API, scripts, mobile) against the scratch schema | sections 2e and 4 |
| 3 | Rehearse the cutover on a fresh backup; go/no-go | sections 2e (separability) and 5 |

## 0. Artefacts

| What | Where |
|---|---|
| Live backups | `D:\BAYLO\backups\baylo-pg-20261003-084921.sql` (Step 1, restore drill passed) and `baylo-pg-20261003-095000.sql` (the current scratch copy, rebuilt after deciding to keep Notification.link). Both: 34 tables, 1959 rows, ledger 1744 = 1744 |
| New schema | `prisma/schema.prisma` (25 models) |
| Migration 1: core | `prisma/migrations/20261003000000_schema_v2_core/migration.sql` |
| Migration 2: ledger (high risk, separable) | `prisma/migrations/20261003000001_schema_v2_ledger/migration.sql` |
| Migration 3: trade (high risk, separable) | `prisma/migrations/20261003000002_schema_v2_trade/migration.sql` |
| Migration 4: audit fixes (schema only, needs core) | `prisma/migrations/20261004000000_schema_v2_audit_fixes/migration.sql` |
| Migration 5: completedAt backfill (data, needs trade) | `prisma/migrations/20261004000001_schema_v2_trade_completed_backfill/migration.sql` |
| Migration 6: drop Trade hide flags (needs trade) | `prisma/migrations/20261004000002_schema_v2_drop_trade_hidden/migration.sql` |
| Scratch builder | `scripts/schema-v2/build-scratch.ts` |
| Verifier | `scripts/schema-v2/verify-v2.ts` |
| Scratch schemas (kept for week 2) | `schema_v2_wk1` (new structure) and `schema_v2_wk1_src` (old structure, same data, untouched reference) |

**The data migration is inside the migrations.** Each migration runs in this order: create the new tables, copy the old data across with `INSERT … SELECT`, assert the counts with `RAISE EXCEPTION`, then drop the old tables. All of that is one file, and Postgres runs a multi-statement migration as one implicit transaction. So `prisma migrate deploy` either lands a whole step or none of it. This was tested: a failure injected after the last statement of migration 2 left the copy exactly as it was. Keeping the copy inside the migration makes each step atomic and lets a step be held back by deleting its folder (section 2e). A separate copy script would need a manual "stop between migrations" at cutover, which `migrate deploy` cannot do.

Every statement is unqualified, with no `public.` and no catalog lookup by name. That lets the same files run against a scratch schema through `search_path`. The builder refuses any file that breaks this rule.

---

## 2a. Where every old column goes

Notation: `Old.col → New.col`. "=" means the same table and the same column. Tables that are renamed keep every column.

### Tables carried over as-is (columns unchanged unless listed)

| Old table | New table | Column changes |
|---|---|---|
| User | User | none (relations only) |
| Follow | Follow | none |
| Message | Message | none; `tradeId` FK now references **Trade** (same ids) |
| Notification | Notification | none. `link` is **kept** on purpose although it is a known 3NF redundancy (see 2c) |
| Review | Review | none; `tradeId` FK now references **Trade** (same ids) |
| Block | Block | none |
| IdVerification | IdVerification | none |
| AdminAction | AdminAction | `reportId → caseId` (FK to ModerationCase; ids unchanged, 0 rows set today) |
| SafeZoneHub | SafeZoneHub | none |
| ItemSafeZone | ItemSafeZone | none |
| Achievement | Achievement | none |
| Story | Story | none |
| StoryView | StoryView | none |
| SwapConfirmationCode | **SwapCode** | renamed, all 9 columns kept; `tradeId` FK references **Trade** |
| PostLike | **Like** | renamed, all 4 columns kept |
| PostComment | **Comment** | renamed, all 6 columns kept |

### Item

| Old column | New |
|---|---|
| id, title, description, category, condition, valueLeaves, valueSetByUser, suggestedLeaves, valuationSource, revaluationCount, status, wantedItems, pickupLat, pickupLng, pickupAddress, moderationHiddenAt, valueRejectionReason, createdAt, updatedAt, userId, isPerishable, quantity, quantityUnit, tradeWithinHours | = |
| images (JSON array in TEXT) | **ItemImage**(itemId, position = array index, url) |
| imageHash | **dropped**: duplicate of ItemImage(position 0).hash, asserted equal on all 51 rows before the drop |
| lookingForCategories (enum[]) | **ItemWantedCategory**(itemId, category) |
| isFeatured, featuredUntil, featuredAt | **dropped**: boosting removed |
| (new) | `bracket`: a STORED GENERATED column, `CASE` over `valueLeaves` (copy three of `BRACKET_CEILINGS`), NULL when valueLeaves is NULL |

### ItemImageHash → ItemImage

| Old | New |
|---|---|
| itemId, position | ItemImage.itemId, position (the same index into the old JSON array) |
| hash | ItemImage.hash (nullable: 179 of 231 photos were never hashed) |

### RefreshToken, PasswordResetToken, EmailVerificationToken → AuthToken

| Old | New |
|---|---|
| RefreshToken.id, userId, tokenHash, familyId, usedAt, revokedAt, expiresAt, createdAt | AuthToken, same names, `type = REFRESH` |
| EmailVerificationToken.id, userId, tokenHash, expiresAt, createdAt | AuthToken, `type = EMAIL_VERIFICATION` |
| PasswordResetToken.id, expiresAt, createdAt | AuthToken, `type = PASSWORD_RESET` |
| PasswordResetToken.token (clear text) | AuthToken.tokenHash = `encode(sha256(token), 'hex')`, the hash `@/lib/auth-tokens` uses |
| PasswordResetToken.email | AuthToken.userId (the User with that email). The email itself is **dropped** (the user row holds it) |

### Offer + TradeRequest → Trade

| Old | New |
|---|---|
| TradeRequest.id | Trade.id |
| Offer.id | Trade.legacyOfferId (unique); also Trade.id when the offer never became a trade |
| Offer.senderId / TradeRequest.senderId | Trade.senderId |
| Offer.receiverId / TradeRequest.receiverId | Trade.receiverId |
| Offer.postId / TradeRequest.requestedItemId | Trade.requestedItemId |
| Offer.offeredItems (client JSON `[{id,title}]`) / TradeRequest.offeredItemId | Trade.offeredItemId, a **real FK** (nullable only for legacy Leaves-only offers). The `title` snapshot is **dropped**: all 39 snapshots equal the item's current title |
| Offer.status | Trade.offerStatus (OfferStatus, NULL = no offer phase) |
| TradeRequest.status | Trade.status (TradeStatus, NULL = not a trade) |
| Offer.message / TradeRequest.message | Trade.message (the trade's copy wins; the two were identical on all 32 pairs) |
| Offer.createdAt | Trade.createdAt (proposal time; TradeRequest.createdAt when there was no offer) |
| TradeRequest.createdAt | Trade.tradeCreatedAt |
| Offer.updatedAt / TradeRequest.updatedAt | Trade.updatedAt = the later of the two |
| TradeRequest.completedAt, hiddenBySender, hiddenByReceiver, safeZoneHubId, meetupHubId, meetupAt, meetupNote, meetupProposedBySender, meetupAgreedAt, bridgeFeePaidBySender | Trade, same names (the two hidden flags are then dropped by migration 6, section 2g) |
| Offer.offeredLeaves / TradeRequest.offeredLeaves | Trade.offeredLeaves (the trade's settled figure wins; it differs on 4 pairs, see 2c) |
| Offer.bridgeFeeLeaves / TradeRequest.bridgeFeeLeaves | Trade.bridgeFeeLeaves (identical on all pairs, asserted) |
| Offer.offeredBracket, targetBracket, consentAt, policyVersion | Trade, same names |

### TaskCompletion → LeafTransaction

| Old | New |
|---|---|
| TaskCompletion.task, refId | LeafTransaction.task, taskRefId, stamped on the TASK_REWARD row that paid it |
| TaskCompletion.leaves | LeafTransaction.amount (asserted equal) |
| TaskCompletion.userId | LeafTransaction.userId |
| TaskCompletion.createdAt | the ledger row's own createdAt is kept (≤ 0.27 s apart). For denied (0-Leaf) completions, a new row with createdAt = eventAt = the completion's createdAt |
| TaskCompletion.id | **dropped** for paid rows (nothing referenced it); reused as the ledger id for the 4 denied rows |
| LeafTransaction.offerId | **remapped** into tradeId (migration 3), then the column is dropped |
| LeafTransaction.contractId | = (legacy, 2 rows) |

### Report + ListingAppeal → ModerationCase

| Old | New |
|---|---|
| Report.id / ListingAppeal.id | ModerationCase.id |
| Report.reporterId / ListingAppeal.ownerId | filedById |
| Report.status / ListingAppeal.status | status (one enum, ModerationCaseStatus) |
| Report.targetType, targetId, category, notes, openKey | = (REPORT only) |
| ListingAppeal.itemId, message, actionId | = (LISTING_APPEAL only) |
| ListingAppeal.kind | appealKind |
| Report.resolvedById / ListingAppeal.decidedById | decidedById |
| Report.resolvedAt / ListingAppeal.decidedAt | decidedAt |
| Report.resolutionNote / ListingAppeal.decisionReason | decisionNote |
| createdAt | = |

### Organization + OrganizationMember → Organization

| Old | New |
|---|---|
| Organization.* | = |
| OrganizationMember (role OWNER, status ACTIVE).userId | Organization.ownerId |
| OrganizationMember (OWNER, ACTIVE).joinedAt | Organization.ownerJoinedAt (`joinedAt`, else `invitedAt`; all 13 had joinedAt) |
| OrganizationMember.id, role, status, invitedAt (owner rows) | **dropped**: implied by ownerId |
| every non-owner OrganizationMember row | **dropped** (2c) |

### QuestAssignment + UserAchievement → UserProgress

| Old | New |
|---|---|
| QuestAssignment.id, userId, periodStart, tier, quest, rewardLeaves, completedAt, createdAt | UserProgress, same names, `type = QUEST` |
| UserAchievement.id, userId, achievementId, unlockedAt, displayOrder, homeDisplayOrder | UserProgress, same names, `type = ACHIEVEMENT`; createdAt = unlockedAt |

### Dropped tables

| Table | Rows | Why |
|---|---|---|
| CommentLike | 0 | Unused (web-only route). The migration **refuses to run** if it has rows by cutover |
| ConversationHide | 0 | The hidden-conversation feature is removed. Same guard |
| DeferredContract | 1 (FULFILLED) | DPAs retired 16 Sep 2026. The migration refuses if any row is still open. The ledger pair keeps `contractId` |

Enums dropped: ContractStatus, ReportStatus, ListingAppealStatus (both replaced by ModerationCaseStatus), OrgMemberRole, OrgMemberStatus. Enums added: AuthTokenType, ModerationCaseType, ModerationCaseStatus, ProgressType. LeafTxType keeps CONTRACT_PAY, CONTRACT_COLLECT and FEATURE_BOOST, because ledger rows use them.

## 2b. The merges: discriminators, nullability, uniqueness, FKs

Every per-type rule below is a **CHECK constraint** in the migrations. Prisma neither models nor diffs CHECK constraints, so they are invisible to `migrate diff`, the same situation as the old GIN index.

**AuthToken**, `type ∈ {REFRESH, PASSWORD_RESET, EMAIL_VERIFICATION}`

| Column | REFRESH | PASSWORD_RESET | EMAIL_VERIFICATION |
|---|---|---|---|
| userId, tokenHash, expiresAt, createdAt | required | required | required |
| familyId | **required** | NULL | NULL |
| usedAt, revokedAt | optional | NULL | NULL |

- Checks: `(type='REFRESH') = (familyId IS NOT NULL)` and `type='REFRESH' OR (usedAt IS NULL AND revokedAt IS NULL)`.
- Uniqueness: `tokenHash` is unique across all types.
- FK: userId → User, Cascade.
- Indexes: (userId, type), (familyId).

**Trade**: two phase columns rather than one discriminator.

| Kind of row | offerStatus | status | tradeCreatedAt | offeredItemId | legacyOfferId |
|---|---|---|---|---|---|
| Live or closed offer, never a trade | PENDING / DECLINED / WITHDRAWN / EXPIRED / ACCEPTED (legacy) | NULL | NULL | nullable (legacy `[]`) | = id |
| Offer that became a trade | ACCEPTED | ACCEPTED / CONFIRMING / COMPLETED / CANCELLED | set | required | the Offer id ≠ id |
| Direct trade request, no offer (legacy, seeds) | NULL | any TradeStatus | set (= createdAt) | required | NULL |

- Checks: `offerStatus IS NOT NULL OR status IS NOT NULL`, `(status IS NULL) = (tradeCreatedAt IS NULL)` and `status IS NULL OR offeredItemId IS NOT NULL`.
- Uniqueness: `legacyOfferId`.
- FKs: sender and receiver → User (Restrict); requestedItemId and offeredItemId → Item (**Restrict**; Offer.post used to Cascade); safeZoneHubId and meetupHubId → SafeZoneHub (Restrict). Message, Review and SwapCode reference Trade with the same delete rules they had toward TradeRequest (SetNull, Restrict, Cascade).
- Why two columns: a single status cannot represent the 11 legacy offers that were ACCEPTED and never became trades without inventing a new state. The two columns are also exactly the old semantics, which made the copy lossless and verifiable.

**LeafTransaction.task**

- Checks: `(task IS NULL) = (taskRefId IS NULL)` and `task IS NULL OR type = 'TASK_REWARD'`.
- Uniqueness: `@@unique([userId, task, taskRefId])`. Postgres treats NULLs as distinct, so non-task rows are outside the constraint without a partial index. The old once-per-task rule (`refId ""` for one-time tasks) carries over unchanged.

**ModerationCase**, `type ∈ {REPORT, LISTING_APPEAL}`

| Column | REPORT | LISTING_APPEAL |
|---|---|---|
| filedById, status, createdAt | required | required |
| targetType, targetId, category | required | NULL |
| notes | optional | NULL |
| openKey | "live" while OPEN/REVIEWING | NULL |
| itemId, appealKind, message, actionId | NULL | required |
| decidedById, decidedAt, decisionNote | optional | optional |
| allowed status | OPEN, REVIEWING, ACTIONED, DISMISSED | OPEN, UPHELD, OVERTURNED, WITHDRAWN |

- Uniqueness: `(filedById, targetType, targetId, openKey)` (one live report per reporter and target; appeal rows are all NULL there) and `actionId` (one appeal per decision; report rows are NULL).
- FKs: filedById → User (Cascade), itemId → Item (Cascade), decidedById → User (SetNull), and AdminAction.caseId → ModerationCase (SetNull). Since migration 4: actionId → AdminAction (Restrict).
- A report's target stays a (type, id) pair, **deliberately not an FK** (a report must survive its target).

**UserProgress**, `type ∈ {QUEST, ACHIEVEMENT}`

| Column | QUEST | ACHIEVEMENT |
|---|---|---|
| periodStart, tier, quest, rewardLeaves | required | NULL |
| completedAt | optional | NULL |
| achievementId, unlockedAt | NULL | required |
| displayOrder, homeDisplayOrder | NULL | optional |

- Uniqueness: `(userId, periodStart, quest)` and `(userId, achievementId)`. Both are plain unique indexes, safe because the other type's columns are NULL. The `completeQuest()` claim guard and the criteria engine's `skipDuplicates` insert keep their constraints.
- FKs: userId → User (Cascade), achievementId → Achievement (Cascade).

**Organization.ownerId**: required, FK → User (Restrict), indexed. A person may own several orgs (no unique constraint).

**ItemImage / ItemWantedCategory**:
- ItemImage PK is (itemId, position) and ItemWantedCategory PK is (itemId, category), both Cascade from Item.
- ItemWantedCategory's `category` B-tree index replaces the GIN index on the array.
- The PK makes a repeated category impossible. The array never prevented repeats, though none exist today.

## 2c. Data-loss check: what does not survive (live, 3 Oct 2026)

Every count below was measured on live (read-only) and confirmed by `verify-v2.ts` on the copy.

| What | Count | Detail |
|---|---|---|
| Non-owner **OrganizationMember** rows | **3** | All on the "Baylo" org: Jamaica Jumuad `jmjumuad2@gmail.com` (STAFF, ACTIVE), User3 `johnsaplad61@gmail.com` (STAFF, PENDING invite), Vinsento `vinsento@gmail.com` (STAFF, ACTIVE). These are the "3 extra" of 16 rows for 13 orgs; every org has exactly one ACTIVE OWNER |
| ORG_INVITE **Notification** about a removed invitation | **1** | User3's pending invite. Deleted, following the invite routes' own rule ("a notification about an invitation that no longer exists points at nothing") |
| **DeferredContract** | **1** | `cmtvo24bs0004bs73o52g36uo`, FULFILLED (18 Leaves, paid in full 10 Sep). Its CONTRACT_PAY / CONTRACT_COLLECT ledger pair stays and keeps `contractId`. The row survives in the backup file |
| CommentLike / ConversationHide | 0 / 0 | The migration refuses to run if either gains rows |
| Item boost columns | 8 items | `featuredUntil` / `featuredAt` set on 8 items (`isFeatured` false on all; no boost is live). The 8 FEATURE_BOOST ledger rows (−16 Leaves) **stay** |
| Item.imageHash | 51 values | No information lost: each equals ItemImage position 0's hash (asserted) |
| ~~Notification.link~~ | 0 | **Kept** (decision of 3 Oct 2026). It is a known 3NF redundancy, since the web URL is derivable from `type` + `entityType`/`entityId`. It is kept on purpose because about 20 web/API routes still write it and the web admin and dashboard read it. Removing it is a separate change, not part of v2 |
| PasswordResetToken.email, and the clear token | 2 rows | Both rows are kept as hashed AuthTokens owned by the resolved user. Both are already expired. The email is derivable from the user row |
| Offer.offeredItems title snapshot | 39 values | All equal the item's current title (verified) |
| Offer.offeredLeaves on paired offers | **4** | Trades `cmqj07kiw…`, `cmqj8qlgq…`, `cmqj986fj…` (800, CANCELLED) and `cmqke0ah9…` (500, COMPLETED): the offer said NULL and the trade said 800/500. The trade's figure is what settlement read and is kept |
| Offer.updatedAt on paired offers | 32 | Within 0.25 s of the trade's creation, so it adds nothing; Trade.updatedAt keeps the later stamp |
| TaskCompletion.createdAt on paid rows | 49 | The paying ledger row's createdAt (≤ 0.27 s apart) is kept instead |
| OrganizationMember id/role/status/invitedAt of owners | 13 | Implied by ownerId |

Nothing else is lost. `verify-v2.ts` section 2 compares every carried-over table row for row on every shared column, both ways, and found **0 differences**.

**One pre-existing drift** is unrelated to v2 but shows up in any `migrate diff`: `Achievement.updatedAt` has a DB default and the unique index is named `Achievement_key` (Prisma expects `Achievement_key_key`). It came from the achievements migration and is present identically on the untouched old copy. v2 does not fix it; it is a one-line follow-up if wanted.

## 2d. The Leaves ledger

**The invariant cannot move, by construction.** `awardTask()` always wrote a paid TaskCompletion in the same transaction as exactly one TASK_REWARD row of the same amount. The ledger migration therefore inserts no ledger row for a paid completion. It finds the existing row and stamps `(task, taskRefId)` on it, in this order:
1. The candidates are rows with the same user, TASK_REWARD type and amount, unclaimed, and written within 5 s of the completion.
2. A candidate whose description names a different task is excluded.
3. The remaining candidates are ranked by `tradeId = refId`, then by a description naming this task, then by smallest time gap, then by id.

The only rows it inserts are the 4 **denied** completions (`leaves = 0`, repeat partner or weekly cap). They are inserted at **amount 0**, so the denial stays permanent, exactly as TaskCompletion made it. Asserted before TaskCompletion is dropped:
- the number of task rows on the ledger equals the TaskCompletion count (53 = 53);
- the sum of task rows equals the sum of `TaskCompletion.leaves` (715);
- every (user, task, refId, leaves) completion is present;
- no TASK_REWARD row is left without a task (0);
- no pre-existing ledger row changed user, type, amount, description or time (verified separately: 0).

Result on the copy: SUM(User.leaves) **1744** = SUM(amount) **1744**; balances + escrow **1804** = issuance **1804**; escrow from the ledger **60** = held on rows **60**. All five figures are identical to the old copy. Per-user, balance equals ledger sum for every user on both copies.

**References from ledger rows to removed or merged tables:**
- **`offerId` (10 rows: 6 BRIDGE_FEE_HOLD, 4 BRIDGE_FEE_RELEASE).** Migration 3 rewrites each to `tradeId = Trade.id WHERE legacyOfferId = offerId`, asserts none is left unresolved, then drops `offerId`. The original offer id stays recoverable through `Trade.legacyOfferId`. Because a deal is now one row, the fee's HOLD, RELEASE and PAID rows all key on the same `tradeId` for the deal's whole life. Before, they split across offerId and tradeId.
- **`tradeId` (20 rows).** Unchanged: a TradeRequest id is its Trade's id. All resolve (verified).
- **`contractId` (2 rows: CONTRACT_PAY −18, CONTRACT_COLLECT +18).** Kept as a frozen legacy column, so the pair still explains itself. It points at the dropped DeferredContract by design, and the pair nets to zero.
- The escrow cross-check moves from Offer + TradeRequest to Trade: `status IS NULL AND offerStatus = 'PENDING' AND offeredBracket < targetBracket` (held on a proposer-pays offer) plus `status IN (PENDING, ACCEPTED, CONFIRMING)` (live trades). Migration 3 asserts the old and new formulas agree (60 = 60).

## 2e. Code impact (week 2)

The API keeps its **wire shapes**: `/api/v1` responses keep `images: string[]`, `lookingForCategories`, offer and trade objects and so on, assembled from the new tables. So most mobile files need **no** change, and the mobile list below is only what must change. File lists come from a grep of `src/`, `scripts/` and the mobile app; the full lists are in the appendix.

| # | Change | API `src/` | API `scripts/` | Mobile | Risk |
|---|---|---|---|---|---|
| 18 | **Offer + TradeRequest → Trade** | ~45 files: all offer/trade routes, `lib/offers`, `trade-participant`, `trade-fee-release`, `trade-reward`, `meetup`, `quests`, `achievements`, `trust-tiers`, `reputation-*`, `recommend`, `organizations`, `v1/item`, web dashboard. **Protected:** `leaves.ts` (`availableLeaves()` sums PENDING Offer.offeredLeaves), `bridge-fee.ts` (writes ledger `offerId`, `isClosed()` keys on it, held-escrow query reads Offer + TradeRequest) | ~26 (`lib/ledger-invariant.ts`, every settlement/trade verify) | none if wire shapes hold; `MessagePayloads.tsx`, `api/offer.ts`, `api/trades.ts` must keep working with **old offer ids embedded in chat JSON** (resolve `id` then `legacyOfferId`) | **HIGHEST**: moves currency; rivals/withdraw lookups switch from JSON `contains` to `offeredItemId =`; Item delete becomes Restrict |
| 20 | **TaskCompletion → LeafTransaction** | `lib/tasks.ts` (`claimCompletion()` becomes a `leafTransaction.createMany({ skipDuplicates })` that **is** the ledger write; zero-Leaf denial rows), `lib/task-constants`, `lib/quests`, `api/user/delete-account.ts`. **Protected:** `leaves.ts` / `bridge-fee.ts` only via #18 | `backfill-task-rewards`, `verify-task-awards`, `diagnose-weekly-cap`, `analyze-safezone-faucet`, `lib/ledger-invariant` | none | **HIGHEST**: the claim and the payment become one write; the weekly-cap window must still ignore 0-Leaf rows (it sums amounts, so it does) |
| 2 | 3 token tables → AuthToken | `lib/auth-tokens.ts`, `lib/email-verification.ts`, `api/auth/{forgot-password,reset-password,refresh,revoke}`, `delete-account` | 4 verify scripts | none | Medium: **reset must hash the presented token** and look up by userId+type |
| 3 | SwapCode rename | 3 confirm routes, `v1/trades`, `delete-account` | 6 | none | Low (mechanical) |
| 9–11 | Item: images → ItemImage, wanted → ItemWantedCategory, bracket, boosts removed | ~35 for images (every `JSON.parse(item.images)`, `lib/image-hashes`, `offer-check`, `item-visibility`, `v1/item`, admin, web); ~6 for wanted (`category-match.ts`: `hasSome` becomes a join); boosts: `lib/featured.ts`, `api/v1/featured`, `api/v1/items/[id]/boost`, `v1/home`, `spotlight`, `profile/me` | ~30 for images (seeds, verify), `expire-featured.ts` (delete) | boosts: `api/featured.ts`, boost UI in `item.tsx` / `profile.tsx` / `ExclusiveTile.tsx` / `achievements.tsx` (remove) | Medium, because of breadth. Images are read almost everywhere; a single `itemImages()` helper should own the shape |
| 16–17 | Like / Comment renames; CommentLike gone | 7 routes incl. `posts/[id]/comments/[commentId]/like` (delete) | 2 | none | Low |
| — | ConversationHide gone | `api/messages`, `v1/messages/conversations`, web messages page | — | none | Low |
| 21 | Report + ListingAppeal → ModerationCase | `lib/moderation`, `appeals`, `admin-appeals`, `admin-reports`, admin pages and routes, `v1/reports`, `v1/items/[id]/appeal`, `items/[id]` | 6 | none | Medium: status enum values merge |
| 23 | OrganizationMember → Organization.ownerId | `lib/organizations.ts` (`requireOrgMember` / `requireOrgOwner` become `ownerId =`), `trade-participant`, `inbox`, `perishable`, `pusher/auth`, `v1/organizations/**` (**members routes deleted**), `v1/notifications`, `profile/[id]` | 8 | `api/organizations.ts` (members/invite calls), `OrgStorefrontHeader.tsx`, `api/notifications.ts` (`org_invite`) | Medium |
| 25 | QuestAssignment + UserAchievement → UserProgress | `lib/quests`, `lib/achievements`, `v1/achievements` (+ **raw SQL in `achievements/display`**, which must keep the schema-qualified table, now `"UserProgress"`), `v1/home`, `profile/*` | ~9 | none | Medium (raw SQL) |
| — | DeferredContract gone | `blocking.ts`, `trust-tiers.ts`, `admin/anomalies`, `admin/listings/[id]`. **Protected:** `v1/contracts/**` stubs are pure 410 responses with no DB access, so **no code change**; one comment mentions the table | 4 | none | Low |
| — | Item.bracket | optional: `trade-rules.ts` (**protected**, pure functions, **no change needed**), `offer-check`, `valuation-server`, admin can read the column instead of `bracketOf()` | — | optional | Low |

**Raw SQL.** Every `$queryRaw` / `$executeRaw` naming a renamed or dropped table must change, and must stay schema-qualified (see the 23 Sep incident). Known sites: `api/v1/achievements/display` (UserAchievement), `admin/anomalies` (page and route), `v1/home`, `v1/messages/conversations` (ConversationHide), `v1/profile/me`, `v1/profile/[id]`, `scripts/check-new-enum-rows.ts`, `scripts/verify-moderation.ts`.

**Protected files, summarised:**

| File | Must change? | Why |
|---|---|---|
| `leaves.ts` | yes, #18 | Offer aggregate becomes Trade (`offerStatus = 'PENDING'`) |
| `bridge-fee.ts` | yes, #18 and #20 | Ledger `offerId` becomes `tradeId`; Offer/TradeRequest queries become Trade |
| `trade-rules.ts` | no | pure functions |
| `v1/contracts` stubs | no (comment only) | — |

### Separability (the go/no-go)

#18 and #20 are their own migrations, and **nothing in core depends on either**. Rehearsed on separate scratch copies, all built from the same backup and all passing `verify-v2.ts` with the ledger intact:

| Shipped | Tables | Result |
|---|---|---|
| core + ledger + trade | 25 | VERIFIED |
| core only | 27 (TaskCompletion, Offer, TradeRequest stay) | VERIFIED |
| core + ledger (trade held back) | 26 | VERIFIED |
| core + trade (ledger held back) | 26 | VERIFIED |

To hold one back:
1. Delete its migration folder.
2. Restore its old models in `schema.prisma` from git (`git show feature/stories-v1:prisma/schema.prisma`). For trade, that means Offer and TradeRequest, with Message, Review and SwapCode relations back to TradeRequest. For ledger, it means TaskCompletion, and removing `task` / `taskRefId`.
3. Ship only the week-2 code for the rest.

Week-2 code should keep #18 and #20 on their own commits for the same reason.

## 2f. Audit fixes (migration 4, 4 Oct 2026)

These come from a read-only audit of the copy. The migration is schema only, writes no rows, and asserts its preconditions first.

- **Dropped two redundant indexes.** Each one is the leading column of another index on the same table:
  - `LeafTransaction_userId_idx` is covered by (userId, createdAt), (userId, eventAt) and the unique (userId, task, taskRefId);
  - `ModerationCase_filedById_idx` is covered by the unique (filedById, targetType, targetId, openKey).
- **Added the FK `ModerationCase.actionId` → AdminAction (Restrict).** Audit rows are never deleted by the app, so the FK costs nothing. Three test cleanups (verify-appeals, verify-moderation, verify-value-review) now delete cases before audit rows.
- **Added two CHECKs on Item:**
  - `Item_perishable_window_check`: `isPerishable = (tradeWithinHours IS NOT NULL)`.
  - `Item_pickup_shape_check`: both coordinates or neither, and an address only with a pin. A pin **without** an address stays legal, because the API accepts one (`pickupAddress` is optional in validation).

## 2g. Trade.completedAt backfill and the hide flags (migrations 5 and 6, 4 Oct 2026)

Both depend on the trade migration. `build-scratch.ts --skip trade` skips them too.

- **`20261004000001_schema_v2_trade_completed_backfill`** fills `completedAt` on COMPLETED trades where it is NULL, and only there. That is 12 rows in the 3 Oct backup, all completed before the column was added on 25 Sep.
  - **Source:** the earliest ledger row that paid out for the trade's settlement (TASK_REWARD, TRADE_REWARD, TRADE_SPEND/RECEIVE or BRIDGE_FEE_PAID, with amount ≠ 0). Otherwise the trade's `updatedAt` (3 of the 12).
  - Denied 0-Leaf task rows are excluded, because they carry the 24 Aug migration time.
  - The migration asserts that no COMPLETED trade is left NULL and that no value falls before `tradeCreatedAt`.
  - **Live gets this at cutover:** `migrate deploy` runs it against whatever legacy NULLs live has then. Settlement has written `completedAt` itself since 25 Sep, so the set should still be these 12.
- **`20261004000002_schema_v2_drop_trade_hidden`** drops `hiddenBySender` and `hiddenByReceiver`.
  - Only the web dashboard ever set them, and no row on live had either one true on 4 Oct.
  - The migration refuses if any row is hidden by then, because dropping the columns would unhide it.
  - `PATCH /api/trades/[id] {action: "hide"}` now answers **410**, and the dashboard no longer offers "Remove".

## 3. Verification on the copy (Step 3 result)

`npx tsx --env-file=.env scripts/schema-v2/verify-v2.ts --schema schema_v2_wk1` → **SCHEMA V2 VERIFIED**, 0 failures:

- **Counts:** every carried table is equal. AuthToken 429 = 410 + 17 + 2. ItemImage 231 = photos, 52 hashed = ItemImageHash. ItemWantedCategory 239. Trade 65 = 36 + 61 − 32 paired (32 offer+trade, 29 offer only, 4 trade only). ModerationCase 2 = 0 + 2. UserProgress 105 = 75 + 30. LeafTransaction 116 = 112 + 4 denied. Notification 243 = 244 − 1 invite.
- **Rebuilt and re-verified** from `baylo-pg-20261003-095000.sql` after the decision to keep `Notification.link`. All results below hold; Notification is now carried with all 10 columns.
- **Row for row:** 19 carried tables compared on every shared column, EXCEPT ALL both ways: 0 differences.
- **FKs:** 49 foreign keys, all validated, 0 orphans. Soft references resolve: ledger tradeId → Trade, notification trade/meetup → Trade, audit TRADE / LISTING_APPEAL targets, appeal actionId → AdminAction. The only by-design dangling reference is `contractId` on the 2 DPA rows.
- **Ledger:** 1744 = 1744, 1804 = 1804, 60 = 60, identical to the old copy.
- **Bracket:** equals `bracketOf(valueLeaves)` on all 223 items, and is a STORED GENERATED column.
- **Samples, field by field:** 10/10 items (with photos and hashes in order, wanted categories, bracket), 10/10 trades (4 offer+trade, 3 offer only, 3 trade only), 10/10 users (every column plus tokens, progress, ledger sum, task completions, deals, likes, cases).
- **Schema match:** `prisma migrate diff` from the copy to `schema.prisma` shows only the pre-existing Achievement drift (2c). `prisma migrate status` on the copy reports up to date (30 migrations recorded).
- **Atomicity:** migration 2 with a failure injected after its last statement left TaskCompletion, the ledger (112 rows) and the column set untouched.
- **Live untouched:** live `public` still has the 34 old tables, with counts equal to the backup and ledger 1744 = 1744.

## 4. Using the scratch schema in week 2

- App: `DATABASE_URL=…?schema=schema_v2_wk1`, then `npx prisma generate`. Restart `next dev`, because a running server keeps the old client.
- **Raw SQL resolves through `search_path` to `public` (live).** Every raw statement written in week 2 must be schema-qualified, or the code must run against a database where public is not live.
- Rebuild from a fresher backup: `npx tsx --env-file=.env scripts/schema-v2/build-scratch.ts <backup.sql> --schema schema_v2_wk1 --replace`, then run `prisma migrate resolve --applied` for each migration with `?schema=schema_v2_wk1`, then `verify-v2.ts`.

## 4b. Week 2, Phase A (core): what changed beyond the table renames

- **Each phase is a consistent set.** On the Phase A commit, `schema.prisma` models the core-only database (Offer, TradeRequest and TaskCompletion are still there), and the ledger and trade migrations wait in `prisma/schema-v2-pending/`. Phases B and C each move their migration back and change the schema in the same commit. `build-scratch.ts` applies only what is in `prisma/migrations/`.
- **Raw SQL is pinned to the copy.** For a `schema_v2_*` URL, `src/lib/prisma.ts` connects with `search_path="<schema>",extensions`. An unqualified `$queryRaw`/`$executeRaw` therefore resolves to the copy, and `public` (live) is not on the path. This closes the 23 Sep raw-SQL bug class at the connection instead of per call site. `verify-perishable-schema-qualification.ts` now proves the inverted property.
- **Wire shapes kept.**
  - `images` stays a `string[]` (v1) or a JSON string (legacy routes and admin), built from ordered `ItemImage` rows via `ITEM_IMAGES`; `imageHash` = the position-0 hash.
  - `lookingFor` / `lookingForCategories` are built from `ItemWantedCategory`.
  - `featuredUntil` is always `null`.
  - Comment `likeCount`/`liked` are always 0/false.
  - `openContracts` is always `[]`.
  - Org `role` is always `"OWNER"`, `staffCount` 1, `invitations` `[]`.
  - Report, audit and user payloads keep their old keys (`reporter`, `resolvedAt`, `resolutionNote`, `reportId`, `_count.reportsMade`).
- **Retired endpoints answer instead of disappearing**, the v1/contracts convention:
  - `GET /api/v1/featured` → an empty list, so old builds draw nothing;
  - `POST /api/v1/items/[id]/boost` → 410;
  - staff invite, role and remove (`members` POST, `members/[memberId]` PATCH/DELETE) → 410; `members` GET returns the owner alone;
  - `DELETE /api/messages` (hide a conversation) → 410;
  - `posts/[id]/comments/[commentId]/like` → deleted, since it was web-only.
- **Shop permissions** (act as, post, trade, chat, Pusher channel, inbox, self-trade refusal) read `Organization.ownerId`. The tests that exercised staff now move ownership to stand in for "joins / is removed".
- **Achievement display** writes are typed `userProgress.updateMany` calls scoped by `type`; the raw SQL and its column feature-detect are gone.
- **Retired scripts:** `expire-featured.ts`, and `backfill-null-display-order.ts` (a one-off live repair of three rows, done 23 Sep).

## 5. Week-3 cutover (outline, not yet rehearsed against live)

1. Freeze writes (maintenance) and take a backup with `backup-baylo-pg.ps1`, which must verify.
2. Rebuild the scratch copy from **that** backup and run `verify-v2.ts`. The preconditions in each migration (open DPAs, CommentLike/ConversationHide rows, org owners, offer shapes) catch any drift since 3 Oct.
3. `prisma migrate deploy` on live (the three migrations, or only the ones that passed the go/no-go), then deploy the week-2 code.
4. Recovery path: restore the step-1 backup (`pg-backup.ts restore`) and redeploy the old code.

---

## Appendix: files referencing each changed model

Generated by grep over `baylo/src`, `baylo/scripts`, `baylo-mobile/src` and `baylo-mobile/app` (generated Prisma client excluded). Over-inclusive by design: a match is a file to open, not necessarily a file to change.

### #18 Trade (Offer, TradeRequest) (93)

- `baylo-mobile/app/offer.tsx`
- `baylo-mobile/app/story.tsx`
- `baylo-mobile/app/trades-history.tsx`
- `baylo-mobile/src/api/offer.ts`
- `baylo-mobile/src/api/quests.ts`
- `baylo-mobile/src/api/trades.ts`
- `baylo-mobile/src/api/types.ts`
- `baylo-mobile/src/components/home/FeedCard.tsx`
- `baylo-mobile/src/components/messages/MessagePayloads.tsx`
- `baylo-mobile/src/components/offer/OfferSheet.tsx`
- `baylo-mobile/src/components/offer/states.tsx`
- `baylo-mobile/src/components/trades/copy.ts`
- `baylo-mobile/src/components/trades/present.ts`
- `baylo/scripts/analyze-safezone-faucet.ts`
- `baylo/scripts/cancel-backfill-trades.ts`
- `baylo/scripts/check-new-enum-rows.ts`
- `baylo/scripts/diagnose-weekly-cap.ts`
- `baylo/scripts/lib/ledger-invariant.ts`
- `baylo/scripts/refresh-demo-perishables.ts`
- `baylo/scripts/verify-bracket-libs.ts`
- `baylo/scripts/verify-bracket-trading.ts`
- `baylo/scripts/verify-id-verification.ts`
- `baylo/scripts/verify-meetup-both-sides.ts`
- `baylo/scripts/verify-meetup-plan.ts`
- `baylo/scripts/verify-moderation.ts`
- `baylo/scripts/verify-org-bridge-release-http.ts`
- `baylo/scripts/verify-org-settlement-http.ts`
- `baylo/scripts/verify-org-trading-http.ts`
- `baylo/scripts/verify-quests.ts`
- `baylo/scripts/verify-recommend.ts`
- `baylo/scripts/verify-safezone-faucet.ts`
- `baylo/scripts/verify-settle-and-code-http.ts`
- `baylo/scripts/verify-settlement-offeredleaves.ts`
- `baylo/scripts/verify-settlement-tx.ts`
- `baylo/scripts/verify-swap-code-and-settle.ts`
- `baylo/scripts/verify-task-awards.ts`
- `baylo/scripts/verify-trust-tier.ts`
- `baylo/scripts/verify-v1-endpoints.ts`
- `baylo/scripts/verify-valuation.ts`
- `baylo/src/app/admin/anomalies/page.tsx`
- `baylo/src/app/api/admin/anomalies/route.ts`
- `baylo/src/app/api/admin/trades/[id]/reverse-reward/route.ts`
- `baylo/src/app/api/items/[id]/route.ts`
- `baylo/src/app/api/offers/[id]/route.ts`
- `baylo/src/app/api/offers/route.ts`
- `baylo/src/app/api/reviews/route.ts`
- `baylo/src/app/api/trades/[id]/confirm/start/route.ts`
- `baylo/src/app/api/trades/[id]/confirm/status/route.ts`
- `baylo/src/app/api/trades/[id]/confirm/submit/route.ts`
- `baylo/src/app/api/trades/[id]/route.ts`
- `baylo/src/app/api/trades/route.ts`
- `baylo/src/app/api/user/delete-account.ts`
- `baylo/src/app/api/v1/items/[id]/route.ts`
- `baylo/src/app/api/v1/offers/[id]/withdraw/route.ts`
- `baylo/src/app/api/v1/profile/[id]/route.ts`
- `baylo/src/app/api/v1/profile/me/route.ts`
- `baylo/src/app/api/v1/trades/[id]/meetup/accept/route.ts`
- `baylo/src/app/api/v1/trades/[id]/meetup/route.ts`
- `baylo/src/app/api/v1/trades/route.ts`
- `baylo/src/app/auth/login/page.tsx`
- `baylo/src/app/auth/register/page.tsx`
- `baylo/src/app/dashboard/baylo-dashboard.tsx`
- `baylo/src/app/dashboard/impact/page.tsx`
- `baylo/src/app/dashboard/page.tsx`
- `baylo/src/app/dashboard/shelf/page.tsx`
- `baylo/src/app/dashboard/tradeplace/TradeplaceClient.tsx`
- `baylo/src/app/dashboard/tradeplace/page.tsx`
- `baylo/src/app/dashboard/trades/TradesClient.tsx`
- `baylo/src/app/dashboard/trades/page.tsx`
- `baylo/src/components/chat-renderers.tsx`
- `baylo/src/lib/achievements.ts`
- `baylo/src/lib/admin-reports.ts`
- `baylo/src/lib/blocking.ts`
- `baylo/src/lib/bridge-fee.ts`
- `baylo/src/lib/chat-helpers.ts`
- `baylo/src/lib/item-visibility.ts`
- `baylo/src/lib/leaves.ts`
- `baylo/src/lib/meetup.ts`
- `baylo/src/lib/offers.ts`
- `baylo/src/lib/organizations.ts`
- `baylo/src/lib/perishable.ts`
- `baylo/src/lib/quests.ts`
- `baylo/src/lib/recommend.ts`
- `baylo/src/lib/reputation-config.ts`
- `baylo/src/lib/reputation-gate.ts`
- `baylo/src/lib/tasks.ts`
- `baylo/src/lib/trade-fee-release.ts`
- `baylo/src/lib/trade-participant.ts`
- `baylo/src/lib/trade-reward.ts`
- `baylo/src/lib/trust-tiers.ts`
- `baylo/src/lib/v1/item.ts`
- `baylo/src/lib/validation.ts`
- `baylo/src/lib/verification.ts`

### #20 Ledger (TaskCompletion, LeafTransaction, offerId/contractId) (69)

- `baylo-mobile/app/offer.tsx`
- `baylo-mobile/src/api/offer.ts`
- `baylo-mobile/src/api/pusher.ts`
- `baylo-mobile/src/api/trades.ts`
- `baylo-mobile/src/components/messages/MessagePayloads.tsx`
- `baylo-mobile/src/components/trades/present.ts`
- `baylo-mobile/src/components/trades/useOfferDecisionFlow.tsx`
- `baylo/scripts/analyze-safezone-faucet.ts`
- `baylo/scripts/backfill-task-rewards.ts`
- `baylo/scripts/cancel-backfill-trades.ts`
- `baylo/scripts/check-new-enum-rows.ts`
- `baylo/scripts/diagnose-weekly-cap.ts`
- `baylo/scripts/grant-demo-leaves.ts`
- `baylo/scripts/lib/ledger-invariant.ts`
- `baylo/scripts/migrate-mysql-to-postgres.ts`
- `baylo/scripts/seed-demo-population.ts`
- `baylo/scripts/verify-bracket-libs.ts`
- `baylo/scripts/verify-bracket-trading.ts`
- `baylo/scripts/verify-email-verification.ts`
- `baylo/scripts/verify-id-verification.ts`
- `baylo/scripts/verify-mobile-auth.ts`
- `baylo/scripts/verify-moderation.ts`
- `baylo/scripts/verify-org-bridge-release-http.ts`
- `baylo/scripts/verify-org-cloudinary.ts`
- `baylo/scripts/verify-org-http.ts`
- `baylo/scripts/verify-org-settlement-http.ts`
- `baylo/scripts/verify-orgs-and-perishables.ts`
- `baylo/scripts/verify-quests.ts`
- `baylo/scripts/verify-safezone-faucet.ts`
- `baylo/scripts/verify-settle-and-code-http.ts`
- `baylo/scripts/verify-settlement-offeredleaves.ts`
- `baylo/scripts/verify-settlement-tx.ts`
- `baylo/scripts/verify-swap-code-and-settle.ts`
- `baylo/scripts/verify-task-awards.ts`
- `baylo/scripts/verify-token-auth.ts`
- `baylo/scripts/verify-v1-endpoints.ts`
- `baylo/scripts/verify-valuation.ts`
- `baylo/src/app/admin/anomalies/page.tsx`
- `baylo/src/app/api/admin/anomalies/route.ts`
- `baylo/src/app/api/admin/organizations/[id]/route.ts`
- `baylo/src/app/api/admin/trades/[id]/reverse-reward/route.ts`
- `baylo/src/app/api/items/route.ts`
- `baylo/src/app/api/leaves/route.ts`
- `baylo/src/app/api/offers/[id]/route.ts`
- `baylo/src/app/api/offers/route.ts`
- `baylo/src/app/api/trades/[id]/confirm/submit/route.ts`
- `baylo/src/app/api/user/delete-account.ts`
- `baylo/src/app/api/user/route.ts`
- `baylo/src/app/api/v1/offers/[id]/withdraw/route.ts`
- `baylo/src/app/api/v1/profile/me/route.ts`
- `baylo/src/app/api/v1/trades/route.ts`
- `baylo/src/app/dashboard/_shell/ChatDock.tsx`
- `baylo/src/app/dashboard/baylo-dashboard.tsx`
- `baylo/src/app/dashboard/tradeplace/TradeplaceClient.tsx`
- `baylo/src/app/dashboard/trades/TradesClient.tsx`
- `baylo/src/components/chat-renderers.tsx`
- `baylo/src/lib/achievements.ts`
- `baylo/src/lib/admin-reports.ts`
- `baylo/src/lib/bridge-fee.ts`
- `baylo/src/lib/chat-helpers.ts`
- `baylo/src/lib/featured.ts`
- `baylo/src/lib/offers.ts`
- `baylo/src/lib/organizations.ts`
- `baylo/src/lib/quests.ts`
- `baylo/src/lib/task-constants.ts`
- `baylo/src/lib/tasks.ts`
- `baylo/src/lib/trade-fee-release.ts`
- `baylo/src/lib/trade-reward.ts`
- `baylo/src/lib/verification.ts`

### #2 AuthToken (11)

- `baylo/scripts/verify-email-verification.ts`
- `baylo/scripts/verify-id-verification.ts`
- `baylo/scripts/verify-mobile-auth.ts`
- `baylo/scripts/verify-moderation.ts`
- `baylo/src/app/api/auth/forgot-password/route.ts`
- `baylo/src/app/api/auth/refresh/route.ts`
- `baylo/src/app/api/auth/reset-password/route.ts`
- `baylo/src/app/api/auth/revoke/route.ts`
- `baylo/src/app/api/user/delete-account.ts`
- `baylo/src/lib/auth-tokens.ts`
- `baylo/src/lib/email-verification.ts`

### #3 SwapCode (11)

- `baylo/scripts/verify-bracket-trading.ts`
- `baylo/scripts/verify-moderation.ts`
- `baylo/scripts/verify-settle-and-code-http.ts`
- `baylo/scripts/verify-settlement-offeredleaves.ts`
- `baylo/scripts/verify-swap-code-and-settle.ts`
- `baylo/scripts/verify-v1-endpoints.ts`
- `baylo/src/app/api/trades/[id]/confirm/start/route.ts`
- `baylo/src/app/api/trades/[id]/confirm/status/route.ts`
- `baylo/src/app/api/trades/[id]/confirm/submit/route.ts`
- `baylo/src/app/api/user/delete-account.ts`
- `baylo/src/app/api/v1/trades/route.ts`

### #10 ItemImage (images, imageHash, ItemImageHash) (84)

- `baylo-mobile/app/(app)/home.tsx`
- `baylo-mobile/app/(app)/item.tsx`
- `baylo-mobile/app/(app)/profile.tsx`
- `baylo-mobile/app/listing-review.tsx`
- `baylo-mobile/app/offer.tsx`
- `baylo-mobile/app/post-item.tsx`
- `baylo-mobile/app/story.tsx`
- `baylo-mobile/src/api/post.ts`
- `baylo-mobile/src/api/types.ts`
- `baylo-mobile/src/components/home-redesign/ExclusiveCard.tsx`
- `baylo-mobile/src/components/home-redesign/ExclusiveTile.tsx`
- `baylo-mobile/src/components/home-redesign/HeroBanner.tsx`
- `baylo-mobile/src/components/home/FeedCard.tsx`
- `baylo-mobile/src/components/marketplace/GridTile.tsx`
- `baylo-mobile/src/components/marketplace/PhotoCarousel.tsx`
- `baylo-mobile/src/post/relist.ts`
- `baylo-mobile/src/post/state.tsx`
- `baylo/scripts/diagnose-weekly-cap.ts`
- `baylo/scripts/rehash-items.ts`
- `baylo/scripts/seed-demo-appeal.ts`
- `baylo/scripts/seed-demo-brackets.ts`
- `baylo/scripts/seed-demo-population.ts`
- `baylo/scripts/verify-appeals.ts`
- `baylo/scripts/verify-bracket-libs.ts`
- `baylo/scripts/verify-bracket-trading.ts`
- `baylo/scripts/verify-bridge-discount.ts`
- `baylo/scripts/verify-id-verification.ts`
- `baylo/scripts/verify-meetup-both-sides.ts`
- `baylo/scripts/verify-meetup-plan.ts`
- `baylo/scripts/verify-moderation.ts`
- `baylo/scripts/verify-offer-accept-realtime-http.ts`
- `baylo/scripts/verify-org-bridge-release-http.ts`
- `baylo/scripts/verify-org-http.ts`
- `baylo/scripts/verify-org-settlement-http.ts`
- `baylo/scripts/verify-org-trading-http.ts`
- `baylo/scripts/verify-orgs-and-perishables.ts`
- `baylo/scripts/verify-perishable-http.ts`
- `baylo/scripts/verify-perishable-schema-qualification.ts`
- `baylo/scripts/verify-premium-brackets.ts`
- `baylo/scripts/verify-quests.ts`
- `baylo/scripts/verify-safezone-faucet.ts`
- `baylo/scripts/verify-settle-and-code-http.ts`
- `baylo/scripts/verify-settlement-offeredleaves.ts`
- `baylo/scripts/verify-settlement-tx.ts`
- `baylo/scripts/verify-stories.ts`
- `baylo/scripts/verify-swap-code-and-settle.ts`
- `baylo/scripts/verify-task-awards.ts`
- `baylo/scripts/verify-v1-endpoints.ts`
- `baylo/scripts/verify-valuation.ts`
- `baylo/scripts/verify-value-review.ts`
- `baylo/src/app/admin/anomalies/page.tsx`
- `baylo/src/app/admin/reports/[id]/ReportImageViewer.tsx`
- `baylo/src/app/admin/reports/[id]/page.tsx`
- `baylo/src/app/api/admin/reports/[id]/route.ts`
- `baylo/src/app/api/ai/phash/route.ts`
- `baylo/src/app/api/items/[id]/route.ts`
- `baylo/src/app/api/items/route.ts`
- `baylo/src/app/api/offers/[id]/route.ts`
- `baylo/src/app/api/offers/route.ts`
- `baylo/src/app/api/v1/items/[id]/route.ts`
- `baylo/src/app/api/v1/notifications/route.ts`
- `baylo/src/app/api/v1/organizations/spotlight/route.ts`
- `baylo/src/app/api/v1/profile/[id]/reviews/route.ts`
- `baylo/src/app/api/v1/trades/route.ts`
- `baylo/src/app/auth/login/page.tsx`
- `baylo/src/app/auth/register/page.tsx`
- `baylo/src/app/dashboard/baylo-dashboard.tsx`
- `baylo/src/app/dashboard/page.tsx`
- `baylo/src/app/dashboard/shelf/page.tsx`
- `baylo/src/app/dashboard/tradeplace/PostWizard.tsx`
- `baylo/src/app/dashboard/tradeplace/TradeplaceClient.tsx`
- `baylo/src/app/dashboard/tradeplace/page.tsx`
- `baylo/src/app/dashboard/trades/page.tsx`
- `baylo/src/app/listings/[id]/TradeButton.tsx`
- `baylo/src/app/listings/[id]/page.tsx`
- `baylo/src/app/profile/page.tsx`
- `baylo/src/components/ItemCard.tsx`
- `baylo/src/components/TradeRequestModal.tsx`
- `baylo/src/lib/admin-appeals.ts`
- `baylo/src/lib/image-hashes.ts`
- `baylo/src/lib/item-visibility.ts`
- `baylo/src/lib/offer-check.ts`
- `baylo/src/lib/v1/item.ts`
- `baylo/src/lib/validation.ts`

### #11 ItemWantedCategory (17)

- `baylo-mobile/app/post-item.tsx`
- `baylo-mobile/src/api/item.ts`
- `baylo-mobile/src/api/post.ts`
- `baylo-mobile/src/components/home/EditListingSheet.tsx`
- `baylo-mobile/src/post/state.tsx`
- `baylo-mobile/src/post/wanted-keywords.ts`
- `baylo/scripts/check-category-match.ts`
- `baylo/scripts/lib/demo-population-catalogue.ts`
- `baylo/scripts/seed-demo-population.ts`
- `baylo/scripts/verify-org-http.ts`
- `baylo/scripts/verify-orgs-and-perishables.ts`
- `baylo/scripts/verify-perishable-http.ts`
- `baylo/src/app/api/items/[id]/route.ts`
- `baylo/src/app/api/items/route.ts`
- `baylo/src/lib/category-match.ts`
- `baylo/src/lib/v1/item.ts`
- `baylo/src/lib/validation.ts`

### Boosts removed (16)

- `baylo-mobile/app/(app)/item.tsx`
- `baylo-mobile/app/(app)/profile.tsx`
- `baylo-mobile/app/achievements.tsx`
- `baylo-mobile/src/api/featured.ts`
- `baylo-mobile/src/api/types.ts`
- `baylo-mobile/src/components/home-redesign/ExclusiveTile.tsx`
- `baylo/scripts/check-new-enum-rows.ts`
- `baylo/scripts/expire-featured.ts`
- `baylo/scripts/lib/ledger-invariant.ts`
- `baylo/src/app/api/v1/featured/route.ts`
- `baylo/src/app/api/v1/home/route.ts`
- `baylo/src/app/api/v1/items/[id]/boost/route.ts`
- `baylo/src/app/api/v1/organizations/spotlight/route.ts`
- `baylo/src/app/api/v1/profile/me/route.ts`
- `baylo/src/lib/featured.ts`
- `baylo/src/lib/v1/item.ts`

### #16-17 Like / Comment / CommentLike (9)

- `baylo/scripts/verify-recommend.ts`
- `baylo/scripts/verify-v1-endpoints.ts`
- `baylo/src/app/api/posts/[id]/comments/[commentId]/like/route.ts`
- `baylo/src/app/api/posts/[id]/comments/route.ts`
- `baylo/src/app/api/posts/[id]/like/route.ts`
- `baylo/src/app/api/user/delete-account.ts`
- `baylo/src/app/api/v1/items/[id]/comments/route.ts`
- `baylo/src/app/api/v1/items/[id]/like/route.ts`
- `baylo/src/lib/recommend.ts`

### ConversationHide (3)

- `baylo/src/app/api/messages/route.ts`
- `baylo/src/app/api/v1/messages/conversations/route.ts`
- `baylo/src/app/dashboard/messages/page.tsx`

### DeferredContract (15)

- `baylo/scripts/verify-id-verification.ts`
- `baylo/scripts/verify-moderation.ts`
- `baylo/scripts/verify-settle-and-code-http.ts`
- `baylo/scripts/verify-swap-code-and-settle.ts`
- `baylo/src/app/api/admin/anomalies/route.ts`
- `baylo/src/app/api/admin/listings/[id]/route.ts`
- `baylo/src/app/api/v1/contracts/[id]/accept/route.ts`
- `baylo/src/app/api/v1/contracts/[id]/decline/route.ts`
- `baylo/src/app/api/v1/contracts/[id]/extension/grant/route.ts`
- `baylo/src/app/api/v1/contracts/[id]/extension/request/route.ts`
- `baylo/src/app/api/v1/contracts/[id]/preview/route.ts`
- `baylo/src/app/api/v1/contracts/[id]/settle/route.ts`
- `baylo/src/app/api/v1/contracts/route.ts`
- `baylo/src/lib/blocking.ts`
- `baylo/src/lib/trust-tiers.ts`

### #21 ModerationCase (Report, ListingAppeal) (27)

- `baylo/scripts/check-new-enum-rows.ts`
- `baylo/scripts/seed-demo-appeal.ts`
- `baylo/scripts/verify-appeals.ts`
- `baylo/scripts/verify-moderation.ts`
- `baylo/scripts/verify-stories.ts`
- `baylo/scripts/verify-value-review.ts`
- `baylo/src/app/admin/audit/page.tsx`
- `baylo/src/app/admin/dashboard/page.tsx`
- `baylo/src/app/admin/page.tsx`
- `baylo/src/app/admin/reports/[id]/ModerationActions.tsx`
- `baylo/src/app/admin/reports/[id]/page.tsx`
- `baylo/src/app/api/admin/appeals/[id]/route.ts`
- `baylo/src/app/api/admin/audit/route.ts`
- `baylo/src/app/api/admin/listings/[id]/route.ts`
- `baylo/src/app/api/admin/reports/[id]/resolve/route.ts`
- `baylo/src/app/api/admin/reports/[id]/route.ts`
- `baylo/src/app/api/admin/reports/route.ts`
- `baylo/src/app/api/admin/trades/[id]/reverse-reward/route.ts`
- `baylo/src/app/api/admin/users/[id]/route.ts`
- `baylo/src/app/api/items/[id]/route.ts`
- `baylo/src/app/api/v1/items/[id]/appeal/route.ts`
- `baylo/src/app/api/v1/reports/route.ts`
- `baylo/src/lib/achievements.ts`
- `baylo/src/lib/admin-appeals.ts`
- `baylo/src/lib/admin-reports.ts`
- `baylo/src/lib/appeals.ts`
- `baylo/src/lib/moderation.ts`

### #23 Organization owner (OrganizationMember) (22)

- `baylo-mobile/src/api/notifications.ts`
- `baylo-mobile/src/api/organizations.ts`
- `baylo-mobile/src/api/types.ts`
- `baylo-mobile/src/components/OrgStorefrontHeader.tsx`
- `baylo/scripts/check-new-enum-rows.ts`
- `baylo/scripts/seed-demo-population.ts`
- `baylo/scripts/verify-offer-accept-realtime-http.ts`
- `baylo/scripts/verify-org-cloudinary.ts`
- `baylo/scripts/verify-org-http.ts`
- `baylo/scripts/verify-org-settlement-http.ts`
- `baylo/scripts/verify-org-trading-http.ts`
- `baylo/scripts/verify-orgs-and-perishables.ts`
- `baylo/src/app/api/pusher/auth/route.ts`
- `baylo/src/app/api/v1/notifications/route.ts`
- `baylo/src/app/api/v1/organizations/[id]/members/[memberId]/route.ts`
- `baylo/src/app/api/v1/organizations/[id]/members/route.ts`
- `baylo/src/app/api/v1/organizations/route.ts`
- `baylo/src/app/api/v1/profile/[id]/route.ts`
- `baylo/src/lib/inbox.ts`
- `baylo/src/lib/organizations.ts`
- `baylo/src/lib/perishable.ts`
- `baylo/src/lib/trade-participant.ts`

### #25 UserProgress (QuestAssignment, UserAchievement) (16)

- `baylo/scripts/_diag.mjs`
- `baylo/scripts/_diag2.mjs`
- `baylo/scripts/audit-achievements-live.ts`
- `baylo/scripts/backfill-null-display-order.ts`
- `baylo/scripts/verify-achievements-display.ts`
- `baylo/scripts/verify-org-trading-http.ts`
- `baylo/scripts/verify-premium-achievement.ts`
- `baylo/scripts/verify-quests.ts`
- `baylo/scripts/verify-settlement-offeredleaves.ts`
- `baylo/src/app/api/v1/achievements/display/route.ts`
- `baylo/src/app/api/v1/achievements/route.ts`
- `baylo/src/app/api/v1/home/route.ts`
- `baylo/src/app/api/v1/profile/[id]/route.ts`
- `baylo/src/app/api/v1/profile/me/route.ts`
- `baylo/src/lib/achievements.ts`
- `baylo/src/lib/quests.ts`

### Notification.link (kept; for reference only) (31)

- `baylo-mobile/app/trades-waiting.tsx`
- `baylo-mobile/src/components/OrgStorefrontHeader.tsx`
- `baylo-mobile/src/components/home/VerifyEmailBar.tsx`
- `baylo/scripts/cancel-backfill-trades.ts`
- `baylo/scripts/verify-email-verification.ts`
- `baylo/src/app/admin/admin-theme.css`
- `baylo/src/app/api/admin/id-verification/[id]/route.ts`
- `baylo/src/app/api/admin/organizations/[id]/route.ts`
- `baylo/src/app/api/follows/[id]/route.ts`
- `baylo/src/app/api/follows/route.ts`
- `baylo/src/app/api/messages/route.ts`
- `baylo/src/app/api/offers/[id]/route.ts`
- `baylo/src/app/api/offers/route.ts`
- `baylo/src/app/api/posts/[id]/comments/route.ts`
- `baylo/src/app/api/reviews/route.ts`
- `baylo/src/app/api/trades/[id]/confirm/submit/route.ts`
- `baylo/src/app/api/trades/[id]/route.ts`
- `baylo/src/app/api/trades/route.ts`
- `baylo/src/app/api/v1/items/[id]/comments/route.ts`
- `baylo/src/app/dashboard/_shell/TopNav.tsx`
- `baylo/src/app/dashboard/baylo-dashboard.css`
- `baylo/src/app/dashboard/page.tsx`
- `baylo/src/app/dashboard/shelf/page.tsx`
- `baylo/src/app/dashboard/tradeplace/page.tsx`
- `baylo/src/app/dashboard/tradeplace/tradeplace.css`
- `baylo/src/app/dashboard/trades/page.tsx`
- `baylo/src/app/globals.css`
- `baylo/src/components/Navbar.tsx`
- `baylo/src/lib/category-match.ts`
- `baylo/src/lib/moderation.ts`
- `baylo/src/lib/offers.ts`

### #9 Item.bracket (bracketOf callers, optional) (40)

- `baylo-mobile/app/(app)/item.tsx`
- `baylo-mobile/app/listing-review.tsx`
- `baylo-mobile/src/api/offer.ts`
- `baylo-mobile/src/api/trades.ts`
- `baylo-mobile/src/components/home-redesign/ExclusiveCard.tsx`
- `baylo-mobile/src/components/home-redesign/ExclusiveTile.tsx`
- `baylo-mobile/src/components/home/FeedCard.tsx`
- `baylo-mobile/src/components/marketplace/FilterSheet.tsx`
- `baylo-mobile/src/components/marketplace/GridTile.tsx`
- `baylo-mobile/src/components/offer/WhereYouStand.tsx`
- `baylo-mobile/src/components/post/StepReview.tsx`
- `baylo-mobile/src/components/post/StepValue.tsx`
- `baylo-mobile/src/lib/brackets.ts`
- `baylo-mobile/src/lib/gap.ts`
- `baylo-mobile/src/lib/share.ts`
- `baylo-mobile/src/lib/trade-rules.ts`
- `baylo-mobile/src/search-helper/match.ts`
- `baylo/scripts/seed-demo-appeal.ts`
- `baylo/scripts/seed-demo-population.ts`
- `baylo/scripts/verify-bracket-libs.ts`
- `baylo/scripts/verify-bracket-trading.ts`
- `baylo/scripts/verify-org-bridge-release-http.ts`
- `baylo/scripts/verify-org-settlement-http.ts`
- `baylo/scripts/verify-orgs-and-perishables.ts`
- `baylo/scripts/verify-perishable-http.ts`
- `baylo/scripts/verify-premium-brackets.ts`
- `baylo/src/app/admin/anomalies/page.tsx`
- `baylo/src/app/admin/listings/page.tsx`
- `baylo/src/app/api/admin/anomalies/route.ts`
- `baylo/src/app/api/admin/appeals/[id]/route.ts`
- `baylo/src/app/api/admin/listings/[id]/route.ts`
- `baylo/src/app/api/v1/items/[id]/route.ts`
- `baylo/src/app/api/v1/profile/[id]/reviews/route.ts`
- `baylo/src/lib/admin-appeals.ts`
- `baylo/src/lib/brackets.ts`
- `baylo/src/lib/offer-check.ts`
- `baylo/src/lib/reputation-gate.ts`
- `baylo/src/lib/trade-reward.ts`
- `baylo/src/lib/trade-rules.ts`
- `baylo/src/lib/valuation-server.ts`
