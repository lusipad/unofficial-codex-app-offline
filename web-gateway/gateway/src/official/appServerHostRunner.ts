// @ts-nocheck
export {};

/**
 * 独立 Node 子进程：托管 26.1120+ 上游 `.vite/build/app-server-host.js`。
 *
 * app-server-host.js 原本作为 Electron utilityProcess 运行，这里通过极薄的 Node 适配层
 * 提供所需的 electron.net.isOnline、process.parentPort 生命周期消息及 Cap'n Web
 * bootstrap/open-connection/admit 宿主服务，并把浏览器的 Cap'n Web 端口直通到 renderer 会话。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const cp = require("node:child_process");
const { EventEmitter } = require("node:events");
const { Transform } = require("node:stream");

const {
  RpcTarget,
  createElectronPortPair,
  encodeCapnwebFrame,
  decodeCapnwebFrame,
  createStructuredCapnwebSession,
} = require("./capnwebLite");
const {
  sanitizeCodexAppMcpConfig,
} = require("../ipc/codex/capabilityContractData.cjs");
const { patchModelListResult } = require("../ipc/codex/modelCatalogCompat.cjs");
const {
  patchCodexConfigResult,
  patchExperimentalFeatureListResult,
} = require("../ipc/codex/featurePatches");

const HOST_ID = "local";
const HOST_GENERATION = "1";

function sendToParent(payload: any) {
  if (typeof process.send === "function") {
    try {
      process.send(payload);
    } catch {}
  }
}

function logWarn(...args: any[]) {
  console.warn("[app-server-host-runner]", ...args);
}

/**
 * Hook child_process.spawn so codex app-server stdio shares the offline Gateway compatibility contracts
 * (MCP codex_app sanitization on stdin; model/list, config/read, experimentalFeature/list patching on stdout).
 */
