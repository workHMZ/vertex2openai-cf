// ============================================================
// Vertex finishReason → OpenAI finish_reason
// ============================================================

/**
 * OpenAI clients only understand these values; anything else makes strict
 * SDKs (and schema validators) reject the response. The Vertex enum is much
 * larger, so every reason has to be folded into one of them.
 *
 * Vertex enum: FINISH_REASON_UNSPECIFIED, STOP, MAX_TOKENS, SAFETY,
 * RECITATION, OTHER, BLOCKLIST, PROHIBITED_CONTENT, SPII,
 * MALFORMED_FUNCTION_CALL, MODEL_ARMOR, IMAGE_SAFETY,
 * IMAGE_PROHIBITED_CONTENT, IMAGE_RECITATION, IMAGE_OTHER,
 * UNEXPECTED_TOOL_CALL, NO_IMAGE
 */
export type OpenAIFinishReason =
  | "stop"
  | "length"
  | "content_filter"
  | "tool_calls";

const FINISH_REASON_MAP: Record<string, OpenAIFinishReason> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  MODEL_ARMOR: "content_filter",
  IMAGE_SAFETY: "content_filter",
  IMAGE_PROHIBITED_CONTENT: "content_filter",
  IMAGE_RECITATION: "content_filter",
  MALFORMED_FUNCTION_CALL: "tool_calls",
  UNEXPECTED_TOOL_CALL: "tool_calls",
};

/**
 * Map a Vertex finishReason to a valid OpenAI finish_reason.
 * When the candidate carried tool calls, OpenAI clients expect "tool_calls"
 * even though Vertex reports STOP.
 */
export function mapFinishReason(
  reason: string | undefined,
  hasToolCalls = false
): OpenAIFinishReason {
  const mapped = reason ? FINISH_REASON_MAP[reason] : undefined;

  if (hasToolCalls && (mapped === "stop" || mapped === undefined)) {
    return "tool_calls";
  }
  // FINISH_REASON_UNSPECIFIED, OTHER, IMAGE_OTHER, NO_IMAGE and any value
  // added to the Vertex enum later all land here.
  return mapped ?? "stop";
}
