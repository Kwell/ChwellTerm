param([switch]$Browser)
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (Test-Path -LiteralPath (Join-Path $projectRoot '.tools\cargo\bin\cargo.exe')) {
    $env:CARGO_HOME = Join-Path $projectRoot '.tools\cargo'
    $env:RUSTUP_HOME = Join-Path $projectRoot '.tools\rustup'
    $env:Path = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:Path
}
if ($Browser) { pnpm dev } else { pnpm desktop }
