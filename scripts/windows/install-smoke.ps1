#Requires -Version 7.0
param(
    [ValidateSet('x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc')]
    [string] $Target = 'x86_64-pc-windows-msvc'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$architecture = if ($Target -eq 'aarch64-pc-windows-msvc') { 'arm64' } else { 'x86_64' }
$expectedMachine = if ($architecture -eq 'arm64') { 0xAA64 } else { 0x8664 }
$out = Join-Path $env:RUNNER_TEMP "windows-install-$architecture"
New-Item $out -ItemType Directory | Out-Null

function Assert-Machine([string] $Path) {
    $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($Path))
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw "Missing DOS signature: $Path" }
        $reader.BaseStream.Position = 0x3C
        $offset = $reader.ReadUInt32()
        $reader.BaseStream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw "Missing PE signature: $Path" }
        $machine = $reader.ReadUInt16()
        if ($machine -ne $expectedMachine) { throw ('Unexpected PE machine: 0x{0:X4}' -f $machine) }
        Write-Output ('{0}: PE machine 0x{1:X4} ({2})' -f (Split-Path $Path -Leaf), $machine, $architecture)
    } finally { $reader.Dispose() }
}

$packages = Join-Path $repo 'app/dist-windows'
Expand-Archive (Join-Path $packages "garret-windows-$architecture.zip") (Join-Path $out 'portable')
$portable = Join-Path $out 'portable/app/garret.exe'
Assert-Machine $portable
# NSIS uses an x86 launcher even when its application payload is ARM64.
$installer = Join-Path $packages "garret-windows-$architecture-setup.exe"
$installDir = Join-Path $out 'installed'
$process = Start-Process $installer -ArgumentList @('/S', "/D=$installDir") -PassThru
try {
    if (-not $process.WaitForExit(180000)) { throw 'Installer exceeded 180 seconds' }
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
} finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}
$installed = Join-Path $installDir 'garret.exe'
Assert-Machine $installed
if ((Get-FileHash $installed).Hash -ne (Get-FileHash $portable).Hash) {
    throw 'Installed executable differs from the portable executable'
}
if (-not (Test-Path (Join-Path $installDir 'dist/index.html') -PathType Leaf)) {
    throw 'Installed interface is missing'
}
$fixture = Join-Path $repo 'app/fixtures/sample'
$project = Join-Path $out 'sample.db'
$process = Start-Process $installed -ArgumentList @('--seed', "`"$fixture`"", "`"$project`"") -PassThru `
    -RedirectStandardOutput (Join-Path $out 'seed.log') -RedirectStandardError (Join-Path $out 'seed-error.log')
try {
    if (-not $process.WaitForExit(120000)) { throw 'Installed application exceeded 120 seconds' }
    if ($process.ExitCode -ne 0) {
        Get-Content (Join-Path $out 'seed-error.log')
        throw "Installed application failed: $($process.ExitCode)"
    }
    if (-not (Test-Path $project -PathType Leaf)) { throw 'Installed application did not seed the sample book' }
} finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}
Write-Output "Windows $architecture portable, installation and sample-book checks passed"
