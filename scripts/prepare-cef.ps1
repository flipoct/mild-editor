# Lay out CEF for the Windows installer.
#
#   $env:CEF_PATH = "$env:USERPROFILE/.local/share/cef"; scripts/prepare-cef.ps1
#
# The NSIS bundle takes everything under src-tauri/cef/win/ and installs it next to the
# executable (tauri.cef.windows.conf.json), which is where libcef.dll expects its
# resources and locales. Only the runtime files are copied: the headers, import libraries
# and CMake project that export-cef-dir also unpacks are build-time inputs the cef crate
# reads from CEF_PATH itself.
#
# `tauri dev` needs no staging: the cef crate's build script copies the same files into
# the cargo target directory next to the dev binary.
#
# Without CEF_PATH this script only warns: the editor builds and runs, the problem panel
# reports itself unavailable.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "src-tauri/cef/win"

if (-not $env:CEF_PATH) {
    Write-Warning "prepare-cef: CEF_PATH is not set; building without the problem panel"
    exit 0
}
$cef = $env:CEF_PATH
if (-not (Test-Path (Join-Path $cef "libcef.dll"))) {
    throw "prepare-cef: no libcef.dll under $cef (run export-cef-dir --target x86_64-pc-windows-msvc)"
}

if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force $out | Out-Null

# Runtime files sit flat next to the executable; locales/ is the one directory Chromium
# looks for beside them.
$runtime = @(".dll", ".pak", ".bin", ".dat")
Get-ChildItem -LiteralPath $cef -File | Where-Object {
    $runtime -contains $_.Extension -or $_.Name -eq "vk_swiftshader_icd.json"
} | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $out }
Copy-Item -LiteralPath (Join-Path $cef "locales") -Destination (Join-Path $out "locales") -Recurse

$count = (Get-ChildItem -LiteralPath $out -Recurse -File | Measure-Object).Count
$size = [math]::Round((Get-ChildItem -LiteralPath $out -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB)
Write-Host "prepare-cef: staged $count files ($size MB) under $out"
