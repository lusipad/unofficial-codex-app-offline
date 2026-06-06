const STATSIG_DEFAULT_FEATURES_CONFIG = "statsig_default_enable_features";

const STATSIG_DEFAULT_FEATURE_OVERRIDES = Object.freeze({
  "4166894088": true,
  guardian_approval: true,
  fast_mode: true,
  "410262010": true,
  "410065390": true,
  "4250630194": true,
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
  "1609556872": true,
  "1221508807": true,
  "459748632": true,
  "2574306096": true,
  "1042620455": true,
  "4114442250": true,
  "839469903": true,
  "1244621283": true,
  "4100906017": true,
  "1444479692": true,
});

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
  "inAppBrowserUseAllowed",
  "externalBrowserUseAllowed",
  "computerUseNodeRepl",
  "3903742690",
  "3326157269",
  "2900529421",
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
  ...REQUIRED_STATSIG_FEATURE_MARKERS,
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
  "1244621283",
  "4100906017",
  "2574306096",
  "1444479692",
  "1042620455",
  "4114442250",
  "839469903",
]);

const DESKTOP_ASAR_PATCH_MARKERS = Object.freeze([
  "/* codex-offline:windowsStore-patch */",
  "/*codex-offline:windows-browser-use-capability*/",
  "/*codex-offline:node-repl-feature-enabled*/",
  "/*codex-offline:feature-overrides-preserve-mcp-config*/",
  "/*codex-offline:feature-enablement-preserve-unified-exec*/",
  "/*codex-offline:bundled-plugin-cache-lock-nonfatal*/",
  "/*codex-offline:node-repl-config-reconcile-finally*/",
  "/*codex-offline:node-repl-disable-sandbox*/",
  "/*codex-offline:node-repl-tool-search-feature*/",
  "/*codex-offline:computer-use-plugin-root-fallback*/",
  "/*codex-offline:computer-use-input-mention*/",
  "/*codex-offline:computer-use-input-mention-v2*/",
  "/*codex-offline:computer-use-input-skill*/",
  "/*codex-offline:computer-use-thread-start-tool-search*/",
  "/*codex-offline:computer-use-node-repl-dynamic-tool*/",
  "/*codex-offline:computer-use-node-repl-dynamic-tool-call*/",
  "/*codex-offline:bundled-browser-plugins-no-force-reload*/",
  "/*codex-offline:bundled-runtime-plugins*/",
  "/*codex-offline:fast-mode-selector*/",
  "/*codex-offline:fast-mode-auth-method*/",
  "/*codex-offline:fast-mode-service-tier-options*/",
  "/*codex-offline:context-usage-visible*/",
  "/*codex-offline:plugins-api-key-nav*/",
  "/*codex-offline:plugins-api-key-route*/",
  "/*codex-offline:renderer-known-statsig-gates*/",
  "/*codex-offline:codex-mobile-auth-relogin*/",
  "/*codex-offline:external-agent-config-import*/",
  "/*codex-offline:disable-auto-updater-breadcrumb*/",
]);

const FAST_MODE_CONTRACT = Object.freeze({
  statsigStoreKey: STATSIG_DEFAULT_FEATURES_CONFIG,
  featureKey: "fast_mode",
  selectorPatchMarker: "/*codex-offline:fast-mode-selector*/",
  authMethodPatchMarker: "/*codex-offline:fast-mode-auth-method*/",
  serviceTierOptionsPatchMarker: "/*codex-offline:fast-mode-service-tier-options*/",
  availabilityMarkers: Object.freeze(["additionalSpeedTiers", "canUseFastMode"]),
});

const CONTEXT_USAGE_CONTRACT = Object.freeze({
  localStatusSectionStorageKey: "local-conversation-status-section-visible",
  visibilityPatchMarker: "/*codex-offline:context-usage-visible*/",
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
  DESKTOP_ASAR_PATCH_MARKERS,
  DESKTOP_BROWSER_USE_AVAILABILITY_MARKERS,
  DESKTOP_BROWSER_USE_CAPABILITY_KEYS,
  FAST_MODE_CONTRACT,
  CONTEXT_USAGE_CONTRACT,
  FORCED_DESKTOP_FEATURE_STATE,
  REQUIRED_CAPABILITY_MARKERS,
  REQUIRED_DESKTOP_FEATURE_MARKERS,
  REQUIRED_STATSIG_FEATURE_MARKERS,
  REQUIRED_WEB_SHELL_FEATURE_MARKERS,
  STATSIG_DEFAULT_FEATURE_OVERRIDES,
  STATSIG_DEFAULT_FEATURES_CONFIG,
  normalizeDesktopFeatureValues,
};
