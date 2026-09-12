const STATSIG_DEFAULT_FEATURES_CONFIG = "statsig_default_enable_features";

const STATSIG_DEFAULT_FEATURE_OVERRIDES = Object.freeze({
  "4166894088": true,
  "824038554": true,
  "2106641128": true,
  "3693343337": true,
  "3026692602": true,
  "4039078146": true,
  guardian_approval: true,
  fast_mode: true,
  "410262010": true,
  "410065390": true,
  "4250630194": true,
  "2177625257": true,
  "2679188970": true,
  "1060282072": true,
  "1506311413": true,
  "2171042036": true,
  "3903563814": true,
  "3032432888": true,
  browserPane: true,
  inAppBrowserUse: true,
  inAppBrowserUseAllowed: true,
  externalBrowserUse: true,
  externalBrowserUseAllowed: true,
  computerUse: true,
  computerUseNodeRepl: true,
  control: true,
  avatarOverlay: true,
  "3903742690": true,
  "3326157269": true,
  "2900529421": true,
  "2711149772": true,
  "816842483": true,
  "3278809559": true,
  artifacts: true,
  // From DESKTOP_ASAR_KNOWN_GATE_IDS (previously only bypassed in ASAR)
  "3075919032": true,
  "3789238711": true,
  "2302560359": true,
  "1488233300": true,
  "2425897452": true,
  "2553306736": true,
  "875176429": true,
  "505458": true,
  "1907601843": true,
  "588076040": true,
  "533078438": true,
  // false selects the current unified plugins page; true selects the legacy
  // storefront whose category "see more" rows have an empty click handler.
  "3413548395": false,
  "1609556872": true,
  "1221508807": true,
  "459748632": true,
  "2574306096": true,
  "839469903": true,
  "1244621283": true,
  "4100906017": true,
  "1444479692": true,
  "717035860": true,
  "1042620455": true,
  "4114442250": true,
});

// Unknown desktop renderer gates are opened by the central Statsig SDK seam.
// Keep this list empty until a real bundle review proves a gate must remain off.
const DESKTOP_GATE_DENYLIST = Object.freeze([]);

const DEFAULT_DESKTOP_FEATURE_STATE = Object.freeze({
  ambientSuggestions: false,
  artifactsPane: true,
  avatarOverlay: true,
  browserAgent: true,
  browserAgentAvailable: true,
  browserPane: true,
  computerUse: true,
  computerUseNodeRepl: true,
  control: true,
  externalBrowserUse: true,
  externalBrowserUseAllowed: true,
  inAppBrowserUse: true,
  inAppBrowserUseAllowed: true,
  multiWindow: false,
});

const FORCED_DESKTOP_FEATURE_STATE = Object.freeze({
  artifactsPane: true,
  avatarOverlay: true,
  browserAgent: true,
  browserAgentAvailable: true,
  browserPane: true,
  computerUse: true,
  computerUseNodeRepl: true,
  control: true,
  externalBrowserUse: true,
  externalBrowserUseAllowed: true,
  inAppBrowserUse: true,
  inAppBrowserUseAllowed: true,
});

const DESKTOP_FEATURE_KEYS = new Set(Object.keys(DEFAULT_DESKTOP_FEATURE_STATE));

function booleanDesktopFeatureEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key, item]) => DESKTOP_FEATURE_KEYS.has(key) && typeof item === "boolean")
  );
}

function normalizeDesktopFeatureValues(payload, current) {
  return {
    ...DEFAULT_DESKTOP_FEATURE_STATE,
    ...booleanDesktopFeatureEntries(current),
    ...booleanDesktopFeatureEntries(payload),
    ...FORCED_DESKTOP_FEATURE_STATE,
  };
}

const REQUIRED_STATSIG_FEATURE_MARKERS = Object.freeze([
  "fast_mode",
  "824038554",
  "2106641128",
  "3693343337",
  "3026692602",
  "4039078146",
  "2177625257",
  "717035860",
  "inAppBrowserUseAllowed",
  "externalBrowserUseAllowed",
  "computerUseNodeRepl",
  "3903742690",
  "3326157269",
  "2900529421",
  "3278809559",
  "1042620455",
  "4114442250",
]);

const REQUIRED_DESKTOP_FEATURE_MARKERS = Object.freeze([
  "setDesktopFeatureValues",
  "browserAgentAvailable",
  "inAppBrowserUseAllowed",
  "externalBrowserUseAllowed",
  "computerUseNodeRepl",
]);

