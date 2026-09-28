<#
.SYNOPSIS
  Runs SlicerWeb build stages inside the toolchain container.
.DESCRIPTION
  -ExtensionsDir (or $env:SW_EXTENSIONS_DIR): the folder of extension description files that
  80-extensions builds, instead of extensions\ of this repository (see docs\extensions.md).
  A GitHub token for private repositories is taken from $env:SW_GIT_TOKEN, or from the file
  .secrets\github-token; without one, only public repositories can be fetched.
.EXAMPLE
  .\build.ps1 00-sources 10-vtk-compiletools 20-vtk
  .\build.ps1 all
  .\build.ps1 -ExtensionsDir C:\D\SlicerWebExtensions 80-extensions
  .\build.ps1 shell
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$ExtensionsDir = $env:SW_EXTENSIONS_DIR,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Stages = @('all')
)
$ErrorActionPreference = 'Stop'
$Image = 'slicerweb-toolchain:emsdk5.0.3'
$Volume = 'slicerweb-build'          # Docker volume (lives in Docker's data disk on D:)
$Dist = 'D:\SlicerWeb-build\dist'    # wheels and web bundles are copied here
New-Item -ItemType Directory -Force $Dist | Out-Null

docker image inspect $Image *> $null
if (-not $?) { docker build -t $Image "$PSScriptRoot\docker"; if (-not $?) { exit 1 } }

$dockerArgs = @('run', '--rm', '-i', '-v', "${Volume}:/build", '-v', "${PSScriptRoot}:/work", '-v', "${Dist}:/dist", '-e', "SW_PROFILE=$env:SW_PROFILE", '-e', "SW_CONFIGURE_ONLY=$env:SW_CONFIGURE_ONLY", '-e', "SW_EXTENSIONS=$env:SW_EXTENSIONS")
# The extension folder, mounted where 80-extensions reads it (extensions\ of this repository is /work/extensions)
if ($ExtensionsDir) {
  $ExtensionsDir = (Resolve-Path $ExtensionsDir).Path
  $dockerArgs += @('-v', "${ExtensionsDir}:/extensions:ro", '-e', 'SW_EXTENSIONS_DIR=/extensions')
}
# A token for private repositories, passed by name so that its value is not on the command line.
# Everything the build runs can read it - the extensions' own code included - so the token to use is
# a fine-grained one that can only read the repositories it is needed for.
$tokenFile = Join-Path $PSScriptRoot '.secrets\github-token'
if (-not $env:SW_GIT_TOKEN -and (Test-Path $tokenFile)) { $env:SW_GIT_TOKEN = (Get-Content $tokenFile -Raw).Trim() }
if ($env:SW_GIT_TOKEN) { $dockerArgs += @('-e', 'SW_GIT_TOKEN') }
if ($Stages -contains 'shell') { $dockerArgs += '-t' }
$dockerArgs += @($Image, 'bash', '/work/scripts/build.sh') + $Stages
& docker @dockerArgs
exit $LASTEXITCODE
