<#
.SYNOPSIS
  Dumps the Supabase Postgres database and REFUSES to call it a backup until it
  has proved the file is one. The Postgres counterpart of backup-baylo.ps1.

.DESCRIPTION
  Baylo moved from MariaDB to Supabase Postgres on 2026-09-15. backup-baylo.ps1
  still runs, but it dumps the MariaDB fallback -- which stopped being the live
  database that day. From the switch until this script existed, the only backup
  of the live data was a MySQL snapshot taken at 19:02 on the day of the move.

  This matters more here than it would elsewhere. The Supabase FREE TIER TAKES
  NO AUTOMATIC BACKUPS, and this database has been destroyed three times in its
  life (two MariaDB corruptions and one deleted redo log). A hosted database is
  not a backed-up database.

  SAME FIVE CHECKS as the MySQL script, because the failure they were written
  for -- 26 Aug 2026, a dump that reported success and was 991 bytes of nothing
  -- is not a MySQL failure, it is a backup failure:

    1  the dump tool's EXIT CODE, genuinely. Never a PowerShell pipeline: a
       pipeline reports the exit status of its LAST stage, so `pg_dump | Out-File`
       reports Out-File's success even when pg_dump died halfway. Both paths
       below have the tool write the file itself.

    2  SIZE >= a floor. Blunt, and meant to be. 991 bytes dies here.

    3  The TRAILER. Both tools write a final line only on success, so its
       absence means truncation -- killed, out of disk, connection dropped
       mid-table. This is the check size alone cannot make: a dump can be large
       and still be cut off.

    4  TABLE COUNT. The 991-byte file was structurally plausible -- correct
       header, no tables. A size floor alone would not catch the same failure
       on a bigger database; an expected minimum count does.

    5  ROW DATA. A schema-only dump of a populated database restores cleanly
       and leaves you with nothing.

  And a SIXTH the MySQL script could not make, because this dump carries its own
  accounting:

    6  THE TRAILER'S NUMBERS AGAINST THE LIVE DATABASE. The data dump records a
       per-table row count and the ledger invariant as they were at dump time.
       Both are re-read here and compared against the database. A file that
       dumped half a table disagrees with its own trailer's totals; a database
       whose invariant is broken is reported rather than quietly preserved.
       (Skipped for a pg_dump file, which has no such trailer; -VerifyOnly on
       an old file compares only what the file itself claims.)

  On any failure the bad file is renamed *.FAILED so it can never be mistaken
  for a usable backup, and the script exits non-zero.

.PARAMETER UseFallback
  Skip pg_dump and always use scripts/pg-backup.ts. The fallback needs no
  PostgreSQL install but writes DATA ONLY -- restoring it needs this repo's
  migrations to build the schema first. pg_dump is preferred when present.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\backup-baylo-pg.ps1

.EXAMPLE
  # From a scheduled task, keeping only the last 14 dumps:
  powershell -ExecutionPolicy Bypass -File scripts\backup-baylo-pg.ps1 -Keep 14

.EXAMPLE
  # Audit a backup you already have -- which is how you find out that the one
  # you have been relying on has been empty for a week.
  powershell -ExecutionPolicy Bypass -File scripts\backup-baylo-pg.ps1 -VerifyOnly D:\BAYLO\backups\baylo-pg-20260916-084500.sql
#>

[CmdletBinding()]
param(
  [string] $OutDir      = "D:\BAYLO\backups",
  [string] $ProjectDir  = "D:\BAYLO\baylo",
  [string] $EnvFile     = "",          # defaults to <ProjectDir>\.env
  [string] $DatabaseUrl = "",          # overrides the .env value

  # Where pg_dump is, if it is not on PATH. Empty means "look for it".
  [string] $PgDumpPath  = "",
  [switch] $UseFallback,

  # Check thresholds. Raise MinTables as the schema grows -- it is a floor, and
  # a floor that never moves stops being a check.
  [int]    $MinBytes    = 102400,      # 100 KB
  [int]    $MinTables   = 25,

  # 0 keeps every dump forever.
  [int]    $Keep        = 0,

  # Run the checks against an EXISTING file and dump nothing.
  [string] $VerifyOnly  = ""
)

$ErrorActionPreference = "Stop"

function Fail([string] $Message) {
  Write-Host ""
  Write-Host "  BACKUP FAILED: $Message" -ForegroundColor Red
  Write-Host ""
  exit 1
}
function Ok([string] $Message)   { Write-Host "  OK    $Message" -ForegroundColor Green }
function Info([string] $Message) { Write-Host "  ..    $Message" -ForegroundColor DarkGray }
function Warn([string] $Message) { Write-Host "  !!    $Message" -ForegroundColor Yellow }