const REQUIRED_WEB_SHELL_FEATURE_MARKERS = Object.freeze([
  "avatar-overlay-open-state-changed",
  'w.location.pathname === "/avatar-overlay"',
  "w.history.replaceState",
]);

const DESKTOP_BROWSER_USE_CAPABILITY_KEYS = Object.freeze([
  "browserPane",
  "inAppBrowserUse",
  "inAppBrowserUseAllowed",
  "externalBrowserUse",
  "externalBrowserUseAllowed",
  "computerUse",
  "computerUseNodeRepl",
]);

const DESKTOP_BROWSER_USE_AVAILABILITY_MARKERS = Object.freeze([
  "computerUseNodeRepl",
  "externalBrowserUse",
  "inAppBrowserUse",
]);

const DESKTOP_ASAR_KNOWN_GATE_IDS = Object.freeze([
  "4166894088",
  "824038554",
  "2106641128",
  "3693343337",
  "3026692602",
  "4039078146",
  "3075919032",
  "3789238711",
  "2302560359",
  "2679188970",
  "1488233300",
  "2425897452",
  "3903742690",
  "2553306736",
  "875176429",
  "505458",
  "1907601843",
  "410262010",
  "410065390",
  "4250630194",
  "2177625257",
  "588076040",
  "533078438",
  "1609556872",
  "1221508807",
  "459748632",
  "1506311413",
  "2171042036",
  "1060282072",
  "3903563814",
  "3032432888",
  "3326157269",
  "2900529421",
  "2711149772",
  "816842483",
  "3278809559",
  "1244621283",
  "4100906017",
  "2574306096",
  "1444479692",
  "717035860",
  "1042620455",
  "4114442250",
  "839469903",
]);

