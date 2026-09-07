// ============================================================
// What a given Gemini model actually supports
// ============================================================

/**
 * Capabilities are derived from the parsed version number, never from
 * hardcoded name prefixes. `gemini-3.8-flash`, `gemini-3-flash-preview` and a
 * future `gemini-4-flash` all land in the right branch with no code change.
 */
export interface ModelVersion {
  major: number;
  minor: number;
}

export interface ModelCapabilities {
  /** null for non-Gemini or unparseable ids. */
  version: ModelVersion | null;
  /** This adapter targets Gemini 3 and newer only. */
  isSupported: boolean;
  /** Generates images, and therefore rejects thinkingConfig. */
  isImage: boolean;
  isLite: boolean;
  isPro: boolean;
  supportsThinking: boolean;
  /** Some Gemini 3 models reject thinkingLevel: MINIMAL with a 400. */
  supportsMinimalThinkingLevel: boolean;
  /** Some Gemini 3 models reject frequencyPenalty / presencePenalty. */
  supportsPenalties: boolean;
}

/** Gemini 2.x reached end of life in October 2026 and is not supported. */
export const MINIMUM_SUPPORTED_MAJOR = 3;

/**
 * Models documented as rejecting `thinkingLevel: "MINIMAL"`.
 * gemini-3.8-flash: "The minimal thinking level is not supported" (launch
 * limitation, 2026-09-02). Requests for it fall back to LOW instead of failing.
 */
const NO_MINIMAL_THINKING_LEVEL = new Set(["gemini-3.8-flash"]);

/**
 * Models that reject `frequencyPenalty` / `presencePenalty` with
 * "Penalty is not enabled for this model" (verified against the live API,
 * 2026-09-07). The parameters are dropped rather than failing the request.
 */
const NO_PENALTIES = new Set(["gemini-3.8-flash"]);

const VERSION_RE = /^gemini-(\d+)(?:\.(\d+))?(?:-|$)/;
const segment = (id: string, word: string) =>
  new RegExp(`(^|-)${word}(-|$)`).test(id);

export function parseModelVersion(baseModel: string): ModelVersion | null {
  const m = VERSION_RE.exec(baseModel);
  if (!m) return null;
  return { major: Number(m[1]), minor: m[2] ? Number(m[2]) : 0 };
}

/** True when `version` is at least major.minor. */
export function atLeast(
  version: ModelVersion | null,
  major: number,
  minor = 0
): boolean {
  if (!version) return false;
  return (
    version.major > major || (version.major === major && version.minor >= minor)
  );
}

export function getModelCapabilities(baseModel: string): ModelCapabilities {
  const version = parseModelVersion(baseModel);
  const isSupported = atLeast(version, MINIMUM_SUPPORTED_MAJOR);
  const isImage = segment(baseModel, "image");

  return {
    version,
    isSupported,
    isImage,
    isLite: segment(baseModel, "lite"),
    isPro: segment(baseModel, "pro"),
    // Every Gemini 3 model thinks; image models reject thinkingConfig.
    supportsThinking: isSupported && !isImage,
    supportsMinimalThinkingLevel: !NO_MINIMAL_THINKING_LEVEL.has(baseModel),
    supportsPenalties: !NO_PENALTIES.has(baseModel),
  };
}

export type ThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

/**
 * OpenAI's reasoning_effort vocabulary, including the `xhigh`/`max` values
 * added alongside the Responses API. Gemini tops out at HIGH.
 */
const EFFORT_TO_LEVEL: Record<string, ThinkingLevel> = {
  none: "MINIMAL",
  minimal: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  xhigh: "HIGH",
  max: "HIGH",
};

/**
 * Map reasoning_effort onto a thinkingLevel the model will accept.
 * Returns undefined when the caller asked for nothing recognisable.
 */
export function resolveThinkingLevel(
  effort: string | undefined,
  caps: ModelCapabilities
): ThinkingLevel | undefined {
  if (!effort) return undefined;
  const level = EFFORT_TO_LEVEL[effort.toLowerCase()];
  if (!level) return undefined;
  return clampThinkingLevel(level, caps);
}

/** Downgrade MINIMAL to LOW on models that reject it, rather than 400ing. */
export function clampThinkingLevel(
  level: ThinkingLevel,
  caps: ModelCapabilities
): ThinkingLevel {
  if (level === "MINIMAL" && !caps.supportsMinimalThinkingLevel) return "LOW";
  return level;
}

/** Message shown when a caller asks for a model this adapter no longer serves. */
export function unsupportedModelMessage(baseModel: string): string {
  const version = parseModelVersion(baseModel);
  if (version && version.major < MINIMUM_SUPPORTED_MAJOR) {
    return `Model '${baseModel}' is from the Gemini ${version.major}.x family, which reached end of life and is no longer supported. Use a Gemini ${MINIMUM_SUPPORTED_MAJOR}.x model — see GET /v1/models.`;
  }
  return `Unrecognised model '${baseModel}'. This adapter serves Gemini ${MINIMUM_SUPPORTED_MAJOR}.x models — see GET /v1/models.`;
}
