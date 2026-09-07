import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createVertexStreamTransformer,
  createStreamTransformer,
  StreamingReasoningProcessor,
} from "../src/converters/streaming";

/** Feed SSE text through a transformer and return the emitted `data:` payloads. */
async function pump(
  transformer: TransformStream<Uint8Array, Uint8Array>,
  frames: string[]
): Promise<string[]> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });

  const reader = source.pipeThrough(transformer).getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value as Uint8Array, { stream: true });
  }
  return out
    .split("\n\n")
    .filter(Boolean)
    .map((line) => line.replace(/^data: /, ""));
}

const parseChunks = (payloads: string[]) =>
  payloads.filter((p) => p !== "[DONE]").map((p) => JSON.parse(p));

describe("createVertexStreamTransformer", () => {
  test("numbers tool calls upward across chunks", async () => {
    const payloads = await pump(createVertexStreamTransformer("m"), [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"a","args":{}}}]}}]}\n\n',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"b","args":{}}}]},"finishReason":"STOP"}]}\n\n',
    ]);

    const indexes = parseChunks(payloads)
      .flatMap((c) => c.choices[0].delta.tool_calls ?? [])
      .map((t: { index: number }) => t.index);
    assert.deepEqual(indexes, [0, 1]);
  });

  test("closes a tool-calling stream with finish_reason tool_calls", async () => {
    const payloads = await pump(createVertexStreamTransformer("m"), [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"a","args":{}}}]},"finishReason":"STOP"}]}\n\n',
    ]);
    const finish = parseChunks(payloads)
      .map((c) => c.choices[0].finish_reason)
      .filter(Boolean);
    assert.deepEqual(finish, ["tool_calls"]);
    assert.equal(payloads.at(-1), "[DONE]");
  });

  test("emits thought parts as reasoning_content", async () => {
    const payloads = await pump(createVertexStreamTransformer("m"), [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hmm","thought":true},{"text":"hi"}]},"finishReason":"STOP"}]}\n\n',
    ]);
    const deltas = parseChunks(payloads).map((c) => c.choices[0].delta);
    assert.deepEqual(deltas[0], { role: "assistant" });
    assert.deepEqual(deltas[1], { reasoning_content: "hmm" });
    assert.deepEqual(deltas[2], { content: "hi" });
  });

  test("reassembles a JSON frame split across network chunks", async () => {
    const payloads = await pump(createVertexStreamTransformer("m"), [
      'data: {"candidates":[{"content":{"role":"model","par',
      'ts":[{"text":"split"}]},"finishReason":"STOP"}]}\n\n',
    ]);
    const text = parseChunks(payloads)
      .map((c) => c.choices[0].delta.content)
      .filter(Boolean)
      .join("");
    assert.equal(text, "split");
  });

  test("always terminates with [DONE]", async () => {
    const payloads = await pump(createVertexStreamTransformer("m"), [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]}\n\n',
    ]);
    assert.equal(payloads.at(-1), "[DONE]");
    assert.equal(payloads.filter((p) => p === "[DONE]").length, 1);
  });

  test("reports usage on the final chunk", async () => {
    const payloads = await pump(createVertexStreamTransformer("m"), [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"thoughtsTokenCount":6,"totalTokenCount":13}}\n\n',
    ]);
    const last = parseChunks(payloads).at(-1);
    assert.deepEqual(last.usage, {
      prompt_tokens: 3,
      completion_tokens: 10,
      total_tokens: 13,
      completion_tokens_details: { reasoning_tokens: 6 },
    });
  });

  test("ignores malformed frames instead of aborting the stream", async () => {
    const payloads = await pump(createVertexStreamTransformer("m"), [
      "data: {not json}\n\n",
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n',
    ]);
    const text = parseChunks(payloads)
      .map((c) => c.choices[0].delta.content)
      .filter(Boolean)
      .join("");
    assert.equal(text, "ok");
  });
});

describe("createStreamTransformer", () => {
  test("terminates with [DONE] even when upstream never sends one", async () => {
    const payloads = await pump(createStreamTransformer("m"), [
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
    ]);
    assert.equal(payloads.at(-1), "[DONE]");
  });

  test("does not duplicate [DONE] when upstream sends one", async () => {
    const payloads = await pump(createStreamTransformer("m"), [
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.equal(payloads.filter((p) => p === "[DONE]").length, 1);
  });

  test("splits tagged reasoning out of the content stream", async () => {
    const payloads = await pump(createStreamTransformer("m"), [
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"<vertex_think_tag>why</vertex_think_tag>answer"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const deltas = parseChunks(payloads).map((c) => c.choices[0].delta);
    assert.deepEqual(deltas[0], { reasoning_content: "why" });
    assert.deepEqual(deltas[1], { content: "answer" });
  });
});

describe("StreamingReasoningProcessor", () => {
  test("handles a tag split across chunk boundaries", () => {
    const p = new StreamingReasoningProcessor();
    let content = "";
    let reasoning = "";
    for (const chunk of ["<vertex_think", "_tag>secret</vertex_", "think_tag>public"]) {
      const [c, r] = p.processChunk(chunk);
      content += c;
      reasoning += r;
    }
    const [c, r] = p.flushRemaining();
    assert.equal(reasoning + r, "secret");
    assert.equal(content + c, "public");
  });
});

describe("usage normalisation in the OpenAI-compatible stream", () => {
  test("folds reasoning tokens into the streamed usage chunk", async () => {
    // Real shape from Vertex's OpenAI-compatible endpoint: 11 + 9 != 125.
    const payloads = await pump(createStreamTransformer("m"), [
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      'data: {"id":"x","created":1,"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":9,"total_tokens":125,"completion_tokens_details":{"reasoning_tokens":105}}}\n\n',
      "data: [DONE]\n\n",
    ]);

    const usage = parseChunks(payloads).find((c) => c.usage)!.usage;
    assert.equal(usage.completion_tokens, 114);
    assert.equal(usage.prompt_tokens + usage.completion_tokens, usage.total_tokens);
    assert.deepEqual(usage.completion_tokens_details, { reasoning_tokens: 105 });
  });
});

describe("finish_reason handling in the OpenAI-compatible stream", () => {
  test("does not add a second finish chunk when upstream already sent one", async () => {
    // Real Vertex shape: the last content chunk carries finish_reason + usage.
    const payloads = await pump(createStreamTransformer("m"), [
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
      "data: [DONE]\n\n",
    ]);

    const finishes = parseChunks(payloads)
      .flatMap((c) => c.choices ?? [])
      .map((c: { finish_reason: string | null }) => c.finish_reason)
      .filter(Boolean);
    assert.deepEqual(finishes, ["stop"]);
  });

  test("still synthesises a finish chunk when upstream sends none", async () => {
    const payloads = await pump(createStreamTransformer("m"), [
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const finishes = parseChunks(payloads)
      .flatMap((c) => c.choices ?? [])
      .map((c: { finish_reason: string | null }) => c.finish_reason)
      .filter(Boolean);
    assert.deepEqual(finishes, ["stop"]);
  });

  test("every streamed choice carries the required finish_reason key", async () => {
    const payloads = await pump(createStreamTransformer("m"), [
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n',
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"b"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    for (const chunk of parseChunks(payloads)) {
      for (const choice of chunk.choices ?? []) {
        assert.ok("finish_reason" in choice, JSON.stringify(choice));
      }
    }
  });
});