// Every app.asar edit the desktop build makes, with the classification that
// decides how it is verified and what happens when it goes missing.
//
//   kind    'patch'    changes upstream behaviour
//           'sentinel' changes nothing; it only asserts an upstream shape
//   tier    'required' a miss fails the build
//           'degraded' a miss is a warning; necessity could not be established
//   assert  'marker'   the marker must be present in the packaged asar
//           'absent'   the marker must NOT be present (dormant tripwire)
//           'negative' the upstream bad shape must no longer match
//
// `evidence` records why the entry is still here and against which Store
// bundle that was established; `reverify` records what would settle it again.
// See docs/superpowers/specs/2026-09-11-desktop-patch-boundary-design.md.
const DESKTOP_ASAR_PATCHES = Object.freeze([
  Object.freeze({
    marker: "/*codex-offline:windows-browser-use-capability*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: upstream only sets computerUse and computerUseNodeRepl on Windows; browserPane, inAppBrowserUse(Allowed) and externalBrowserUse(Allowed) stay off.",
    reverify: "Compare the win32 capability object in the main bundle against the patched form.",
  }),
  Object.freeze({
    marker: "/*codex-offline:node-repl-feature-enabled*/",
    kind: "patch",
    tier: "degraded",
    assert: "marker",
    evidence:
      "26.903.8094.0: flips the synthesized node_repl feature default from off to on. The code path only runs once the Computer Use plugin is installed, which a bare asar harness cannot reach, so necessity is unproven.",
    reverify: "Full portable package including the primary runtime plugin, plus a Computer Use end-to-end run.",
  }),
  Object.freeze({
    marker: "/*codex-offline:feature-overrides-preserve-mcp-config*/",
    kind: "patch",
    tier: "degraded",
    assert: "marker",
    evidence:
      "26.903.8094.0: upstream drops mcp_servers.* keys while merging feature defaults; the patch keeps them and forces seven features.* flags. Same unreachable code path as the other node_repl entries.",
    reverify: "Full portable package including the primary runtime plugin, plus a Computer Use end-to-end run.",
  }),
  Object.freeze({
    marker: "/*codex-offline:bundled-plugin-cache-lock-nonfatal*/",
    kind: "patch",
    tier: "degraded",
    assert: "marker",
    evidence:
      "26.903.8094.0: upstream throws on a plugin_cache_windows_file_lock error; the patch makes it non-fatal. This guards a Windows file-lock race, so a run that happens to succeed proves nothing either way.",
    reverify: "Reproduce the lock under concurrent startup, or check whether upstream added its own retry.",
  }),
  Object.freeze({
    marker: "/*codex-offline:node-repl-disable-sandbox*/",
    kind: "patch",
    tier: "degraded",
    assert: "marker",
    evidence:
      "26.903.8094.0: upstream synthesizes the node_repl MCP server with args: []; the patch adds --disable-sandbox. Unreachable without the Computer Use plugin installed.",
    reverify: "Full portable package including the primary runtime plugin, plus a Computer Use end-to-end run.",
  }),
  Object.freeze({
    marker: "/*codex-offline:node-repl-tool-search-feature*/",
    kind: "patch",
    tier: "degraded",
    assert: "marker",
    evidence:
      "26.903.8094.0: upstream synthesizes the node_repl MCP server without any features.* flags; the patch adds six. Unreachable without the Computer Use plugin installed.",
    reverify: "Full portable package including the primary runtime plugin, plus a Computer Use end-to-end run.",
  }),
  Object.freeze({
    marker: "/*codex-offline:computer-use-resource-runtime-paths*/",
    kind: "sentinel",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: the applied branch is content.replace(RE, '$&' + MARKER) — it appends the marker and changes no behaviour. It exists so an unrecognized upstream shape fails the build. It also absorbed the retired computer-use-plugin-root-fallback marker, whose rewriting branches never fired because upstream already resolves the canonical runtime path.",
    reverify: "Confirm the marker still only appears in an append-only branch of patch-app-asar.mjs.",
  }),
  Object.freeze({
    marker: "/*codex-offline:computer-use-input-skill*/",
    kind: "patch",
    tier: "degraded",
    assert: "marker",
    evidence:
      "26.903.8094.0: intercepts thread/start to inject node_repl configuration. Unreachable without the Computer Use plugin installed.",
    reverify: "Full portable package including the primary runtime plugin, plus a Computer Use end-to-end run.",
  }),
  Object.freeze({
    marker: "/*codex-offline:computer-use-thread-start-tool-search*/",
    kind: "patch",
    tier: "degraded",
    assert: "marker",
    evidence:
      "26.903.8094.0: intercepts thread/start to inject node_repl configuration. Unreachable without the Computer Use plugin installed.",
    reverify: "Full portable package including the primary runtime plugin, plus a Computer Use end-to-end run.",
  }),
  Object.freeze({
    marker: "/*codex-offline:computer-use-node-repl-dynamic-tool*/",
    kind: "patch",
    tier: "degraded",
    assert: "marker",
    evidence:
      "26.903.8094.0: additive — upstream exposes no node_repl namespace at all, so the feature cannot exist without this. Whether the feature works offline is what remains unproven.",
    reverify: "Full portable package including the primary runtime plugin, plus a Computer Use end-to-end run.",
  }),
  Object.freeze({
    marker: "/*codex-offline:computer-use-node-repl-dynamic-tool-call*/",
    kind: "patch",
    tier: "degraded",
    assert: "marker",
    evidence:
      "26.903.8094.0: additive — bridges node_repl/js calls through app-server mcpServer/tool/call, which upstream does not do.",
    reverify: "Full portable package including the primary runtime plugin, plus a Computer Use end-to-end run.",
  }),
  Object.freeze({
    marker: "/*codex-offline:archived-threads-partial-list*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: upstream pages archived threads in a do/while with no try/catch, so one failed page throws away the whole list.",
    reverify: "Check whether the archived thread list query still lacks error handling upstream.",
  }),
  Object.freeze({
    marker: "/*codex-offline:archived-threads-cache-fallback*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: upstream has no cache fallback, so a failed page offline leaves the archive empty rather than showing the last known list.",
    reverify: "Check whether the archived thread list query gained its own fallback upstream.",
  }),
  Object.freeze({
    marker: "/*codex-offline:archived-settings-offline-local-visibility*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: upstream computes the panel error as ae.length===0&&(c&&x||S==null&&O||k&&N==null&&ee). O is the cloud-task query error, which is always true offline, so the archive panel reports failure. Root cause of issue #55.",
    reverify: "Compare the isError expression in data-controls against the patched single-term form.",
  }),
  Object.freeze({
    marker: "/*codex-offline:bundled-browser-plugins-no-force-reload*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: the browser and chrome plugin descriptors gate isAvailable on online feature flags, which are false offline.",
    reverify: "Check the isAvailable predicates of the bundled browser and chrome descriptors.",
  }),
  Object.freeze({
    marker: "/*codex-offline:bundled-runtime-plugins*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: upstream filters the materialized marketplace down to marketplacePluginNames, which drops the computer-use, documents, spreadsheets and presentations plugins injected at packaging time.",
    reverify: "Check whether the marketplace filter still excludes packaging-time plugins.",
  }),
  Object.freeze({
    marker: "/*codex-offline:fast-mode-auth-method*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: upstream gates the Fast selector on ChatGPT auth plus a backend featureRequirements.fast_mode response, both unavailable to API-key and offline users.",
    reverify: "Check whether the fast_mode availability expression still requires backend agreement.",
  }),
  Object.freeze({
    marker: "/*codex-offline:plugins-api-key-nav*/",
    kind: "sentinel",
    tier: "required",
    assert: "absent",
    evidence:
      "26.903.8094.0: dormant. The renderer gate moved to init.cjs; this only fires if an upstream bundle reintroduces the gated Plugins nav branch.",
    reverify: "It landing at all is the signal that a rewrite against the new seam is due.",
  }),
  Object.freeze({
    marker: "/*codex-offline:plugins-api-key-route*/",
    kind: "sentinel",
    tier: "required",
    assert: "absent",
    evidence:
      "26.903.8094.0: dormant. The renderer gate moved to init.cjs; this only fires if an upstream bundle reintroduces the gated Plugins route branch.",
    reverify: "It landing at all is the signal that a rewrite against the new seam is due.",
  }),
  Object.freeze({
    marker: "/*codex-offline:renderer-known-statsig-gates*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: Statsig gates fail closed offline — _makeFeatureGate returns value: n?.value===!0 and a probe found no cached evaluations in localStorage, so every gate resolves false. 38 call sites are neutralized.",
    reverify: "Check the _makeFeatureGate default and whether an offline run seeds any cached evaluations.",
  }),
  Object.freeze({
    marker: "/*codex-offline:sidebar-activity-view*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: the same fail-closed gate problem, for a gate whose id is held in a variable rather than a literal, so the generic pass cannot reach it.",
    reverify: "Check whether the sidebar activity gate is still read through a variable id.",
  }),
  Object.freeze({
    marker: "/*codex-offline:workspace-dependencies-settings*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: the same fail-closed gate problem, for a gate whose id is held in a variable rather than a literal, so the generic pass cannot reach it.",
    reverify: "Check whether the workspace dependencies gate is still read through a variable id.",
  }),
  Object.freeze({
    marker: "/*codex-offline:worktree-head-ref*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: upstream still resolves a literal HEAD starting ref as refs/heads/HEAD, which fails permanent worktree creation.",
    reverify: "The needle still matching is itself the proof; a miss means upstream fixed it.",
  }),
  Object.freeze({
    marker: "/*codex-offline:model-id-display-name-fallback*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: upstream labels any model without a display name as `Custom`, so every entry of an API or custom catalog renders identically.",
    reverify: "Check whether upstream still falls back to the Custom label.",
  }),
  Object.freeze({
    marker: "/*codex-offline:offline-query-network-mode*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: upstream sets no networkMode, so React Query defaults to online and suspends queries whenever the renderer reports itself offline.",
    reverify: "Check whether the query client still omits networkMode.",
  }),
  Object.freeze({
    marker: "/*codex-offline:offline-mutation-network-mode*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: upstream sets no mutation networkMode, so mutations are paused offline instead of reaching the local app-server.",
    reverify: "Check whether the query client still omits a mutations networkMode.",
  }),
  Object.freeze({
    marker: "/*codex-offline:ultra-reasoning-effort*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: upstream filters the ultra reasoning effort out of the selector; the patch keeps it and synthesizes an entry for models that advertise max but not ultra.",
    reverify: "Check whether the supportedReasoningEfforts filter still excludes ultra.",
  }),
  Object.freeze({
    marker: "/*codex-offline:codex-mobile-auth-relogin*/",
    kind: "sentinel",
    tier: "required",
    assert: "absent",
    evidence:
      "26.903.8094.0: dormant. This only fires if an upstream bundle reintroduces the gated Codex Mobile auth branch.",
    reverify: "It landing at all is the signal that a rewrite against the new seam is due.",
  }),
  Object.freeze({
    marker: "/*codex-offline:default-on-gate-wrapper*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: opens unknown renderer gates read through the Statsig client's checkGate, which covers 21 direct call sites. Gates read through the jotai atom path are not covered; see section 8 of the design.",
    reverify: "Check that the checkGate seam still matches and count the call sites on each path.",
  }),
  Object.freeze({
    marker: "/*codex-offline:settings-route-map*/",
    kind: "patch",
    tier: "required",
    assert: "negative",
    evidence:
      "26.903.8094.0: the Electron build throws \"not implemented\" for show-settings and open-config-toml, so those menu entries do nothing without this.",
    reverify: "The upstream throw no longer matching means upstream implemented the handlers.",
  }),
  Object.freeze({
    marker: "/*codex-offline:locale-source-default*/",
    kind: "patch",
    tier: "required",
    assert: "negative",
    evidence:
      "26.903.8094.0: upstream defaults locale_source to IDE, which is wrong for a standalone desktop build with no IDE to read a locale from.",
    reverify: "Check whether the IDE default is still there.",
  }),
  Object.freeze({
    marker: "/*codex-offline:stdio-write-error-guard-v2*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0: closed-pipe writes surface as uncaught exceptions when the console that launched Codex exits first. There is no upstream shape to assert against, so this is marker-asserted.",
    reverify: "Check whether upstream added its own EPIPE/EOF handling on stdout and stderr.",
  }),
  Object.freeze({
    marker: "/*codex-offline:i18n-default-enabled*/",
    kind: "patch",
    tier: "required",
    assert: "negative",
    evidence:
      "26.903.8094.0: the settings page offers the language selector while the i18n provider defaults enable_i18n to false, so translations never load. This patch had no marker and no assertion at all until the boundary redesign.",
    reverify: "Check whether the provider still defaults enable_i18n to false.",
  }),
]);

