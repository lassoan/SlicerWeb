<#
.SYNOPSIS
  Runs SlicerWeb build stages inside the toolchain container.
.EXAMPLE
  .\build.ps1 00-sources 10-vtk-compiletools 20-vtk
  .\build.ps1 all
  .\build.ps1 shell
#>
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Stages = @('all'))
$ErrorActionPreference = 'Stop'
$Image = 'slicerweb-toolchain:emsdk5.0.3'
$Volume = 'slicerweb-build'          # Docker volume (lives in Docker's data disk on D:)
$Dist = 'D:\SlicerWeb-build\dist'    # wheels and web bundles are copied here
New-Item -ItemType Directory -Force $Dist | Out-Null

docker image inspect $Image *> $null
if (-not $?) { docker build -t $Image "$PSScriptRoot\docker"; if (-not $?) { exit 1 } }

$mirrors = @{
  'C:\D\S4' = '/mirror/Slicer'; 'C:\D\VTK' = '/mirror/VTK'; 'C:\D\ITK' = '/mirror/ITK';
  'C:\D\teem' = '/mirror/teem'; 'C:\D\vtkAddon' = '/mirror/vtkAddon';
  'C:\D\S4R\SlicerExecutionModel' = '/mirror/SlicerExecutionModel'
}
$dockerArgs = @('run', '--rm', '-i', '-v', "${Volume}:/build", '-v', "${PSScriptRoot}:/work", '-v', "${Dist}:/dist", '-e', "SW_PROFILE=$env:SW_PROFILE", '-e', "SW_CONFIGURE_ONLY=$env:SW_CONFIGURE_ONLY")
foreach ($k in $mirrors.Keys) { if (Test-Path $k) { $dockerArgs += @('-v', "${k}:$($mirrors[$k]):ro") } }
if ($Stages -contains 'shell') { $dockerArgs += '-t' }
$dockerArgs += @($Image, 'bash', '/work/scripts/build.sh') + $Stages
& docker @dockerArgs
exit $LASTEXITCODE
