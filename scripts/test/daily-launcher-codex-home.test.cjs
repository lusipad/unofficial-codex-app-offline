"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const buildScript = fs.readFileSync(
  path.join(repoRoot, "scripts", "build-offline-package.ps1"),
  "utf8",
);

// Evaluate the launcher definitions with PowerShell itself: the arrays share
// the CODEX_HOME import lines through `+`, so parsing them by hand would test
// a copy instead of what the build writes.
function launcherLines() {
  const start = buildScript.indexOf("$codexHomeImportCalls = @(");
  const end = buildScript.indexOf("$syncDefaultCmd = @(", start);
  assert.notEqual(start, -1, "shared CODEX_HOME import is missing");
  assert.notEqual(end, -1, "launcher block terminator is missing");
  const definitions = buildScript
    .slice(start, end)
    .split(/\r?\n/)
    .filter(line => !/Set-Content|New-Item|^\$toolsRoot\s*=/.test(line))
    .join("\n");
  const json = execFileSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", "-"],
    {
      input:
        definitions +
        "\n@{daily=$dailyLaunchCmd;web=$webLaunchCmd;direct=$launchDirectCmd} | ConvertTo-Json -Compress\n",
      encoding: "utf8",
    },
  );
  return JSON.parse(json);
}

const LAUNCHERS = {
  daily: { file: "Codex.cmd", target: "app" },
  direct: { file: path.join("_internal", "tools", "Launch Codex Direct.cmd"), target: "app" },
  web: { file: "Codex Web.cmd", target: "web" },
};

// Build a throwaway package whose app is node.exe renamed to ChatGPT.exe and
// whose web entry is a probe script, so each launcher records the CODEX_HOME
// the desktop app or the web gateway would receive.
function launchAndReadCodexHome(kind, { rootEnv, internalEnv, inheritedCodexHome } = {}) {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex launcher "));
  try {
    const probeOut = path.join(packageRoot, "probe.txt");
    const probeSource =
      `require("fs").writeFileSync(${JSON.stringify(probeOut)}, process.env.CODEX_HOME ?? "<unset>")`;
    const appDir = path.join(packageRoot, "_internal", "app");
    const webDir = path.join(packageRoot, "_internal", "web");
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(webDir, { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "_internal", "tools"), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(appDir, "ChatGPT.exe"));
    fs.writeFileSync(path.join(webDir, "start-web.mjs"), probeSource.replace("require(\"fs\")", "(await import(\"node:fs\"))"));
    const appProbe = path.join(packageRoot, "probe.js");
    fs.writeFileSync(appProbe, probeSource);

    const launcher = path.join(packageRoot, LAUNCHERS[kind].file);
    fs.writeFileSync(launcher, launcherLines()[kind].join("\r\n") + "\r\n", "ascii");
    if (rootEnv != null) {
      fs.writeFileSync(path.join(packageRoot, "skill-installer.env"), rootEnv);
    }
    if (internalEnv != null) {
      fs.writeFileSync(path.join(packageRoot, "_internal", "skill-installer.env"), internalEnv);
    }

    const env = { ...process.env };
    delete env.CODEX_HOME;
    if (inheritedCodexHome != null) env.CODEX_HOME = inheritedCodexHome;
    const args = LAUNCHERS[kind].target === "app" ? [appProbe] : [];
    execFileSync("cmd.exe", ["/d", "/c", "call", launcher, ...args], { env, stdio: "ignore" });

    const deadline = Date.now() + 15000;
    while (!fs.existsSync(probeOut)) {
      if (Date.now() > deadline) throw new Error(`${kind} launcher probe did not run`);
      execFileSync(process.execPath, ["-e", "setTimeout(()=>{},100)"]);
    }
    return { packageRoot, codexHome: fs.readFileSync(probeOut, "utf8") };
  } catch (error) {
    fs.rmSync(packageRoot, { recursive: true, force: true });
    throw error;
  }
}

function withLaunch(kind, options, check) {
  const { packageRoot, codexHome } = launchAndReadCodexHome(kind, options);
  try {
    check(codexHome, packageRoot);
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
}

const windowsOnly = { skip: process.platform !== "win32" && "cmd launchers are Windows-only" };

for (const kind of Object.keys(LAUNCHERS)) {
  const name = LAUNCHERS[kind].file;

  test(`${name} passes CODEX_HOME from the package-root skill-installer.env`, windowsOnly, () => {
    const target = path.join(os.tmpdir(), "codex home from env");
    withLaunch(kind, {
      rootEnv: `# comment\r\nGITHUB_TOKEN=abc\r\nCODEX_HOME="${target}"\r\nCODEX_HOME=C:\\ignored\r\n`,
      internalEnv: "CODEX_HOME=C:\\internal-loses\r\n",
    }, codexHome => assert.equal(codexHome, target));
  });

  test(`${name} falls back to _internal and resolves relative paths from the package root`, windowsOnly, () => {
    withLaunch(kind, { internalEnv: "CODEX_HOME=data\\codex-home\r\n" }, (codexHome, packageRoot) =>
      assert.equal(codexHome, path.join(packageRoot, "data", "codex-home")));
  });

  test(`${name} keeps an inherited CODEX_HOME and leaves it unset without a config`, windowsOnly, () => {
    withLaunch(kind, {
      rootEnv: "CODEX_HOME=C:\\from-file\r\n",
      inheritedCodexHome: "C:\\from-environment",
    }, codexHome => assert.equal(codexHome, "C:\\from-environment"));
    withLaunch(kind, {}, codexHome => assert.equal(codexHome, "<unset>"));
  });
}
