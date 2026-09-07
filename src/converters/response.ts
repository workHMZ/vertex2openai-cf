// ============================================================
// Vertex AI → OpenAI response conversion (non-streaming)
// ============================================================

import type {
  OpenAIResponse,
  OpenAIChoice,
  OpenAIResponseMessage,
  OpenAIUsage,
  VertexPart,
  VertexResponse,
  VertexUsageMetadata,
} from "../types";
import { convertFunctionCallsToOpenAI } from "./tools";
import { mapFinishReason } from "./finish-reason";

const THINKING_TAG = "vertex_think_tag";

/**
 * Extract reasoning content from thinking tags.
 * Returns [reasoning, remainingContent].
 */
export function extractReasoningByTags(text: string): [string, string] {
  if (!text) return ["", ""];
  const re = new RegExp(
    `<${THINKING_TAG}>([\\s\\S]*?)</${THINKING_TAG}>`,
    "g"
  );
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) parts.push(m[1]);
  if (parts.length === 0) return ["", text];
  // Only collapse whitespace where a tag was removed — trimming untagged
  // output would eat leading indentation in code answers.
  const normal = text.replace(re, "").trim();
  return [parts.join("").trim(), normal];
}

/**
 * Process an OpenAI-compatible JSON response from Vertex,
 * extracting reasoning tags and normalizing the format.
 */
export function processOpenAIResponse(
  data: Record<string, unknown>,
  requestModel: string
): OpenAIResponse {
  const choices = (data.choices as Record<string, unknown>[]) || [];
  const processed: OpenAIChoice[] = [];

  for (const c of choices) {
    const msg = (c.message as Record<string, unknown>) || {};
    const raw = msg.content as string | null;
    const out: OpenAIResponseMessage = {
      role: "assistant",
      content: raw ?? null,
      refusal: (msg.refusal as string | null) ?? null,
    };

    if (typeof raw === "string" && raw.length > 0) {
      const [reasoning, content] = extractReasoningByTags(raw);
      out.content = content;
      if (reasoning) out.reasoning_content = reasoning;
    }

    const toolCalls = msg.tool_calls as OpenAIResponseMessage["tool_calls"];
    if (toolCalls && toolCalls.length > 0) {
      out.tool_calls = toolCalls;
      // Gemini can emit a preamble alongside a tool call; keep it rather than
      // dropping it, but normalise "" to null the way OpenAI does.
      out.content = out.content || null;
    }

    processed.push({
      index: (c.index as number) ?? 0,
      message: out,
      logprobs: null,
      finish_reason:
        toolCalls && toolCalls.length > 0
          ? "tool_calls"
          : (c.finish_reason as string) ?? "stop",
    });
  }

  const usage = normalizeUsage(
    data.usage as Record<string, unknown> | undefined
  );

  return {
    id: (data.id as string) ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: (data.created as number) ?? Math.floor(Date.now() / 1000),
    model: requestModel,
    choices: processed,
    usage,
  };
}

function extractParts(parts: VertexPart[]): {
  content: string;
  reasoning: string;
} {
  const content: string[] = [];
  const reasoning: string[] = [];

  for (const part of parts) {
    if (part.text) {
      if (part.thought) {
        reasoning.push(part.text);
      } else {
        content.push(part.text);
      }
    } else if (part.inlineData?.data) {
      const mimeType = part.inlineData.mimeType || "application/octet-stream";
      content.push(`data:${mimeType};base64,${part.inlineData.data}`);
    }
  }

  return {
    content: content.join(""),
    reasoning: reasoning.join(""),
  };
}

/**
 * Process a native Vertex generateContent response into OpenAI format.
 */
export function processVertexResponse(
  data: VertexResponse,
  requestModel: string
): OpenAIResponse {
  const responseId = `chatcmpl-${Date.now()}`;
  const choices: OpenAIChoice[] = [];

  for (const [index, candidate] of (data.candidates || []).entries()) {
    const parts = candidate.content?.parts || [];
    const { content, reasoning } = extractParts(parts);
    const message: OpenAIResponseMessage = {
      role: "assistant",
      content: content || null,
      refusal: null,
    };

    if (reasoning) message.reasoning_content = reasoning;

    const toolCalls = convertFunctionCallsToOpenAI(parts, responseId, index);
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
      message.content = content || null;
    }

    choices.push({
      index,
      message,
      logprobs: null,
      finish_reason: mapFinishReason(
        candidate.finishReason,
        toolCalls.length > 0
      ),
    });
  }

  if (choices.length === 0) {
    choices.push({
      index: 0,
      message: { role: "assistant", content: null, refusal: null },
      logprobs: null,
      finish_reason: "stop",
    });
  }

  const usage = buildUsage(data.usageMetadata);

  return {
    id: responseId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestModel,
    choices,
    usage,
  };
}

/**
 * Vertex reports thinking tokens separately: candidatesTokenCount excludes
 * them, so completion_tokens has to add them back or the numbers do not sum
 * to total_tokens.
 */
export function buildUsage(meta: VertexUsageMetadata | undefined): OpenAIUsage {
  const reasoning = meta?.thoughtsTokenCount ?? 0;
  const cached = meta?.cachedContentTokenCount ?? 0;
  const usage: OpenAIUsage = {
    prompt_tokens: meta?.promptTokenCount ?? 0,
    completion_tokens: (meta?.candidatesTokenCount ?? 0) + reasoning,
    total_tokens: meta?.totalTokenCount ?? 0,
  };
  if (reasoning > 0) {
    usage.completion_tokens_details = { reasoning_tokens: reasoning };
  }
  if (cached > 0) {
    usage.prompt_tokens_details = { cached_tokens: cached };
  }
  return usage;
}

/**
 * Vertex's OpenAI-compatible endpoint reports reasoning tokens *outside*
 * completion_tokens, so prompt + completion does not reach total. OpenAI
 * treats completion_tokens_details.reasoning_tokens as a subset of
 * completion_tokens, so fold them in when the arithmetic says they are missing.
 */
export function normalizeUsage(
  raw: Record<string, unknown> | undefined
): OpenAIUsage {
  const prompt = numberAt(raw, "prompt_tokens");
  const total = numberAt(raw, "total_tokens");
  let completion = numberAt(raw, "completion_tokens");

  const details = raw?.completion_tokens_details as
    | Record<string, unknown>
    | undefined;
  const reasoning = numberAt(details, "reasoning_tokens");

  if (reasoning > 0 && prompt + completion + reasoning === total) {
    completion += reasoning;
  }

  const usage: OpenAIUsage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
  if (reasoning > 0) {
    usage.completion_tokens_details = { reasoning_tokens: reasoning };
  }

  const promptDetails = raw?.prompt_tokens_details as
    | Record<string, unknown>
    | undefined;
  const cached = numberAt(promptDetails, "cached_tokens");
  if (cached > 0) {
    usage.prompt_tokens_details = { cached_tokens: cached };
  }

  return usage;
}

function numberAt(obj: Record<string, unknown> | undefined, key: string): number {
  const value = obj?.[key];
  return typeof value === "number" ? value : 0;
}
