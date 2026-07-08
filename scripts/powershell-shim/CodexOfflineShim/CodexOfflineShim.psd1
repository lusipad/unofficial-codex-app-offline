@{
    ModuleVersion     = '1.0.0'
    GUID              = 'a3f7c8d1-2e4b-4f6a-9c0d-5e8b1a3f7c9d'
    Author            = 'codex-app-offline'
    Description       = 'Shim that lets the official Codex CLI /app command discover a classic (non-MSIX) Codex Desktop installation.'
    RootModule        = 'CodexOfflineShim.psm1'
    FunctionsToExport = @('Get-AppxPackage')
    PowerShellVersion = '5.1'
}
