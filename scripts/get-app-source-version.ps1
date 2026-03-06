[CmdletBinding()]
param(
    [string]$ConfigPath = 'config/offline-package.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-AbsolutePath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$PathValue
    )

    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return [System.IO.Path]::GetFullPath($PathValue)
    }

    return [System.IO.Path]::GetFullPath((Join-Path $BasePath $PathValue))
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..'))
$configFile = Resolve-AbsolutePath -BasePath $repoRoot -PathValue $ConfigPath
$config = Get-Content -Path $configFile -Raw | ConvertFrom-Json
$mode = [string]$config.appSource.mode

switch ($mode) {
    'rg_adguard' {
        $resolverJson = node (Join-Path $scriptRoot 'resolve-store-bundle-url.mjs') --package-family-name $config.appSource.packageFamilyName --ring $config.appSource.ring
        if ($LASTEXITCODE -ne 0) {
            throw 'The rg-adguard resolver failed.'
        }

        $resolved = $resolverJson | ConvertFrom-Json
        [ordered]@{
            packageId = $config.packageId
            sourceMode = $mode
            version = $resolved.version
            releaseTag = 'offline-v{0}' -f $resolved.version
            releaseName = '{0} Offline {1}' -f $config.appName, $resolved.version
            packageFamilyName = $resolved.packageFamilyName
            selected = $resolved.selected
        } | ConvertTo-Json -Depth 8
    }
    'installed_store' {
        $package = Get-AppxPackage -Name $config.packageId | Sort-Object Version -Descending | Select-Object -First 1
        if ($null -eq $package) {
            throw "Store package '$($config.packageId)' was not found on this machine."
        }

        [ordered]@{
            packageId = $config.packageId
            sourceMode = $mode
            version = $package.Version.ToString()
            releaseTag = 'offline-v{0}' -f $package.Version
            releaseName = '{0} Offline {1}' -f $config.appName, $package.Version
            packageFamilyName = $package.PackageFamilyName
            selected = $null
        } | ConvertTo-Json -Depth 8
    }
    default {
        throw "Unsupported app source mode: $mode"
    }
}
