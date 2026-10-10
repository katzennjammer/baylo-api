<#
.SYNOPSIS
  Runs the auth / refresh / revoke / sessions acceptance harnesses over HTTP
  against a scratch server from scripts\scratch-dev-safe.ps1, then prints a
  pass/fail table.
.DESCRIPTION
  ORDER AND THE ONE RESTART. /api/auth/register allows 3 calls per hour per IP
  and keeps the count in the SERVER's memory. verify-mobile-auth spends all 3
  and verify-email-verification needs 2 more, so they cannot share a server
  lifetime. The runner stops before verify-email-verification and says how to
  continue: restart the scratch server, then re-run with -From.

  Every other suite here registers nobody (they build fixtures in the
  database), and every login uses a per-run email, so the login limit
  (10 per email per 15 minutes) is never shared between suites.

  The harness processes get the same disarmed environment as the server, plus
  DATABASE_URL on the SAME scratch schema, so their fixtures are what the
  server reads. Restored when the runner exits.

.EXAMPLE
  .\scripts\run-auth-harnesses.ps1 -Name scratch_auth -Port 3001
.EXAMPLE
  # after restarting the scratch server when told to
  .\scripts\run-auth-harnesses.ps1 -Name scratch_auth -Port 3001 -From verify-email-verification
#>
param(
  [Parameter(Mandatory = $true)] [string] $Name,
  [int]    $Port = 3001,
  [string] $From = "verify-mobile-auth",
  [string] $ProjectDir = "D:\BAYLO\baylo"
)

$ErrorActionPreference = "Stop"
function Refuse([string] $why) { Write-Host "`n  REFUSING: $why`n" -ForegroundColor Red; exit 1 }

# Fresh = needs a server started fresh just before it (register budget).
# Expected = last recorded count; "" where none was ever recorded. A suite
# that passes with a different count is not a failure -- suites grow.
$suites = @(
  [pscustomobject]@{ Name = "verify-mobile-auth";        Fresh = $true;  Expected = "";    Why = "registers 3 accounts: the whole register budget" }
  [pscustomobject]@{ Name = "verify-email-verification"; Fresh = $true;  Expected = "";    Why = "registers 2 accounts, and verify-mobile-auth spent the budget" }
  [pscustomobject]@{ Name = "verify-v1-endpoints";       Fresh = $false; Expected = "39";  Why = "" }
  [pscustomobject]@{ Name = "verify-moderation";         Fresh = $false; Expected = "93";  Why = "" }
  [pscustomobject]@{ Name = "verify-org-http";           Fresh = $false; Expected = "";    Why = "" }
  [pscustomobject]@{ Name = "verify-active-sessions";    Fresh = $false; Expected = "57";  Why = "" }
)
$start = [array]::IndexOf(@($suites | ForEach-Object Name), $From)
if ($start -lt 0) { Refuse "-From '$From' is not one of: $(($suites | ForEach-Object Name) -join ', ')" }

# ── Preconditions ────────────────────────────────────────────────────────────
if ($Name -eq "public" -or $Name -notmatch '^scratch_[a-z0-9_]+$') { Refuse "-Name must match scratch_[a-z0-9_]+ (got '$Name')." }
if ($Port -eq 3000) { Refuse "-Port 3000 is the live server's port." }
if (@(Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue).Count -gt 0) {
  Refuse "something is listening on port 3000. The live server must be stopped while the scratch one runs."
}
if (@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).Count -eq 0) {
  Refuse "nothing is listening on port $Port. Start it first: .\scripts\scratch-dev-safe.ps1 -Name $Name -Port $Port"
}
if (@(Get-NetTCPConnection -State Listen -LocalPort 2525 -ErrorAction SilentlyContinue).Count -gt 0) {
  Refuse "port 2525 is taken; the email harnesses open their SMTP sink there (an orphaned earlier run?)."
}

Push-Location $ProjectDir
$line = Get-Content .env | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
if (-not $line) { Pop-Location; Refuse "no DATABASE_URL in .env" }
$base = ($line -replace '^DATABASE_URL=', '' -replace '"', '').Trim()
if ($base -match '\?') { Pop-Location; Refuse "DATABASE_URL in .env already carries query parameters." }

