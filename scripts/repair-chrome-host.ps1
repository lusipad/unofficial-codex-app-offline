param(
    [string]$InstallRoot = $PSScriptRoot,
    [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-AbsolutePath {
    param([Parameter(Mandatory = $true)][string]$PathValue)

    return [System.IO.Path]::GetFullPath($PathValue)
}

function Get-ChromePluginRoot {
    param([Parameter(Mandatory = $true)][string]$RootPath)

    $resolvedRoot = Resolve-AbsolutePath -PathValue $RootPath
    $candidates = @(
        (Join-Path $resolvedRoot 'app\resources\plugins\openai-bundled\plugins\chrome'),
        (Join-Path $resolvedRoot '_internal\app\resources\plugins\openai-bundled\plugins\chrome'),
        (Join-Path $resolvedRoot 'resources\plugins\openai-bundled\plugins\chrome')
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Container) {
            return (Resolve-AbsolutePath -PathValue $candidate)
        }
    }

    throw "Bundled Chrome plugin was not found under: $resolvedRoot"
}

function Get-ArchitectureName {
    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    switch ($architecture) {
        'x64' { return 'x64' }
        'arm64' { return 'arm64' }
        default { throw "Unsupported Windows architecture for Chrome native host: $architecture" }
    }
}

function Get-ManifestPath {
    $localAppData = [System.Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($localAppData)) {
        throw 'Could not resolve LocalApplicationData.'
    }

    return (Join-Path $localAppData 'OpenAI\extension\com.openai.codexextension.json')
}

function Get-RegistryKeyPath {
    return 'Software\Google\Chrome\NativeMessagingHosts\com.openai.codexextension'
}

function Read-RegistryDefaultValue {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey((Get-RegistryKeyPath))
    if ($null -eq $key) { return $null }

    try {
        return [string]$key.GetValue('')
    }
    finally {
        $key.Dispose()
    }
}

function Write-Utf8NoBomFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Sync-PatchedChromePluginCache {
    param([Parameter(Mandatory = $true)][string]$ChromePluginRoot)

    $pluginManifestPath = Join-Path $ChromePluginRoot '.codex-plugin\plugin.json'
    if (-not (Test-Path -LiteralPath $pluginManifestPath -PathType Leaf)) {
        return
    }

    $pluginManifest = Get-Content -LiteralPath $pluginManifestPath -Raw | ConvertFrom-Json
    $pluginVersion = [string]$pluginManifest.version
    if ([string]::IsNullOrWhiteSpace($pluginVersion)) {
        return
    }

    $codexHome = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        Join-Path ([System.Environment]::GetFolderPath('UserProfile')) '.codex'
    }
    else {
        $env:CODEX_HOME
    }
    $pluginRoots = @(
        (Join-Path $codexHome "plugins\cache\openai-bundled\chrome\$pluginVersion"),
        (Join-Path $codexHome '.tmp\bundled-marketplaces\openai-bundled\plugins\chrome')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Container }

    $relativePaths = @('scripts\browser-client.mjs', 'scripts\check-native-host-manifest.js')
    $skillPath = Get-ChildItem -Path (Join-Path $ChromePluginRoot 'skills') -Filter 'SKILL.md' -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { (Get-Content -LiteralPath $_.FullName -Raw).Contains('scripts/browser-client.mjs') } |
        Select-Object -First 1
    if ($null -ne $skillPath) {
        $relativePaths += ('skills\{0}\SKILL.md' -f $skillPath.Directory.Name)
    }

    foreach ($relativePath in $relativePaths) {
        $sourcePath = Join-Path $ChromePluginRoot $relativePath
        foreach ($pluginRoot in $pluginRoots) {
            $destinationPath = Join-Path $pluginRoot $relativePath
            if ((Test-Path -LiteralPath $sourcePath -PathType Leaf) -and (Test-Path -LiteralPath (Split-Path $destinationPath -Parent) -PathType Container)) {
                Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
            }
        }
    }
}

