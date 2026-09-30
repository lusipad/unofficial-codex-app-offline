"use strict";

const ASTRA_MODEL_SLUG = "gpt-6-astra";
const ASTRA_DISPLAY_NAME = "GPT-6-Astra";
const ASTRA_DESCRIPTION = "Our most capable model for complex, demanding work.";

// 26.928 renderer 已内置 gpt-6.1-sol 的升级公告 UI，但 26.924/26.928 的内嵌目录
// 还没有该模型；ChatGPT 账号的云端目录会下发它（hidden=true，官方端靠
// model_availability 白名单显示）。离线端把 model_availability 清成
// {use_hidden_models:false} 后只剩 !hidden 可见，必须把该条目恢复可见，
// 与官方端对该账号的行为对齐。只翻转已存在的条目，不合成注入
// （本地目录尚无该模型时不能向 API-key 用户提供一个后端不存在的模型）。
const GPT_6_1_SOL_SLUG = "gpt-6.1-sol";
const WIRE_UNHIDE_MODEL_SLUGS = Object.freeze([GPT_6_1_SOL_SLUG]);

const ASTRA_REASONING_LEVELS = Object.freeze([
  { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
  {
    reasoningEffort: "medium",
    description: "Balances speed and reasoning depth for everyday tasks",
  },
  {
    reasoningEffort: "high",
    description: "Greater reasoning depth for complex problems",
  },
  {
    reasoningEffort: "xhigh",
    description: "Extra high reasoning depth for complex problems",
  },
  {
    reasoningEffort: "max",
    description: "Maximum reasoning depth for the hardest problems",
  },
  {
    reasoningEffort: "ultra",
    description: "Maximum reasoning with automatic task delegation",
  },
]);

function createAstraAppServerModel() {
  return {
    id: ASTRA_MODEL_SLUG,
    model: ASTRA_MODEL_SLUG,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: ASTRA_DISPLAY_NAME,
    description: ASTRA_DESCRIPTION,
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: ASTRA_REASONING_LEVELS.map((level) => ({ ...level })),
    defaultReasoningEffort: "low",
    inputModalities: ["text", "image"],
    supportsPersonality: true,
    multiAgentVersion: "v2",
    additionalSpeedTiers: ["fast"],
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "2x speed, increased usage",
      },
    ],
    defaultServiceTier: null,
    isDefault: false,
  };
}

function modelSlug(model) {
  if (!model || typeof model !== "object") return null;
  return model.model || model.slug || model.id || null;
}

function patchModelArray(models) {
  let foundAstra = false;
  let changed = false;
  const patched = models.map((model) => {
    const slug = modelSlug(model);
    if (slug === ASTRA_MODEL_SLUG) {
      foundAstra = true;
      if (model.hidden === false) return model;
      changed = true;
      return { ...model, hidden: false };
    }
    if (slug === GPT_6_1_SOL_SLUG && model.hidden === true) {
      changed = true;
      return { ...model, hidden: false };
    }
    return model;
  });

  if (!foundAstra) {
    patched.unshift(createAstraAppServerModel());
    changed = true;
  }
  return changed ? patched : models;
}

/**
 * 桌面 wire 路径（renderer mcp-response）专用：只把 WIRE_UNHIDE_MODEL_SLUGS 里
 * 已存在且被隐藏的条目恢复可见。与 patchModelListResult 不同，这里不合成 Astra——
 * 桌面端在 wire 上不做任何目录改写是既有行为，不能因为修复 6.1 而改变账号
 * 实际不可用的模型的可见性。
 */
function patchWireModelListResult(result) {
  const patchArray = (models) => {
    let changed = false;
    const patched = models.map((model) => {
      const slug = modelSlug(model);
      if (slug != null && WIRE_UNHIDE_MODEL_SLUGS.indexOf(slug) >= 0 && model.hidden === true) {
        changed = true;
        return { ...model, hidden: false };
      }
      return model;
    });
    return changed ? patched : models;
  };
  if (Array.isArray(result)) return patchArray(result);
  if (!result || typeof result !== "object" || !Array.isArray(result.data)) {
    return result;
  }
  const data = patchArray(result.data);
  return data === result.data ? result : { ...result, data };
}

function patchModelListResult(result) {
  if (Array.isArray(result)) return patchModelArray(result);
  if (!result || typeof result !== "object" || !Array.isArray(result.data)) {
    return result;
  }
  const data = patchModelArray(result.data);
  return data === result.data ? result : { ...result, data };
}

function makeAstraCatalogModelVisible(model) {
  if (!model || typeof model !== "object" || model.slug !== ASTRA_MODEL_SLUG) {
    return model;
  }
  return model.visibility === "list" ? model : { ...model, visibility: "list" };
}

module.exports = {
  ASTRA_DESCRIPTION,
  ASTRA_DISPLAY_NAME,
  ASTRA_MODEL_SLUG,
  GPT_6_1_SOL_SLUG,
  WIRE_UNHIDE_MODEL_SLUGS,
  createAstraAppServerModel,
  makeAstraCatalogModelVisible,
  patchModelListResult,
  patchWireModelListResult,
};
