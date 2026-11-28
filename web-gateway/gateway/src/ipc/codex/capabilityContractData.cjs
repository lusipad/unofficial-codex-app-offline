const STATSIG_DEFAULT_FEATURES_CONFIG = "statsig_default_enable_features";

// 26.928 起「应用快照」（编辑器"捕获应用快照"与对应设置分区）由该 Statsig dynamic config
// 的 appshots_enabled 字段驱动（renderer 侧 lp("1193530394") 读取），不再走 gate 路径。
// Web gateway 的 initialize/bootstrap 本地应答和桌面 init.cjs 的 Statsig 拦截都要携带它，
// 否则 renderer 解析缺省为 false，功能入口整体消失。
// 26.1007 起该 id 变为 realtimeConversationPrompt（实时语音）配置，appshots_enabled 只控制
// 语音会话里的应用快照动态工具；设置分区与编辑器入口改由 gate 1304276663 +（Windows）
// 2124127696 + 原生捕获助手 supported 决定，均由 gate-atom/wrapper 默认开启补丁覆盖。
//
// 26.1103 起动态配置 "72216192" 驱动界面的国际化多语言加载（enable_i18n / locale_source）。
// 离线环境下 Statsig 远端不可达，必须在默认 dynamic configs 中常驻下发，确保非英语语言包
// （如 zh-CN）能正常请求加载。
const STATSIG_DEFAULT_DYNAMIC_CONFIGS = Object.freeze({
  "1193530394": Object.freeze({
    appshots_enabled: true,
  }),
  "72216192": Object.freeze({
    enable_i18n: true,
    locale_source: "SYSTEM",
  }),
});

const STATSIG_DEFAULT_FEATURE_OVERRIDES = Object.freeze({
  "505458": true,
  "410065390": true,
  "410262010": true,
  "459748632": true,
  "717035860": true,
  "839469903": true,
  "1042620455": true,
  "1244621283": true,
  "1506311413": true,
  "2106641128": true,
  "2171042036": true,
  "2425897452": true,
  "3026692602": true,
  "3278809559": true,
  "3693343337": true,
  "4039078146": true,
  "4100906017": true,
  "4114442250": true,
  guardian_approval: true,
  fast_mode: true,
  browserPane: true,
  inAppBrowserUse: true,
  inAppBrowserUseAllowed: true,
  externalBrowserUse: true,
  externalBrowserUseAllowed: true,
  computerUse: true,
  control: true,
  avatarOverlay: true,
  artifacts: true,
});

