#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$exe = Join-Path $repo 'app/shell-tauri/src-tauri/target/x86_64-pc-windows-msvc/release/garret.exe'
$out = Join-Path $env:RUNNER_TEMP 'pdf-smoke'
New-Item $out -ItemType Directory | Out-Null
$fixture = Join-Path $repo 'app/fixtures/sample'
$project = Join-Path $out 'sample.db'
$seed = Start-Process $exe -ArgumentList @('--seed', "`"$fixture`"", "`"$project`"") -PassThru -Wait `
    -RedirectStandardOutput (Join-Path $out 'seed.log') -RedirectStandardError (Join-Path $out 'seed-error.log')
if ($seed.ExitCode -ne 0) { throw "Seed failed: $($seed.ExitCode)" }

# Preserve runner/runtime facts without uploading its profile or seeded database.
@{
    os = [Environment]::OSVersion.VersionString
    runner = $env:ImageVersion
    webview = @(Get-ChildItem "${env:ProgramFiles(x86)}/Microsoft/EdgeWebView/Application" -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
} | ConvertTo-Json | Set-Content (Join-Path $out 'environment.json')
$env:GARRET_PDF_SMOKE = $out
$process = Start-Process $exe -PassThru `
    -RedirectStandardOutput (Join-Path $out 'stdout.log') -RedirectStandardError (Join-Path $out 'stderr.log')
try {
    if (-not $process.WaitForExit(270000)) {
        Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'garret|msedgewebview2' } |
            Select-Object Name, ProcessId, ParentProcessId, ExecutablePath |
            ConvertTo-Json | Set-Content (Join-Path $out 'timeout-processes.json')
        throw 'Native PDF smoke exceeded 270 seconds; inspect phases.jsonl and timeout-processes.json'
    }
    Get-Content (Join-Path $out 'phases.jsonl')
    Get-Content (Join-Path $out 'result.json')
    if ($process.ExitCode -ne 0) { throw "Native PDF smoke failed: $($process.ExitCode)" }
    $result = Get-Content (Join-Path $out 'result.json') -Raw | ConvertFrom-Json
    if (-not $result.ok -or $result.pages -le 1 -or $result.pages -ne $result.leaves -or
        $result.bytes -ne (Get-Item (Join-Path $out 'proof.pdf')).Length) {
        throw 'PDF result does not satisfy the sample export contract'
    }
} finally {
    Remove-Item Env:GARRET_PDF_SMOKE
    if (-not $process.HasExited) { taskkill /PID $process.Id /T /F }
}
