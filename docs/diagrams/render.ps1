# render.ps1 - Render .puml files to .png via the public PlantUML server (no Java needed).
#
# PlantUML's URL format is:
#     https://www.plantuml.com/plantuml/png/<ENCODED>
# where <ENCODED> is the diagram text DEFLATE-compressed (raw deflate, no zlib
# header) and re-encoded with PlantUML's custom base64 alphabet.
#
# Usage:  powershell -ExecutionPolicy Bypass -File render.ps1
#         powershell -ExecutionPolicy Bypass -File render.ps1 use-case-admin

param(
    [string]$Only = ""
)

$ErrorActionPreference = "Stop"
$server = "https://www.plantuml.com/plantuml/png"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir = Join-Path $here "png"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

# PlantUML's base64 alphabet (standard alphabet with - and _ substituted at 62/63)
$alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"

function Get-PlantUmlEncoded([string]$text) {
    # 1. UTF-8 bytes
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)

    # 2. Raw DEFLATE (no zlib/gzip wrapper)
    $ms = New-Object System.IO.MemoryStream
    $ds = New-Object System.IO.Compression.DeflateStream($ms, [System.IO.Compression.CompressionMode]::Compress)
    $ds.Write($bytes, 0, $bytes.Length)
    $ds.Close()
    $deflated = $ms.ToArray()
    $ms.Close()

    # 3. PlantUML's 3-bytes-to-4-chars base64 over the custom alphabet
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $deflated.Length; $i += 3) {
        $b0 = $deflated[$i]
        $b1 = if ($i + 1 -lt $deflated.Length) { $deflated[$i + 1] } else { 0 }
        $b2 = if ($i + 2 -lt $deflated.Length) { $deflated[$i + 2] } else { 0 }

        $c0 = $b0 -shr 2
        $c1 = (($b0 -band 0x3) -shl 4) -bor ($b1 -shr 4)
        $c2 = (($b1 -band 0xF) -shl 2) -bor ($b2 -shr 6)
        $c3 = $b2 -band 0x3F

        [void]$sb.Append($alphabet[$c0])
        [void]$sb.Append($alphabet[$c1])
        [void]$sb.Append($alphabet[$c2])
        [void]$sb.Append($alphabet[$c3])
    }
    return $sb.ToString()
}

$files = Get-ChildItem -Path $here -Filter *.puml
if ($Only -ne "") {
    $files = $files | Where-Object { $_.BaseName -like "*$Only*" }
}

foreach ($file in $files) {
    Write-Host "Rendering $($file.Name) ..." -ForegroundColor Cyan
    $text = Get-Content -Raw -Path $file.FullName
    $encoded = Get-PlantUmlEncoded $text
    $url = "$server/$encoded"
    $outPath = Join-Path $outDir ($file.BaseName + ".png")

    try {
        Invoke-WebRequest -Uri $url -OutFile $outPath -UseBasicParsing -TimeoutSec 60
        $size = (Get-Item $outPath).Length
        Write-Host "  OK  -> png/$($file.BaseName).png ($size bytes)" -ForegroundColor Green
    } catch {
        Write-Host "  FAIL -> $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host "Done." -ForegroundColor Yellow
