# release-windows.ps1 — Step 2b: build Windows x64, upload.
# Run on a Windows machine after create-release.sh.
#
# Usage: .\scripts\release\release-windows.ps1 v0.2.0
#Requires -Version 5.1
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidatePattern('^v\d')]
    [string]$Version
)

$ErrorActionPreference = 'Stop'

# ── Helpers ───────────────────────────────────────────────────────────────────
function Find-RepoRoot {
    $dir = $PSScriptRoot
    while ($dir -and -not (Test-Path (Join-Path $dir '.git'))) {
        $dir = Split-Path $dir -Parent
    }
    if (-not $dir) { throw 'Could not locate git repo root (no .git found)' }
    return $dir
}

function Import-EnvFile([string]$Path) {
    if (-not (Test-Path $Path)) {
        throw ".env.release not found at $Path`nCopy scripts\release\.env.release.example to .env.release (repo root) and fill in the values."
    }
    foreach ($line in Get-Content $Path) {
        $line = $line.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $idx = $line.IndexOf('=')
        if ($idx -le 0) { continue }
        $name  = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
        [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

function Assert-EnvVars([string[]]$Names) {
    $missing = $Names | Where-Object { -not [System.Environment]::GetEnvironmentVariable($_) }
    if ($missing) { throw "Missing required env vars in .env.release:`n  $($missing -join "`n  ")" }
}

function Assert-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name — install it and try again"
    }
}

function Log([string]$Msg)     { Write-Host "▶  $Msg" }
function Success([string]$Msg) { Write-Host "✓  $Msg" -ForegroundColor Green }

# ── Setup ─────────────────────────────────────────────────────────────────────
$RepoRoot = Find-RepoRoot
Import-EnvFile (Join-Path $RepoRoot '.env.release')

Assert-EnvVars @('TAURI_SIGNING_PRIVATE_KEY', 'GITHUB_TOKEN', 'GITHUB_REPO')
Assert-Command 'gh'
Assert-Command 'node'
Assert-Command 'npx'

Set-Location $RepoRoot

$BundleDir = Join-Path $RepoRoot 'src-tauri\target\x86_64-pc-windows-msvc\release\bundle'

# ── 1. Build sidecar ─────────────────────────────────────────────────────────
Log 'Building Windows x64 sidecar (node20-win-x64)...'
$env:SKILLWORKS_PKG_TARGET   = 'node20-win-x64'
$env:TAURI_ENV_TARGET_TRIPLE = 'x86_64-pc-windows-msvc'
node scripts/build-tauri-sidecar.js
if ($LASTEXITCODE -ne 0) { throw 'Sidecar build failed' }
Success 'Windows sidecar ready'

# ── 2. Tauri build ────────────────────────────────────────────────────────────
Log 'Building Tauri app for x86_64-pc-windows-msvc...'
npx tauri build --target x86_64-pc-windows-msvc
if ($LASTEXITCODE -ne 0) { throw 'Tauri build failed' }

# ── 3. Locate artifacts ───────────────────────────────────────────────────────
$NsisDir = Join-Path $BundleDir 'nsis'
$MsiDir  = Join-Path $BundleDir 'msi'

$Exe = Get-ChildItem $NsisDir -Filter '*-setup.exe'    -ErrorAction SilentlyContinue | Select-Object -First 1
$Zip = Get-ChildItem $NsisDir -Filter '*.nsis.zip'     -ErrorAction SilentlyContinue | Select-Object -First 1
$Sig = Get-ChildItem $NsisDir -Filter '*.nsis.zip.sig' -ErrorAction SilentlyContinue | Select-Object -First 1
$Msi = Get-ChildItem $MsiDir  -Filter '*.msi'          -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $Exe) { throw "NSIS setup .exe not found under $NsisDir" }
if (-not $Zip) { throw ".nsis.zip not found under $NsisDir" }
if (-not $Sig) { throw ".nsis.zip.sig not found — check that TAURI_SIGNING_PRIVATE_KEY is set correctly" }

$UploadFiles = @($Exe.FullName, $Zip.FullName, $Sig.FullName)
if ($Msi) { $UploadFiles += $Msi.FullName }

# ── 4. Upload to GitHub Release ───────────────────────────────────────────────
Log "Uploading Windows artifacts to GitHub Release $Version..."
gh release upload $Version @UploadFiles --repo $env:GITHUB_REPO --clobber
if ($LASTEXITCODE -ne 0) { throw 'Upload failed' }

Success 'Windows artifacts uploaded:'
$UploadFiles | ForEach-Object { Write-Host "  $(Split-Path $_ -Leaf)" }