function installAppServerStdioHook() {
  const origSpawn = cp.spawn;
  const CONFIG_OVERRIDE_METHODS = new Set(["thread/start", "thread/resume", "thread/fork", "turn/start"]);

  cp.spawn = function patchedSpawn(command: string, args?: readonly string[], options?: any) {
    const child = origSpawn.apply(this, arguments as any);
    const argList = Array.isArray(args) ? args : [];
    const looksLikeAppServer = argList.includes("app-server") && !argList.includes("version");
    if (!looksLikeAppServer || !child || !child.stdin || !child.stdout) {
      return child;
    }

    const pendingMethodsById = new Map<string | number, string>();

    function transformOutgoingLine(line: string): string {
      if (!line || line.charCodeAt(0) !== 123) return line;
      try {
        const msg = JSON.parse(line);
        if (!msg || typeof msg !== "object") return line;
        if (msg.id !== undefined && msg.id !== null && typeof msg.method === "string") {
          pendingMethodsById.set(msg.id, msg.method);
        }
        if (
          typeof msg.method === "string" &&
          CONFIG_OVERRIDE_METHODS.has(msg.method) &&
          msg.params &&
          typeof msg.params === "object" &&
          msg.params.config
        ) {
          const sanitized = sanitizeCodexAppMcpConfig(msg.params.config);
          if (sanitized !== msg.params.config) {
            msg.params.config = sanitized;
            return JSON.stringify(msg);
          }
        }
      } catch {}
      return line;
    }

    function transformIncomingLine(line: string): string {
      if (!line || line.charCodeAt(0) !== 123) return line;
      try {
        const msg = JSON.parse(line);
        if (!msg || typeof msg !== "object" || msg.id === undefined || msg.id === null) return line;
        const method = pendingMethodsById.get(msg.id);
        if (!method) return line;
        pendingMethodsById.delete(msg.id);
        if (msg.error || !Object.prototype.hasOwnProperty.call(msg, "result")) return line;

        let nextResult = msg.result;
        if (method === "model/list") {
          nextResult = patchModelListResult(nextResult);
        } else if (method === "experimentalFeature/list") {
          nextResult = patchExperimentalFeatureListResult(nextResult);
        } else if (method === "config/read") {
          nextResult = patchCodexConfigResult(nextResult);
        }
        if (nextResult !== msg.result) {
          msg.result = nextResult;
          return JSON.stringify(msg);
        }
      } catch {}
      return line;
    }

    // Wrap stdin.write
    const stdin = child.stdin;
    const origWrite = stdin.write.bind(stdin);
    const origEnd = stdin.end.bind(stdin);
    let stdinBuffer = "";

    stdin.write = function (chunk: any, encoding?: any, cb?: any) {
      if (typeof encoding === "function") {
        cb = encoding;
        encoding = undefined;
      }
      const isBuffer = Buffer.isBuffer(chunk);
      const text = typeof chunk === "string" ? chunk : isBuffer ? chunk.toString(encoding || "utf8") : null;
      if (text === null) return origWrite(chunk, encoding, cb);

      stdinBuffer += text;
      const lastNl = stdinBuffer.lastIndexOf("\n");
      if (lastNl === -1) {
        if (typeof cb === "function") cb();
        return true;
      }
      const complete = stdinBuffer.slice(0, lastNl);
      stdinBuffer = stdinBuffer.slice(lastNl + 1);
      const lines = complete.split("\n").map((rawLine) => {
        const hasCr = rawLine.endsWith("\r");
        const clean = hasCr ? rawLine.slice(0, -1) : rawLine;
        const out = transformOutgoingLine(clean);
        return hasCr ? `${out}\r` : out;
      });
      const outText = `${lines.join("\n")}\n`;
      return origWrite(isBuffer ? Buffer.from(outText, "utf8") : outText, isBuffer ? undefined : (encoding || "utf8"), cb);
    };

    stdin.end = function (chunk?: any, encoding?: any, cb?: any) {
      if (typeof encoding === "function") {
        cb = encoding;
        encoding = undefined;
      }
      if (chunk) stdin.write(chunk, encoding);
      if (stdinBuffer.length > 0) {
        const flushed = transformOutgoingLine(stdinBuffer);
        stdinBuffer = "";
        origWrite(flushed, "utf8");
      }
      return origEnd(cb);
    };

    // Wrap stdout through a line Transform so readline / data listeners see normalized JSON-RPC responses
    const origStdout = child.stdout;
    let stdoutBuffer = "";
    const lineTransform = new Transform({
      transform(chunk, _enc, callback) {
        stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        const lastNl = stdoutBuffer.lastIndexOf("\n");
        if (lastNl === -1) {
          callback();
          return;
        }
        const complete = stdoutBuffer.slice(0, lastNl);
        stdoutBuffer = stdoutBuffer.slice(lastNl + 1);
        const lines = complete.split("\n").map((rawLine) => {
          const hasCr = rawLine.endsWith("\r");
          const clean = hasCr ? rawLine.slice(0, -1) : rawLine;
          const out = transformIncomingLine(clean);
          return hasCr ? `${out}\r` : out;
        });
        callback(null, `${lines.join("\n")}\n`);
      },
      flush(callback) {
        if (stdoutBuffer.length > 0) {
          const flushed = transformIncomingLine(stdoutBuffer);
          stdoutBuffer = "";
          this.push(flushed);
        }
        callback();
      },
    });
    origStdout.pipe(lineTransform);
    Object.defineProperty(child, "stdout", {
      value: lineTransform,
      configurable: true,
      enumerable: true,
    });
    if (Array.isArray(child.stdio)) {
      child.stdio[1] = lineTransform;
    }

    return child;
  };
}

class DisposableLease extends RpcTarget {
  private onDispose?: () => void;
  constructor(onDispose?: () => void) {
    super();
    this.onDispose = onDispose;
  }
  [Symbol.dispose]() {
    this.onDispose?.();
  }
}

