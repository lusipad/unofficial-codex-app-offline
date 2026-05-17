import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const internalRoot = path.resolve(webRoot, "..");
const packageRoot = path.resolve(internalRoot, "..");
const appRoot = path.join(internalRoot, "app");
const appAsarPath = path.join(appRoot, "resources", "app.asar");
const codexExePath = path.join(appRoot, process.platform === "win32" ? "Codex.exe" : "Codex");
const codexAppServerPath = path.join(
  appRoot,
  "resources",
  process.platform === "win32" ? "codex.exe" : "codex",
);
const serverPath = path.join(webRoot, "gateway", "dist", "server.js");
const bundleCacheDir = path.join(webRoot, "cache", "official-bundle");

const host = process.env.HOST || "127.0.0.1";
const port = process.env.PORT || "3737";
const publicUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;

function fail(message) {
  console.error(`[codex-web] ${message}`);
  process.exit(1);
}

function requireFile(filePath, label) {
  if (!existsSync(filePath)) {
    fail(`${label} was not found: ${filePath}`);
  }
}

function quoteShellArg(value) {
  if (process.platform === "win32") {
    return `"${String(value).replace(/"/g, '""')}"`;
  }
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function openBrowser(url) {
  const command =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function waitForHealth(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = new URL("/api/health", url);

  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(healthUrl, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        retry();
      });
      req.on("error", retry);
      req.setTimeout(1_000, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`gateway did not become healthy within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 500);
    };

    tick();
  });
}

requireFile(appAsarPath, "Codex app.asar");
requireFile(codexExePath, "Codex executable");
requireFile(codexAppServerPath, "Codex app-server executable");
requireFile(serverPath, "Codex web gateway");

if ((host === "0.0.0.0" || host === "::") && !process.env.CODEX_WEB_PASSWORD) {
  fail("CODEX_WEB_PASSWORD is required when HOST listens beyond localhost.");
}

const env = {
  ...process.env,
  HOST: host,
  PORT: port,
  CODEX_DESKTOP_APP_PATH: process.env.CODEX_DESKTOP_APP_PATH || appRoot,
  CODEX_APP_SERVER_CMD:
    process.env.CODEX_APP_SERVER_CMD ||
    `${quoteShellArg(codexAppServerPath)} app-server --listen stdio://`,
  CODEX_WEB_OFFICIAL_BUNDLE_DIR:
    process.env.CODEX_WEB_OFFICIAL_BUNDLE_DIR || bundleCacheDir,
  CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE:
    process.env.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE || "1",
};

console.log(`[codex-web] starting gateway at ${publicUrl}`);
const server = spawn(process.execPath, [serverPath], {
  cwd: webRoot,
  env,
  stdio: "inherit",
});

let opened = false;
waitForHealth(publicUrl)
  .then(() => {
    if (opened) return;
    opened = true;
    console.log(`[codex-web] opening ${publicUrl}`);
    openBrowser(publicUrl);
  })
  .catch((error) => {
    console.warn(`[codex-web] ${error.message}`);
  });

server.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code || 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.kill(signal);
  });
}
