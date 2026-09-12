"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const modulePromise = import(
  pathToFileURL(path.resolve(__dirname, "../build-api-model-catalog.mjs"))
);

function openAiModel(slug, multiAgentVersion = "v2") {
  return {
    slug,
    display_name: slug,
    supports_search_tool: true,
    web_search_tool_type: "text_and_image",
    tool_mode: "code_mode_only",
    multi_agent_version: multiAgentVersion,
    use_responses_lite: true,
  };
}

function deepSeekModel(slug) {
  const model = {
    slug,
    display_name: slug,
    // Upstream turned the search tool off for v4-pro while keeping it on flash.
    supports_search_tool: slug !== "deepseek-v4-pro",
    web_search_tool_type: "text",
    tool_mode: null,
    multi_agent_version: "v2",
    use_responses_lite: false,
  };
  if (slug === "deepseek-flash") {
    model.input_modalities = ["text", "image"];
    model.supports_image_detail_original = true;
  }
  return model;
}

function astraModel() {
  return {
    ...openAiModel("gpt-6-astra"),
    display_name: "GPT-6-Astra",
    description: "Our most capable model for complex, demanding work.",
    visibility: "hide",
    minimal_client_version: "0.153.0",
  };
}

function fixtures() {
  return {
    openAi: {
      models: [
        { slug: "gpt-5.5", display_name: "GPT-5.5" },
        openAiModel("gpt-5.6-sol"),
        openAiModel("gpt-5.6-terra"),
        openAiModel("gpt-5.6-luna", "v1"),
      ],
    },
    astra: astraModel(),
    deepSeek: {
      models: [
        deepSeekModel("deepseek-flash"),
        deepSeekModel("deepseek-v4-pro"),
      ],
    },
  };
}

test("merges Astra and DeepSeek entries and applies the OpenAI provider workaround", async () => {
  const { mergeModelCatalogs } = await modulePromise;
  const { openAi, astra, deepSeek } = fixtures();
  const merged = mergeModelCatalogs(openAi, deepSeek, astra);
  const expected = structuredClone(openAi);
  expected.models.unshift(structuredClone(astra));
  for (const slug of [
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]) {
    Object.assign(
      expected.models.find((model) => model.slug === slug),
      {
        tool_mode: null,
        multi_agent_version: null,
        use_responses_lite: false,
      },
    );
  }
  expected.models[0].visibility = "list";
  expected.models.push(...structuredClone(deepSeek.models));

  assert.deepEqual(merged, expected);

  assert.deepEqual(
    merged.models.map((model) => model.slug),
    [
      "gpt-6-astra",
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "deepseek-flash",
      "deepseek-v4-pro",
    ],
  );
  assert.equal(merged.models[0].display_name, "GPT-6-Astra");
  assert.equal(merged.models[0].visibility, "list");
  assert.deepEqual(merged.models[1], openAi.models[0]);

  for (const slug of [
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]) {
    const model = merged.models.find((entry) => entry.slug === slug);
    assert.equal(model.tool_mode, null);
    assert.equal(model.multi_agent_version, null);
    assert.equal(model.use_responses_lite, false);
    assert.equal(model.supports_search_tool, true);
    assert.equal(model.web_search_tool_type, "text_and_image");
  }

  assert.equal(astra.tool_mode, "code_mode_only");
  assert.equal(astra.visibility, "hide");
  assert.equal(openAi.models[1].tool_mode, "code_mode_only");
  assert.equal(openAi.models[1].use_responses_lite, true);
});

test("extracts the official DeepSeek ModelsJson PowerShell block", async () => {
  const { extractDeepSeekCatalog } = await modulePromise;
  const script = [
    "$ModelsJson = @'",
    JSON.stringify(fixtures().deepSeek, null, 2),
    "'@",
  ].join("\n");

  assert.deepEqual(extractDeepSeekCatalog(script), fixtures().deepSeek);
});

test("rejects an upstream GPT-5.6 metadata change instead of silently overwriting it", async () => {
  const { mergeModelCatalogs } = await modulePromise;
  for (const [field, value] of [
    ["tool_mode", null],
    ["multi_agent_version", null],
    ["use_responses_lite", false],
  ]) {
    const { openAi, astra, deepSeek } = fixtures();
    openAi.models.find((model) => model.slug === "gpt-5.6-sol")[field] = value;
    assert.throws(
      () => mergeModelCatalogs(openAi, deepSeek, astra),
      /compatibility fields changed upstream/,
    );
  }
});

test("requires an official Astra entry when the versioned catalog does not contain it", async () => {
  const { mergeModelCatalogs } = await modulePromise;
  const { openAi, deepSeek } = fixtures();

  assert.throws(
    () => mergeModelCatalogs(openAi, deepSeek),
    /Astra model catalog is missing required model: gpt-6-astra/,
  );
});

test("rejects duplicate DeepSeek slugs already supplied by OpenAI", async () => {
  const { mergeModelCatalogs } = await modulePromise;
  const { openAi, astra, deepSeek } = fixtures();
  openAi.models.push(deepSeekModel("deepseek-flash"));

  assert.throws(
    () => mergeModelCatalogs(openAi, deepSeek, astra),
    /remove the manual DeepSeek merge/,
  );
});

test("rejects deepseek-flash losing the image input it now carries", async () => {
  const { mergeModelCatalogs } = await modulePromise;
  const { openAi, astra, deepSeek } = fixtures();
  const flash = deepSeek.models.find((model) => model.slug === "deepseek-flash");
  delete flash.input_modalities;
  delete flash.supports_image_detail_original;

  assert.throws(
    () => mergeModelCatalogs(openAi, deepSeek, astra),
    /deepseek-flash image capability fields changed upstream/,
  );
});

test("rejects a DeepSeek model whose search support flips unreviewed", async () => {
  const { mergeModelCatalogs } = await modulePromise;
  const { openAi, astra, deepSeek } = fixtures();
  const pro = deepSeek.models.find((model) => model.slug === "deepseek-v4-pro");
  pro.supports_search_tool = true;

  assert.throws(
    () => mergeModelCatalogs(openAi, deepSeek, astra),
    /deepseek-v4-pro capability fields changed upstream/,
  );
});

test("parses the exact Codex CLI prerelease version", async () => {
  const { parseCodexVersion } = await modulePromise;
  assert.equal(parseCodexVersion("codex-cli 0.147.0-alpha.6.5\n"), "0.147.0-alpha.6.5");
});