class LockLease extends RpcTarget {
  private released = false;
  release(_sent = false) {
    this.released = true;
  }
  [Symbol.dispose]() {
    this.release(false);
  }
}

class BootstrapHostTarget extends RpcTarget {
  private hostDir: string;
  private version: string;
  constructor(hostDir: string, version: string) {
    super();
    this.hostDir = hostDir;
    this.version = version;
  }
  bootstrap() {
    return {
      sentry: {
        codexAppSessionId: crypto.randomUUID(),
        buildFlavor: "prod",
        desktopTraceSampleRate: 0,
      },
      framesRoot: this.hostDir,
      spawnInsideWsl: false,
      windowsCoreRuntimeRoot: null,
      version: this.version,
    };
  }
  desktopDatabase() {
    return null;
  }
  async isAnalyticsEnabled() {
    return false;
  }
  async exportTraces() {}
  async sendEnvelope() {
    return { statusCode: 403, headers: {} };
  }
  async updateSampleRate() {}
  async updateUser() {}
  async updateEnvironment() {}
}

class TransportServiceTarget extends RpcTarget {
  ensureAuthHost() {}
  getProductSku() {
    return "unknown";
  }
  cancelCalls() {}
  [Symbol.dispose]() {}
}

class DesktopConnectionHost extends RpcTarget {
  private hostDir: string;
  private codexBinaryPath: string | null;
  private workspaceDir: string;
  private version: string;
  private transport = new TransportServiceTarget();
  public latestConnectionSnapshot: any = null;

  constructor(opts: { hostDir: string; codexBinaryPath: string | null; workspaceDir: string; version: string }) {
    super();
    this.hostDir = opts.hostDir;
    this.codexBinaryPath = opts.codexBinaryPath;
    this.workspaceDir = opts.workspaceDir;
    this.version = opts.version;
  }

  configuration() {
    return {
      hostId: HOST_ID,
      hostConfig: {
        id: HOST_ID,
        display_name: "Local",
        kind: "local",
        codex_cli_command: this.codexBinaryPath
          ? [this.codexBinaryPath, "app-server", "--listen", "stdio://"]
          : undefined,
      },
      nodeNetworkAllowed: true,
      clientInfo: {
        name: "codex_desktop",
        title: "Codex Desktop",
        version: this.version || "26.1120.0",
      },
      buildFlavor: "prod",
      defaultServiceName: "codex",
      ensureAuth: false,
      repoRoot: this.workspaceDir,
      resourcesPath: this.hostDir,
      supportsOpenAIFormElicitation: false,
      continueWaitingForStdioInitializeTimeout: true,
      observeBrowserMessages: false,
      supportsAttestationRequests: false,
      isMcpAppsDilEnabled: false,
    };
  }

  openTransport() {
    return this.transport;
  }
  recorder() {
    return null;
  }
  recorderStatus() {
    return null;
  }
  async stdioLaunchSettings() {
    return { overrides: [], windowsFrameworkRoot: null };
  }
  setDesktopServerRequestMethods() {}
  prepareRequest(req: any) {
    return req?.params;
  }
  async handleServerRequest() {
    return { handled: false };
  }
  connectionState(snapshot: any) {
    this.latestConnectionSnapshot = snapshot;
  }
  accountBoundary() {}
  principalChanged() {}
  invalidateSignal() {}
  tokenChanged() {}
  pendingAccountChange() {}
  observeVerification() {}
  observeBrowserMessage() {}
  windowMessage() {}
  async prepareLogout() {}
  automationMigrationInProgress() {
    return false;
  }
  deleteAutomation() {
    return "store_unavailable";
  }
  async scheduleArchive() {}
  async pauseArchive() {}
  chronicleChanged() {}
  utilityTraffic() {}
  remoteControlChanged() {}
  titleChanged() {}
  automationCapability() {}
  automationTriggered() {}
  lateAutomationStart() {}
  tokenUnavailable() {}
  finishArchiveUndo() {}
  readPrewarmPolicy() {
    return "legacy";
  }
  readStartFeatures() {
    return {};
  }
  readResumeFeatures() {
    return undefined;
  }
  async readSshAutomationContext() {
    return null;
  }
  async listTools() {
    return { data: [] };
  }
  async callTool() {
    return null;
  }
  finishCall() {}
  async ensureAuthHost() {}
  async ensureWslCodexVersion() {
    return null;
  }
  async websocketHandshake() {
    throw new Error("Websocket handshake unavailable");
  }
  async getDurableToken() {
    throw new Error("Durable token unavailable");
  }
  getProductSku() {
    return "unknown";
  }
  async fetchHttp() {
    throw new Error("HTTP unavailable");
  }
  async sshSettings() {
    return { timeout: 15, locale: "en-US", localesPath: "" };
  }
  async loadShell() {
    return null;
  }
  async readOverrides() {
    return [];
  }
}

