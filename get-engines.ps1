# Downloads yt-dlp, ffmpeg and ffprobe into src-tauri\binaries with the names Tauri expects.
$ErrorActionPreference = "Stop"
$t = "x86_64-pc-windows-msvc"
$d = Join-Path $PSScriptRoot "src-tauri\binaries"
New-Item -ItemType Directory -Force $d | Out-Null
Invoke-WebRequest "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile "$d\yt-dlp-$t.exe"
$zip = Join-Path $env:TEMP "ffmpeg-essentials.zip"; $tmp = Join-Path $env:TEMP "ffmpeg-essentials"
Invoke-WebRequest "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $zip
Expand-Archive $zip $tmp -Force
foreach ($n in "ffmpeg","ffprobe") {
  Copy-Item (Get-ChildItem $tmp -Recurse -Filter "$n.exe" | Select-Object -First 1).FullName "$d\$n-$t.exe"
}
Write-Host "Engines ready in $d"
