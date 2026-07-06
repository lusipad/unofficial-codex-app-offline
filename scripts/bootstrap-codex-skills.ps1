[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [string]$CodexHome = '',
    [switch]$NoLaunch,
    [switch]$SkipSkillSync,
    [string]$SkillProfile = '',
    [switch]$AssumeYes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Resolve InstallRoot here instead of in param() because $PSScriptRoot is
# not yet available in param() default values under PowerShell 5.1 when
# [CmdletBinding()] is used and the script is invoked via powershell -File.
if ([string]::IsNullOrEmpty($InstallRoot)) {
    $InstallRoot = $PSScriptRoot
}

function Resolve-AbsolutePath {
    param([Parameter(Mandatory = $true)][string]$PathValue)

    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return [System.IO.Path]::GetFullPath($PathValue)
    }

    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $PathValue))
}

# Load skill-installer.env from the same directory as this script (app root).
# Values in the file are applied only when the corresponding env var is not
# already set — system environment variables always take precedence.
function Import-EnvFile {
    param([string]$Path)

    if (-not (Test-Path $Path)) { return }

    foreach ($line in (Get-Content -Path $Path -Encoding UTF8)) {
        $line = $line.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        $eqIdx = $line.IndexOf('=')
        if ($eqIdx -le 0) { continue }
        $key   = $line.Substring(0, $eqIdx).Trim()
        $value = $line.Substring($eqIdx + 1).Trim()
        # Strip surrounding quotes (single or double)
        if ($value.Length -ge 2 -and $value[0] -eq $value[-1] -and ($value[0] -eq '"' -or $value[0] -eq "'")) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        # Only set if not already defined in the environment
        if ($key -ne '' -and -not [System.Environment]::GetEnvironmentVariable($key)) {
            [System.Environment]::SetEnvironmentVariable($key, $value, 'Process')
        }
    }
}

function Get-ContentHash {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $hasher = [System.Security.Cryptography.SHA256]::Create()

    try {
        return ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
    }
}

