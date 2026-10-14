# ClipQueue setup check. Run from the project folder:
#   powershell -ExecutionPolicy Bypass -File .\check-setup.ps1
# Lists what is missing and how to fix it. Nothing is installed or changed.
$ErrorActionPreference = "SilentlyContinue"
$script:failed = 0
$root = $PSScriptRoot
$triple = "x86_64-pc-windows-msvc"

function Check($name, $pass, $fix) {
  if ($pass) { Write-Host ("  [ OK ]    " + $name) -ForegroundColor Green }
  else { Write-Host ("  [MISSING] " + $name) -ForegroundColor Red; Write-Host ("            Fix: " + $fix) -ForegroundColor Yellow; $script:failed++ }
}
function Warn($name, $problem, $fix) {
  if ($problem) { Write-Host ("  [ WARN ]  " + $name) -ForegroundColor Yellow; Write-Host ("            " + $fix) -ForegroundColor DarkYellow }
  else { Write-Host ("  [ OK ]    " + $name) -ForegroundColor Green }
}

Write-Host "`nClipQueue setup check`n" -ForegroundColor Cyan
Write-Host "Required tools" -ForegroundColor Cyan

$nodeV = node --version 2>$null
$nodeMajor = 0
if ($nodeV) { $nodeMajor = [int](($nodeV -replace '^v','') -split '\.')[0] }
Check "Node.js 20 or newer ($nodeV)" ($nodeMajor -ge 20) "winget install OpenJS.NodeJS.LTS"
Check "npm" ([bool](npm --version 2>$null)) "Comes with Node.js; reinstall Node.js"
Check "Rust compiler (rustc)" ([bool](rustc --version 2>$null)) "winget install Rustlang.Rustup, then reopen PowerShell"
Check "Cargo" ([bool](cargo --version 2>$null)) "Reinstall Rust with rustup"
$host64 = (rustc -vV 2>$null) -match "host: $triple"
Check "Rust MSVC toolchain ($triple)" $host64 "rustup default stable-x86_64-pc-windows-msvc"

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$vc = $null
if (Test-Path $vswhere) { $vc = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null }
Check "Visual Studio Build Tools with C++" ([bool]$vc) "Install 'Build Tools for Visual Studio' and tick 'Desktop development with C++'"

$wv = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
$wvv = (Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$wv").pv
if (-not $wvv) { $wvv = (Get-ItemProperty "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$wv").pv }
Check "WebView2 runtime" ([bool]$wvv) "Install the Evergreen runtime from https://developer.microsoft.com/microsoft-edge/webview2/"

Write-Host "`nProject files" -ForegroundColor Cyan
Check "npm packages installed (node_modules)" (Test-Path (Join-Path $root "node_modules")) "npm install"
foreach ($n in "yt-dlp","ffmpeg","ffprobe") {
  $f = Join-Path $root "src-tauri\binaries\$n-$triple.exe"
  Check "Engine file: $n-$triple.exe" (Test-Path $f) "powershell -ExecutionPolicy Bypass -File .\get-engines.ps1"
}
Check "App icon (src-tauri\icons\icon.ico)" (Test-Path (Join-Path $root "src-tauri\icons\icon.ico")) "npx tauri icon path\to\logo.png"

Write-Host "`nThings that commonly cause build errors" -ForegroundColor Cyan
$busy = [bool](Get-NetTCPConnection -LocalPort 1420 -State Listen 2>$null)
Warn "Port 1420 is free" $busy "Another dev server is running. Close it, or run: taskkill /F /IM node.exe"
$odd = ($root -match "OneDrive|Dropbox|Google Drive|iCloud|\\Downloads\\|\\Desktop\\") -or ($root.Length -gt 60)
Warn "Project folder location" $odd "Move the project to a short local path such as C:\clipqueue. Synced, Downloads and long paths cause file-lock errors."
$excl = (Get-MpPreference).ExclusionPath
$isExcl = $false
foreach ($e in $excl) { if ($e -and $root.StartsWith($e, [System.StringComparison]::OrdinalIgnoreCase)) { $isExcl = $true } }
Warn "Antivirus exclusion for the project folder" (-not $isExcl) "If builds fail with 'os error 32', run PowerShell as admin: Add-MpPreference -ExclusionPath '$root' (this check cannot see exclusions without admin rights or with other antivirus)"
$driveName = (Get-Item $root).PSDrive.Name
$free = (Get-PSDrive $driveName).Free / 1GB
Warn ("Free disk space on $driveName`: ({0:N1} GB)" -f $free) ($free -lt 5) "Release builds need about 5 GB free."

Write-Host ""
if ($script:failed -eq 0) { Write-Host "All required checks passed. Run: npm run tauri dev" -ForegroundColor Green; exit 0 }
else { Write-Host ("$script:failed required item(s) missing. Fix them and run this check again.") -ForegroundColor Red; exit 1 }
