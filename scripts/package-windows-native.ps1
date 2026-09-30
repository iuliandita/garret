#Requires -Version 7.0
# Build a portable Windows package on a native MSVC runner.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Checked {
    param([string] $Command, [string[]] $Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

$repo = Split-Path -Parent $PSScriptRoot
$revision = Invoke-Checked -Command git -Arguments @('-C', $repo, 'rev-parse', 'HEAD')
function Assert-UnchangedSource {
    $current = Invoke-Checked -Command git -Arguments @('-C', $repo, 'rev-parse', 'HEAD')
    $changes = Invoke-Checked -Command git -Arguments @('-C', $repo, 'status', '--porcelain')
    if ($current -ne $revision -or $changes) {
        throw 'Commit or set aside source changes before packaging; source must stay unchanged during the build.'
    }
}
Assert-UnchangedSource

$target = 'x86_64-pc-windows-msvc'
$hostDir = Join-Path $repo 'app/shell-tauri/src-tauri'
$uiDist = Join-Path $repo 'app/ui/dist'
$hostDist = Join-Path $repo 'app/shell-tauri/dist'
$out = Join-Path $repo 'app/dist-windows'
$stage = Join-Path $out 'app'
$config = Get-Content (Join-Path $hostDir 'tauri.conf.json') -Raw | ConvertFrom-Json
$lock = Get-Content (Join-Path $hostDir 'Cargo.lock') -Raw
$tauri = [regex]::Match($lock, '(?m)^name = "tauri"\r?\nversion = "([^"]+)"')
if (-not $tauri.Success) { throw 'Cannot read the locked Tauri version.' }

Push-Location (Join-Path $repo 'app/ui')
try { Invoke-Checked -Command bun -Arguments @('run', 'build') }
finally { Pop-Location }
# Tauri embeds this directory at compile time, independently of runtime dist.
if (Test-Path $hostDist) { Remove-Item $hostDist -Recurse -Force }
Copy-Item $uiDist $hostDist -Recurse

$flagsName = 'CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS'
$previousFlags = [Environment]::GetEnvironmentVariable($flagsName)
[Environment]::SetEnvironmentVariable($flagsName, '-C target-feature=+crt-static')
Push-Location $hostDir
try { Invoke-Checked -Command cargo -Arguments @('build', '--locked', '--release', '--target', $target, '-j', '8') }
finally {
    Pop-Location
    [Environment]::SetEnvironmentVariable($flagsName, $previousFlags)
}
Assert-UnchangedSource

$exe = Join-Path $hostDir "target/$target/release/garret.exe"
if (-not (Test-Path $exe -PathType Leaf)) { throw "No binary at $exe" }
# Fresh staging prevents old interface assets from entering a new package.
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item $stage -ItemType Directory -Force | Out-Null
Copy-Item $exe (Join-Path $stage 'garret.exe')
Copy-Item $uiDist (Join-Path $stage 'dist') -Recurse
Copy-Item (Join-Path $PSScriptRoot 'windows/README.txt') (Join-Path $stage 'README.txt')
Copy-Item (Join-Path $repo 'COPYING'), (Join-Path $repo 'THIRD-PARTY-NOTICES.md') $stage
@(
    "Source revision: $revision"
    "Application version: $($config.version)"
    "Tauri version: $($tauri.Groups[1].Value)"
    "Target: $target"
    "Built UTC: $([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))"
    'Signing: unsigned'
    'Windows GUI verification: not performed for this build'
) | Set-Content (Join-Path $stage 'BUILD.txt') -Encoding utf8NoBOM

$sums = Get-ChildItem $stage -File -Recurse | Sort-Object FullName | ForEach-Object {
    $relative = [IO.Path]::GetRelativePath($stage, $_.FullName).Replace('\', '/')
    "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $relative"
}
$sums | Set-Content (Join-Path $stage 'SHA256SUMS.txt') -Encoding utf8NoBOM
$zip = Join-Path $out 'garret-windows-x86_64.zip'
Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
"$((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($zip))" |
    Set-Content "$zip.sha256" -Encoding utf8NoBOM
Assert-UnchangedSource
Write-Output "Wrote $zip"
