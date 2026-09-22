<#
.SYNOPSIS
  Uploads the WebAssembly runtime of a local build to the "runtime" release, where the
  "Publish app" workflow takes it from (.github/workflows/publish-app.yml).

.DESCRIPTION
  The wheels take hours to compile and no GitHub runner could build them, so they are built here
  and uploaded: the workflow only builds the web application around them. They are not committed,
  because every rebuild would be another 57 MB in the history of this repository for ever; a
  release asset is replaced, not accumulated.

  Needs the GitHub CLI, signed in with a token that may write to the repository (gh auth login).

.EXAMPLE
  .\scripts\publish-runtime.ps1
  .\scripts\publish-runtime.ps1 -Publish       # also start the workflow that rebuilds the site
#>
param(
  [string]$Dist = "D:\SlicerWeb-build\dist",
  [string]$Repository = "lassoan/SlicerWeb",
  [string]$Tag = "runtime",
  [switch]$Publish
)
$ErrorActionPreference = "Stop"

foreach ($name in @("wheels", "extensions")) {
  if (-not (Test-Path (Join-Path $Dist $name))) { throw "Not found: $(Join-Path $Dist $name) (run .\build.ps1 60-wheels 80-extensions)" }
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) "slicerweb-runtime"
Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $staging | Out-Null

$assets = foreach ($name in @("wheels", "extensions")) {
  $zip = Join-Path $staging "$name.zip"
  Compress-Archive -Path (Join-Path $Dist "$name\*") -DestinationPath $zip
  "{0} ({1:N1} MB)" -f $name, ((Get-Item $zip).Length / 1MB) | Write-Host
  $zip
}

# gh says what it is doing on the error stream, which PowerShell would otherwise turn into a
# failure of its own; what actually happened is in the exit code, which is checked after each call.
$ErrorActionPreference = "Continue"

# The release is a place to keep files, not an announcement: it is a prerelease, and its notes say
# which build the files came from.
$notes = "WebAssembly runtime of SlicerWeb: the wheels the application is built on (VTK, ITK, the Slicer libraries and modules) and the extension wheels.`n`nBuilt $(Get-Date -Format 'yyyy-MM-dd HH:mm') from $(git -C $PSScriptRoot\.. rev-parse --short HEAD)."
gh release view $Tag --repo $Repository 1>$null 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Updating release $Tag"
  gh release edit $Tag --repo $Repository --notes $notes
} else {
  Write-Host "Creating release $Tag"
  gh release create $Tag --repo $Repository --title "Runtime wheels" --notes $notes --prerelease --target main
}
if ($LASTEXITCODE -ne 0) { throw "The release could not be written" }

gh release upload $Tag --repo $Repository --clobber @assets
if ($LASTEXITCODE -ne 0) { throw "The wheels could not be uploaded" }
Remove-Item -Recurse -Force $staging

if ($Publish) {
  gh workflow run publish-app.yml --repo $Repository
  if ($LASTEXITCODE -ne 0) { throw "The workflow could not be started" }
  Write-Host "Publishing: gh run watch --repo $Repository"
} else {
  Write-Host "Uploaded. Rebuild the site with: gh workflow run publish-app.yml --repo $Repository"
}
