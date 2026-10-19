$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (Test-Path -LiteralPath (Join-Path $projectRoot '.tools\cargo\bin\cargo.exe')) {
    $env:CARGO_HOME = Join-Path $projectRoot '.tools\cargo'
    $env:RUSTUP_HOME = Join-Path $projectRoot '.tools\rustup'
    $env:Path = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:Path
}
pnpm desktop:build --bundles nsis
if ($LASTEXITCODE -ne 0) { throw 'ChwellTerm build failed.' }
$appVersion = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json).version
$outputDir = Join-Path $projectRoot 'output\windows'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'src-tauri\target\release\chwellterm.exe') -Destination (Join-Path $outputDir "ChwellTerm-v$appVersion.exe")
Write-Host "ChwellTerm v$appVersion portable executable: $outputDir"
