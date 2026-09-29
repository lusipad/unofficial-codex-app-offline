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

// Unrecognized desktop renderer gates default on through two seams: the Statsig
// checkGate wrapper and the jotai gate atom (default-on-gate-atom). Gates listed
// here keep their upstream (offline: false) value on both.
//
// Reviewed against the 26.924.2738.0 renderer (docs/renderer-gate-atom-default-on.md).
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
const DESKTOP_GATE_DENYLIST = Object.freeze([
  "131713", "8119044", "13323501", "60299493", "67629032", "68267662", "85924660", "87569714",
  "88729972", "89600278", "93596649", "107580212", "110872417", "131701769", "140487509", "183402703",
  "183803860", "185496087", "199045523", "216490582", "219401130", "225453312", "262557526", "267402900",
  "282477705", "283315982", "301381018", "308137029", "324493575", "337040058", "337408568", "339548201",
  "347810050", "349489989", "375130565", "383746455", "392100945", "419294242", "421173867", "423018073",
  "423161634", "423260384", "435814576", "444626067", "452956359", "473637331", "474909459", "476199071",
  "479474474", "500337272", "507055138", "510816968", "512083054", "512537293", "514645398", "521320455",
  "523386142", "536305374", "573202630", "576820092", "579992154", "603443661", "616577762", "620613358",
  "635008376", "637432221", "663642302", "699583893", "714010102", "741821319", "770071981", "782250190",
  "794043821", "798638120", "800714400", "809615575", "820196652", "821253728", "823322201", "834063493",
  "834565546", "867377638", "868657095", "887623693", "917107581", "931825599", "973546965", "998088620",
  "1009060764", "1055689174", "1069053961", "1075962129", "1118223457", "1126370259", "1139999823", "1161146167",
  "1161538056", "1161820487", "1193530394", "1235214514", "1246162292", "1269116100", "1274567217", "1290093942",
  "1326334369", "1349514884", "1402002035", "1404955983", "1408180753", "1420162012", "1427398073", "1431301099",
  "1439503871", "1450647191", "1453178174", "1490494395", "1498636858", "1500581060", "1524951846", "1529702798",
  "1542198993", "1546790766", "1553649031", "1557113222", "1567168325", "1571655448", "1588629910", "1594900112",
  "1605145461", "1609929612", "1611573287", "1645387566", "1648954249", "1697652030", "1715534902", "1748737189",
  "1753656205", "1753900615", "1760150231", "1763977100", "1793241212", "1811711706", "1811798529", "1823130936",
  "1827303475", "1833686164", "1841893773", "1848317837", "1852804523", "1857002365", "1862054621", "1868494721",
  "1873790768", "1892382740", "1892621033", "1895559448", "1896812223", "1911760873", "1912312436", "1929707103",
  "1932174607", "1939400492", "1946731762", "1950211113", "1950533395", "1984032627", "1991660486", "2009341345",
  "2029197928", "2031251742", "2039979220", "2048788910", "2055603567", "2060455659", "2074528425", "2078407422",
  "2083739836", "2107644292", "2125321167", "2126931955", "2128165686", "2133596510", "2138468235", "2144562623",
  "2148883851", "2151067420", "2160290604", "2165992955", "2186196265", "2196156952", "2199204045", "2199741681",
  "2220834113", "2221440816", "2248542797", "2251074964", "2272277762", "2277470408", "2303743841", "2305612616",
  "2327881676", "2337831332", "2347841422", "2369306882", "2369709783", "2401070674", "2404437118", "2413345355",
  "2423536643", "2437304967", "2458863263", "2460218704", "2465577016", "2468797591", "2470976080", "2484414311",
  "2493948789", "2513446768", "2521882900", "2533914996", "2534086513", "2537605702", "2546594521", "2561885426",
  "2562735250", "2619337129", "2620175081", "2656155954", "2658206886", "2664309699", "2673474834", "2679405192",
  "2707980096", "2711242789", "2712711964", "2716206584", "2718448475", "2726095122", "2761268526", "2767344663",
  "2789236610", "2791276931", "2796470471", "2797915223", "2807523224", "2817990312", "2821958399", "2826703856",
  "2840857813", "2846759686", "2849306825", "2861925050", "2880010779", "2881473956", "2889497622", "2899820207",
  "2910064124", "2911503418", "2912878776", "2925981202", "2929091547", "2929582856", "2942273643", "2980760407",
  "2981678837", "2983946247", "2992509071", "2998660035", "3000193894", "3001618585", "3011042580", "3017902351",
  "3033586454", "3051515858", "3062419800", "3066066594", "3067284829", "3079718369", "3081805378", "3085093835",
  "3092648596", "3096145510", "3133640912", "3157804138", "3162484136", "3194776735", "3199592968", "3204182052",
  "3210336210", "3219370863", "3220576529", "3220935388", "3224986812", "3226853936", "3283824397", "3309093858",
  "3333071866", "3335252006", "3336871980", "3337546492", "3350594701", "3350594702", "3365181325", "3384989494",
  "3389661532", "3398492218", "3402733355", "3410379651", "3413445247", "3449856777", "3453210147", "3463396747",
  "3470175389", "3470842601", "3488289778", "3500066563", "3528236309", "3528415127", "3538455134", "3543489707",
  "3558392037", "3563322242", "3566525122", "3569283526", "3573128711", "3574573347", "3583034603", "3586972587",
  "3589846221", "3609742639", "3617198761", "3646412386", "3651873258", "3652260651", "3654803918", "3656984380",
  "3685705952", "3696110188", "3698563163", "3734976009", "3737772469", "3751415262", "3754576034", "3765605143",
  "3768341700", "3788389430", "3792512848", "3813052382", "3845962714", "3849065407", "3856252093", "3857987738",
  "3861898381", "3876839960", "3882703512", "3898549694", "3904859678", "3909937021", "3927407613", "3934129380",
  "3936985709", "3939855767", "3941040396", "3943865271", "3946177020", "3950229590", "3956214348", "3957595485",
  "3959296341", "3959961672", "3960854641", "3976152662", "3979058447", "3999280432", "4004151486", "4006626389",
  "4020418403", "4023951618", "4029789265", "4030542669", "4038208412", "4062279831", "4067531359", "4082596618",
  "4107938382", "4128908571", "4135020696", "4135903789", "4147559047", "4153229570", "4192642686", "4209825986",
  "4218407052", "4231797315", "4263582812", "4277823746", "4285716042", "4290238484",
]);

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
