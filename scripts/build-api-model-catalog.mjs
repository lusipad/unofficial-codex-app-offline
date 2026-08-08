#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const OPENAI_CATALOG_URL =
  "https://raw.githubusercontent.com/openai/codex/rust-v{version}/codex-rs/models-manager/models.json";
const DEEPSEEK_SETUP_URL =
  "https://cdn.deepseek.com/api-docs/codex-deepseek-setup-en.ps1";
const DEEPSEEK_CATALOG_SHA256 =
  "2f4295501fc41902cb78cfc4b9101ca09c6d89644c83adaadf7a23590b6735c5";

const GPT_56_SLUGS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const GPT_56_UPSTREAM_MULTI_AGENT_VERSIONS = Object.freeze({
  "gpt-5.6-sol": "v2",
  "gpt-5.6-terra": "v2",
  "gpt-5.6-luna": "v1",
});
const DEEPSEEK_SLUGS = ["deepseek-v4-flash", "deepseek-v4-pro"];
const GPT_56_CUSTOM_PROVIDER_PATCH = Object.freeze({
  tool_mode: null,
  multi_agent_version: null,
  use_responses_lite: false,
});

function usage() {
  return [
    "Usage:",
    "  node scripts/build-api-model-catalog.mjs --codex-binary <path> --output <path>",
    "  node scripts/build-api-model-catalog.mjs --codex-version <version> --output <path>",
  ].join("\n");
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--codex-binary", "--codex-version", "--output"].includes(key)) {
      throw new Error(`Unknown argument: ${key}\n${usage()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}\n${usage()}`);
    }
    values[key.slice(2)] = value;
    index += 1;
  }

  if (!values.output) {
    throw new Error(`--output is required\n${usage()}`);
  }
  if (Boolean(values["codex-binary"]) === Boolean(values["codex-version"])) {
    throw new Error(
      `Specify exactly one of --codex-binary or --codex-version\n${usage()}`,
    );
  }
  return values;
}

function normalizeVersion(version) {
  const normalized = String(version).trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) {
    throw new Error(`Unsupported Codex version: ${version}`);
  }
  return normalized;
}

export function parseCodexVersion(output) {
  const match = String(output).match(/\bcodex-cli\s+([^\s]+)/);
  if (!match) {
    throw new Error(`Could not parse Codex version from: ${String(output).trim()}`);
  }
  return normalizeVersion(match[1]);
}

async function readCodexVersion(binaryPath) {
  const { stdout, stderr } = await execFileAsync(binaryPath, ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  return parseCodexVersion(`${stdout}\n${stderr}`);
}

async function fetchText(url, label) {
  const response = await fetch(url, {
    headers: { "user-agent": "codex-app-offline-model-catalog-builder" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`${label} download failed: HTTP ${response.status} ${url}`);
  }
  return response.text();
}

function parseCatalog(text, label) {
  let catalog;
  try {
    catalog = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  validateCatalog(catalog, label);
  return catalog;
}

function validateCatalog(catalog, label) {
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.models)) {
    throw new Error(`${label} must contain a models array`);
  }

  const slugs = new Set();
  for (const model of catalog.models) {
    if (!model || typeof model !== "object" || typeof model.slug !== "string") {
      throw new Error(`${label} contains a model without a string slug`);
    }
    if (slugs.has(model.slug)) {
      throw new Error(`${label} contains duplicate model slug: ${model.slug}`);
    }
    slugs.add(model.slug);
  }
}

function sortForHash(value) {
  if (Array.isArray(value)) return value.map(sortForHash);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortForHash(value[key])]),
  );
}

export function catalogSha256(catalog) {
  return createHash("sha256")
    .update(JSON.stringify(sortForHash(catalog)))
    .digest("hex");
}

