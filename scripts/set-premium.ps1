# Sets or clears User.premiumUntil by hand, so both sides of the premium gate
# can be demonstrated before Play Billing exists.
#
# Run from the baylo/ directory:
#   ./scripts/set-premium.ps1 jmjumuad2@gmail.com            # 30 days from now
#   ./scripts/set-premium.ps1 jmjumuad2@gmail.com -Days 365
#   ./scripts/set-premium.ps1 jmjumuad2@gmail.com -Clear     # back to not subscribed
#   ./scripts/set-premium.ps1                                # list who is premium
#
# This is the ONLY writer of the column. When a real subscription lands, the
# Play Billing verifier replaces this script and nothing else has to change:
# every reader goes through isPremium() in src/lib/premium.ts.

param(
  [string]$Email,
  [int]$Days = 30,
  [switch]$Clear
)

$ErrorActionPreference = "Stop"
$mysql = "D:\Xampp\mysql\bin\mysql.exe"
$db    = "baylo"

function Invoke-Sql([string]$sql) {
  & $mysql -u root -h 127.0.0.1 -P 3306 $db -e $sql
  if ($LASTEXITCODE -ne 0) { throw "mysql failed" }
}

if (-not $Email) {
  Write-Host "Premium accounts (premiumUntil in the future):"
  Invoke-Sql "SELECT email, premiumUntil FROM User WHERE premiumUntil IS NOT NULL ORDER BY premiumUntil DESC;"
  exit 0
}

$safeEmail = $Email.Replace("'", "''")

if ($Clear) {
  Invoke-Sql "UPDATE User SET premiumUntil = NULL WHERE email = '$safeEmail';"
  Write-Host "Cleared premiumUntil for $Email"
} else {
  Invoke-Sql "UPDATE User SET premiumUntil = DATE_ADD(NOW(3), INTERVAL $Days DAY) WHERE email = '$safeEmail';"
  Write-Host "Set premiumUntil = now + $Days days for $Email"
}

Invoke-Sql "SELECT email, premiumUntil FROM User WHERE email = '$safeEmail';"
