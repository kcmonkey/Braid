<#
.SYNOPSIS
  Convert a screen recording (MP4/MKV/MOV) into a small, high-quality GIF
  suitable for the README hero image.

.DESCRIPTION
  Uses ffmpeg's two-pass palette method (palettegen + paletteuse), which gives
  far better quality at a fraction of the size of a naive `ffmpeg -i in out.gif`.
  Requires ffmpeg on PATH (https://ffmpeg.org/ — or `winget install Gyan.FFmpeg`).

.PARAMETER Source
  Input video file (the raw screen recording).

.PARAMETER Out
  Output GIF path. Default: media\demo\demo.gif

.PARAMETER Fps
  Frames per second. Lower = smaller file. 12-15 is a good range. Default: 15

.PARAMETER Width
  Output width in pixels (height auto-keeps aspect ratio). Default: 860

.PARAMETER Start
  Optional start offset, e.g. "3" or "00:00:03". Trims the head.

.PARAMETER Duration
  Optional clip length in seconds, e.g. "35". Trims the tail.

.EXAMPLE
  ./scripts/make-gif.ps1 -Source .\raw-demo.mp4

.EXAMPLE
  ./scripts/make-gif.ps1 -Source .\raw-demo.mkv -Out .\media\demo\demo.gif -Fps 12 -Width 760 -Start 2 -Duration 35
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Source,

    [string]$Out = (Join-Path $PSScriptRoot '..\media\demo\demo.gif'),

    [int]$Fps = 15,

    [int]$Width = 860,

    [string]$Start = '',

    [string]$Duration = ''
)

$ErrorActionPreference = 'Stop'

# --- preflight ---------------------------------------------------------------
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
    Write-Error "ffmpeg not found on PATH. Install it (e.g. 'winget install Gyan.FFmpeg') and reopen the shell, or use ScreenToGif to export a GIF directly."
    exit 1
}

if (-not (Test-Path -LiteralPath $Source)) {
    Write-Error "Source video not found: $Source"
    exit 1
}

$Source = (Resolve-Path -LiteralPath $Source).Path
$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

# Build the optional trim args (apply to BOTH passes so palette matches output).
$trim = @()
if ($Start)    { $trim += @('-ss', $Start) }
if ($Duration) { $trim += @('-t',  $Duration) }

$palette = Join-Path ([System.IO.Path]::GetTempPath()) 'bc-demo-palette.png'
$filters = "fps=$Fps,scale=${Width}:-1:flags=lanczos"

Write-Host "[1/2] Generating color palette..." -ForegroundColor Cyan
& ffmpeg -y @trim -i $Source -vf "$filters,palettegen=stats_mode=diff" $palette
if ($LASTEXITCODE -ne 0) { Write-Error "palettegen failed (ffmpeg exit $LASTEXITCODE)"; exit 1 }

Write-Host "[2/2] Encoding GIF..." -ForegroundColor Cyan
& ffmpeg -y @trim -i $Source -i $palette -lavfi "$filters [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" $Out
if ($LASTEXITCODE -ne 0) { Write-Error "paletteuse failed (ffmpeg exit $LASTEXITCODE)"; exit 1 }

Remove-Item -LiteralPath $palette -ErrorAction SilentlyContinue

# --- report ------------------------------------------------------------------
$sizeMB = [math]::Round((Get-Item -LiteralPath $Out).Length / 1MB, 2)
Write-Host ""
Write-Host "Done -> $Out  ($sizeMB MB, ${Fps}fps, ${Width}px wide)" -ForegroundColor Green
if ($sizeMB -gt 8) {
    Write-Warning "GIF is over 8 MB — GitHub renders inline GIFs up to ~10 MB. Try -Fps 12, -Width 760, or trim with -Start/-Duration."
}
