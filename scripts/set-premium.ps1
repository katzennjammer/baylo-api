# Thin wrapper over scripts/set-tier.ts, kept under the old name and the old
# flag shape. The database moved from local MySQL to Supabase Postgres on
# 15 Sep 2026 and this script still spoke `mysql.exe -h 127.0.0.1` against a
# database that no longer exists; set-tier.ts is the real implementation now,
# and it writes to whatever schema DATABASE_URL in .env points at (that is
# `public` -- the live database -- unless you have pointed it at a scratch
# schema; see scripts/scratch.ps1).
#
# Run from the baylo-api/ directory:
#   ./scripts/set-premium.ps1 jmjumuad2@gmail.com                    # premium, LIFETIME (beta pricing)
#   ./scripts/set-premium.ps1 jmjumuad2@gmail.com -Tier vip                # vip, 30 days
#   ./scripts/set-premium.ps1 jmjumuad2@gmail.com -Days 7                  # premium, timed (demos/tests)
#   ./scripts/set-premium.ps1 jmjumuad2@gmail.com -Clear             # back to not subscribed
#   ./scripts/set-premium.ps1                                        # list current subscribers
#   ./scripts/set-premium.ps1 jmjumuad2@gmail.com -Live              # confirm writing to LIVE
#
# This is the ONLY writer of premiumUntil/vipUntil. When a real subscription
# lands, the Play Billing verifier replaces it and nothing else has to change:
# every reader goes through isPremium()/isVip() in src/lib/premium.ts.
#
# PROVISIONAL -- BETA PRICING (30 Sep 2026): Premium is a one-time ₱199
# lifetime purchase during the beta, so a premium grant without -Days is
# lifetime (PREMIUM_LIFETIME_UNTIL in src/lib/premium.ts). This changes when
# real pricing is decided.

param(
  [string]$Email,
  [ValidateSet("premium", "vip")]
  [string]$Tier = "premium",
  [int]$Days = 0,   # 0 = not given: premium -> lifetime, vip -> 30 days
  [switch]$Clear,
  [switch]$Live
)

$ErrorActionPreference = "Stop"

$scriptArgs = @()
if ($Email) { $scriptArgs += $Email }
$scriptArgs += "--tier"
$scriptArgs += $Tier
if ($Days -gt 0) {
  $scriptArgs += "--days"
  $scriptArgs += $Days
}
if ($Clear) { $scriptArgs += "--clear" }
if ($Live) { $scriptArgs += "--live" }

npx tsx --env-file=.env scripts/set-tier.ts @scriptArgs
if ($LASTEXITCODE -ne 0) { throw "set-tier.ts failed" }
