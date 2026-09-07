// ============================================================
// GET /v1/models handler
// ============================================================

import type { Env, ModelsConfig } from "../types";
import { getExpressKeys, parseServiceAccountJsons } from "../config";
import defaultModels from "../models.json";
import { getModelCapabilities } from "../model-capabilities";

interface ModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

/**
 * Handle GET /v1/models — return list of available models with variants.
 */
export async function handleModels(env: Env): Promise<Response> {
  const hasExpress = getExpressKeys(env).length > 0;
  const hasSA = parseServiceAccountJsons(env.GOOGLE_CREDENTIALS_JSON).length > 0;

  const config = loadModelsConfig(env.MODELS_CONFIG);

  const models: ModelEntry[] = [];
  // A configured id the adapter cannot serve would only produce broken
  // variants, so it is filtered out of the listing entirely.
  const seen = new Set<string>();
  const now = Math.floor(Date.now() / 1000);

  function addWithVariants(
    baseId: string,
    prefix: string,
    includeOpenAIVariants: boolean
  ) {
    const caps = getModelCapabilities(baseId);
    if (!caps.isSupported) return;

    // Suffixes for each model
    const suffixes = [""];
    if (includeOpenAIVariants) {
      suffixes.push("-openai", "-openaisearch");
    }

    // Grounded search is not offered for image-generation models.
    if (!caps.isImage) {
      suffixes.push("-search");
    }

    if (caps.supportsThinking) {
      suffixes.push("-nothinking", "-max");
    }

    if (caps.isImage) {
      suffixes.push("-2k", "-4k");
    }

    for (const suffix of suffixes) {
      const modelId = baseId + suffix;
      // Experimental models have no prefix
      const finalId = baseId.includes("-exp-")
        ? modelId
        : `${prefix}${modelId}`;

      if (!seen.has(finalId)) {
        seen.add(finalId);
        models.push({
          id: finalId,
          object: "model",
          created: now,
          owned_by: "google",
        });
      }
    }
  }

  // Express models
  if (hasExpress) {
    for (const m of config.vertex_express_models) {
      addWithVariants(m, "[EXPRESS] ", false);
    }
  }

  // SA models
  if (hasSA) {
    for (const m of config.vertex_models) {
      addWithVariants(m, "[PAY] ", true);
    }
  }

  // Sort by id
  models.sort((a, b) => a.id.localeCompare(b.id));

  return new Response(JSON.stringify({ object: "list", data: models }), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * MODELS_CONFIG is operator-supplied JSON, so fall back to the built-in list
 * rather than serving a broken model list when it is malformed or partial.
 */
export function loadModelsConfig(raw: string | undefined): ModelsConfig {
  if (!raw) return defaultModels;

  try {
    const parsed = JSON.parse(raw) as Partial<ModelsConfig>;
    const vertex = parsed.vertex_models;
    const express = parsed.vertex_express_models;
    if (!Array.isArray(vertex) && !Array.isArray(express)) {
      console.warn("MODELS_CONFIG has no model arrays; using built-in list.");
      return defaultModels;
    }
    return {
      vertex_models: Array.isArray(vertex) ? vertex : [],
      vertex_express_models: Array.isArray(express) ? express : [],
    };
  } catch {
    console.warn("MODELS_CONFIG is not valid JSON; using built-in list.");
    return defaultModels;
  }
}
