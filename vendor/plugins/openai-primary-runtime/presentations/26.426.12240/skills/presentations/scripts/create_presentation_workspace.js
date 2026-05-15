#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REQUIRED_ARTIFACT_TOOL_VERSION = "2.7.2";
const REQUIRED_EXPORTS = [
  "Presentation",
  "PresentationFile",
  "row",
  "column",
  "grid",
  "layers",
  "panel",
  "text",
  "image",
  "shape",
  "chart",
  "table",
  "rule",
  "fill",
  "hug",
  "fixed",
  "wrap",
  "grow",
  "fr",
  "auto",
];

function usage() {
  return `Usage: create_presentation_workspace.js --deck-id <slug> [--workspace <dir>] [--force]

Creates an isolated presentation workspace:
  src/      agent-authored deck code
  scratch/  previews, layout exports, reports, assets, logs
  output/   final user-facing files only

The script verifies the bundled @oai/artifact-tool runtime and links it into the workspace.
It does not generate deck code or a slide template.`;
}

function parseArgs(argv) {
  const args = { force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") {
      args.force = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument: ${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    i += 1;
    if (arg === "--deck-id") args.deckId = value;
    else if (arg === "--workspace") args.workspace = value;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!args.deckId) throw new Error(usage());
  return args;
}

function cleanSlug(value) {
  const slug = String(value)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "presentation";
}

function defaultRuntimeNodeModules() {
  return path.join(
    os.homedir(),
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "node",
    "node_modules",
  );
}

function nodeExecutableName() {
  return process.platform === "win32" ? "node.exe" : "node";
}

function defaultRuntimeNodePath(nodeModulesDir) {
  return path.join(path.dirname(nodeModulesDir), "bin", nodeExecutableName());
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function artifactToolPackageFromNodeModules(directory) {
  const nodeModulesDir = path.resolve(directory);
  const packageDir = path.join(nodeModulesDir, "@oai", "artifact-tool");
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) return null;
  const packageJson = readJson(packageJsonPath);
  if (packageJson.name !== "@oai/artifact-tool") return null;
  return { nodeModulesDir, packageDir, packageJson };
}

function compareVersions(left, right) {
  const a = String(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function resolveInstalledArtifactToolPackage() {
  const packageInfo = artifactToolPackageFromNodeModules(defaultRuntimeNodeModules());
  if (!packageInfo) {
    throw new Error(
      [
        `Could not find @oai/artifact-tool in the default Codex runtime node_modules: ${defaultRuntimeNodeModules()}`,
        "Install or refresh the Codex runtime bundle, then retry.",
      ].join("\n"),
    );
  }
  if (compareVersions(packageInfo.packageJson.version, REQUIRED_ARTIFACT_TOOL_VERSION) < 0) {
    throw new Error(
      [
        `@oai/artifact-tool ${packageInfo.packageJson.version} is installed, but Presentations requires ${REQUIRED_ARTIFACT_TOOL_VERSION} or newer.`,
        "Install or refresh the Codex runtime bundle so @oai/artifact-tool presentation JSX helpers are available.",
      ].join("\n"),
    );
  }
  return packageInfo;
}

function installArtifactToolPackageLink(workspaceDir, artifactPackage) {
  const scopeDir = path.join(workspaceDir, "node_modules", "@oai");
  const target = path.join(scopeDir, "artifact-tool");
  fs.mkdirSync(scopeDir, { recursive: true });

  if (fs.existsSync(target) || fs.lstatSync(scopeDir).isSymbolicLink()) {
    fs.rmSync(target, { recursive: true, force: true });
  }

  let symlinkTarget = path.relative(scopeDir, artifactPackage.packageDir).split(path.sep).join("/");
  if (!symlinkTarget.startsWith(".")) symlinkTarget = `./${symlinkTarget}`;
  fs.symlinkSync(symlinkTarget, target, process.platform === "win32" ? "junction" : "dir");
  return target;
}

function ensurePackageJson(workspaceDir) {
  const packageJsonPath = path.join(workspaceDir, "package.json");
  const desired = {
    private: true,
    type: "module",
  };
  if (fs.existsSync(packageJsonPath)) {
    const existing = readJson(packageJsonPath);
    if (existing.type === "module") return packageJsonPath;
  }
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(desired, null, 2)}\n`, "utf8");
  return packageJsonPath;
}

function verifyComposeExports(workspaceDir, nodePath) {
  const script = `
    const mod = await import("@oai/artifact-tool");
    const presentationJsx = await import("@oai/artifact-tool/presentation-jsx");
    const jsxRuntime = await import("@oai/artifact-tool/presentation-jsx/jsx-runtime");
    const jsxDevRuntime = await import("@oai/artifact-tool/presentation-jsx/jsx-dev-runtime");
    const required = ${JSON.stringify(REQUIRED_EXPORTS)};
    const missing = required.filter((name) => !(name in mod));
    if (missing.length) {
      throw new Error("Missing @oai/artifact-tool exports: " + missing.join(", "));
    }
    if (!presentationJsx.Fragment || !presentationJsx.paint || !presentationJsx.textStyle) {
      throw new Error("Missing @oai/artifact-tool/presentation-jsx exports");
    }
    if (!jsxRuntime.Fragment || !jsxRuntime.jsx || !jsxRuntime.jsxs || !jsxDevRuntime.jsxDEV) {
      throw new Error("Missing @oai/artifact-tool/presentation-jsx JSX runtime exports");
    }
    console.log(JSON.stringify({ ok: true, exports: required.length, presentationJsx: true }));
  `;
  const result = spawnSync(nodePath, ["--input-type=module", "-e", script], {
    cwd: workspaceDir,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        "Could not verify @oai/artifact-tool presentation JSX exports.",
        result.stderr.trim() || result.stdout.trim() || `Node exited with status ${result.status}`,
      ].join("\n"),
    );
  }
}

function ensureCleanOutputDir(outputDir, force) {
  fs.mkdirSync(outputDir, { recursive: true });
  const entries = fs.readdirSync(outputDir);
  if (!entries.length) return;
  const allowed = new Set(["output.pptx"]);
  const unexpected = entries.filter((name) => !allowed.has(name));
  if (unexpected.length && !force) {
    throw new Error(
      [
        `Output directory contains non-deliverable files: ${unexpected.join(", ")}`,
        "Move them to scratch or rerun with --force to remove them.",
      ].join("\n"),
    );
  }
  for (const name of unexpected) {
    fs.rmSync(path.join(outputDir, name), { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const deckId = cleanSlug(args.deckId);
  const workspaceDir = path.resolve(args.workspace || path.join("tmp", "presentations", deckId));
  const srcDir = path.join(workspaceDir, "src");
  const scratchDir = path.join(workspaceDir, "scratch");
  const outputDir = path.join(workspaceDir, "output");

  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(scratchDir, { recursive: true });
  ensureCleanOutputDir(outputDir, args.force);

  const artifactPackage = resolveInstalledArtifactToolPackage();
  const runtimeNodePath = defaultRuntimeNodePath(artifactPackage.nodeModulesDir);
  if (!fs.existsSync(runtimeNodePath)) {
    throw new Error(`Could not find runtime Node executable: ${runtimeNodePath}`);
  }

  const linkedPackage = installArtifactToolPackageLink(workspaceDir, artifactPackage);
  const packageJsonPath = ensurePackageJson(workspaceDir);
  verifyComposeExports(workspaceDir, runtimeNodePath);

  const result = {
    deck_id: deckId,
    workspace: workspaceDir,
    src: srcDir,
    scratch: scratchDir,
    output: outputDir,
    final_pptx: path.join(outputDir, "output.pptx"),
    package_json: packageJsonPath,
    artifact_tool: {
      version: artifactPackage.packageJson.version,
      linked_package: linkedPackage,
    },
    node: runtimeNodePath,
  };
  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