function Get-RelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$PathValue
    )

    $resolvedBasePath = [System.IO.Path]::GetFullPath($BasePath)
    $resolvedTargetPath = [System.IO.Path]::GetFullPath($PathValue)
    $baseRoot = [System.IO.Path]::GetPathRoot($resolvedBasePath)
    $targetRoot = [System.IO.Path]::GetPathRoot($resolvedTargetPath)

    if (-not [string]::Equals($baseRoot, $targetRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $resolvedTargetPath.Replace('\\', '/').Replace('\', '/')
    }

    if ($resolvedBasePath -eq $resolvedTargetPath) {
        return '.'
    }

    if (-not $resolvedBasePath.EndsWith([string][System.IO.Path]::DirectorySeparatorChar) -and
        -not $resolvedBasePath.EndsWith([string][System.IO.Path]::AltDirectorySeparatorChar)) {
        $resolvedBasePath += [System.IO.Path]::DirectorySeparatorChar
    }

    $baseUri = [System.Uri]$resolvedBasePath
    $targetUri = [System.Uri]$resolvedTargetPath
    $relativePath = [System.Uri]::UnescapeDataString(
        $baseUri.MakeRelativeUri($targetUri).ToString()
    ).Replace('/', [System.IO.Path]::DirectorySeparatorChar)

    return $relativePath.Replace('\\', '/').Replace('\', '/')
}

function Get-DirectoryHash {
    param([Parameter(Mandatory = $true)][string]$DirectoryPath)

    $material = (Get-ChildItem -Path $DirectoryPath -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
        $relativePath = Get-RelativePath -BasePath $DirectoryPath -PathValue $_.FullName
        $hash = (Get-FileHash -Algorithm SHA256 -Path $_.FullName).Hash.ToLowerInvariant()
        '{0}:{1}' -f $relativePath, $hash
    }) -join "`n"

    return Get-ContentHash -Value $material
}

function Get-ObjectProperty {
    param(
        [Parameter(Mandatory = $true)]$ObjectValue,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $property = $ObjectValue.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Join-SafeRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath) -or [System.IO.Path]::IsPathRooted($RelativePath)) {
        throw "Unsafe skill manifest path: $RelativePath"
    }

    $parts = $RelativePath.Replace('\', '/').Split('/') | Where-Object { $_ -ne '' }
    if ($parts | Where-Object { $_ -eq '.' -or $_ -eq '..' }) {
        throw "Unsafe skill manifest path: $RelativePath"
    }

    $targetPath = $BasePath
    foreach ($part in $parts) {
        $targetPath = Join-Path $targetPath $part
    }

    $resolvedBasePath = [System.IO.Path]::GetFullPath($BasePath)
    $resolvedTargetPath = [System.IO.Path]::GetFullPath($targetPath)
    if (-not $resolvedBasePath.EndsWith([string][System.IO.Path]::DirectorySeparatorChar)) {
        $resolvedBasePath += [System.IO.Path]::DirectorySeparatorChar
    }

    if (-not $resolvedTargetPath.StartsWith($resolvedBasePath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Skill manifest path escapes the target directory: $RelativePath"
    }

    return $resolvedTargetPath
}

function Remove-PreviouslyManagedSkills {
    param(
        $PreviousManifest,
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [string[]]$KeepRelativePaths = @()
    )

    if ($null -eq $PreviousManifest) { return }
    $previousSkills = Get-ObjectProperty -ObjectValue $PreviousManifest -Name 'skills'
    if ($null -eq $previousSkills) { return }

    $keepSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($relativePath in $KeepRelativePaths) {
        if (-not [string]::IsNullOrWhiteSpace($relativePath)) {
            $keepSet.Add($relativePath.Replace('\', '/')) | Out-Null
        }
    }

    foreach ($skill in @($previousSkills)) {
        $relativePath = [string](Get-ObjectProperty -ObjectValue $skill -Name 'relativePath')
        $skillHash = [string](Get-ObjectProperty -ObjectValue $skill -Name 'skillHash')

        if ([string]::IsNullOrWhiteSpace($relativePath) -or [string]::IsNullOrWhiteSpace($skillHash)) { continue }
        if ($keepSet.Contains($relativePath.Replace('\', '/'))) { continue }

        $targetPath = Join-SafeRelativePath -BasePath $TargetRoot -RelativePath $relativePath
        if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) { continue }
        if ((Get-DirectoryHash -DirectoryPath $targetPath) -ne $skillHash) { continue }

        Remove-Item -LiteralPath $targetPath -Recurse -Force
    }
}

function Select-ManifestProfile {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [string]$RequestedProfile
    )

    $defaultProfile = [string](Get-ObjectProperty -ObjectValue $Manifest -Name 'defaultInstallProfile')
    $profileName = if (-not [string]::IsNullOrWhiteSpace($RequestedProfile)) {
        $RequestedProfile
    }
    elseif (-not [string]::IsNullOrWhiteSpace($defaultProfile)) {
        $defaultProfile
    }
    else {
        'all'
    }

    $selectedSkills = if ([string]::Equals($profileName, 'all', [System.StringComparison]::OrdinalIgnoreCase)) {
        @($Manifest.skills)
    }
    else {
        @($Manifest.skills | Where-Object {
            $installProfiles = @($_.installProfiles | ForEach-Object { [string]$_ })
            ($installProfiles -contains $profileName) -or
                ($_.installByDefault -and [string]::Equals($profileName, $defaultProfile, [System.StringComparison]::OrdinalIgnoreCase))
        })
    }

    if ($selectedSkills.Count -eq 0 -and -not [string]::Equals($profileName, 'all', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Skill profile '$profileName' does not contain any bundled skills."
    }

    $profileHashes = Get-ObjectProperty -ObjectValue $Manifest -Name 'profileHashes'
    $profileHash = $null
    if ($null -ne $profileHashes) {
        $profileHashProperty = $profileHashes.PSObject.Properties[$profileName]
        if ($null -ne $profileHashProperty) {
            $profileHash = [string]$profileHashProperty.Value
        }
    }

    if ([string]::IsNullOrWhiteSpace($profileHash)) {
        $hashMaterial = ($selectedSkills | Sort-Object relativePath | ForEach-Object {
            '{0}:{1}' -f $_.relativePath, $_.skillHash
        }) -join "`n"
        $profileHash = Get-ContentHash -Value $hashMaterial
    }

    return [pscustomobject]([ordered]@{
        packageVersion = $Manifest.packageVersion
        generatedAt = $Manifest.generatedAt
        contentHash = $profileHash
        sourceContentHash = $Manifest.contentHash
        installProfile = $profileName
        defaultInstallProfile = $defaultProfile
        skills = $selectedSkills
    })
}

function Copy-ManifestSkills {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$SeedRoot,
        [Parameter(Mandatory = $true)][string]$TargetRoot
    )

    foreach ($skill in @($Manifest.skills)) {
        $relativePath = [string]$skill.relativePath
        $sourcePath = Join-SafeRelativePath -BasePath $SeedRoot -RelativePath $relativePath
        $targetPath = Join-SafeRelativePath -BasePath $TargetRoot -RelativePath $relativePath

        if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
            throw "Bundled skill listed in manifest was not found: $relativePath"
        }

        New-Item -ItemType Directory -Force -Path $targetPath | Out-Null
        Get-ChildItem -LiteralPath $sourcePath -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $targetPath -Recurse -Force
        }
    }
}

function Confirm-BundledSkillsSync {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetPath,
        [string]$ProfileName,
        [int]$SkillCount,
        [switch]$NoLaunch,
        [switch]$AssumeYes
    )

    if ($AssumeYes) { return $true }

    $details = "This copies the bundled '$ProfileName' skill profile ($SkillCount skill(s)) into your local Codex skills directory. Extra bundled skills stay inside the package and can be synced later from _internal\tools if needed."
    $message = if ($NoLaunch) {
        "Codex Offline is about to sync bundled skills to:`n$TargetPath`n`n$details`n`nDo you want to continue?"
    }
    else {
        "Codex Offline needs to sync bundled skills to:`n$TargetPath`n`nbefore launch.`n`n$details`n`nDo you want to continue?"
    }

    try {
        $shell = New-Object -ComObject WScript.Shell
        $result = $shell.Popup($message, 0, 'Codex Offline', 4 + 32 + 4096)
        return $result -eq 6
    }
    catch {
        $choices = [System.Management.Automation.Host.ChoiceDescription[]]@(
            (New-Object System.Management.Automation.Host.ChoiceDescription '&Yes', 'Continue and sync bundled skills.'),
            (New-Object System.Management.Automation.Host.ChoiceDescription '&No', 'Cancel without syncing.')
        )
        $selection = $Host.UI.PromptForChoice('Codex Offline', $message, $choices, 1)
        return $selection -eq 0
    }
}

# Check the package root (parent of _internal/) first so the user's config at
# the root takes priority, then fall back to a file beside this script.
Import-EnvFile -Path (Join-Path (Join-Path $PSScriptRoot '..') 'skill-installer.env')
Import-EnvFile -Path (Join-Path $PSScriptRoot 'skill-installer.env')

$resolvedInstallRoot = Resolve-AbsolutePath -PathValue $InstallRoot
$resolvedCodexHome = if (-not [string]::IsNullOrWhiteSpace($CodexHome)) {
    Resolve-AbsolutePath -PathValue $CodexHome
}
elseif (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
    Resolve-AbsolutePath -PathValue $env:CODEX_HOME
}
else {
    Join-Path $HOME '.codex'
}

$seedRoot = Join-Path $resolvedInstallRoot 'seed/codex-home/skills'
$manifestPath = Join-Path $resolvedInstallRoot 'seed/skills-manifest.json'

# Expose the bundled skills directory to skill-installer scripts so they
# default to local source without requiring network access.  Only set when
# the caller hasn't already configured a preferred source.
if (-not [System.Environment]::GetEnvironmentVariable('CODEX_SKILL_SOURCE_DIR')) {
    [System.Environment]::SetEnvironmentVariable('CODEX_SKILL_SOURCE_DIR', $seedRoot, 'Process')
}
$stateRoot = Join-Path $resolvedCodexHome '.offline-package'
$statePath = Join-Path $stateRoot 'skills-manifest.json'
$targetSkillsRoot = Join-Path $resolvedCodexHome 'skills'
$launcherPath = Join-Path $resolvedInstallRoot 'app/Codex.exe'
$currentState = $null
$manifestToSync = $null

if (-not (Test-Path $launcherPath)) {
    throw "Codex executable was not found: $launcherPath"
}

if ($SkipSkillSync) {
    Write-Host 'Skipping bundled skills sync.' -ForegroundColor Yellow
    $needSync = $false
}
else {
    if (-not (Test-Path $seedRoot)) {
        throw "Bundled skill seed directory was not found: $seedRoot"
    }

    if (-not (Test-Path $manifestPath)) {
        throw "Bundled skill manifest was not found: $manifestPath"
    }

    $manifest = Get-Content -Path $manifestPath -Raw | ConvertFrom-Json
    $manifestToSync = Select-ManifestProfile -Manifest $manifest -RequestedProfile $SkillProfile
    $needSync = $true

    if (Test-Path $statePath) {
        $currentState = Get-Content -Path $statePath -Raw | ConvertFrom-Json

        if (
            $currentState.contentHash -eq $manifestToSync.contentHash -and
            [string](Get-ObjectProperty -ObjectValue $currentState -Name 'installProfile') -eq [string]$manifestToSync.installProfile
        ) {
            $needSync = $false
        }
    }
}

if ($needSync) {
    if (-not (Confirm-BundledSkillsSync -TargetPath $targetSkillsRoot -ProfileName $manifestToSync.installProfile -SkillCount @($manifestToSync.skills).Count -NoLaunch:$NoLaunch -AssumeYes:$AssumeYes)) {
        if ($NoLaunch) {
            Write-Warning 'Skill sync canceled by user.'
        }
        else {
            Write-Warning 'Launch canceled before syncing bundled skills.'
        }
        exit 2
    }

    Write-Host 'Syncing bundled skills...' -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $targetSkillsRoot | Out-Null

    $selectedRelativePaths = @($manifestToSync.skills | ForEach-Object { [string]$_.relativePath })
    Remove-PreviouslyManagedSkills -PreviousManifest $currentState -TargetRoot $targetSkillsRoot -KeepRelativePaths $selectedRelativePaths
    Copy-ManifestSkills -Manifest $manifestToSync -SeedRoot $seedRoot -TargetRoot $targetSkillsRoot

    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    $manifestToSync | ConvertTo-Json -Depth 6 | Set-Content -Path $statePath -Encoding UTF8
    Write-Host "Skills synced ($($manifestToSync.installProfile): $(@($manifestToSync.skills).Count))." -ForegroundColor Green
} else {
    if ($null -ne $manifestToSync) {
        Write-Host "Skills up to date ($($manifestToSync.installProfile))." -ForegroundColor Green
    }
}

if ($NoLaunch) {
    Write-Output "Skills ready in $targetSkillsRoot"
    return
}

# Codex 26.506+ keeps Windows Computer Use behind an Electron process env gate.
# Set the offline default here so all provided launchers inherit it, while still
# allowing advanced users to override it before invoking this script.
if (-not [System.Environment]::GetEnvironmentVariable('CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE')) {
    [System.Environment]::SetEnvironmentVariable('CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE', '1', 'Process')
}

Write-Host 'Launching Codex...' -ForegroundColor Cyan
Start-Process -FilePath $launcherPath -WorkingDirectory (Split-Path $launcherPath -Parent)