// Unrecognized desktop renderer gates default on through two seams: the Statsig
// checkGate wrapper and the jotai gate atom (default-on-gate-atom). Gates listed
// here keep their upstream (offline: false) value on both.
//
// Reviewed against the 26.924.2738.0 renderer (docs/architecture/renderer-gate-atom-default-on.md).
// It holds every gate the atom path read while offline-closed that is either
// ChatGPT/cloud-only (billing, GPTs, Library, Sites, maps, ads, voice, mobile,
// announcements), onboarding/NUX, a plugin surface, telemetry, bound for the
// app-server tool catalog, or only read from shared chunks where its purpose
// could not be established. Gates the checkGate wrapper already opens are
// deliberately absent: listing one here would turn it off on that path too.
// The one exception is 3765605143 (ChatGPT Library): the checkGate path never
// surfaced it, while the atom path adds a sidebar entry that cannot load offline.
// A few ids are read through a variable rather than a literal and were found by
// logging which gates the patched atom opens during an offline launch.
//
// Reclassified after later identification (do not re-deny):
// - 3085093835: 26.928 navigation rail / scheduled-tasks sidebar mode switch.
// - 1892382740: renderer `browserUseTinysky` desktop feature (26.928). Dispatched
//   via `electron-desktop-features-changed`; the main process requires it for the
//   unified-computer-use plugin availability (`cua_repl` TinySky CUA runtime, the
//   电脑操控 surface) and mirrors it into `BROWSER_USE_TINYSKY_ENABLED`. Denying it
//   hides the new computer-control entry while the legacy computer-use plugin
//   keeps working; verified against the 26.928.21956 bundle.
//
// Inverted kill switches (true DISABLES a local feature; keep the upstream offline false):
// - 2373428540: external agent import (Claude Code etc.) — checkGate seeds the atom
//   that hides Settings → Import and short-circuits the import flows, command palette
//   entry and onboarding import (26.1007). Found via the offline feature probe.
// - 1799487541: composer context window usage ring — !gate("1799487541") gates
//   the composer context-usage indicator, Settings → General → Show context usage
//   toggle, and thread token-usage subscription (26.1117+). Opening it hides all three.
//
// Added by the 26.1013.3656.0 review (33 new ids scanned, docs/maintenance/gate-report.md):
// - Account / workspace identity: 217963745 + 1696552190 seed the accountUserId /
//   requestUserId source atom; 2034334892 (workspace plan), 2259614083 (workspace
//   account ordering), 2777527054 (ChatGPT-auth + matching account + email),
//   2438148931 + 3042818307 (account warning banner, both required).
// - Billing / checkout: 2799430872 (credits checkout loading label).
// - Cloud enrollment: 1199393483 (student-codex-enrollment).
// - Cloud sharing: 1665452992 (pet sharing in the pet settings dialog).
// - Ads / placement: 4101895715 (image card display types, ad impression transitions).
// - Telemetry: 349610806 (readiness/exposure-log gate, disableExposureLog).
// - GPTs / agents builder: 1010509169 (deployments / saved-draft API availability).
// - NUX: 2247892263 (code-review-link GitHub NUX).
// - Space (cloud workspace): 1442582935 (files search index), 2092319279 (suggested
//   tab fetch), 2648108507 (landing-page-v2 fetch/redirect).
// - Unconfirmed general chunk: 3368287113 (capability-gated surface next to the
//   enhanced-citations namespace).
// - 581294493 (nativeReplay) is consumed via a direct getFeatureGate business call
//   (experimentalFeatureGates) so the default-on seams do not touch it today; denied
//   defensively in case a future build routes it through checkGate / the gate atom.
// - Surfaced by the review's own seed-set update (learned readers): 494797613
//   (response favorites / file library), 711121807 + 4117608041 (promote-to-Page
//   cloud write, both required), 1205965498 (ChatGPT conversation markdown view),
//   1450219610 (content reference / GPTs), 2230082701 (plugin connector safety
//   prompt fetch), 2457328746 (pairs with 2092319279 on the space suggested-tab
//   query), 3104400975 (chronicle recorder history reminder).
// Left default-on as local/harmless: 1538937767 (localThreadStoreCompression settings
// surface), 1937538638 (local thread projection params), 3681340459 (response save
// action), 451195040 (window-transfer route behavior), 2733752831 (composer copy
// serialization span).
//
// Added by the 26.1120.6357.0 Rspack gate-report audit:
// - Gizmo / GPTs: 15851580, 1825130190, 2160578039
// - Checkout / billing / plans: 1970737597, 200883286, 2021736494
// - Ads: 4189971933, 1357702419
// - ChatGPT cloud / CME: 2989431347, 1468404277, 3063076119
// - Telemetry: 1878141435
const DESKTOP_GATE_DENYLIST = Object.freeze([
  "8119044", "15851580", "60299493", "68267662", "88729972", "89600278", "93596649", "110872417", "140487509", "183402703",
  "183803860", "185496087", "199045523", "200883286", "217963745", "219401130", "262557526", "267402900", "283315982", "301381018",
  "324493575", "337408568", "347810050", "375130565", "392100945", "419294242", "421173867", "423161634", "423260384", "444626067",
  "473637331", "476199071", "479474474", "494797613", "500337272", "507055138", "510816968", "512083054", "514645398", "523386142",
  "536305374", "573202630", "603443661", "616577762", "620613358", "637432221", "663642302", "699583893", "741821319", "770071981",
  "782250190", "798638120", "800714400", "809615575", "820196652", "821253728", "834063493", "867377638", "998088620", "1009060764",
  "1010509169", "1055689174", "1075962129", "1118223457", "1126370259", "1161538056", "1199393483", "1205965498", "1246162292", "1269116100",
  "1290093942", "1326334369", "1357702419", "1404955983", "1408180753", "1420162012", "1427398073", "1431301099", "1439503871", "1442582935",
  "1450219610", "1450647191", "1453178174", "1468404277", "1490494395", "1498636858", "1529702798", "1542198993", "1557113222", "1571655448",
  "1588629910", "1594900112", "1609929612", "1645387566", "1696552190", "1697652030", "1748737189", "1753656205", "1760150231", "1793241212",
  "1799487541", "1811798529", "1825130190", "1833686164", "1841893773", "1848317837", "1862054621", "1868494721", "1878141435", "1911760873",
  "1929707103", "1939400492", "1946731762", "1950211113", "1950533395", "1970737597", "1984032627", "2021736494", "2031251742", "2034334892",
  "2039979220", "2048788910", "2055603567", "2060455659", "2074528425", "2083739836", "2092319279", "2107644292", "2133596510", "2148883851",
  "2151067420", "2160578039", "2186196265", "2196156952", "2199204045", "2221440816", "2230082701", "2247892263", "2277470408", "2303743841",
  "2305612616", "2337831332", "2369306882", "2369709783", "2373428540", "2401070674", "2423536643", "2437304967", "2438148931", "2457328746",
  "2458863263", "2460218704", "2465577016", "2468797591", "2484414311", "2521882900", "2533914996", "2537605702", "2546594521", "2561885426",
  "2620175081", "2656155954", "2673474834", "2679405192", "2711242789", "2716206584", "2718448475", "2726095122", "2761268526", "2767344663",
  "2777527054", "2791276931", "2799430872", "2821958399", "2849306825", "2861925050", "2880010779", "2881473956", "2889497622", "2899820207",
  "2925981202", "2929091547", "2929582856", "2942273643", "2980760407", "2981678837", "2989431347", "2992509071", "3001618585", "3011042580",
  "3033586454", "3042818307", "3063076119", "3067284829", "3079718369", "3081805378", "3104400975", "3157804138", "3194776735", "3204182052",
  "3219370863", "3220935388", "3224986812", "3226853936", "3283824397", "3335252006", "3337546492", "3368287113", "3389661532", "3398492218",
  "3410379651", "3449856777", "3453210147", "3463396747", "3488289778", "3538455134", "3558392037", "3569283526", "3573128711", "3574573347",
  "3583034603", "3609742639", "3651873258", "3654803918", "3656984380", "3696110188", "3698563163", "3734976009", "3751415262", "3754576034",
  "3788389430", "3845962714", "3849065407", "3856252093", "3857987738", "3861898381", "3882703512", "3909937021", "3936985709", "3939855767",
  "3941040396", "3946177020", "3956214348", "3957595485", "3959961672", "3960854641", "4020418403", "4023951618", "4029789265", "4062279831",
  "4101895715", "4117608041", "4128908571", "4135903789", "4153229570", "4189971933", "4192642686", "4209825986", "4218407052", "4231797315",
  "4263582812", "4285716042", "4290238484",
]);

