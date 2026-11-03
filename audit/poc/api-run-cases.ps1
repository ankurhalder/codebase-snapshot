# api-run-cases.ps1 - deterministic CLI behaviour capture (no early pipeline termination)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # repo root
$poc  = $PSScriptRoot
$fix  = Join-Path $poc 'api-fixture'
$trace = Join-Path $poc 'api-trace-writes.cjs'
$results = New-Object System.Collections.Generic.List[object]

function Run-Case {
    param([string]$Name, [string[]]$CliArgs, [string]$WorkDir = $root, [switch]$Trace)
    $outFile = Join-Path $poc "api-case-$Name.out.txt"
    $errFile = Join-Path $poc "api-case-$Name.err.txt"
    $env:TRACE_LOG = (Join-Path $poc "api-case-$Name.writes.txt")
    Remove-Item $env:TRACE_LOG -ErrorAction SilentlyContinue
    if ($Trace) { $env:NODE_OPTIONS = "--require $trace" } else { $env:NODE_OPTIONS = $null }
    Push-Location $WorkDir
    & node (Join-Path $root 'dist\cli.js') @CliArgs > $outFile 2> $errFile
    $code = $LASTEXITCODE
    Pop-Location
    $env:NODE_OPTIONS = $null
    $out = [string]((Get-Content $outFile -Raw) -replace '\r', '')
    $err = [string]((Get-Content $errFile -Raw) -replace '\r', '')
    $writes = if (Test-Path $env:TRACE_LOG) { (Get-Content $env:TRACE_LOG) -join ' | ' } else { '<none>' }
    $results.Add([pscustomobject]@{ Case = $Name; Exit = $code; Out = $out; Err = $err; Writes = $writes })
    Write-Host ("=" * 78)
    Write-Host "CASE: $Name  exit=$code"
    Write-Host "--- stdout ---"
    Write-Host $out.TrimEnd()
    if ($err.Trim().Length -gt 0) { Write-Host "--- stderr ---"; Write-Host $err.TrimEnd() }
    if ($writes -ne '<none>') { Write-Host "--- fs writes ---"; Write-Host $writes }
}

Run-Case -Name 'dryrun'      -CliArgs @('generate','--cwd',$fix,'--dry-run') -Trace
Run-Case -Name 'force'       -CliArgs @('generate','--cwd',$fix,'--force') -Trace
Run-Case -Name 'unknowncmd'  -CliArgs @('foo','--cwd',$fix)
Run-Case -Name 'equalsform'  -CliArgs @('generate','--cwd',$fix,'--format=json')
Run-Case -Name 'unknownflag' -CliArgs @('generate','--cwd',$fix,'--bogus-flag','x')
Run-Case -Name 'help'        -CliArgs @('--help')
Run-Case -Name 'version'     -CliArgs @('--version')
Run-Case -Name 'badcwd'      -CliArgs @('generate','--cwd',(Join-Path $poc 'api-does-not-exist'))
Run-Case -Name 'validate-clean' -CliArgs @('validate','--cwd',$fix)
Run-Case -Name 'validate-json'  -CliArgs @('validate','--cwd',$fix,'--format','json')
Run-Case -Name 'report-nomanifest' -CliArgs @('report','--cwd',(Join-Path $poc 'api-fixture-empty'))
Run-Case -Name 'json-generate' -CliArgs @('generate','--cwd',$fix,'--format','json')
Run-Case -Name 'badtoken'    -CliArgs @('generate','--cwd',$fix,'--max-part-bytes','12KB')

$results | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $poc 'api-cases.json') -Encoding utf8