class HostStateTarget extends RpcTarget {
  private workspaceDir: string;
  constructor(workspaceDir: string) {
    super();
    this.workspaceDir = workspaceDir;
  }
  open() {
    return {
      state: {
        admitted: true,
        ready: true,
        daybreak: false,
        queue: true,
        permissionSelection: undefined,
        titles: undefined,
      },
      lease: new DisposableLease(),
      hasCatalog: false,
      workspaceDir: this.workspaceDir,
    };
  }
  logoutWithoutServer() {}
  async removeCatalogThread() {}
  subscribeCatalog() {
    return new DisposableLease();
  }
}

class ReadStateTarget extends RpcTarget {
  open() {
    return {
      unread: [],
      lease: new DisposableLease(),
    };
  }
  set() {}
}

class StorageTarget extends RpcTarget {
  private atoms = new Map<string, any>();
  private globalState = new Map<string, any>();
  private queue: any = null;

  open() {
    return {
      snapshot: {
        atoms: Array.from(this.atoms.entries()),
        queue: this.queue,
      },
      lease: new DisposableLease(),
    };
  }
  writeAtom(key: string, value: any) {
    if (value === undefined) this.atoms.delete(key);
    else this.atoms.set(key, value);
  }
  readGlobal(key: string) {
    return this.globalState.has(key) ? this.globalState.get(key) : null;
  }
  async commitGlobal(key: string, _expected: any, next: any) {
    this.globalState.set(key, next);
    return { status: "committed" };
  }
  async commitQueue(_expected: any, next: any) {
    this.queue = next;
    return { status: "committed" };
  }
}

function createSettingsOperations() {
  return {
    readCatalogEntry: () => null,
    readSettings: async () => ({
      defaultFeatureOverrides: {},
      defaultPersonality: "friendly",
      instructionOverrides: null,
      includeProseDetailLevelInstructions: false,
      writingBlocks: false,
    }),
    fetchProxyConfig: async () => null,
    readCodexConfig: async () => ({}),
    readFollowUpQueueMode: async () => "send-now",
    readPermissionRefreshEnabled: async () => false,
    hasReadyExecutionAssignments: async () => true,
    readExperimentPersonality: async () => "friendly",
  };
}

function createSettingsOpenResult() {
  return {
    policy: {
      boundedCloudHistory: false,
      timeline: false,
      consumeCatalog: false,
      featureOverrides: {},
      sidebarSections: true,
      serverSections: false,
    },
    isBrowserRuntime: true,
    usesDesktopMcp: false,
    allowMemoryPromptOverrides: false,
    history: {
      useTailHydration: false,
      paginatedHistoryEnabled: true,
      originators: [],
    },
    operations: createSettingsOperations(),
    lease: new DisposableLease(),
    [Symbol.dispose]() {},
  };
}

class SettingsTarget extends RpcTarget {
  open() {
    return createSettingsOpenResult();
  }
}

