import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  processVertexResponse,
  processOpenAIResponse,
  extractReasoningByTags,
  buildUsage,
  normalizeUsage,
} from "../src/converters/response";
import { mapFinishReason } from "../src/converters/finish-reason";
import type { VertexResponse } from "../src/types";

const OPENAI_FINISH_REASONS = new Set([
  "stop",
  "length",
  "content_filter",
  "tool_calls",
]);

describe("mapFinishReason", () => {
  test("only ever produces reasons OpenAI clients understand", () => {
    const vertexEnum = [
      "FINISH_REASON_UNSPECIFIED", "STOP", "MAX_TOKENS", "SAFETY", "RECITATION",
      "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
      "MALFORMED_FUNCTION_CALL", "MODEL_ARMOR", "IMAGE_SAFETY",
      "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "IMAGE_OTHER",
      "UNEXPECTED_TOOL_CALL", "NO_IMAGE",
    ];
    for (const reason of [...vertexEnum, undefined, "SOMETHING_NEW"]) {
      const mapped = mapFinishReason(reason as string | undefined);
      assert.ok(OPENAI_FINISH_REASONS.has(mapped), `${reason} -> ${mapped}`);
    }
  });

  test("maps the documented reasons", () => {
    assert.equal(mapFinishReason("STOP"), "stop");
    assert.equal(mapFinishReason("MAX_TOKENS"), "length");
    assert.equal(mapFinishReason("SAFETY"), "content_filter");
    assert.equal(mapFinishReason("BLOCKLIST"), "content_filter");
    assert.equal(mapFinishReason("IMAGE_SAFETY"), "content_filter");
  });

  test("reports tool_calls when the candidate carried tool calls", () => {
    assert.equal(mapFinishReason("STOP", true), "tool_calls");
    // A truncated or filtered response keeps its own reason.
    assert.equal(mapFinishReason("MAX_TOKENS", true), "length");
  });
});

describe("processVertexResponse", () => {
  const withToolCall = (over: Partial<VertexResponse> = {}): VertexResponse => ({
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ functionCall: { name: "f", args: { a: 1 } } }],
        },
        finishReason: "STOP",
      },
    ],
    ...over,
  });

  test("reports finish_reason 'tool_calls' for a tool call", () => {
    const res = processVertexResponse(withToolCall(), "gemini-3-pro-preview");
    assert.equal(res.choices[0].finish_reason, "tool_calls");
    assert.equal(res.choices[0].message.tool_calls?.length, 1);
  });

  test("gives parallel calls to the same function distinct ids", () => {
    const res = processVertexResponse(
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { functionCall: { name: "read", args: { p: "a" } } },
                { functionCall: { name: "read", args: { p: "b" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
      "m"
    );
    const ids = res.choices[0].message.tool_calls!.map((t) => t.id);
    assert.equal(new Set(ids).size, 2, `duplicate ids: ${ids.join(", ")}`);
  });

  test("surfaces the thought signature on the tool call", () => {
    const res = processVertexResponse(
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: { name: "f", args: {} },
                  thoughtSignature: "SIG123",
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
      "m"
    );
    assert.equal(res.choices[0].message.tool_calls![0].thought_signature, "SIG123");
  });

  test("separates thought parts into reasoning_content", () => {
    const res = processVertexResponse(
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { text: "thinking...", thought: true },
                { text: "answer" },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
      "m"
    );
    assert.equal(res.choices[0].message.reasoning_content, "thinking...");
    assert.equal(res.choices[0].message.content, "answer");
  });

  test("survives a blocked candidate that carries no content", () => {
    const res = processVertexResponse(
      { candidates: [{ finishReason: "SAFETY" }] } as VertexResponse,
      "m"
    );
    assert.equal(res.choices[0].finish_reason, "content_filter");
    assert.equal(res.choices[0].message.content, null);
  });

  test("renders inline image data as a data URL", () => {
    const res = processVertexResponse(
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ inlineData: { mimeType: "image/png", data: "AAA" } }],
            },
            finishReason: "STOP",
          },
        ],
      },
      "m"
    );
    assert.equal(res.choices[0].message.content, "data:image/png;base64,AAA");
  });
});

