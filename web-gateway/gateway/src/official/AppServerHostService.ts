// @ts-nocheck
export {};

const crypto = require("node:crypto");
const path = require("node:path");
const { fork } = require("node:child_process");

const RUNNER_PATH = path.join(__dirname, "appServerHostRunner.js");

export type AttachRendererHandle = {
  id: string;
  sendFrame(frame: any): void;
  close(): void;
};

/**
 * 管理托管 `app-server-host.js` 的 Node 子进程，并提供浏览器 Cap'n Web 端口接入句柄。
 */
class AppServerHostService {
  private options: {
    hostDir: string | null;
    codexBinaryPath: string | null;
    codexHome: string;
    workspaceDir: string;
    version: string;
    logger?: any;
  };
  private child: any = null;
  private readyPromise: Promise<string> | null = null;
  private readyGeneration = "1";
  private disposed = false;
  private renderers = new Map<
    string,
    { hostId: string; generation: string; onFrame: (frame: any) => void; onClose: () => void }
  >();

  constructor(options: {
    hostDir: string | null;
    codexBinaryPath?: string | null;
    codexHome: string;
    workspaceDir: string;
    version?: string;
    logger?: any;
  }) {
    this.options = {
      hostDir: options.hostDir || null,
      codexBinaryPath: options.codexBinaryPath || null,
      codexHome: options.codexHome,
      workspaceDir: options.workspaceDir,
      version: options.version || "26.1120.0",
      logger: options.logger,
    };
  }

  isAvailable(): boolean {
    return Boolean(this.options.hostDir);
  }

  getGeneration(): string {
    return this.readyGeneration;
  }

  ensureReady(): Promise<string> {
    if (this.disposed) {
      return Promise.reject(new Error("AppServerHostService has been disposed"));
    }
    if (!this.options.hostDir) {
      return Promise.reject(new Error("Official bundle does not include app-server-host.js"));
    }
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<string>((resolve, reject) => {
      let settled = false;
      const child = fork(RUNNER_PATH, [], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: {
          ...process.env,
          CODEX_HOME: this.options.codexHome,
        },
      });
      this.child = child;

      if (child.stdout) {
        child.stdout.on("data", (chunk: Buffer) => {
          const text = String(chunk).trim();
          if (text && process.env.CODEX_WEB_DEBUG === "1") {
            console.log(`[app-server-host] ${text}`);
          }
        });
      }
      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          const text = String(chunk).trim();
          if (text) {
            console.warn(`[app-server-host:err] ${text}`);
          }
        });
      }

      const failAndReset = (err: Error) => {
        if (this.child === child) {
          this.child = null;
          this.readyPromise = null;
        }
        for (const [id, entry] of this.renderers.entries()) {
          this.renderers.delete(id);
          try {
            entry.onClose();
          } catch {}
        }
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      child.on("message", (msg: any) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "ready") {
          this.readyGeneration = String(msg.generation || "1");
          if (!settled) {
            settled = true;
            resolve(this.readyGeneration);
          }
          return;
        }
        if (msg.type === "init-error") {
          failAndReset(new Error(String(msg.error || "app-server-host init failed")));
          return;
        }
        if (msg.type === "renderer-message" && msg.id) {
          const entry = this.renderers.get(String(msg.id));
          if (entry) entry.onFrame(msg.frame);
          return;
        }
        if (msg.type === "renderer-closed" && msg.id) {
          const id = String(msg.id);
          const entry = this.renderers.get(id);
          if (entry) {
            this.renderers.delete(id);
            entry.onClose();
          }
        }
      });

      child.once("exit", (code: number | null, signal: string | null) => {
        failAndReset(new Error(`app-server-host runner exited (code=${code}, signal=${signal})`));
      });

      child.once("error", (error: Error) => {
        failAndReset(error);
      });

      child.send({
        type: "init",
        hostDir: this.options.hostDir,
        codexBinaryPath: this.options.codexBinaryPath,
        codexHome: this.options.codexHome,
        workspaceDir: this.options.workspaceDir,
        version: this.options.version,
      });
    });

    return this.readyPromise;
  }

  async attachRenderer({
    hostId = "local",
    generation,
    onFrame,
    onClose,
  }: {
    hostId?: string;
    generation?: string;
    onFrame: (frame: any) => void;
    onClose: () => void;
  }): Promise<AttachRendererHandle> {
    const activeGen = await this.ensureReady();
    if (!this.child) {
      throw new Error("AppServerHostService child is unavailable");
    }
    const id = crypto.randomUUID();
    const resolvedGeneration = String(generation || activeGen);
    this.renderers.set(id, { hostId, generation: resolvedGeneration, onFrame, onClose });
    this.child.send({
      type: "attach-renderer",
      id,
      hostId,
      generation: resolvedGeneration,
    });

    return {
      id,
      sendFrame: (frame: any) => {
        if (!this.child || !this.renderers.has(id)) return;
        this.child.send({
          type: "renderer-message",
          id,
          frame,
        });
      },
      close: () => {
        if (!this.renderers.has(id)) return;
        this.renderers.delete(id);
        if (this.child && this.child.connected) {
          try {
            this.child.send({
              type: "revoke-renderer",
              id,
              hostId,
              generation: resolvedGeneration,
            });
          } catch {}
        }
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const [id, entry] of this.renderers.entries()) {
      this.renderers.delete(id);
      try {
        entry.onClose();
      } catch {}
    }
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
    this.readyPromise = null;
  }
}

module.exports = { AppServerHostService };
