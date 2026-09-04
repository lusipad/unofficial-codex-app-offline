#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import modelCatalogCompat from "./desktop-patches/model-catalog-compat.cjs";

const execFileAsync = promisify(execFile);
const {
  ASTRA_MODEL_SLUG,
  makeAstraCatalogModelVisible,
} = modelCatalogCompat;

const OPENAI_CATALOG_URL =
  "https://raw.githubusercontent.com/openai/codex/rust-v{version}/codex-rs/models-manager/models.json";
const OPENAI_LATEST_CATALOG_URL =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
const DEEPSEEK_SETUP_URL =
  "https://cdn.deepseek.com/api-docs/codex-deepseek-setup-en.ps1";
const ASTRA_CATALOG_SHA256 =
  "d1d24c2cbcf0c5d489b27eb622d6487a4731dc6909cd9af30e9321f7b8a51f54";
const DEEPSEEK_CATALOG_SHA256 =
  "b78e9ba4df6be1457d7c610989fed9b4b3ff19e634d947708b443e360ec9ae11";

const GPT_56_SLUGS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const GPT_56_UPSTREAM_MULTI_AGENT_VERSIONS = Object.freeze({
  "gpt-5.6-sol": "v2",
  "gpt-5.6-terra": "v2",
  "gpt-5.6-luna": "v1",
});
const CUSTOM_PROVIDER_MODEL_VERSIONS = Object.freeze({
  [ASTRA_MODEL_SLUG]: "v2",
  ...GPT_56_UPSTREAM_MULTI_AGENT_VERSIONS,
});
const DEEPSEEK_SLUGS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
];
const OPENAI_CUSTOM_PROVIDER_PATCH = Object.freeze({
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

export function mergeModelCatalogs(openAiCatalog, deepSeekCatalog, astraModel = null) {
  validateCatalog(openAiCatalog, "OpenAI model catalog");
  validateCatalog(deepSeekCatalog, "DeepSeek model catalog");

  const merged = clone(openAiCatalog);
  const modelsBySlug = new Map(merged.models.map((model) => [model.slug, model]));

  if (!modelsBySlug.has(ASTRA_MODEL_SLUG)) {
    if (!astraModel || astraModel.slug !== ASTRA_MODEL_SLUG) {
      throw new Error(
        `Astra model catalog is missing required model: ${ASTRA_MODEL_SLUG}`,
      );
    }
    const visibleAstra = makeAstraCatalogModelVisible(clone(astraModel));
    merged.models.unshift(visibleAstra);
    modelsBySlug.set(ASTRA_MODEL_SLUG, visibleAstra);
  } else {
    const visibleAstra = makeAstraCatalogModelVisible(
      modelsBySlug.get(ASTRA_MODEL_SLUG),
    );
    if (visibleAstra !== modelsBySlug.get(ASTRA_MODEL_SLUG)) {
      const astraIndex = merged.models.findIndex(
        (model) => model.slug === ASTRA_MODEL_SLUG,
      );
      merged.models[astraIndex] = visibleAstra;
      modelsBySlug.set(ASTRA_MODEL_SLUG, visibleAstra);
    }
  }

  for (const slug of [ASTRA_MODEL_SLUG, ...GPT_56_SLUGS]) {
    const model = modelsBySlug.get(slug);
    if (!model) {
      throw new Error(`OpenAI model catalog is missing required model: ${slug}`);
    }
    if (model.supports_search_tool !== true || !model.web_search_tool_type) {
      throw new Error(`${slug} no longer advertises native web search; review the patch`);
    }
    if (
      model.tool_mode !== "code_mode_only" ||
      model.multi_agent_version !== CUSTOM_PROVIDER_MODEL_VERSIONS[slug] ||
      model.use_responses_lite !== true
    ) {
      throw new Error(`${slug} compatibility fields changed upstream; review the temporary patch`);
    }
    Object.assign(model, OPENAI_CUSTOM_PROVIDER_PATCH);
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
    if (slug === "deepseek-v4-flash-vision-exp") {
      if (
        !Array.isArray(model.input_modalities) ||
        !model.input_modalities.includes("image") ||
        model.supports_image_detail_original !== true
      ) {
        throw new Error(
          `${slug} image capability fields changed upstream; review before publishing`,
        );
      }
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
  let astraModel = openAiCatalog.models.find(
    (model) => model.slug === ASTRA_MODEL_SLUG,
  );
  let astraHash = null;
  if (!astraModel) {
    const latestOpenAiCatalog = parseCatalog(
      await fetchText(OPENAI_LATEST_CATALOG_URL, "Latest OpenAI model catalog"),
      "Latest OpenAI model catalog",
    );
    astraModel = latestOpenAiCatalog.models.find(
      (model) => model.slug === ASTRA_MODEL_SLUG,
    );
    if (!astraModel) {
      throw new Error(
        `Latest OpenAI model catalog is missing required model: ${ASTRA_MODEL_SLUG}`,
      );
    }
    astraHash = catalogSha256({ models: [astraModel] });
    if (astraHash !== ASTRA_CATALOG_SHA256) {
      throw new Error(
        `OpenAI Astra model changed (${astraHash}); review it and update the pinned hash`,
      );
    }
  }
  const deepSeekHash = catalogSha256(deepSeekCatalog);
  if (deepSeekHash !== DEEPSEEK_CATALOG_SHA256) {
    throw new Error(
      `DeepSeek model catalog changed (${deepSeekHash}); review it and update the pinned hash`,
    );
  }

  const merged = mergeModelCatalogs(openAiCatalog, deepSeekCatalog, astraModel);
  const resolvedOutput = path.resolve(outputPath);
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  return {
    codexVersion: version,
    astraCatalogSha256: astraHash,
    astraCatalogUrl: astraHash ? OPENAI_LATEST_CATALOG_URL : openAiUrl,
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