class FilesystemServiceTarget extends RpcTarget {
  private codexHome: string;
  private workspaceDir: string;
  constructor(codexHome: string, workspaceDir: string) {
    super();
    this.codexHome = codexHome;
    this.workspaceDir = workspaceDir;
  }
  open() {
    const codexHome = this.codexHome;
    const workspaceDir = this.workspaceDir;
    return new (class extends RpcTarget {
      getCodexHome() {
        return codexHome;
      }
      readCodexHome() {
        return codexHome;
      }
      readWorkspacesRoot() {
        return workspaceDir;
      }
      ensureDirectory(dirPath: string) {
        if (dirPath) fs.mkdirSync(dirPath, { recursive: true });
        return null;
      }
      async readLocalFile(filePath: string) {
        return fs.promises.readFile(filePath);
      }
      async readLocalFileSize(filePath: string) {
        return (await fs.promises.stat(filePath)).size;
      }
      async uploadLocalFile() {
        return null;
      }
      async readGitOrigins() {
        return [];
      }
      async createProjectlessThreadWorkspace() {
        return workspaceDir;
      }
      async getManagedWorktreeRoots() {
        return [];
      }
      async getConfiguredWorktreeRoot() {
        return null;
      }
      [Symbol.dispose]() {}
    })();
  }
}

class ThreadsServiceTarget extends RpcTarget {
  open() {
    return new (class extends RpcTarget {
      assignments = new (class extends RpcTarget {
        private memberships = new Map<string, any>();
        readMemberships() {
          return Object.fromEntries(this.memberships.entries());
        }
        getThreadStartProjectId() {
          return null;
        }
        setAssignment() {}
        updateProjectlessThread() {}
        setProjectless() {}
        setMembership(threadId: string, membership: any) {
          this.memberships.set(threadId, membership);
        }
        restoreMemberships() {}
      })();
      pins = new (class extends RpcTarget {
        list() {
          return [];
        }
        set() {}
        listSections() {
          return [];
        }
        listSectionThreadIds() {
          return [];
        }
        createSection() {
          return null;
        }
        updateSection() {}
        deleteSection() {}
        setThreadSection() {}
      })();
      pendingArchives = new (class extends RpcTarget {
        add() {}
        remove() {}
      })();
      inactiveArchive = new (class extends RpcTarget {
        async archiveInactiveThread() {}
        async removeMissingEntry() {
          return false;
        }
      })();
      async deleteArchivedThreads() {
        return [];
      }
      async applySectionCommand() {}
      async startLoginForward() {}
      async stopLoginForward() {}
      async readWorktreePreference() {
        return null;
      }
      [Symbol.dispose]() {}
    })();
  }
}

class PreparationTarget extends RpcTarget {
  bind() {}
  async prepareTurn(_hostId: string, turn: any) {
    return turn;
  }
  async prepareSession() {
    return {};
  }
  async captureGit() {
    return { result: null };
  }
}

class ExecutionTarget extends RpcTarget {
  open() {
    return new (class extends RpcTarget {
      executeOwned = undefined;
      forkCloudThread = undefined;
      voice = undefined;
      execute = undefined;
      savePreview = undefined;
      browser = undefined;
      async archiveRun() {}
      [Symbol.dispose]() {}
    })();
  }
}

class LocksTarget extends RpcTarget {
  acquireStart() {
    return new LockLease();
  }
  acquireSend() {
    return new LockLease();
  }
}

class AdmitHostTarget extends RpcTarget {
  private subServices: any;
  constructor(opts: { codexHome: string; workspaceDir: string }) {
    super();
    this.subServices = {
      hostState: new HostStateTarget(opts.workspaceDir),
      readState: new ReadStateTarget(),
      storage: new StorageTarget(),
      settings: new SettingsTarget(),
      filesystem: new FilesystemServiceTarget(opts.codexHome, opts.workspaceDir),
      threads: new ThreadsServiceTarget(),
      preparation: new PreparationTarget(),
      execution: new ExecutionTarget(),
      locks: new LocksTarget(),
    };
  }

