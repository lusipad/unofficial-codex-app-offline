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
  return {
    slug,
    display_name: slug,
    supports_search_tool: true,
    web_search_tool_type: "text",
    tool_mode: null,
    multi_agent_version: "v2",
    use_responses_lite: false,
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
    deepSeek: {
      models: [
        deepSeekModel("deepseek-v4-flash"),
        deepSeekModel("deepseek-v4-pro"),
      ],
    },
  };
}

test("merges DeepSeek entries and applies only the GPT-5.6 provider workaround", async () => {
  const { mergeModelCatalogs } = await modulePromise;
  const { openAi, deepSeek } = fixtures();
  const merged = mergeModelCatalogs(openAi, deepSeek);
  const expected = structuredClone(openAi);
  for (const slug of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    Object.assign(
      expected.models.find((model) => model.slug === slug),
      {
        tool_mode: null,
        multi_agent_version: null,
        use_responses_lite: false,
      },
    );
  }
  expected.models.push(...structuredClone(deepSeek.models));

  assert.deepEqual(merged, expected);

  assert.deepEqual(
    merged.models.map((model) => model.slug),
    [
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ],
  );
  assert.deepEqual(merged.models[0], openAi.models[0]);

  for (const slug of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    const model = merged.models.find((entry) => entry.slug === slug);
    assert.equal(model.tool_mode, null);
    assert.equal(model.multi_agent_version, null);
    assert.equal(model.use_responses_lite, false);
    assert.equal(model.supports_search_tool, true);
    assert.equal(model.web_search_tool_type, "text_and_image");
  }

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
    const { openAi, deepSeek } = fixtures();
    openAi.models.find((model) => model.slug === "gpt-5.6-sol")[field] = value;
    assert.throws(
      () => mergeModelCatalogs(openAi, deepSeek),
      /compatibility fields changed upstream/,
    );
  }
});

test("rejects duplicate DeepSeek slugs already supplied by OpenAI", async () => {
  const { mergeModelCatalogs } = await modulePromise;
  const { openAi, deepSeek } = fixtures();
  openAi.models.push(deepSeekModel("deepseek-v4-flash"));

  assert.throws(
    () => mergeModelCatalogs(openAi, deepSeek),
    /remove the manual DeepSeek merge/,
  );
});

test("parses the exact Codex CLI prerelease version", async () => {
  const { parseCodexVersion } = await modulePromise;
  assert.equal(parseCodexVersion("codex-cli 0.147.0-alpha.6.5\n"), "0.147.0-alpha.6.5");
});
