// ============================================================
// Gemini 3 thought signatures
// ============================================================

import type { OpenAIToolCall } from "../types";

/**
 * Gemini 3 attaches a `thoughtSignature` to the first functionCall part of
 * each step and rejects the next request with HTTP 400 if it is not echoed
 * back. The OpenAI wire format has nowhere to carry it, so this adapter
 * surfaces it as a non-standard `thought_signature` field on the tool call and
 * reads it back from the assistant turn.
 *
 * Clients that drop unknown fields cannot round-trip it. For those, Vertex AI
 * documents an opt-out placeholder that skips validation at the cost of some
 * model quality — this is the only accepted value on Vertex (the Gemini API's
 * "context_engineering_is_the_way_to_go" is rejected there).
 */
export const SIGNATURE_PLACEHOLDER = "skip_thought_signature_validator";

/**
 * Pull a thought signature off an incoming tool call, accepting the shapes
 * different clients use to pass vendor extensions through.
 */
export function readToolCallSignature(
  toolCall: OpenAIToolCall | Record<string, unknown>
): string | undefined {
  const tc = toolCall as Record<string, unknown>;

  const direct = tc.thought_signature ?? tc.thoughtSignature;
  if (typeof direct === "string" && direct) return direct;

  const fn = tc.function as Record<string, unknown> | undefined;
  const onFn = fn?.thought_signature ?? fn?.thoughtSignature;
  if (typeof onFn === "string" && onFn) return onFn;

  const extra = tc.extra_content as
    | { google?: { thought_signature?: unknown } }
    | undefined;
  const nested = extra?.google?.thought_signature;
  if (typeof nested === "string" && nested) return nested;

  return undefined;
}
