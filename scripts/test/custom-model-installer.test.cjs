"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const installer = fs.readFileSync(
  path.join(repoRoot, "installer", "CodexOffline.iss.tpl"),
  "utf8",
);
const setup = fs.readFileSync(
  path.join(repoRoot, "scripts", "setup-codex-offline.ps1"),
  "utf8",
);
const build = fs.readFileSync(
  path.join(repoRoot, "scripts", "build-offline-package.ps1"),
  "utf8",
);
const verify = fs.readFileSync(
  path.join(repoRoot, "scripts", "verify-offline-package.ps1"),
  "utf8",
);

test("installer exposes custom models and clears managed configuration when unchecked", () => {
  assert.match(installer, /Name: "custommodels"/);
  assert.match(
    installer,
    /en\.TaskCustomModels=.*config\.toml.*uncheck on reinstall or uninstall.*providers.*API keys/i,
  );
  assert.match(
    installer,
    /zh\.TaskCustomModels=.*config\.toml.*重新安装时取消勾选或卸载.*Provider.*API Key/,
  );
  assert.match(
    build,
    /zh\.TaskCustomModels=.*config\.toml.*重新安装时取消勾选或卸载.*Provider.*API Key/,
  );
  assert.match(
    verify,
    /zh\.TaskCustomModels=.*config\.toml.*重新安装时取消勾选或卸载.*Provider.*API Key/,
  );
  assert.match(installer, /-InstallCustomModels/);
  assert.match(installer, /-RemoveCustomModels/);
  assert.match(installer, /\[UninstallRun\][\s\S]*-RemoveCustomModels/);
});

test("custom model cleanup is scoped to the installer-managed catalog", () => {
  assert.match(setup, /\[switch\]\$InstallCustomModels/);
  assert.match(setup, /\[switch\]\$RemoveCustomModels/);
  assert.match(setup, /models-api-offline\.json/);
  assert.match(setup, /model_catalog_json/);
  assert.match(setup, /Remove-ManagedModelCatalog/);
  assert.match(setup, /Install-ManagedModelCatalog/);
});

test(
  "custom model catalog stays at TOML root when provider tables exist",
  { skip: process.platform !== "win32" },
  () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-custom-model-"));
    const packageRoot = path.join(tempRoot, "package");
    const internalRoot = path.join(packageRoot, "_internal");
    const codexHome = path.join(tempRoot, "codex-home");
    const configPath = path.join(codexHome, "config.toml");
    const catalogPath = path.join(codexHome, "models-api-offline.json");
    const setupScript = path.join(repoRoot, "scripts", "setup-codex-offline.ps1");

    fs.mkdirSync(path.join(internalRoot, "app"), { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(internalRoot, "app", "ChatGPT.exe"), "");
    fs.writeFileSync(path.join(internalRoot, "bootstrap-codex-skills.ps1"), "");
    fs.writeFileSync(path.join(internalRoot, "repair-chrome-host.ps1"), "");
    fs.writeFileSync(path.join(internalRoot, "models-api.json"), '{"models":[]}\n');
    fs.writeFileSync(
      configPath,
      [
        'model = "sentinel-model"',
        "",
        "[model_providers.sentinel]",
        'name = "Keep Me"',
        'base_url = "https://example.invalid/v1"',
        "",
      ].join("\n"),
    );

    try {
      const installArgs = [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        setupScript,
        "-InstallRoot",
        packageRoot,
        "-CodexHome",
        codexHome,
        "-InstallCustomModels",
        "-SkipSkillSync",
        "-SkipChromeGuide",
        "-NoLaunch",
        "-NonInteractive",
        "-Language",
        "en",
      ];
      const installResult = spawnSync("powershell.exe", installArgs, {
        encoding: "utf8",
      });
      assert.equal(installResult.status, 0, installResult.stderr || installResult.stdout);

      const reinstallResult = spawnSync("powershell.exe", installArgs, {
        encoding: "utf8",
      });
      assert.equal(
        reinstallResult.status,
        0,
        reinstallResult.stderr || reinstallResult.stdout,
      );

      const installedConfig = fs.readFileSync(configPath, "utf8");
      const catalogIndex = installedConfig.indexOf("model_catalog_json = ");
      const firstTableIndex = installedConfig.indexOf("[model_providers.sentinel]");
      assert.ok(catalogIndex >= 0, "model_catalog_json was not written");
      assert.equal(
        installedConfig.match(/^model_catalog_json\s*=/gm)?.length,
        1,
        `reinstall must keep a single model_catalog_json key:\n${installedConfig}`,
      );
      assert.ok(
        catalogIndex < firstTableIndex,
        `model_catalog_json must be a TOML root key:\n${installedConfig}`,
      );
      assert.ok(fs.existsSync(catalogPath), "managed catalog was not installed");

      const removeResult = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          setupScript,
          "-InstallRoot",
          packageRoot,
          "-CodexHome",
          codexHome,
          "-RemoveCustomModels",
          "-CleanupOnly",
          "-NonInteractive",
          "-Language",
          "en",
        ],
        { encoding: "utf8" },
      );
      assert.equal(removeResult.status, 0, removeResult.stderr || removeResult.stdout);

      const cleanedConfig = fs.readFileSync(configPath, "utf8");
      assert.doesNotMatch(cleanedConfig, /^model_catalog_json\s*=/m);
      assert.match(cleanedConfig, /\[model_providers\.sentinel\]/);
      assert.match(cleanedConfig, /name = "Keep Me"/);
      assert.equal(fs.existsSync(catalogPath), false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

test("the version-matched catalog is bundled before archives and installer generation", () => {
  assert.match(build, /Join-Path \$internalRoot 'models-api\.json'/);
  assert.ok(
    build.indexOf("Join-Path $internalRoot 'models-api.json'") <
      build.indexOf("Write-BuildTrace 'Creating archives.'"),
  );
  assert.match(build, /LOCALAPPDATA[\s\S]*Inno Setup 6\/ISCC\.exe/);
});
