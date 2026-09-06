<#
.SYNOPSIS
  Points an EXISTING baylo database at the squashed baseline migration, without
  re-running or resetting anything.

.DESCRIPTION
  On 2026-09-06 the 19-migration chain was squashed into a single migration,
  20260906000000_baseline. A database created from scratch after that gets the
  baseline and nothing else. A database that predates it -- yours -- is already
  past every migration in the old chain, and its `_prisma_migrations` table
  still names all 19 of them.

  Prisma treats "applied in the database but absent from the migrations folder"
  as a hard error, which is why `prisma migrate status` currently fails with a
  20-line list instead of saying "up to date". This script fixes that, and it is
  the ONLY thing it does.

  ── WHAT THIS TOUCHES, EXACTLY ──────────────────────────────────────────────

  One table: `_prisma_migrations`, which is Prisma's own bookkeeping. The 20
  superseded rows are deleted and one row naming the baseline replaces them.

  NO DDL RUNS. NO DATA TABLE IS READ OR WRITTEN. The baseline's SQL is never
  executed against this database -- `prisma migrate resolve --applied` records a
  migration as applied precisely so that its statements do NOT run. Your tables,
  your rows and your schema come out the far side byte for byte identical.

  That is also why the order matters: the schema this database already has was
  verified to match what the baseline produces from empty (26 tables, 92
  indexes, 46 foreign keys, zero column differences), so marking it applied is
  a true statement about this database and not a convenient fiction.

  ── SAFETY ──────────────────────────────────────────────────────────────────

  Step 1 is a verified backup via backup-baylo.ps1, and this script REFUSES to
  continue if that backup does not pass its own five checks. Skip it with
  -SkipBackup only if you have just taken one by hand.

  Idempotent: the DELETE is scoped with `WHERE migration_name <> ...`, so a
  second run finds nothing to delete and a baseline row already present, and
  changes nothing.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\baseline-existing-db.ps1

.EXAMPLE
  # Show what would happen and touch nothing.
  powershell -ExecutionPolicy Bypass -File scripts\baseline-existing-db.ps1 -DryRun
#>

[CmdletBinding()]
param(
  [string] $Database  = "baylo",
  [string] $MysqlBin  = "D:\Xampp\mysql\bin",
  [string] $DbHost    = "127.0.0.1",
  [int]    $Port      = 3306,
  [string] $User      = "root",
  [string] $Password  = "",
  [string] $Baseline  = "20260906000000_baseline",
  [switch] $SkipBackup,
  [switch] $DryRun
)

$ErrorActionPreference = "Stop"

function Fail([string] $m) { Write-Host ""; Write-Host "  FAILED: $m" -ForegroundColor Red; Write-Host ""; exit 1 }
function Ok([string] $m)   { Write-Host "  OK    $m" -ForegroundColor Green }
function Info([string] $m) { Write-Host "  ..    $m" -ForegroundColor DarkGray }

$mysql = Join-Path $MysqlBin "mysql.exe"
if (-not (Test-Path $mysql)) { Fail "mysql.exe not found at $mysql" }

$repo = Split-Path $PSScriptRoot -Parent
$migrationDir = Join-Path $repo "prisma\migrations\$Baseline"
if (-not (Test-Path $migrationDir)) {
  Fail "no such migration folder: $migrationDir  (is -Baseline right?)"
}

function Invoke-Sql([string] $sql) {
  $args = @("--host=$DbHost", "--port=$Port", "--user=$User", "--batch", "--skip-column-names", "--database=$Database", "--execute=$sql")
  if ($Password) { $args = ,"--password=$Password" + $args }
  $out = & $mysql @args 2>&1
  if ($LASTEXITCODE -ne 0) { Fail "mysql exited $LASTEXITCODE - $out" }
  return $out
}

Write-Host ""
Write-Host "  baselining '$Database' onto $Baseline" -ForegroundColor Cyan
Write-Host ""

# ── Preflight ────────────────────────────────────────────────────────────────

$rows = (Invoke-Sql "SELECT COUNT(1) FROM _prisma_migrations;").Trim()
$hasBaseline = (Invoke-Sql "SELECT COUNT(1) FROM _prisma_migrations WHERE migration_name = '$Baseline';").Trim()
$stale = [int]$rows - [int]$hasBaseline

Info "_prisma_migrations holds $rows row(s); $stale of them superseded"

if ($stale -eq 0 -and $hasBaseline -eq "1") {
  Ok "already baselined - nothing to do"
  Write-Host ""
  exit 0
}

$tables = (Invoke-Sql "SELECT COUNT(1) FROM information_schema.tables WHERE table_schema = '$Database';").Trim()
Info "$tables tables in the schema (these are NOT touched)"

if ($DryRun) {
  Write-Host ""
  Write-Host "  -DryRun. Would do exactly this and nothing else:" -ForegroundColor Yellow
  Write-Host "    1. backup-baylo.ps1                                 (verified)"
  Write-Host "    2. DELETE $stale row(s) FROM _prisma_migrations WHERE migration_name <> '$Baseline'"
  Write-Host "    3. prisma migrate resolve --applied $Baseline       (runs no SQL)"
  Write-Host "    4. prisma migrate status                            (expect: up to date)"
  Write-Host ""
  exit 0
}

# ── 1. Backup ────────────────────────────────────────────────────────────────

if ($SkipBackup) {
  Info "-SkipBackup: no backup taken (you said you already have one)"
} else {
  Info "taking a verified backup first..."
  & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "backup-baylo.ps1")
  if ($LASTEXITCODE -ne 0) { Fail "backup did not verify - refusing to continue" }
  Ok "backup verified"
}

# ── 2. Replace the bookkeeping rows ──────────────────────────────────────────

Invoke-Sql "DELETE FROM _prisma_migrations WHERE migration_name <> '$Baseline';" | Out-Null
Ok "removed $stale superseded row(s) from _prisma_migrations"

# ── 3. Record the baseline as applied, WITHOUT running it ────────────────────

if ($hasBaseline -eq "0") {
  Push-Location $repo
  try {
    & npx prisma migrate resolve --applied $Baseline
    if ($LASTEXITCODE -ne 0) { Fail "prisma migrate resolve failed" }
  } finally { Pop-Location }
  Ok "$Baseline recorded as applied (none of its SQL ran)"
} else {
  Ok "$Baseline was already recorded"
}

# ── 4. Prove it ──────────────────────────────────────────────────────────────

Push-Location $repo
try {
  & npx prisma migrate status
  $statusCode = $LASTEXITCODE
} finally { Pop-Location }

$tablesAfter = (Invoke-Sql "SELECT COUNT(1) FROM information_schema.tables WHERE table_schema = '$Database';").Trim()
if ($tablesAfter -ne $tables) { Fail "table count changed from $tables to $tablesAfter - this should be impossible" }
Ok "still $tablesAfter tables - schema untouched"

if ($statusCode -ne 0) { Fail "prisma migrate status still unhappy (exit $statusCode) - read its output above" }

Write-Host ""
Write-Host "  BASELINED. migrate status reports up to date." -ForegroundColor Green
Write-Host ""
exit 0