function Test-NativeHostRegistration {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$ExtensionHostPath,
        [Parameter(Mandatory = $true)][string]$ExtensionId,
        [Parameter(Mandatory = $true)][string]$ExtensionHostName
    )

    $registryManifestPath = Read-RegistryDefaultValue
    if ([string]::IsNullOrWhiteSpace($registryManifestPath)) {
        return [pscustomobject]@{
            Correct = $false
            Problem = 'Chrome native host registry key is missing.'
        }
    }

    if (-not [string]::Equals($registryManifestPath, $ManifestPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject]@{
            Correct = $false
            Problem = "Chrome native host registry path points to '$registryManifestPath'."
        }
    }

    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        return [pscustomobject]@{
            Correct = $false
            Problem = "Chrome native host manifest is missing: $ManifestPath"
        }
    }

    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    $expectedOrigin = "chrome-extension://$ExtensionId/"
    $allowedOrigins = @($manifest.allowed_origins | ForEach-Object { [string]$_ })

    if ([string]$manifest.name -ne $ExtensionHostName) {
        return [pscustomobject]@{
            Correct = $false
            Problem = "Chrome native host manifest name is not '$ExtensionHostName'."
        }
    }

    if (-not [string]::Equals([string]$manifest.path, $ExtensionHostPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject]@{
            Correct = $false
            Problem = "Chrome native host manifest path is not '$ExtensionHostPath'."
        }
    }

    if ($allowedOrigins -notcontains $expectedOrigin) {
        return [pscustomobject]@{
            Correct = $false
            Problem = "Chrome native host manifest does not allow $expectedOrigin."
        }
    }

    return [pscustomobject]@{
        Correct = $true
        Problem = $null
    }
}

if ($PSVersionTable.PSEdition -ne 'Desktop' -and -not $IsWindows) {
    throw 'Chrome native host repair is only supported on Windows.'
}

$chromePluginRoot = Get-ChromePluginRoot -RootPath $InstallRoot
$extensionConfigPath = @(
    Join-Path $chromePluginRoot 'scripts\extension-id.json'
    Join-Path $chromePluginRoot 'scripts\extension-ids.json'
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if ($null -eq $extensionConfigPath) {
    throw "Chrome extension config was not found under: $(Join-Path $chromePluginRoot 'scripts')"
}

$extensionConfig = Get-Content -LiteralPath $extensionConfigPath -Raw | ConvertFrom-Json
$extensionIdProperty = $extensionConfig.PSObject.Properties['extensionId']
$extensionId = if ($null -eq $extensionIdProperty) { '' } else { [string]$extensionIdProperty.Value }
if ([string]::IsNullOrWhiteSpace($extensionId)) {
    $extensionIdsProperty = $extensionConfig.PSObject.Properties['extensionIds']
    $extensionIdCandidates = if ($null -ne $extensionIdsProperty) {
        @($extensionIdsProperty.Value)
    }
    else {
        @()
    }
    $extensionIds = @(
        $extensionIdCandidates |
            Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
            Select-Object -First 1
    )
    if ($extensionIds.Count -gt 0) {
        $extensionId = [string]$extensionIds[0]
    }
}
$extensionHostName = [string]$extensionConfig.extensionHostName
if ([string]::IsNullOrWhiteSpace($extensionId) -or [string]::IsNullOrWhiteSpace($extensionHostName)) {
    throw "Chrome extension config is missing extensionId, extensionIds, or extensionHostName: $extensionConfigPath"
}

$architectureName = Get-ArchitectureName
$extensionHostFileName = 'extension-host.exe'
$extensionHostPath = Join-Path $chromePluginRoot "extension-host\windows\$architectureName\$extensionHostFileName"
if (-not (Test-Path -LiteralPath $extensionHostPath -PathType Leaf)) {
    throw "Bundled Chrome extension host binary was not found: $extensionHostPath"
}
$extensionHostPath = Resolve-AbsolutePath -PathValue $extensionHostPath

$manifestPath = Get-ManifestPath
$registration = Test-NativeHostRegistration `
    -ManifestPath $manifestPath `
    -ExtensionHostPath $extensionHostPath `
    -ExtensionId $extensionId `
    -ExtensionHostName $extensionHostName

if ($Check) {
    if ($registration.Correct) {
        Write-Host "Chrome native host is registered: $manifestPath" -ForegroundColor Green
        exit 0
    }

    Write-Host $registration.Problem -ForegroundColor Yellow
    exit 1
}

$manifest = [ordered]@{
    name = $extensionHostName
    description = 'Codex chrome native messaging host'
    type = 'stdio'
    path = $extensionHostPath
    allowed_origins = @("chrome-extension://$extensionId/")
}

New-Item -ItemType Directory -Force -Path (Split-Path $manifestPath -Parent) | Out-Null
Write-Utf8NoBomFile -Path $manifestPath -Value ($manifest | ConvertTo-Json -Depth 4)

$registryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey((Get-RegistryKeyPath))
try {
    $registryKey.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String)
}
finally {
    $registryKey.Dispose()
}

$registration = Test-NativeHostRegistration `
    -ManifestPath $manifestPath `
    -ExtensionHostPath $extensionHostPath `
    -ExtensionId $extensionId `
    -ExtensionHostName $extensionHostName

if (-not $registration.Correct) {
    throw $registration.Problem
}

Sync-PatchedChromePluginCache -ChromePluginRoot $chromePluginRoot

Write-Host "Chrome native host repaired: $manifestPath" -ForegroundColor Green
Write-Host 'Restart Chrome, then try @chrome again in Codex.' -ForegroundColor Cyan