const DESKTOP_ASAR_PATCH_MARKERS = Object.freeze(
  DESKTOP_ASAR_PATCHES.map((record) => record.marker),
);

const DESKTOP_ASAR_PATCH_BY_MARKER = new Map(
  DESKTOP_ASAR_PATCHES.map((record) => [record.marker, record]),
);

function getPatchRecord(marker) {
  return DESKTOP_ASAR_PATCH_BY_MARKER.get(marker);
}

function patchMarkersByTier(tier) {
  return Object.freeze(
    DESKTOP_ASAR_PATCHES.filter((record) => record.tier === tier).map((record) => record.marker),
  );
}

function patchMarkersByKind(kind) {
  return Object.freeze(
    DESKTOP_ASAR_PATCHES.filter((record) => record.kind === kind).map((record) => record.marker),
  );
}

const FAST_MODE_CONTRACT = Object.freeze({
  statsigStoreKey: STATSIG_DEFAULT_FEATURES_CONFIG,
  featureKey: "fast_mode",
  authMethodPatchMarker: "/*codex-offline:fast-mode-auth-method*/",
});

const REQUIRED_CAPABILITY_MARKERS = Object.freeze(
  Array.from(
    new Set([
      ...REQUIRED_WEB_SHELL_FEATURE_MARKERS,
      ...REQUIRED_STATSIG_FEATURE_MARKERS,
      ...REQUIRED_DESKTOP_FEATURE_MARKERS,
      ...DESKTOP_ASAR_PATCH_MARKERS,
    ])
  )
);

module.exports = {
  DEFAULT_DESKTOP_FEATURE_STATE,
  DESKTOP_ASAR_KNOWN_GATE_IDS,
  DESKTOP_ASAR_PATCHES,
  DESKTOP_ASAR_PATCH_MARKERS,
  getPatchRecord,
  patchMarkersByKind,
  patchMarkersByTier,
  DESKTOP_BROWSER_USE_AVAILABILITY_MARKERS,
  DESKTOP_BROWSER_USE_CAPABILITY_KEYS,
  FAST_MODE_CONTRACT,
  FORCED_DESKTOP_FEATURE_STATE,
  REQUIRED_CAPABILITY_MARKERS,
  REQUIRED_DESKTOP_FEATURE_MARKERS,
  REQUIRED_STATSIG_FEATURE_MARKERS,
  REQUIRED_WEB_SHELL_FEATURE_MARKERS,
  STATSIG_DEFAULT_FEATURE_OVERRIDES,
  STATSIG_DEFAULT_FEATURES_CONFIG,
  DESKTOP_GATE_DENYLIST,
  normalizeDesktopFeatureValues,
};