  open(token: { hostId: string; generation: string }) {
    if (!token || token.hostId !== HOST_ID || String(token.generation) !== HOST_GENERATION) {
      throw new Error("Hosted manager generation changed");
    }
    return this.subServices;
  }
}

let bootPromise: Promise<void> | null = null;
const rendererPorts = new Map<string, any>();

async function startHostRuntime(config: {
  hostDir: string;
  codexBinaryPath?: string | null;
  codexHome: string;
  workspaceDir: string;
  version?: string;
}) {
  const hostEntry = path.join(config.hostDir, "app-server-host.js");
  if (!fs.existsSync(hostEntry)) {
    throw new Error(`Missing app-server-host.js in ${config.hostDir}`);
  }

  // 1. Provide electron mock (app-server-host only reads electron.net.isOnline())
  // and resolve dependencies like `tslib` from web-gateway/node_modules when hostDir sits in cache/temp.
  const origLoad = (Module as any)._load;
  (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
    if (request === "electron") {
      return {
        net: {
          isOnline: () => true,
        },
      };
    }
    try {
      return origLoad.apply(this, arguments);
    } catch (error: any) {
      if (
        error?.code === "MODULE_NOT_FOUND" &&
        typeof request === "string" &&
        !request.startsWith(".") &&
        !path.isAbsolute(request) &&
        request !== "better-sqlite3"
      ) {
        return origLoad.call(Module, require.resolve(request), parent, isMain);
      }
      throw error;
    }
  };

  // 2. Hook codex app-server stdio for offline compatibility contracts
  installAppServerStdioHook();

  // 3. Install process.parentPort shim matching Electron UtilityProcess
  const parentPort: any = new EventEmitter();
  parentPort.postMessage = (message: any) => {
    if (message && message.type === "renderer-closed" && message.id) {
      const port = rendererPorts.get(message.id);
      rendererPorts.delete(message.id);
      try {
        port?.close();
      } catch {}
    }
    sendToParent({ type: "host-parent-message", message });
  };
  Object.defineProperty(process, "parentPort", {
    value: parentPort,
    configurable: true,
    enumerable: true,
  });

  // 4. Load upstream utility bundle
  require(hostEntry);

  const deliverToParentPort = (data: any, ports: any[] = []) => {
    parentPort.emit("message", { data, ports });
  };

  // 5. Handshake 1: bootstrap
  const bootstrapPair = createElectronPortPair();
  const bootstrapSession = createStructuredCapnwebSession(
    bootstrapPair.port1,
    new BootstrapHostTarget(config.hostDir, config.version || "26.1120.0")
  );
  deliverToParentPort({ type: "bootstrap" }, [bootstrapPair.port2]);

  // 6. Handshake 2: open-connection (spawns & maintains codex app-server stdio)
  const connHost = new DesktopConnectionHost({
    hostDir: config.hostDir,
    codexBinaryPath: config.codexBinaryPath || null,
    workspaceDir: config.workspaceDir,
    version: config.version || "26.1120.0",
  });
  const connPair = createElectronPortPair();
  const connSession = createStructuredCapnwebSession(connPair.port1, connHost);
  deliverToParentPort({ type: "open-connection", hostId: HOST_ID }, [connPair.port2]);
  const connHandle = await connSession.remoteMain.open("codex_desktop:message-for-view", {
    kind: "stdio",
    options: { isPackaged: false },
  });

  // 7. Query live connection auth state so u1.admit(context) identity check passes verbatim
  const ops = await connHandle.openOperations();
  const authMethod = (await ops.getAuthMethod()) ?? "none";
  const principal = authMethod === "chatgpt" ? await ops.getAuthenticatedPrincipal() : null;
  const identity =
    authMethod === "chatgpt" && principal?.accountId && principal?.userId
      ? { kind: "chatgpt", accountId: principal.accountId, userId: principal.userId }
      : { kind: "other", authMode: authMethod };

  // 8. Handshake 3: admit
  const token = { hostId: HOST_ID, generation: HOST_GENERATION };
  const admitPair = createElectronPortPair();
  const admitSession = createStructuredCapnwebSession(
    admitPair.port1,
    new AdmitHostTarget({
      codexHome: config.codexHome,
      workspaceDir: config.workspaceDir,
    })
  );
  deliverToParentPort({ type: "admit", token }, [admitPair.port2]);
  const admitHandle = await admitSession.remoteMain.initialize({ identity });

  // Keep references alive for process lifetime
  void bootstrapSession;
  void connSession;
  void connHandle;
  void ops;
  void admitSession;
  void admitHandle;

  sendToParent({ type: "ready", generation: HOST_GENERATION });
}