describe("buildUsage", () => {
  test("folds thinking tokens into completion_tokens", () => {
    const usage = buildUsage({
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      thoughtsTokenCount: 20,
      totalTokenCount: 35,
    });
    assert.deepEqual(usage, {
      prompt_tokens: 10,
      completion_tokens: 25,
      total_tokens: 35,
      completion_tokens_details: { reasoning_tokens: 20 },
    });
    assert.equal(
      usage.prompt_tokens + usage.completion_tokens,
      usage.total_tokens
    );
  });

  test("omits the details block when nothing was thought", () => {
    const usage = buildUsage({ promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 });
    assert.equal(usage.completion_tokens_details, undefined);
  });

  test("defaults to zeroes when usage is missing", () => {
    assert.deepEqual(buildUsage(undefined), {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });
});

describe("extractReasoningByTags", () => {
  test("splits tagged reasoning from the answer", () => {
    const [reasoning, content] = extractReasoningByTags(
      "<vertex_think_tag>why</vertex_think_tag>\n\nbecause"
    );
    assert.equal(reasoning, "why");
    assert.equal(content, "because");
  });

  test("leaves untagged text byte-for-byte alone", () => {
    const code = "    indented line\n\n";
    const [reasoning, content] = extractReasoningByTags(code);
    assert.equal(reasoning, "");
    assert.equal(content, code);
  });
});

describe("OpenAI schema conformance", () => {
  test("every choice carries the required logprobs and refusal keys", () => {
    const res = processVertexResponse(
      {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "hi" }] },
            finishReason: "STOP",
          },
        ],
      },
      "m"
    );
    assert.ok("logprobs" in res.choices[0], "choices[].logprobs is required");
    assert.equal(res.choices[0].logprobs, null);
    assert.ok("refusal" in res.choices[0].message, "message.refusal is required");
    assert.equal(res.choices[0].message.refusal, null);
  });

  test("an empty candidate list still yields a schema-valid choice", () => {
    const res = processVertexResponse({ candidates: [] }, "m");
    assert.equal(res.choices[0].logprobs, null);
    assert.equal(res.choices[0].message.refusal, null);
  });

  test("surfaces cached prompt tokens", () => {
    const usage = buildUsage({
      promptTokenCount: 100,
      cachedContentTokenCount: 80,
      candidatesTokenCount: 5,
      totalTokenCount: 105,
    });
    assert.deepEqual(usage.prompt_tokens_details, { cached_tokens: 80 });
  });
});

describe("processOpenAIResponse", () => {
  test("keeps a preamble that accompanies a tool call", () => {
    const res = processOpenAIResponse(
      {
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Let me look that up.",
              tool_calls: [
                { id: "c1", type: "function", function: { name: "f", arguments: "{}" } },
              ],
            },
            finish_reason: "stop",
          },
        ],
      },
      "m"
    );
    assert.equal(res.choices[0].message.content, "Let me look that up.");
    assert.equal(res.choices[0].finish_reason, "tool_calls");
  });
});

describe("normalizeUsage", () => {
  test("folds reasoning tokens in when the arithmetic shows they are missing", () => {
    // Shape returned by Vertex's OpenAI-compatible endpoint: 22 + 16 != 108.
    const usage = normalizeUsage({
      prompt_tokens: 22,
      completion_tokens: 16,
      total_tokens: 108,
      completion_tokens_details: { reasoning_tokens: 70 },
    });
    assert.equal(usage.completion_tokens, 86);
    assert.equal(
      usage.prompt_tokens + usage.completion_tokens,
      usage.total_tokens
    );
    assert.deepEqual(usage.completion_tokens_details, { reasoning_tokens: 70 });
  });

  test("leaves a already-consistent usage block alone", () => {
    const usage = normalizeUsage({
      prompt_tokens: 10,
      completion_tokens: 90,
      total_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 40 },
    });
    assert.equal(usage.completion_tokens, 90);
  });

  test("surfaces cached prompt tokens", () => {
    const usage = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 80 },
    });
    assert.deepEqual(usage.prompt_tokens_details, { cached_tokens: 80 });
  });

  test("defaults to zeroes when usage is absent", () => {
    assert.deepEqual(normalizeUsage(undefined), {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });
});