const DEFAULT_DESKTOP_FEATURE_STATE = Object.freeze({
  ambientSuggestions: false,
  avatarOverlay: true,
  browserPane: true,
  computerUse: true,
  control: true,
  externalBrowserUse: true,
  externalBrowserUseAllowed: true,
  inAppBrowserUse: true,
  inAppBrowserUseAllowed: true,
  multiWindow: false,
});

const FORCED_DESKTOP_FEATURE_STATE = Object.freeze({
  avatarOverlay: true,
  browserPane: true,
  computerUse: true,
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
  "2106641128",
  "3693343337",
  "3026692602",
  "4039078146",
  "717035860",
  "inAppBrowserUseAllowed",
  "externalBrowserUseAllowed",
  "3278809559",
  "1042620455",
  "4114442250",
]);

const REQUIRED_DESKTOP_FEATURE_MARKERS = Object.freeze([
  "setDesktopFeatureValues",
  "computerUse",
  "inAppBrowserUseAllowed",
  "externalBrowserUseAllowed",
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
]);

const DESKTOP_BROWSER_USE_AVAILABILITY_MARKERS = Object.freeze([
  "computerUse",
  "externalBrowserUse",
  "inAppBrowserUse",
]);

const DESKTOP_ASAR_KNOWN_GATE_IDS = Object.freeze([
  "505458",
  "410065390",
  "410262010",
  "459748632",
  "717035860",
  "839469903",
  "1042620455",
  "1244621283",
  "1506311413",
  "2106641128",
  "2171042036",
  "2425897452",
  "3026692602",
  "3278809559",
  "3693343337",
  "4039078146",
  "4100906017",
  "4114442250",
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
// See docs/architecture/desktop-patch-boundary-design.md.
const DESKTOP_ASAR_PATCHES = Object.freeze([
  Object.freeze({
    marker: "/*codex-offline:windows-app-contained-core-off*/",
    kind: "patch",
    tier: "required",
    assert: "negative",
    evidence:
      "26.915.4065.0: package.json gained codexWindowsAppContainedCore:\"1\". With it on, the main-process bootstrap calls the native updater's getCurrentPackageFamily() before importing the main app; outside MSIX that throws \"The process has no package identity.\", the bootstrap catch destroys every window, and the app launches to nothing. A pristine 26.915 payload reproduces this with zero patches applied, and clearing the field restores a passing direct-launch smoke.",
    reverify:
      "Check whether package.json still carries the field and whether the bootstrap still calls getCurrentPackageFamily() unguarded ahead of the main import.",
  }),
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
      "26.1027.3384.0: upstream gates Fast mode in useServiceTierAccess hook on ChatGPT auth and drops serviceTierAccess to null for API-key/offline users, hiding the speed selector across composer and settings.",
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
    marker: "/*codex-offline:durable-sign-in-retry-stop*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.928.3736.0: the renderer always adds the durable host manager and lists its recent threads; without a ChatGPT sign-in the main-process durable transport throws 'Sign in to ChatGPT to start a durable thread.' and AppServerConnection reschedules a reconnect forever (14 attempts in 3.5 minutes offline, each logging stack traces). In 26.1002+, unsupported remote app-server versions (e.g. WSL with outdated codex-app-server) also trigger tight reconnect loops. The patch makes shouldStopRetryingRemoteConnection stop the timer for both durable auth errors and unsupported app-server version errors; a later on-demand request (e.g. after signing in or updating) still connects because no non-retryable fatal error is recorded.",
    reverify: "Check that both AppServerConnection failure paths still consult shouldStopRetryingRemoteConnection and that the durable transport and version check still throw the expected error texts.",
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
      "26.903.8094.0: upstream filters the ultra reasoning effort out of the selector; the patch keeps it and synthesizes an entry for gpt-* models that advertise max but not ultra. Third-party catalog models (e.g. deepseek-*) are skipped: their APIs treat ultra as thinking mode and demand reasoning_text echoed back, which codex never sends (issue #114).",
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
    marker: "/*codex-offline:default-on-gate-atom*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.924.2738.0: the renderer's jotai gate atom reads getFeatureGate(key).value without going through checkGate, so every UI hook on that path (App snapshots, Mini/pets, code review settings, worktrees, ...) stays false offline. The patch opens a gate only when Statsig has no recognized evaluation for it and it is not in DESKTOP_GATE_DENYLIST.",
    reverify: "Check that the recognized-evaluation predicate and both atom writes (on mount, on values_updated) still match, then re-run the gate review for new ids.",
  }),
  Object.freeze({
    marker: "/*codex-offline:unauthenticated-capability-default-on*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.928.2636.0: the renderer capability selector (app-shared) returns isLoading forever while the app is unauthenticated (authLoading && authMethod == null), so capability-gated surfaces never render — most visibly the /scheduled automations nav entry and route (automations.local / automations.cloud isCapable), which breaks issue #123 on pure-offline machines that only configure a custom provider in config.toml. The patch gives a null-auth principal the same treatment as the selector's own apiKey branch right below it (isCapable: true): local capabilities have no account dependency. The chatgpt-account-loading branch is untouched.",
    reverify: "Check that the capability selector still gates on authLoading/authMethod/accountLoading and that unauthenticated-with-config.toml remains an expected offline state.",
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
  Object.freeze({
    marker: "/*codex-offline:context-window-usage-default-on*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.1120.5083.0: upstream defines showContextWindowUsage (key \"show-context-window-usage\") with default:!1 in both .vite/build (appServices.settings.readAll) and webview/assets bundles. Flipping the schema default to !0 enables the composer context ring out of the box offline while keeping Settings -> General -> Show context usage toggleable.",
    reverify:
      "Check whether showContextWindowUsage (key \"show-context-window-usage\") still defaults to false in .vite/build and webview/assets.",
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

function hasValidCodexAppTransport(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const hasCommand = typeof obj.command === "string" && obj.command.trim().length > 0;
  const hasUrl = typeof obj.url === "string" && obj.url.trim().length > 0;
  return hasCommand || hasUrl;
}

/**
 * 清洗 config 中不完整的 codex_app MCP 服务器配置。
 * 官方 desktop 和 renderer 会生成类似 "mcp_servers.codex_app": { enabled_tools: [...] } 的碎片，
 * 或没有 command / url 的残余配置。若直接传递给 app-server，会导致 Rust 配置反序列化时报错：
 * "failed to load configuration: invalid transport in mcp_servers.codex_app"。
 * 只有具备非空 command 或 url 的完整有效传输定义才予保留。
 */
function sanitizeCodexAppMcpConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  let sanitized = config;
  let changed = false;
  const ensureMutable = () => {
    if (!changed) {
      sanitized = { ...config };
      changed = true;
    }
  };

  const BASE_PREFIXES = [
    "mcp_servers.codex_app",
    "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app",
  ];

  for (const base of BASE_PREFIXES) {
    if (Object.prototype.hasOwnProperty.call(sanitized, base)) {
      const val = sanitized[base];
      if (!hasValidCodexAppTransport(val)) {
        ensureMutable();
        delete sanitized[base];
      }
    }
    const dottedPrefix = `${base}.`;
    const keys = Object.keys(sanitized).filter((key) => key.startsWith(dottedPrefix));
    if (keys.length > 0) {
      const cmdKey = `${dottedPrefix}command`;
      const urlKey = `${dottedPrefix}url`;
      const hasTransport =
        (typeof sanitized[cmdKey] === "string" && sanitized[cmdKey].trim().length > 0) ||
        (typeof sanitized[urlKey] === "string" && sanitized[urlKey].trim().length > 0);
      if (!hasTransport) {
        ensureMutable();
        for (const key of keys) delete sanitized[key];
      }
    }
  }

  const nested = sanitized.mcp_servers;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const codexApp = nested.codex_app;
    if (codexApp && typeof codexApp === "object" && !Array.isArray(codexApp)) {
      if (!hasValidCodexAppTransport(codexApp)) {
        ensureMutable();
        const nextServers = { ...nested };
        delete nextServers.codex_app;
        sanitized = { ...sanitized, mcp_servers: nextServers };
      }
    }
  }

  if (sanitized.plugins && typeof sanitized.plugins === "object" && !Array.isArray(sanitized.plugins)) {
    const bundledPlugin = sanitized.plugins["codex-app-tools@openai-bundled"];
    if (bundledPlugin && typeof bundledPlugin === "object" && !Array.isArray(bundledPlugin)) {
      const pluginServers = bundledPlugin.mcp_servers;
      if (pluginServers && typeof pluginServers === "object" && !Array.isArray(pluginServers)) {
        const codexApp = pluginServers.codex_app;
        if (codexApp && typeof codexApp === "object" && !Array.isArray(codexApp) && !hasValidCodexAppTransport(codexApp)) {
          ensureMutable();
          const nextPluginServers = { ...pluginServers };
          delete nextPluginServers.codex_app;
          sanitized = {
            ...sanitized,
            plugins: {
              ...sanitized.plugins,
              "codex-app-tools@openai-bundled": {
                ...bundledPlugin,
                mcp_servers: nextPluginServers,
              },
            },
          };
        }
      }
    }
  }

  return sanitized;
}

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
  STATSIG_DEFAULT_DYNAMIC_CONFIGS,
  DESKTOP_GATE_DENYLIST,
  normalizeDesktopFeatureValues,
  sanitizeCodexAppMcpConfig,
};
