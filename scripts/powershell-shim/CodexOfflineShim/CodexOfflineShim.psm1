function Get-AppxPackage {
    <#
    .SYNOPSIS
        Transparent wrapper around the real Get-AppxPackage cmdlet.
        When the caller asks for OpenAI.Codex and the real cmdlet returns
        nothing (no MSIX installed), falls back to the classic (Inno Setup)
        offline installation by reading the codex:// protocol handler from
        the registry.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$Name,
        [switch]$AllUsers,
        [string]$Publisher,
        [string]$PackageTypeFilter,
        [string]$User
    )

    # --- Load the real Appx module and call the real cmdlet ----------------
    $systemAppxPath = Join-Path $env:SystemRoot 'system32\WindowsPowerShell\v1.0\Modules\Appx'
    Import-Module $systemAppxPath -Force -ErrorAction SilentlyContinue

    $realCmd = Microsoft.PowerShell.Core\Get-Command -Name 'Get-AppxPackage' `
        -CommandType Cmdlet -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if ($realCmd) {
        $result = & $realCmd @PSBoundParameters
        if ($result) {
            return $result
        }
    }

    # --- Fallback: only for OpenAI.Codex -----------------------------------
    if ($Name -ne 'OpenAI.Codex') {
        return
    }

    $regPath = 'HKCU:\Software\Classes\codex\shell\open\command'
    $cmdLine = $null
    try {
        $cmdLine = (Get-ItemProperty -LiteralPath $regPath -ErrorAction Stop).'(default)'
    }
    catch {
        return
    }

    if (-not $cmdLine -or $cmdLine -notmatch '"([^"]+)"') {
        return
    }

    $codexCmd   = $Matches[1]                        # e.g. C:\Users\X\Codex\Codex.cmd
    $installDir = Split-Path -Parent $codexCmd        # e.g. C:\Users\X\Codex
    $internal   = Join-Path $installDir '_internal'   # e.g. C:\Users\X\Codex\_internal

    $exe  = Join-Path $internal 'app\Codex.exe'
    $asar = Join-Path $internal 'app\resources\app.asar'

    if ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $asar)) {
        # CLI and Desktop keep threads in separate state_5.sqlite files.
        # Sync the target thread into the Desktop's DB so the deep link
        # can navigate to the full conversation instead of a blank page.
        $callerUrl = $global:url
        if ($callerUrl -match '^codex://threads/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$') {
            $threadId = $Matches[1]
            $syncScript = Join-Path $PSScriptRoot 'sync-thread.js'
            if (Test-Path -LiteralPath $syncScript) {
                try { & node $syncScript $threadId 2>$null } catch {}
            }
        }

        [PSCustomObject]@{
            Name            = 'OpenAI.Codex'
            InstallLocation = $internal
        }
    }
}
