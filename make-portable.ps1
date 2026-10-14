# Run after "npm run tauri build". Packs the portable version: no installer, just unzip and run.
$ErrorActionPreference = "Stop"
$r = Join-Path $PSScriptRoot "src-tauri\target\release"
$out = Join-Path $PSScriptRoot "ClipQueue-portable"
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $out | Out-Null
foreach ($f in "clipqueue.exe","yt-dlp.exe","ffmpeg.exe","ffprobe.exe") {
  $p = Join-Path $r $f
  if (-not (Test-Path $p)) { throw "Missing $p - run npm run tauri build first." }
  Copy-Item $p $out
}
Compress-Archive "$out\*" (Join-Path $PSScriptRoot "ClipQueue-portable.zip") -Force
Write-Host "Created ClipQueue-portable.zip"