export function extractDeepSeekCatalog(setupScript) {
  const match = String(setupScript).match(
    /^\s*\$ModelsJson\s*=\s*@'\r?\n(?<json>\{[\s\S]*?\})\r?\n'@\s*$/m,
  );
  if (!match?.groups?.json) {
    throw new Error("DeepSeek setup script does not contain the expected ModelsJson block");
  }
  return parseCatalog(match.groups.json, "DeepSeek model catalog");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function mergeModelCatalogs(openAiCatalog, deepSeekCatalog) {
  validateCatalog(openAiCatalog, "OpenAI model catalog");
  validateCatalog(deepSeekCatalog, "DeepSeek model catalog");

  const merged = clone(openAiCatalog);
  const modelsBySlug = new Map(merged.models.map((model) => [model.slug, model]));

  for (const slug of GPT_56_SLUGS) {
    const model = modelsBySlug.get(slug);
    if (!model) {
      throw new Error(`OpenAI model catalog is missing required model: ${slug}`);
    }
    if (model.supports_search_tool !== true || !model.web_search_tool_type) {
      throw new Error(`${slug} no longer advertises native web search; review the patch`);
    }
    if (
      model.tool_mode !== "code_mode_only" ||
      model.multi_agent_version !== GPT_56_UPSTREAM_MULTI_AGENT_VERSIONS[slug] ||
      model.use_responses_lite !== true
    ) {
      throw new Error(`${slug} compatibility fields changed upstream; review the temporary patch`);
    }
    Object.assign(model, GPT_56_CUSTOM_PROVIDER_PATCH);
  }

  const deepSeekModels = new Map(
    deepSeekCatalog.models.map((model) => [model.slug, clone(model)]),
  );
  for (const slug of DEEPSEEK_SLUGS) {
    const model = deepSeekModels.get(slug);
    if (!model) {
      throw new Error(`DeepSeek model catalog is missing required model: ${slug}`);
    }
    if (
      model.supports_search_tool !== true ||
      model.web_search_tool_type !== "text" ||
      model.use_responses_lite !== false
    ) {
      throw new Error(`${slug} capability fields changed upstream; review before publishing`);
    }
  }

  for (const model of deepSeekCatalog.models) {
    if (modelsBySlug.has(model.slug)) {
      throw new Error(
        `OpenAI catalog now contains ${model.slug}; remove the manual DeepSeek merge`,
      );
    }
    merged.models.push(clone(model));
    modelsBySlug.set(model.slug, model);
  }

  validateCatalog(merged, "Merged API model catalog");
  return merged;
}

export async function buildApiModelCatalog({ codexVersion, outputPath }) {
  const version = normalizeVersion(codexVersion);
  const openAiUrl = OPENAI_CATALOG_URL.replace("{version}", version);
  const [openAiText, deepSeekSetupScript] = await Promise.all([
    fetchText(openAiUrl, "OpenAI model catalog"),
    fetchText(DEEPSEEK_SETUP_URL, "DeepSeek setup script"),
  ]);

  const openAiCatalog = parseCatalog(openAiText, "OpenAI model catalog");
  const deepSeekCatalog = extractDeepSeekCatalog(deepSeekSetupScript);
  const deepSeekHash = catalogSha256(deepSeekCatalog);
  if (deepSeekHash !== DEEPSEEK_CATALOG_SHA256) {
    throw new Error(
      `DeepSeek model catalog changed (${deepSeekHash}); review it and update the pinned hash`,
    );
  }

  const merged = mergeModelCatalogs(openAiCatalog, deepSeekCatalog);
  const resolvedOutput = path.resolve(outputPath);
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  return {
    codexVersion: version,
    deepSeekCatalogSha256: deepSeekHash,
    modelCount: merged.models.length,
    openAiCatalogUrl: openAiUrl,
    deepSeekSetupUrl: DEEPSEEK_SETUP_URL,
    outputPath: resolvedOutput,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const codexVersion = args["codex-version"]
    ? normalizeVersion(args["codex-version"])
    : await readCodexVersion(path.resolve(args["codex-binary"]));
  const result = await buildApiModelCatalog({
    codexVersion,
    outputPath: args.output,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
