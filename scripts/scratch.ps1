<#
.SYNOPSIS
  A scratch SCHEMA on the live Supabase database, for harnesses and a second
  dev server. Never the live tables.
.DESCRIPTION
  The MySQL-era harness headers say "CREATE DATABASE baylo_x and point
  DATABASE_URL at it". Supabase's free tier gives one database, so the scratch
  unit is a schema inside it: the same DATABASE_URL with `?schema=<name>`
  appended. `prisma db push` builds every table there; src/lib/prisma.ts hands
  the parameter to the driver adapter (it did not until 16 Sep 2026, and a
  harness that believed it was on scratch was on live); and dropping the schema
  takes every row with it.

  PowerShell note: the URL is built as "${base}?schema=..." -- with braces.
  "$base?schema" reads a variable named `base?schema` and yields an empty URL.

.EXAMPLE
  # Run a harness on a fresh scratch schema, then drop it
  .\scripts\scratch.ps1 -Run scripts\verify-bracket-libs.ts

.EXAMPLE
  # Keep the schema afterwards (to inspect, or to reuse with -Name)
  .\scripts\scratch.ps1 -Run scripts\verify-bracket-libs.ts -Keep -Name scratch_libs

.EXAMPLE
  # A second dev server on port 3001 bound to a scratch schema, for the HTTP
  # harnesses (verify-*-http, verify-v1-endpoints, verify-bracket-trading).
  # Push first, seed if the harness wants seed accounts, then serve.
  .\scripts\scratch.ps1 -Push -Name scratch_http
  .\scripts\scratch.ps1 -Seed -Name scratch_http
  .\scripts\scratch.ps1 -Dev  -Name scratch_http -Port 3001
  # ...in another window: $env:BASE="http://localhost:3001"; npx tsx --env-file=.env scripts\verify-bracket-trading.ts
  .\scripts\scratch.ps1 -Drop -Name scratch_http
#>
param(
  [string] $Run   = "",
  [switch] $Push,
  [switch] $Seed,
  [switch] $Dev,
  [switch] $Drop,
  [switch] $Keep,
  [string] $Name  = "",
  [int]    $Port  = 3001,
  [string] $ProjectDir = "D:\BAYLO\baylo"
)

$ErrorActionPreference = "Stop"
Push-Location $ProjectDir
try {
  $line = Get-Content .env | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
  if (-not $line) { throw "no DATABASE_URL in .env" }
  $base = ($line -replace '^DATABASE_URL=', '' -replace '"', '').Trim()
  if ($base -match '\?') { throw "DATABASE_URL already carries query parameters; append ?schema= by hand" }
  if (-not $Name) { $Name = "scratch_" + (Get-Date -Format "yyyyMMdd_HHmmss") }
  if ($Name -notmatch '^scratch_[a-z0-9_]+$') { throw "scratch schema names must match scratch_[a-z0-9_]+ (got '$Name')" }
  $url = "${base}?schema=$Name"

  function Invoke-Drop {
    Write-Host "  dropping schema $Name"
    $env:DATABASE_URL = $base
    npx tsx -e "const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('DROP SCHEMA IF EXISTS ""$Name"" CASCADE');await c.end()})()"
  }

  if ($Drop) { Invoke-Drop; return }

  if ($Push -or $Run -or $Dev -or $Seed) {
    if (-not $Dev -or $Push) {
      Write-Host "  pushing prisma/schema.prisma to schema $Name"
      $env:DATABASE_URL = $url
      npx prisma db push 2>&1 | Select-Object -Last 1
      if ($LASTEXITCODE -ne 0) { throw "db push failed" }
    }
  }

  if ($Seed) {
    $env:DATABASE_URL = $url
    Write-Host "  seeding $Name"
    npx tsx --env-file=.env prisma/seed.ts
    if ($LASTEXITCODE -ne 0) { throw "seed failed" }
  }

  if ($Run) {
    $env:DATABASE_URL = $url
    Write-Host "  running $Run on schema $Name`n"
    npx tsx --env-file=.env $Run
    $code = $LASTEXITCODE
    if (-not $Keep) { Invoke-Drop } else { Write-Host "  kept schema $Name (drop with -Drop -Name $Name)" }
    exit $code
  }

  if ($Dev) {
    $env:DATABASE_URL = $url
    Write-Host "  next dev on port $Port, schema $Name  (Ctrl+C to stop; schema is kept -- drop it with -Drop -Name $Name)`n"
    npx next dev -p $Port
    return
  }

  if ($Push) { Write-Host "  pushed. DATABASE_URL for it:`n  $($url -replace ':[^:@/]+@', ':***@')" }
} finally {
  Pop-Location
}
