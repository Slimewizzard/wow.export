param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$wc3Repository = Split-Path $PSScriptRoot -Parent
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $wc3Repository 'bin\wc3-effects' }
dotnet publish (Join-Path $PSScriptRoot 'wc3-effects\Wc3Effects.csproj') -c Release -r win-x64 --self-contained true -o $OutputDirectory --nologo
if ($LASTEXITCODE -ne 0) { throw 'WC3 effect helper build failed.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'wc3-effects\vendor\LICENSE') -Destination (Join-Path $OutputDirectory 'W3ModelViewer.LICENSE') -Force
$wc3Runtime = (Get-Content -LiteralPath (Join-Path $OutputDirectory 'wc3-effects.runtimeconfig.json') -Raw | ConvertFrom-Json).runtimeOptions.includedFrameworks[0].version
$wc3Packages = if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.nuget\packages' }
$wc3RuntimePackage = Join-Path $wc3Packages ('microsoft.netcore.app.runtime.win-x64\' + $wc3Runtime)
Copy-Item -LiteralPath (Join-Path $wc3RuntimePackage 'LICENSE.TXT') -Destination (Join-Path $OutputDirectory 'DOTNET.LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $wc3RuntimePackage 'THIRD-PARTY-NOTICES.TXT') -Destination (Join-Path $OutputDirectory 'DOTNET.ThirdPartyNotices.txt') -Force
