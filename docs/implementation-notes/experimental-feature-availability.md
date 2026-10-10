# Experimental feature availability compatibility

## Root cause

Codex 26.825 renderer availability queries read `experimentalFeature/list`
and match the app-server entries named `computer_use`, `browser_use`, and
`browser_use_external`. A local app-server configuration can return these
entries with `enabled: false`, even though the offline bundle includes the
corresponding runtime capabilities. The settings page then reports the
features as unavailable.

## Patch boundary

The Gateway patches only those three exact entries after the app-server
response is received. The patch is shared by direct IPC and renderer
`mcp-request` calls through `appServerBridge.callAppServer`; it preserves
entry metadata, unrelated feature values, and pagination fields. It does not
change app-server configuration or enable arbitrary experimental features.

## Verification

The Gateway regression suite covers a disabled response, an unrelated feature,
pagination preservation, and both direct and `mcp-request` paths. The full
Node test matrix and Gateway TypeScript build pass.
