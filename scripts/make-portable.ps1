<#
.SYNOPSIS
  ساخت نسخهٔ پرتابل.
.DESCRIPTION
  همان پیلود نصبی، بعلاوهٔ یک فایل نشانه (portable.flag).
  وجود این فایل باعث می‌شود برنامه تنظیمات و لاگ‌ها را کنار خود اجرایی
  ذخیره کند (نه در %LOCALAPPDATA%) — معنای واقعی پرتابل بودن.
#>
param(
  [Parameter(Mandatory = $true)][string]$Arch,
  [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot
$payload = Join-Path $root "dist/payload-$Arch"
$stage   = Join-Path $root "dist/portable-$Arch/Aether"
$zip     = Join-Path $root "dist/Aether-Portable-$Version-$Arch.zip"

if (-not (Test-Path $payload)) { throw "Payload missing: $payload" }

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item "$payload/*" $stage -Recurse -Force

# نشانهٔ حالت پرتابل
Set-Content -Path (Join-Path $stage 'portable.flag') -Value '1' -NoNewline -Encoding ascii

@"
Aether $Version - Portable ($Arch)
=================================

اجرا: روی Aether.exe کلیک کنید.

توجه: برقراری تونل نیازمند دسترسی مدیر (Administrator) است، چون آداپتور
      Wintun باید ساخته شود — دقیقاً معادل دیالوگ مجوز VPN در اندروید.
      برنامه در صورت نیاز خودش درخواست ارتقای دسترسی می‌دهد.

تمام تنظیمات و لاگ‌ها در کنار همین پوشه ذخیره می‌شوند.
بروزرسانی فقط از طریق صفحهٔ رسمی GitHub Releases انجام می‌شود.
"@ | Set-Content -Path (Join-Path $stage 'READ-ME-FIRST.txt') -Encoding utf8

# --- slim step 1: drop build-only leftovers that add bytes, not behaviour ---
# Debug symbols / incremental-link files can reach the payload when the runner
# restores a previous target/ cache. They are never needed at runtime.
Get-ChildItem $stage -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -in '.pdb', '.map', '.ilk', '.exp', '.lib', '.idb' } |
  Remove-Item -Force -ErrorAction SilentlyContinue

# --- slim step 2: a real compressor ----------------------------------------
# Compress-Archive uses .NET Deflate. On the upstream 1.4.0 release that made
# the portable ZIP 63.6 MiB while the very same payload in Inno Setup LZMA2
# was only 37.3 MiB. 7-Zip's Deflate (mx=9, 258 fast bytes, 15 passes) is
# measurably tighter than .NET's Optimal, and it is preinstalled on GitHub's
# windows-latest runners. Fall back to Compress-Archive when it is absent.
$sevenZip = @(
  (Join-Path $env:ProgramFiles '7-Zip\7z.exe'),
  (Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe'),
  'C:\Program Files\7-Zip\7z.exe'
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

Remove-Item $zip -Force -ErrorAction SilentlyContinue
if ($sevenZip) {
  & $sevenZip a -tzip -mx=9 -mfb=258 -mpass=15 -mm=Deflate -r -- $zip "$stage\*" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "7-Zip could not build $zip" }
  Write-Host "==> ZIP recompressed with 7-Zip Deflate ultra ($sevenZip)"
} else {
  Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
  Write-Host "==> 7-Zip not found; fell back to Compress-Archive Optimal"
}

function Show-Size([string]$file) {
  if (Test-Path $file) {
    Write-Host ("    {0}: {1:N2} MiB" -f (Split-Path $file -Leaf), ((Get-Item $file).Length / 1MB))
  }
}
Show-Size $zip

# --- slim step 3: optional LZMA2 edition ------------------------------------
# Same payload, same name pattern, different container. LZMA2 solid on this
# payload is roughly 35-45% smaller than Deflate. Published as an extra asset
# so the standard .zip stays available for users without an unpacker.
if ($sevenZip) {
  $seven = Join-Path $root "dist/Aether-Portable-$Version-$Arch.7z"
  Remove-Item $seven -Force -ErrorAction SilentlyContinue
  & $sevenZip a -t7z -mx=9 -m0=LZMA2:d=32m:fb=273 -ms=on -r -- $seven "$stage\*" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "7-Zip could not build $seven" }
  Write-Host "==> LZMA2 edition built"
  Show-Size $seven
}
Write-Host "==> $zip"
