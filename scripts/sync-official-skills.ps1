[CmdletBinding()]
param(
    [string]$ConfigPath = 'config/offline-package.json',
    [string]$Destination = ''
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

function Get-GitHubJson {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [hashtable]$Headers = @{}
    )

    $resolvedHeaders = @{
        'User-Agent' = 'codex-app-offline'
        'Accept' = 'application/vnd.github+json'
    }

    foreach ($entry in $Headers.GetEnumerator()) {
        $resolvedHeaders[$entry.Key] = $entry.Value
    }

    return Invoke-RestMethod -Uri $Uri -Headers $resolvedHeaders
}

$repoRoot = (Get-Location).Path
$configFile = Resolve-AbsolutePath -BasePath $repoRoot -PathValue $ConfigPath
$config = Get-Content -Path $configFile -Raw | ConvertFrom-Json
$official = $config.skills.official

if ($null -eq $official) {
    throw 'skills.official is not configured.'
}

$destinationRoot = if ([string]::IsNullOrWhiteSpace($Destination)) {
    Resolve-AbsolutePath -BasePath $repoRoot -PathValue $official.destination
}
else {
    Resolve-AbsolutePath -BasePath $repoRoot -PathValue $Destination
}

$owner = [string]$official.owner
$repo = [string]$official.repo
$ref = [string]$official.ref
$archiveUri = 'https://api.github.com/repos/{0}/{1}/zipball/{2}' -f $owner, $repo, $ref
$commitUri = 'https://api.github.com/repos/{0}/{1}/commits/{2}' -f $owner, $repo, $ref
$token = $env:GITHUB_TOKEN
$headers = @{}

if (-not [string]::IsNullOrWhiteSpace($token)) {
    $headers['Authorization'] = 'Bearer {0}' -f $token
}

$commitInfo = Get-GitHubJson -Uri $commitUri -Headers $headers
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-skills-' + [guid]::NewGuid().ToString('N'))
$archivePath = Join-Path $tempRoot 'skills.zip'
$expandRoot = Join-Path $tempRoot 'expanded'

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
    Invoke-WebRequest -Uri $archiveUri -OutFile $archivePath -Headers @{
        'User-Agent' = 'codex-app-offline'
        'Accept' = 'application/vnd.github+json'
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $expandRoot -Force

    $rootDir = Get-ChildItem -Path $expandRoot -Directory | Select-Object -First 1
    if ($null -eq $rootDir) {
        throw 'The downloaded official skills archive was empty.'
    }

    $skillsRoot = Join-Path $rootDir.FullName 'skills'
    $systemRoot = Join-Path $skillsRoot '.system'
    $curatedRoot = Join-Path $skillsRoot '.curated'

    if (-not (Test-Path $skillsRoot)) {
        throw "The official repository does not contain the expected skills directory: $skillsRoot"
    }

    if (Test-Path $destinationRoot) {
        Remove-Item -Path $destinationRoot -Recurse -Force
    }

    New-Item -ItemType Directory -Force -Path $destinationRoot | Out-Null

    if (Test-Path $systemRoot) {
        Copy-Item -Path $systemRoot -Destination (Join-Path $destinationRoot '.system') -Recurse -Force
    }

    if (Test-Path $curatedRoot) {
        Get-ChildItem -Path $curatedRoot -Directory -Force | ForEach-Object {
            Copy-Item -Path $_.FullName -Destination (Join-Path $destinationRoot $_.Name) -Recurse -Force
        }
    }

    $metadata = [ordered]@{
        owner = $owner
        repo = $repo
        ref = $ref
        commit = $commitInfo.sha
        syncedAt = (Get-Date).ToString('o')
        archiveUri = $archiveUri
        destination = [System.IO.Path]::GetRelativePath($repoRoot, $destinationRoot).Replace('\\', '/').Replace('\', '/')
        topLevelEntries = @((Get-ChildItem -Path $destinationRoot -Directory -Force | Sort-Object Name | Select-Object -ExpandProperty Name))
    }

    $metadata | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $destinationRoot '.sync-metadata.json') -Encoding UTF8
    Write-Output $destinationRoot
}
finally {
    if (Test-Path $tempRoot) {
        Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