if (-not $EnvFile) { $EnvFile = Join-Path $ProjectDir ".env" }

# ── The connection string ────────────────────────────────────────────────────
# Never printed. A backup script that echoes the database password into a
# terminal, a log or a scheduled-task history has created a second problem.

function Get-DatabaseUrl {
  if ($DatabaseUrl) { return $DatabaseUrl }
  if ($env:DATABASE_URL) { return $env:DATABASE_URL }
  if (-not (Test-Path $EnvFile)) { Fail "no DATABASE_URL given and no $EnvFile to read it from" }
  $line = @(Get-Content $EnvFile | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' }) | Select-Object -Last 1
  if (-not $line) { Fail "no uncommented DATABASE_URL in $EnvFile" }
  return ($line -replace '^\s*DATABASE_URL\s*=\s*"?([^"]*)"?\s*$', '$1')
}

function Hide-Password([string] $Url) { return ($Url -replace '://([^:/@]+):[^@]*@', '://$1:***@') }

# ── Verification ─────────────────────────────────────────────────────────────
# Defined before it is used so -VerifyOnly can reach it without running a dump.

function Test-Dump {
  param([string] $Path, [switch] $RenameOnFailure, [string] $Url)

  function Reject([string] $Message) {
    if ($RenameOnFailure) {
      Rename-Item $Path "$Path.FAILED" -Force
      Fail "$Message  (kept as $(Split-Path $Path -Leaf).FAILED for inspection)"
    }
    Fail $Message
  }

  if (-not (Test-Path $Path)) { Fail "no such file: $Path" }

  # ── 2. size ────────────────────────────────────────────────────────────────
  $size = (Get-Item $Path).Length
  if ($size -lt $MinBytes) {
    Reject ("dump is $([math]::Round($size/1KB,1)) KB, below the $([math]::Round($MinBytes/1KB)) KB floor - this is the 991-byte failure mode")
  }
  Ok ("size $([math]::Round($size/1KB,1)) KB (floor $([math]::Round($MinBytes/1KB)) KB)")

  # ── 3. trailer ─────────────────────────────────────────────────────────────
  # Read the tail only: these files grow and the trailer is the last line.
  $tail = Get-Content $Path -Tail 6
  $isFallback = [bool]($tail -match 'Baylo data dump complete')
  $isPgDump   = [bool]($tail -match 'PostgreSQL database dump complete')
  if (-not ($isFallback -or $isPgDump)) {
    Reject "no completion trailer on the last lines - the dump was truncated"
  }
  Ok ("trailer present ($(if ($isFallback) { 'data dump, pg-backup.ts' } else { 'pg_dump' }))")

  # ── 4 and 5, in one streaming pass ─────────────────────────────────────────
  # Streaming rather than Get-Content -Raw, so a large dump need not fit in
  # memory. pg_dump writes rows as COPY blocks by default; the fallback writes
  # INSERTs. Both count as row data.
  $tables = 0; $inserts = 0; $copies = 0; $types = 0
  foreach ($line in [System.IO.File]::ReadLines($Path)) {
    if     ($line.StartsWith("CREATE TABLE "))  { $tables++ }
    elseif ($line.StartsWith("-- table: "))     { $tables++ }
    elseif ($line.StartsWith("INSERT INTO "))   { $inserts++ }
    elseif ($line.StartsWith("COPY "))          { $copies++ }
    elseif ($line.StartsWith("CREATE TYPE "))   { $types++ }
  }

  if ($tables -lt $MinTables) {
    Reject "only $tables tables in the dump, expected at least $MinTables - structurally valid and empty of schema"
  }
  Ok "$tables tables"

  if (($inserts + $copies) -lt 1) {
    Reject "$tables tables but no INSERT and no COPY - a schema-only dump of a populated database"
  }
  Ok ("row data present ($inserts INSERT, $copies COPY)")

  # A pg_dump file that lost its enum types restores into a broken schema.
  if ($isPgDump -and $types -lt 20) {
    Reject "only $types CREATE TYPE statements, expected 20 enum types"
  }
  if ($isPgDump) { Ok "$types enum types" }

  # ── 6. the trailer's numbers against the live database ─────────────────────
  $checked = $false
  if ($isFallback) {
    $rowLine = ($tail | Where-Object { $_ -match '^-- rowcounts: ' }) | Select-Object -First 1
    $invLine = ($tail | Where-Object { $_ -match '^-- invariant: ' }) | Select-Object -First 1
    if (-not $rowLine -or -not $invLine) { Reject "the trailer is missing its rowcounts/invariant lines" }

    $claimed = @{}
    foreach ($pair in ($rowLine -replace '^-- rowcounts: ', '').Trim() -split '\s+') {
      if ($pair -match '^(.+)=(\d+)$') { $claimed[$Matches[1]] = [int]$Matches[2] }
    }
    $claimedTotal = ($claimed.Values | Measure-Object -Sum).Sum
    if ($inserts -ne $claimedTotal) {
      Reject "the file holds $inserts INSERT statements but its trailer claims $claimedTotal rows - it is truncated or was written twice"
    }
    Ok "$inserts INSERT statements match the trailer's own total"

    if ($invLine -match 'userLeaves=(-?\d+) ledger=(-?\d+)') {
      $fu = [int]$Matches[1]; $fl = [int]$Matches[2]
      if ($fu -ne $fl) { Reject "the ledger invariant was BROKEN when this dump was taken (SUM(User.leaves)=$fu, SUM(amount)=$fl)" }
      Ok "ledger invariant in the dump: $fu = $fl"
    } else { Reject "could not read the invariant line in the trailer" }

    # The escrow/issuance line exists in dumps taken after bracket trading
    # (16 Sep 2026). An older dump simply has none, and that is not a defect
    # of the file -- it is stated so nobody wonders why the check was skipped.
    $escLine = ($tail | Where-Object { $_ -match '^-- escrow: ' }) | Select-Object -First 1
    if ($escLine) {
      if ($escLine -match 'escrow=(-?\d+) held=(-?\d+) issuance=(-?\d+)') {
        $fe = [int]$Matches[1]; $fh = [int]$Matches[2]; $fi = [int]$Matches[3]
        if ($fe -ne $fh) { Reject "escrow does not reconcile in this dump: ledger holds $fe, live offers/trades hold $fh" }
        if (($fu + $fe) -ne $fi) { Reject "Leaves were minted outside the issuance types in this dump: balances $fu + escrow $fe != issuance $fi" }
        Ok "escrow reconciles in the dump: $fe held = $fh on rows; $fu + $fe = issuance $fi"
      } else { Reject "could not read the escrow line in the trailer" }
    } else { Info "no escrow line (dump predates bracket trading) - reconciliation check skipped" }

    # Against the live database, when we have one to ask.
    if ($Url) {
      Info "comparing the trailer against the live database"
      Push-Location $ProjectDir
      $live = & cmd.exe /c "set `"DATABASE_URL=$Url`" && node_modules\.bin\tsx.cmd scripts\pg-backup.ts counts 2>&1"
      $code = $LASTEXITCODE
      Pop-Location
      if ($code -ne 0) { Warn "could not read live counts ($code) - skipping check 6's live half" }
      else {
        $liveCounts = @{}
        foreach ($pair in ($live[0] -split '\s+')) { if ($pair -match '^(.+)=(\d+)$') { $liveCounts[$Matches[1]] = [int]$Matches[2] } }
        $drift = @()
        foreach ($t in $claimed.Keys) {
          if ($liveCounts.ContainsKey($t) -and $liveCounts[$t] -ne $claimed[$t]) {
            $drift += "$t file=$($claimed[$t]) live=$($liveCounts[$t])"
          }
        }
        if ($drift.Count -gt 0) {
          # Not a rejection on its own: rows written between the dump and this
          # check are normal on a live database. It is stated so a LARGE drift
          # is visible rather than silent.
          Warn "tables changed since the dump: $($drift -join '; ')"
        } else { Ok "every table matches the live database exactly" }
        $checked = $true
      }
    }
  }
  if (-not $checked -and -not $isFallback) {
    Info "pg_dump file: no self-accounting trailer to cross-check (checks 1-5 applied)"
  }

  return @{ Size = $size; Tables = $tables; Rows = $inserts; Copies = $copies; Fallback = $isFallback }
}

# ── -VerifyOnly ──────────────────────────────────────────────────────────────

if ($VerifyOnly) {
  Write-Host ""
  Write-Host "  verifying $VerifyOnly" -ForegroundColor Cyan
  $u = ""
  try { $u = Get-DatabaseUrl } catch { Warn "no DATABASE_URL available - checking the file only" }
  $r = Test-Dump -Path $VerifyOnly -Url $u
  Write-Host ""
  Write-Host "  DUMP VERIFIED  $($r.Tables) tables, $($r.Rows) rows, $([math]::Round($r.Size/1KB,1)) KB" -ForegroundColor Green
  Write-Host ""
  exit 0
}

# ── Preflight ────────────────────────────────────────────────────────────────

$url = Get-DatabaseUrl
if ($url -notmatch '^postgres') { Fail "DATABASE_URL is not a Postgres URL: $(Hide-Password $url)" }

$stamp  = Get-Date -Format "yyyyMMdd-HHmmss"
$target = Join-Path $OutDir "baylo-pg-$stamp.sql"

Write-Host ""
Write-Host "  baylo Postgres backup - $stamp" -ForegroundColor Cyan
Info "database: $(Hide-Password $url)"
Info "target:   $target"
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force $OutDir | Out-Null }

# Find pg_dump: the parameter, then PATH, then the usual Windows install dirs.
function Find-PgDump {
  if ($PgDumpPath) {
    if (Test-Path $PgDumpPath) { return $PgDumpPath }
    Fail "no pg_dump at $PgDumpPath"
  }
  $onPath = (Get-Command pg_dump -ErrorAction SilentlyContinue).Source
  if ($onPath) { return $onPath }
  $guess = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\pg_dump.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
  if ($guess) { return $guess.FullName }
  return ""
}

$dump = if ($UseFallback) { "" } else { Find-PgDump }

# pg_dump older than the server refuses to run ("server version mismatch"), and
# that is a real refusal rather than a warning: a 16 client cannot be trusted to
# render 17's catalogue. Fall back rather than write a doubtful file.
if ($dump) {
  $ver = (& $dump --version) -join " "
  $major = if ($ver -match '(\d+)\.\d+') { [int]$Matches[1] } elseif ($ver -match '(\d+)') { [int]$Matches[1] } else { 0 }
  if ($major -lt 17) {
    Warn "$ver is older than the server (17) - using the no-install fallback instead"
    $dump = ""
  } else {
    Ok "pg_dump found: $ver"
  }
}

# ── The dump ─────────────────────────────────────────────────────────────────

if ($dump) {
  Info "dumping schema and data with pg_dump..."
  # --file, never a pipeline. See check 1 in the header.
  $dumpArgs = @(
    $url
    "--schema=public"
    "--no-owner"            # Supabase owns its roles; a restore elsewhere should not need them
    "--no-privileges"
    "--format=plain"
    "--file=$target"
  )
  $stderr = Join-Path $env:TEMP "baylo-pg-backup-$stamp.err"
  $proc = Start-Process -FilePath $dump -ArgumentList $dumpArgs -NoNewWindow -Wait -PassThru -RedirectStandardError $stderr
  if ($proc.ExitCode -ne 0) {
    $why = if (Test-Path $stderr) { (Get-Content $stderr -TotalCount 3) -join " " } else { "no stderr" }
    if (Test-Path $target) { Rename-Item $target "$target.FAILED" -Force }
    Fail "pg_dump exited $($proc.ExitCode) - $why"
  }
  Ok "pg_dump exited 0"
  Remove-Item $stderr -ErrorAction SilentlyContinue
} else {
  if (-not $UseFallback) {
    Warn "pg_dump is not installed - using scripts/pg-backup.ts (data only)"
    Warn "restoring this file needs THIS REPO: prisma migrate deploy, then the restore command in its header"
    Info "to get pg_dump: winget install -e --id PostgreSQL.PostgreSQL.17"
  }
  Info "dumping data with pg-backup.ts..."
  Push-Location $ProjectDir
  # The script writes the file itself, so $LASTEXITCODE is genuinely its own.
  & cmd.exe /c "set `"DATABASE_URL=$url`" && node_modules\.bin\tsx.cmd scripts\pg-backup.ts dump `"$target`""
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) {
    if (Test-Path $target) { Rename-Item $target "$target.FAILED" -Force }
    Fail "pg-backup.ts exited $code"
  }
  Ok "pg-backup.ts exited 0"
}

if (-not (Test-Path $target)) { Fail "the dump tool exited 0 but wrote no file" }

# ── Verification ─────────────────────────────────────────────────────────────

$result = Test-Dump -Path $target -RenameOnFailure -Url $url

# ── Retention ────────────────────────────────────────────────────────────────

if ($Keep -gt 0) {
  $old = Get-ChildItem $OutDir -Filter "baylo-pg-*.sql" |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep
  foreach ($f in $old) {
    Remove-Item $f.FullName -Force
    Info "pruned $($f.Name)"
  }
}

Write-Host ""
Write-Host "  BACKUP VERIFIED  $target" -ForegroundColor Green
Write-Host ("  {0} tables, {1} rows, {2} KB{3}" -f $result.Tables, $result.Rows,
  [math]::Round($result.Size/1KB,1), $(if ($result.Fallback) { " (data only)" } else { " (schema and data)" })) -ForegroundColor Green
Write-Host ""
exit 0