process.on("disconnect", () => {
  process.exit(0);
});

process.on("message", (msg: any) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "init") {
    if (!bootPromise) {
      bootPromise = startHostRuntime(msg).catch((error) => {
        logWarn("Failed to start app-server-host runtime:", error);
        sendToParent({
          type: "init-error",
          error: error instanceof Error ? error.stack || error.message : String(error),
        });
        setTimeout(() => process.exit(1), 20);
      });
    }
    return;
  }

  if (msg.type === "attach-renderer" && msg.id) {
    const id = String(msg.id);
    const generation = String(msg.generation || HOST_GENERATION);
    const hostId = String(msg.hostId || HOST_ID);
    const { port1, port2 } = createElectronPortPair();
    rendererPorts.set(id, port1);
    port1.start();
    port1.on("message", (ev: { data: any }) => {
      if (ev?.data === null) {
        sendToParent({ type: "renderer-closed", id });
        return;
      }
      sendToParent({
        type: "renderer-message",
        id,
        frame: encodeCapnwebFrame(ev.data),
      });
    });
    port1.once("close", () => {
      if (rendererPorts.get(id) === port1) {
        rendererPorts.delete(id);
      }
      sendToParent({ type: "renderer-closed", id });
    });
    (process.parentPort as any).emit("message", {
      data: {
        type: "renderer",
        token: { hostId, generation },
        id,
      },
      ports: [port2],
    });
    return;
  }

  if (msg.type === "renderer-message" && msg.id) {
    const port1 = rendererPorts.get(String(msg.id));
    if (!port1) return;
    try {
      port1.postMessage(decodeCapnwebFrame(msg.frame));
    } catch (error) {
      logWarn(`Failed to decode renderer frame for ${msg.id}:`, error);
    }
    return;
  }

  if (msg.type === "revoke-renderer" && msg.id) {
    const id = String(msg.id);
    const generation = String(msg.generation || HOST_GENERATION);
    const hostId = String(msg.hostId || HOST_ID);
    const port1 = rendererPorts.get(id);
    rendererPorts.delete(id);
    try {
      port1?.close();
    } catch {}
    try {
      (process.parentPort as any)?.emit("message", {
        data: {
          type: "revoke",
          token: { hostId, generation },
          id,
        },
        ports: [],
      });
    } catch {}
  }
});

// If launched via env config directly (optional standalone debugging)
if (require.main === module && process.env.CODEX_APP_SERVER_HOST_DIR && !bootPromise) {
  bootPromise = startHostRuntime({
    hostDir: process.env.CODEX_APP_SERVER_HOST_DIR,
    codexBinaryPath: process.env.CODEX_BINARY_PATH || null,
    codexHome: process.env.CODEX_HOME || path.join(require("node:os").homedir(), ".codex"),
    workspaceDir: process.env.CODEX_WORKSPACE_DIR || process.cwd(),
    version: process.env.CODEX_APP_VERSION || "26.1120.0",
  }).catch((error) => {
    logWarn("Standalone start failed:", error);
    process.exitCode = 1;
  });
}

module.exports = {
  SettingsTarget,
  createSettingsOpenResult,
  PreparationTarget,
  ThreadsServiceTarget,
};