# ── Disarmed environment for the harness processes ──────────────────────────
$acceptBase = "http://127.0.0.1:$Port"
$envFor = [ordered]@{
  DATABASE_URL          = "${base}?schema=$Name"    # braces: "$base?schema" would read a variable named base?schema
  DATABASE_POOL_URL     = ""                         # cleared
  PUSHER_SECRET         = "invalid-scratch"
  EMAIL_SMTP_HOST       = "127.0.0.1"
  EMAIL_SMTP_PORT       = "2525"
  EMAIL_SMTP_USER       = "scratch-user"
  EMAIL_SMTP_PASS       = "scratch-pass"
  CLOUDINARY_API_SECRET = "invalid-scratch"
  ANTHROPIC_API_KEY     = "invalid-scratch"
  ACCEPT_BASE           = $acceptBase                # most harnesses
  BAYLO_BASE_URL        = $acceptBase                # verify-org-http
  ACCEPT_SMTP_PORT      = "2525"                     # the sink the email harnesses open
}
$saved = @{}
foreach ($k in $envFor.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, "Process") }

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$logDir = Join-Path $env:TEMP "baylo-auth-harnesses\$stamp"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$results = New-Object System.Collections.Generic.List[object]
$stoppedFor = $null

try {
  foreach ($k in $envFor.Keys) { [Environment]::SetEnvironmentVariable($k, $envFor[$k], "Process") }
  if ([Environment]::GetEnvironmentVariable("DATABASE_POOL_URL", "Process")) { Refuse "could not clear DATABASE_POOL_URL." }
  # Read-only catalog lookup; strips ?schema= itself, so it reads the scratch URL set above.
  $exists = npx tsx --env-file=.env scripts/scratch-schema-exists.ts $Name | Select-Object -Last 1
  if ($exists -ne "yes") { Refuse "schema $Name does not exist. Start the server with scratch-dev-safe.ps1 (it pushes)." }
  # From here a harness writing to stderr is output, not a terminating error
  # (Windows PowerShell 5.1 turns native stderr into ErrorRecords under Stop).
  $ErrorActionPreference = "Continue"

  Write-Host "`n  run-auth-harnesses   schema $Name   server $acceptBase   logs $logDir"
  if ($suites[$start].Fresh) {
    Write-Host "  $($suites[$start].Name) needs a scratch server started fresh for this run ($($suites[$start].Why))." -ForegroundColor Yellow
  }

  $ran = 0
  for ($i = $start; $i -lt $suites.Count; $i++) {
    $s = $suites[$i]
    if ($s.Fresh -and $ran -gt 0) { $stoppedFor = $s; break }

    Write-Host "`n════ $($s.Name) $("═" * [Math]::Max(0, 60 - $s.Name.Length))" -ForegroundColor Cyan
    $log = Join-Path $logDir "$($s.Name).log"
    npx tsx --env-file=.env "scripts\$($s.Name).ts" 2>&1 | Tee-Object -FilePath $log
    $code = $LASTEXITCODE
    $ran++

    $text = Get-Content $log -Raw
    $m = [regex]::Matches($text, '(\d+) passed, (\d+) failed')
    if ($m.Count -gt 0) {
      $passed = [int]$m[$m.Count - 1].Groups[1].Value
      $failed = [int]$m[$m.Count - 1].Groups[2].Value
    } else {
      # verify-org-http prints "  ok    name" / "  FAIL  name" and no totals line.
      $passed = @(Select-String -Path $log -Pattern '^\s*(PASS|ok)\s').Count
      $failed = @(Select-String -Path $log -Pattern '^\s*FAIL\s').Count
    }
    $status = if ($code -eq 0 -and $failed -eq 0) { "PASS" } elseif ($code -eq 2) { "NO SERVER" } else { "FAIL" }
    $results.Add([pscustomobject]@{ Suite = $s.Name; Status = $status; Passed = $passed; Failed = $failed; Expected = $s.Expected; Exit = $code })
  }
} finally {
  foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], "Process") }
  Pop-Location
}

# ── Summary ──────────────────────────────────────────────────────────────────
Write-Host "`n══ SUMMARY ═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
$results | Format-Table Suite, Status, Passed, Failed, @{ Label = "Expected"; Expression = { if ($_.Expected) { "$($_.Expected)/0" } else { "?/0" } } }, Exit -AutoSize | Out-Host
Write-Host "  logs: $logDir"

if ($stoppedFor) {
  Write-Host ""
  Write-Host "  STOPPED before $($stoppedFor.Name): it needs a FRESH scratch server ($($stoppedFor.Why))." -ForegroundColor Yellow
  Write-Host "  1. Ctrl+C the scratch server's window."
  Write-Host "  2. Start it again (schema already pushed):"
  Write-Host "       .\scripts\scratch-dev-safe.ps1 -Name $Name -Port $Port -NoPush"
  Write-Host "  3. Continue:"
  Write-Host "       .\scripts\run-auth-harnesses.ps1 -Name $Name -Port $Port -From $($stoppedFor.Name)"
} else {
  Write-Host ""
  Write-Host "  Done. Ctrl+C the scratch server, then:"
  Write-Host "    .\scripts\scratch.ps1 -Drop -Name $Name"
  Write-Host "    npm run dev:clean        # your live server"
}

$bad = @($results | Where-Object { $_.Status -ne "PASS" }).Count
exit $(if ($bad -eq 0) { 0 } else { 1 })
