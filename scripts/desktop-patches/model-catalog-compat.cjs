"use strict";

const ASTRA_MODEL_SLUG = "gpt-6-astra";
const ASTRA_DISPLAY_NAME = "GPT-6-Astra";
const ASTRA_DESCRIPTION = "Our most capable model for complex, demanding work.";

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
    if (modelSlug(model) !== ASTRA_MODEL_SLUG) return model;
    foundAstra = true;
    if (model.hidden === false) return model;
    changed = true;
    return { ...model, hidden: false };
  });

  if (!foundAstra) {
    patched.unshift(createAstraAppServerModel());
    changed = true;
  }
  return changed ? patched : models;
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
  createAstraAppServerModel,
  makeAstraCatalogModelVisible,
  patchModelListResult,
};
