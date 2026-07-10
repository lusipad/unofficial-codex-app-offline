/**
 * Desktop IPC Interception Module
 *
 * Loaded from the asar entry-point bootstrap snippet.  Runs in the Electron
 * main process before the app code registers its IPC handlers, so we can wrap
 * the registrations and inject feature-gate overrides at the data level
 * instead of regex-patching compiled JavaScript.
 *
 * This is the desktop counterpart of the Web Gateway's featurePatches.ts /
 * fetchIpc.ts Statsig interception layer.
 */

(function () {
  // Guard: only run in Electron main process
  var _electron;
  try { _electron = require('electron'); } catch (_e) { return; }
  if (!_electron || !_electron.ipcMain) return;

  var ipcMain = _electron.ipcMain;
  var app = _electron.app;
  var session = _electron.session;

  // ── Diagnostics ──────────────────────────────────────────────────────────
  // Set CODEX_OFFLINE_PATCH_DEBUG=1 to enable diagnostic logging
  var _diagEnabled;
  try { _diagEnabled = process.env.CODEX_OFFLINE_PATCH_DEBUG === '1'; } catch (_e) { _diagEnabled = false; }
  var _diagLogPath;
  if (_diagEnabled) {
    try {
      _diagLogPath = require('path').join(require('os').homedir(), '.codex', 'logs', 'codex-offline-patches.log');
      require('fs').mkdirSync(require('path').dirname(_diagLogPath), { recursive: true });
    } catch (_e) { _diagLogPath = null; }
  }

  function _diag(msg) {
    if (!_diagEnabled) return;
    try {
      if (_diagLogPath) {
        require('fs').appendFileSync(_diagLogPath,
          '[' + new Date().toISOString() + '] [codex-offline-patches] ' + msg + '\n');
      }
    } catch (_e) { /* best-effort */ }
  }

  // Marker so other code can detect we're active
  try { process.env.CODEX_OFFLINE_PATCH_ACTIVE = '1'; } catch (_e) {}

  // ═══════════════════════════════════════════════════════════════════════
  // Layer 0: Wrap webContents.send to intercept main→renderer data flow
  // ═══════════════════════════════════════════════════════════════════════
  // This catches responses to ipcRenderer.send() that flow back via
  // webContents.send() (the main→renderer direction).

  function wrapWebContentsSend(wc) {
    if (!wc || !wc.send || wc._codexOfflineWrapped) return;
    wc._codexOfflineWrapped = true;
    var _origSend = wc.send.bind(wc);
    wc.send = function (channel) {
      // Log key channels for diagnostics
      if (channel && (channel.indexOf('shared-object') >= 0 ||
                      channel.indexOf('statsig') >= 0 ||
                      channel.indexOf('desktop-features') >= 0 ||
                      channel.indexOf('electron-') >= 0)) {
        _diag('webContents.send: ' + channel + ' arg0Type=' + typeof arguments[1]);
      }
      // Attempt to inject gate overrides
      for (var i = 1; i < arguments.length; i++) {
        if (isPlainObject(arguments[i])) {
          patchSharedObjectPayload(arguments[i]);
        }
      }
      return _origSend.apply(wc, arguments);
    };
  }

  // Wrap existing webContents
  try {
    var _wcModule = _electron.webContents;
    if (_wcModule && typeof _wcModule.getAllWebContents === 'function') {
      var _allWc = _wcModule.getAllWebContents();
      for (var _wi = 0; _wi < _allWc.length; _wi++) {
        wrapWebContentsSend(_allWc[_wi]);
      }
      _diag('webContents.send: wrapped ' + _allWc.length + ' existing webContents');
    }
  } catch (_e) {}

  // Wrap future BrowserWindows
  if (app && typeof app.on === 'function') {
    try {
      app.on('browser-window-created', function (_event, win) {
        if (win && win.webContents) {
          wrapWebContentsSend(win.webContents);
          _diag('webContents.send: wrapped new BrowserWindow');
        }
      });
    } catch (_e) {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Gate Override Data (synced with capabilityContractData.cjs)
  // ═══════════════════════════════════════════════════════════════════════

  var STATSIG_DEFAULT_FEATURES_CONFIG = 'statsig_default_enable_features';
  var STATSIG_MODEL_AVAILABILITY_CONFIG = '107580212';

  /** Every Statsig gate that should be unconditionally enabled offline. */
  var STATSIG_GATE_OVERRIDES = {
    // From STATSIG_DEFAULT_FEATURE_OVERRIDES
    '4166894088': true,   // Settings page
    '824038554': true,    // Codex/Work mode selector
    '2106641128': true,   // Experimental features settings
    '3693343337': true,   // Model features settings
    '3026692602': true,   // Workspace dependencies settings
    '410262010': true,    // Browser use agent
    '410065390': true,    // External Chrome plugin @mentions
    '4250630194': true,   // In-app browser
    '2679188970': true,   // Avatar overlay
    '1060282072': true,   // Thread overlay
    '1506311413': true,   // Computer Use
    '2171042036': true,   // Control desktop feature
    '3903563814': true,   // Browser non-local sites
    '3032432888': true,   // Thread hover cards
    '3903742690': true,   // Artifacts pane
    '3326157269': true,   // External agent config import
    '2900529421': true,   // External agent config
    '2711149772': true,   // External agent config
    '816842483': true,    // External agent config
    guardian_approval: true,
    fast_mode: true,
    browserPane: true,
    inAppBrowserUse: true,
    inAppBrowserUseAllowed: true,
    externalBrowserUse: true,
    externalBrowserUseAllowed: true,
    computerUse: true,
    computerUseNodeRepl: true,
    control: true,
    avatarOverlay: true,
    artifacts: true,

    // Additional gates currently only in DESKTOP_ASAR_KNOWN_GATE_IDS
    '3075919032': true,   // Automations
    '3789238711': true,   // Pull Requests
    '2302560359': true,   // Scratchpad
    '1488233300': true,   // Heartbeat automations
    '2425897452': true,   // Ambient suggestions
    '2553306736': true,   // PR badge icons
    '875176429': true,    // Memories
    '505458': true,       // Worktree mode
    '1907601843': true,   // Local env cloud onboarding
    '588076040': true,    // Bundled plugins marketplace
    '533078438': true,    // Plugins nav (bypass API-key lockout)
    '1609556872': true,   // Slash commands menu
    '1221508807': true,   // Background subagents
    '459748632': true,    // Multi-window
    '1244621283': true,   // Global dictation
    '4100906017': true,   // Global dictation (alt)
    '2574306096': true,   // Chronicle
    '1444479692': true,   // Agent personality
    '1042620455': true,   // Remote connections
    '4114442250': true,   // Remote connections feature flag
    '839469903': true,    // Artifact Electron native
  };

  /** Forced desktop feature state (always-on). */
  var FORCED_DESKTOP_FEATURE_STATE = {
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
  };

  // ═══════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function clearedModelAvailabilityValue() {
    return { available_models: [], use_hidden_models: false };
  }

  function overwriteModelAvailabilityConfig(configs) {
    if (!isPlainObject(configs)) return false;
    var existing = configs[STATSIG_MODEL_AVAILABILITY_CONFIG];
    var nextValue = clearedModelAvailabilityValue();
    if (isPlainObject(existing) &&
        ('value' in existing || existing.name === STATSIG_MODEL_AVAILABILITY_CONFIG)) {
      if (JSON.stringify(existing.value) === JSON.stringify(nextValue)) return false;
      existing.value = nextValue;
    } else {
      configs[STATSIG_MODEL_AVAILABILITY_CONFIG] = {
        name: STATSIG_MODEL_AVAILABILITY_CONFIG,
        rule_id: 'desktop_override',
        value: nextValue,
      };
    }
    return true;
  }

  /** Deep-merge source into target. */
  function deepAssign(target, source) {
    if (!isPlainObject(target) || !isPlainObject(source)) return target;
    var keys = Object.keys(source);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (isPlainObject(source[k]) && isPlainObject(target[k])) {
        deepAssign(target[k], source[k]);
      } else {
        target[k] = source[k];
      }
    }
    return target;
  }

  /**
   * Inject gate overrides into a Statsig-like JSON structure.
   * Handles various key naming conventions (feature_gates / featureGates / gates).
   */
  function injectStatsigGatesIntoObject(obj) {
    if (!isPlainObject(obj)) return false;
    var changed = false;
    var gateKeys = Object.keys(STATSIG_GATE_OVERRIDES);

    // Patch feature_gates / featureGates / gates
    var gateContainerKeys = ['feature_gates', 'featureGates', 'gates'];
    for (var gi = 0; gi < gateContainerKeys.length; gi++) {
      var container = obj[gateContainerKeys[gi]];
      if (!isPlainObject(container)) continue;
      for (var i = 0; i < gateKeys.length; i++) {
        var gateName = gateKeys[i];
        var existing = container[gateName];
        var next = {
          name: gateName,
          value: true,
          rule_id: existing && existing.rule_id ? existing.rule_id : 'desktop_override',
          secondary_exposures: existing && Array.isArray(existing.secondary_exposures)
            ? existing.secondary_exposures : [],
        };
        if (isPlainObject(existing)) {
          Object.keys(existing).forEach(function (k) { if (!(k in next)) next[k] = existing[k]; });
        }
        next.value = true;
        if (JSON.stringify(existing) !== JSON.stringify(next)) {
          container[gateName] = next;
          changed = true;
        }
      }
    }

    // Patch dynamic_configs / dynamicConfigs / configs
    var configContainerKeys = ['dynamic_configs', 'dynamicConfigs', 'configs'];
    for (var ci = 0; ci < configContainerKeys.length; ci++) {
      var configs = obj[configContainerKeys[ci]];
      if (!isPlainObject(configs)) continue;
      var statsigConfig = configs[STATSIG_DEFAULT_FEATURES_CONFIG];
      if (!isPlainObject(statsigConfig)) {
        statsigConfig = { name: STATSIG_DEFAULT_FEATURES_CONFIG, rule_id: 'desktop_override', value: {} };
        configs[STATSIG_DEFAULT_FEATURES_CONFIG] = statsigConfig;
      }
      if (!isPlainObject(statsigConfig.value)) statsigConfig.value = {};
      for (var j = 0; j < gateKeys.length; j++) {
        if (!(gateKeys[j] in statsigConfig.value)) {
          statsigConfig.value[gateKeys[j]] = true;
          changed = true;
        }
      }
      if (overwriteModelAvailabilityConfig(configs)) changed = true;
    }

    return changed;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Layer 1: session.webRequest — Intercept Statsig HTTP requests
  // ═══════════════════════════════════════════════════════════════════════

  function buildStatsigFakeResponse() {
    var body = {
      has_updates: true,
      time: Date.now(),
      feature_gates: {},
      dynamic_configs: {},
      layer_configs: {},
      param_stores: {},
      exposures: {},
      sdk_flags: {},
    };
    injectStatsigGatesIntoObject(body);
    return body;
  }

  var STATSIG_INITIALIZE_URL_PATTERN = '*://ab.chatgpt.com/v1/initialize*';

  function setupWebRequestInterceptor() {
    try {
      var ses = session.defaultSession;
      if (!ses || !ses.webRequest) return;

      ses.webRequest.onBeforeRequest(
        { urls: [STATSIG_INITIALIZE_URL_PATTERN] },
        function (_details, callback) {
          try {
            var fakeBody = JSON.stringify(buildStatsigFakeResponse());
            _diag('webRequest: intercepting Statsig initialize → data: URI (' + fakeBody.length + ' bytes)');
            callback({
              redirectURL: 'data:application/json;charset=utf-8,' + encodeURIComponent(fakeBody),
            });
          } catch (_err) {
            _diag('webRequest: Statsig intercept error: ' + (_err && _err.message));
            callback({});
          }
        }
      );
      _diag('webRequest: Statsig initialize interceptor registered');
    } catch (_e) { _diag('webRequest: setup failed: ' + (_e && _e.message)); }
  }

  // Register as early as possible — before app is ready
  setupWebRequestInterceptor();

  if (app && typeof app.on === 'function') {
    // Re-register after session is fully initialized
    try { app.on('session-created', function () { setupWebRequestInterceptor(); }); } catch (_e) {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Layer 2: ipcMain.handle wrapping — Intercept IPC-based Statsig & config
  // ═══════════════════════════════════════════════════════════════════════

  var _origHandle = ipcMain.handle.bind(ipcMain);

  /** Channels that carry Statsig shared-object snapshots to the renderer. */
  var STATSIG_IPC_CHANNELS = [
    'shared-object-set',
    'shared-object-subscribe',
    'codex_desktop:get-shared-object-snapshot',
    'shared-object-get',
  ];

  /** Channels that carry feature/config data. */
  var CONFIG_IPC_CHANNELS = [
    'config:read',
    'read-config',
    'read-config-for-host',
  ];

  function isStatsigChannel(channel) {
    for (var i = 0; i < STATSIG_IPC_CHANNELS.length; i++) {
      if (channel === STATSIG_IPC_CHANNELS[i]) return true;
    }
    return false;
  }

  function isConfigChannel(channel) {
    for (var i = 0; i < CONFIG_IPC_CHANNELS.length; i++) {
      if (channel === CONFIG_IPC_CHANNELS[i]) return true;
    }
    return false;
  }

  /**
   * Patch a shared-object payload to inject gate overrides.
   * Supports both { key, value } and direct snapshot objects.
   */
  function patchSharedObjectPayload(result) {
    if (!isPlainObject(result)) return result;
    var patched = false;
    // Direct Statsig snapshot object
    if (result.feature_gates || result.featureGates || result.gates ||
        result.dynamic_configs || result.dynamicConfigs || result.configs) {
      patched = injectStatsigGatesIntoObject(result);
    }
    // Single key/value pair — inject overrides for statsig keys
    if (typeof result.key === 'string' && isPlainObject(result.value)) {
      if (result.key === STATSIG_MODEL_AVAILABILITY_CONFIG) {
        if ('value' in result.value || result.value.name === STATSIG_MODEL_AVAILABILITY_CONFIG) {
          result.value.value = clearedModelAvailabilityValue();
        } else {
          result.value = clearedModelAvailabilityValue();
        }
        patched = true;
      } else if (result.key === STATSIG_DEFAULT_FEATURES_CONFIG ||
          result.key.indexOf('statsig') === 0 ||
          result.key.indexOf('feature') === 0) {
        deepAssign(result.value, STATSIG_GATE_OVERRIDES);
        patched = true;
      }
    }
    if (patched) {
      _diag('gate overrides injected into shared-object (key=' + (result.key || 'snapshot') + ')');
    }
    return result;
  }

  function patchConfigResult(result) {
    if (!isPlainObject(result)) return result;
    // Patch config.features
    if (isPlainObject(result.config)) {
      if (!isPlainObject(result.config.features)) result.config.features = {};
      deepAssign(result.config.features, STATSIG_GATE_OVERRIDES);
      // Also merge forced desktop feature state
      deepAssign(result.config.features, FORCED_DESKTOP_FEATURE_STATE);
    }
    // Direct features object
    if (isPlainObject(result.features)) {
      deepAssign(result.features, STATSIG_GATE_OVERRIDES);
    }
    return result;
  }

  ipcMain.handle = function (channel, listener) {
    // ── Statsig shared-object channels: inject gate overrides ──
    if (isStatsigChannel(channel)) {
      _diag('ipc: wrapping Statsig channel (handle): ' + channel);
      return _origHandle(channel, function (_event, payload) {
        _diag('ipc: INVOKED Statsig channel (handle): ' + channel + ' payloadType=' + typeof payload);
        var result = listener(_event, payload);
        // Patch the payload before it's stored (shared-object-set)
        if (isPlainObject(payload)) {
          patchSharedObjectPayload(payload);
        }
        // Patch the result returned to the renderer
        var patched = patchSharedObjectPayload(result);
        return patched;
      });
    }

    // ── Config channels: inject feature flags ──
    if (isConfigChannel(channel)) {
      _diag('ipc: wrapping config channel: ' + channel);
      return _origHandle(channel, function (_event, payload) {
        var result = listener(_event, payload);
        var patched = patchConfigResult(result);
        _diag('ipc: patched config channel ' + channel + ' response');
        return patched;
      });
    }

    // ── IPC handlers that throw "not implemented" in Electron builds ──
    if (channel === 'show-settings' ||
        channel === 'open-extension-settings' ||
        channel === 'open-keyboard-shortcuts') {
      _diag('ipc: overriding ' + channel + ' handler');
      return _origHandle(channel, function (_event, payload) {
        try {
          var win = _event.sender ? _event.sender.getOwnerBrowserWindow() : null;
          if (win) {
            var routeMap = {
              'show-settings': '/settings',
              'open-extension-settings': '/settings/extensions',
              'open-keyboard-shortcuts': '/settings/keyboard-shortcuts',
            };
            var route = routeMap[channel] || '/settings';
            win.loadURL('codex://codex/' + route);
            return { success: true };
          }
        } catch (_e) { /* fall through to default */ }
        return listener(_event, payload);
      });
    }

    if (channel === 'open-config-toml') {
      _diag('ipc: overriding open-config-toml handler');
      return _origHandle(channel, function (_event, payload) {
        try {
          var path = require('path');
          var os = require('os');
          var cp = require('child_process');
          var configPath = (payload && payload.path)
            ? payload.path
            : path.join(os.homedir(), '.codex', 'config.toml');
          var cmd;
          if (process.platform === 'win32') {
            cmd = 'start "" "' + configPath + '"';
          } else if (process.platform === 'darwin') {
            cmd = 'open "' + configPath + '"';
          } else {
            cmd = 'xdg-open "' + configPath + '"';
          }
          cp.exec(cmd);
          return { success: true };
        } catch (_e) {
          return { success: false, error: _e.message };
        }
      });
    }

    // ── Default: pass-through ──
    return _origHandle(channel, listener);
  };

  // ═══════════════════════════════════════════════════════════════════════
  // Layer 3: ipcMain.on wrapping — Intercept event-based IPC
  // ═══════════════════════════════════════════════════════════════════════
  // Many Electron apps use ipcMain.on (send/on) rather than ipcMain.handle
  // (invoke/handle) for broadcast-style messages like shared-object updates.

  var _origOn = ipcMain.on.bind(ipcMain);

  ipcMain.on = function (channel, listener) {
    // ── Statsig shared-object channels ──
    if (isStatsigChannel(channel)) {
      _diag('ipc: wrapping Statsig channel (on): ' + channel);
      return _origOn(channel, function (_event, payload) {
        _diag('ipc: INVOKED Statsig channel (on): ' + channel + ' payloadType=' + typeof payload);
        if (isPlainObject(payload)) {
          patchSharedObjectPayload(payload);
        }
        // Intercept event.sender.send to catch the response data
        if (_event && _event.sender && typeof _event.sender.send === 'function') {
          var _origSend = _event.sender.send.bind(_event.sender);
          _event.sender.send = function (respChannel, respPayload) {
            if (isPlainObject(respPayload)) {
              _diag('ipc: intercepting event.sender.send(' + respChannel + ') keys=' + JSON.stringify(Object.keys(respPayload).slice(0, 10)));
              // Inject gate overrides into the snapshot response
              if (isPlainObject(respPayload.value) || isPlainObject(respPayload)) {
                var before = Object.keys(respPayload.value || respPayload).length;
                patchSharedObjectPayload(respPayload);
              }
            }
            return _origSend.call(_event.sender, respChannel, respPayload);
          };
        }
        listener(_event, payload);
      });
    }

    // ── Config channels ──
    if (isConfigChannel(channel)) {
      _diag('ipc: wrapping config channel (on): ' + channel);
      return _origOn(channel, function (_event, payload) {
        listener(_event, payload);
      });
    }

    // ── Default: pass-through ──
    return _origOn(channel, listener);
  };
})();
