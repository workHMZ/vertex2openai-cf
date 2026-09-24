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

describe("createVertexStreamTransformer edge cases", () => {
  const finishes = (payloads: string[]) =>
    parseChunks(payloads)
      .flatMap((c) => c.choices ?? [])
      .map((c: { finish_reason: string | null }) => c.finish_reason)
      .filter(Boolean);

  test("reports a blocked prompt as content_filter", async () => {
    // Documented shape: first frame, promptFeedback, no candidates.
    const payloads = await pump(createVertexStreamTransformer("m"), [
      'data: {"promptFeedback":{"blockReason":"SAFETY"},"usageMetadata":{"promptTokenCount":5,"totalTokenCount":5}}\n\n',
    ]);
    assert.deepEqual(finishes(payloads), ["content_filter"]);
    assert.equal(parseChunks(payloads)[0].choices[0].delta.role, "assistant");
    assert.equal(payloads.at(-1), "[DONE]");
  });

  test("passes an upstream error frame on instead of a fake stop", async () => {
    const payloads = await pump(createVertexStreamTransformer("m"), [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"par"}]}}]}\n\n',
      'data: {"error":{"code":500,"message":"Internal error","status":"INTERNAL"}}\n\n',
    ]);
    const chunks = payloads.filter((p) => p !== "[DONE]").map((p) => JSON.parse(p));
    assert.deepEqual(chunks.at(-1), {
      error: { code: 500, message: "Internal error", status: "INTERNAL" },
    });
    assert.deepEqual(finishes(payloads), []);
  });

  test("still finishes when the stream ends before finishReason", async () => {
    const payloads = await pump(createVertexStreamTransformer("m"), [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"cut"}]}}]}\n\n',
    ]);
    assert.deepEqual(finishes(payloads), ["stop"]);
    assert.equal(payloads.at(-1), "[DONE]");
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

  test("drops the blank lines Vertex puts after a thought", () => {
    // Live shape: "</vertex_think_tag>\n\n" then the answer, split across chunks.
    const p = new StreamingReasoningProcessor();
    const out = [
      p.processChunk("<vertex_think_tag>hmm"),
      p.processChunk("\n</vertex_think_tag>\n"),
      p.processChunk("\nNo, 1001 = 7 × 11 × 13.\n\n  indented"),
    ];
    assert.equal(out.map(([c]) => c).join(""), "No, 1001 = 7 × 11 × 13.\n\n  indented");
  });

  test("keeps leading indentation when there was no thought", () => {
    const p = new StreamingReasoningProcessor();
    assert.equal(p.processChunk("    code")[0], "    code");
  });

  test("a closing tag cut off mid-thought stays out of the content", () => {
    const p = new StreamingReasoningProcessor();
    p.processChunk("<vertex_think_tag>deep thought</vertex_");
    assert.deepEqual(p.flushRemaining(), ["", "</vertex_"]);
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

  test("keeps usage and finish_reason when the last chunk also carries text", async () => {
    // Live shape from a max_tokens-truncated request: the final text, the
    // finish_reason and the usage all arrive on one chunk.
    const payloads = await pump(createStreamTransformer("m"), [
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"<vertex_think_tag>hmm</vertex_think_tag>"}}]}\n\n',
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"\\n\\n"},"finish_reason":"length"}],"usage":{"prompt_tokens":9,"completion_tokens":37,"total_tokens":46}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const chunks = parseChunks(payloads);
    const finishes = chunks
      .flatMap((c) => c.choices ?? [])
      .map((c: { finish_reason: string | null }) => c.finish_reason)
      .filter(Boolean);
    assert.deepEqual(finishes, ["length"]);
    assert.equal(chunks.filter((c) => c.usage).length, 1);
  });

  test("keeps finish_reason when the finishing text is all reasoning", async () => {
    const payloads = await pump(createStreamTransformer("m"), [
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"<vertex_think_tag>still thinking"},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const chunks = parseChunks(payloads);
    assert.equal(chunks[0].choices[0].delta.reasoning_content, "still thinking");
    const finishes = chunks
      .flatMap((c) => c.choices ?? [])
      .map((c: { finish_reason: string | null }) => c.finish_reason)
      .filter(Boolean);
    assert.deepEqual(finishes, ["length"]);
  });

  test("keeps role and tool calls that share a chunk with text", async () => {
    const payloads = await pump(createStreamTransformer("m"), [
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"Checking.","tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"f","arguments":"{}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const delta = parseChunks(payloads)[0].choices[0].delta;
    assert.equal(delta.role, "assistant");
    assert.equal(delta.content, "Checking.");
    assert.equal(delta.tool_calls[0].id, "c1");
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

describe("OpenAI-compatible stream flushing", () => {
  const texts = (payloads: string[]) =>
    parseChunks(payloads).map((c) => c.choices?.[0]?.delta ?? {});

  test("holds back a possible opening tag split across chunks", async () => {
    const payloads = await pump(createStreamTransformer("m"), [
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"a <vertex_th"}}]}\n\n',
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"ink_tag>why</vertex_think_tag>b"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const deltas = texts(payloads);
    assert.equal(deltas.map((d) => d.content ?? "").join(""), "a b");
    assert.equal(deltas.map((d) => d.reasoning_content ?? "").join(""), "why");
  });

  test("releases held-back text at [DONE] and when upstream just stops", async () => {
    for (const tail of ["data: [DONE]\n\n", ""]) {
      const payloads = await pump(createStreamTransformer("m"), [
        'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"x <vertex"}}]}\n\n',
        tail,
      ]);
      assert.equal(texts(payloads).map((d) => d.content ?? "").join(""), "x <vertex", JSON.stringify(tail));
      assert.equal(payloads.at(-1), "[DONE]");
    }
  });

  test("releases a thought cut off without its closing tag", async () => {
    for (const tail of ["data: [DONE]\n\n", ""]) {
      const payloads = await pump(createStreamTransformer("m"), [
        'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"<vertex_think_tag>unfinished </vertex"}}]}\n\n',
        tail,
      ]);
      const reasoning = texts(payloads).map((d) => d.reasoning_content ?? "").join("");
      assert.equal(reasoning, "unfinished </vertex", JSON.stringify(tail));
    }
  });

  test("skips a malformed frame without dropping the stream", async () => {
    const payloads = await pump(createStreamTransformer("m"), [
      "data: {oops\n\n",
      'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"content":"fine"},"finish_reason":"stop"}]}\n\n',
    ]);
    assert.equal(texts(payloads).map((d) => d.content ?? "").join(""), "fine");
  });

  test("the native transformer passes an explicit [DONE] through once", async () => {
    const payloads = await pump(createVertexStreamTransformer("m"), [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP"}]}\n\n',
      "data: [DONE]\n\n",
      "data: {not json}\n\n",
    ]);
    assert.equal(payloads.filter((p) => p === "[DONE]").length, 1);
  });
});

test("a streamed image costs time in proportion to its size", async () => {
  // A generated image is one SSE frame of several MB, read in ~1 KB pieces.
  // Re-splitting the growing buffer on every read made this quadratic
  // (8.3 s of CPU for a default-size image on a slow machine). Absolute
  // timings depend on the machine, so compare 4x the data: linear work takes
  // about 4x as long, quadratic about 16x.
  async function ms(size: number): Promise<number> {
    const frame = `data: ${JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "A".repeat(size) } }] }, finishReason: "STOP" }],
    })}\n\n`;
    const bytes = new TextEncoder().encode(frame);
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const source = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < bytes.length; i += 1024) c.enqueue(bytes.subarray(i, i + 1024));
          c.close();
        },
      });
      const start = performance.now();
      const out = await new Response(source.pipeThrough(createVertexStreamTransformer("m"))).text();
      best = Math.min(best, performance.now() - start);
      assert.match(out, /data:image\/png;base64,A{1000}/);
    }
    return Math.max(best, 1);
  }
  const small = await ms(700_000);
  const large = await ms(2_800_000);
  assert.ok(large / small < 8, `4x the data took ${(large / small).toFixed(1)}x as long (${small.toFixed(1)} -> ${large.toFixed(1)} ms)`);
});
