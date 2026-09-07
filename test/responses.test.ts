import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  responsesRequestToChat,
  chatToResponse,
  convertResponsesTools,
  convertResponsesToolChoice,
  convertTextFormat,
  buildOutputItems,
} from "../src/converters/responses";
import { createResponsesStreamTransformer } from "../src/converters/responses-streaming";
import type { OpenAIResponse, ResponsesRequest } from "../src/types";

const base: ResponsesRequest = { model: "gemini-3.8-flash" };

describe("responsesRequestToChat", () => {
  test("turns a string input into a user message", () => {
    const chat = responsesRequestToChat({ ...base, input: "hello" });
    assert.deepEqual(chat.messages, [{ role: "user", content: "hello" }]);
  });

  test("lifts instructions into a leading system message", () => {
    const chat = responsesRequestToChat({
      ...base,
      instructions: "be terse",
      input: "hi",
    });
    assert.deepEqual(chat.messages[0], { role: "system", content: "be terse" });
    assert.equal(chat.messages[1].role, "user");
  });

  test("maps developer role onto system", () => {
    const chat = responsesRequestToChat({
      ...base,
      input: [{ type: "message", role: "developer", content: "rules" }],
    });
    assert.equal(chat.messages[0].role, "system");
  });

  test("converts input_text and input_image parts", () => {
    const chat = responsesRequestToChat({
      ...base,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "what is this" },
            { type: "input_image", image_url: "data:image/png;base64,AAA" },
          ],
        },
      ],
    });
    assert.deepEqual(chat.messages[0].content, [
      { type: "text", text: "what is this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ]);
  });

  test("rebuilds the assistant/tool pair from flat call items", () => {
    const chat = responsesRequestToChat({
      ...base,
      input: [
        { role: "user", content: "weather?" },
        {
          type: "function_call",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city":"Tokyo"}',
        },
        { type: "function_call_output", call_id: "call_1", output: '{"temp":21}' },
      ],
    });

    assert.equal(chat.messages[1].role, "assistant");
    assert.deepEqual(chat.messages[1].tool_calls, [
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
      },
    ]);
    assert.equal(chat.messages[2].role, "tool");
    assert.equal(chat.messages[2].tool_call_id, "call_1");
  });

  test("groups parallel calls into one assistant message", () => {
    const chat = responsesRequestToChat({
      ...base,
      input: [
        { type: "function_call", call_id: "a", name: "f", arguments: "{}" },
        { type: "function_call", call_id: "b", name: "g", arguments: "{}" },
      ],
    });
    assert.equal(chat.messages.length, 1);
    assert.equal(chat.messages[0].tool_calls?.length, 2);
  });

  test("keeps a thought signature attached to a call item", () => {
    const chat = responsesRequestToChat({
      ...base,
      input: [
        {
          type: "function_call",
          call_id: "a",
          name: "f",
          arguments: "{}",
          thought_signature: "SIG",
        },
      ],
    });
    assert.equal(chat.messages[0].tool_calls?.[0].thought_signature, "SIG");
  });

  test("serialises a non-string function_call_output", () => {
    const chat = responsesRequestToChat({
      ...base,
      input: [{ type: "function_call_output", call_id: "a", output: { temp: 21 } }],
    });
    assert.equal(chat.messages[0].content, '{"temp":21}');
  });

  test("ignores reasoning items, which Chat Completions cannot carry", () => {
    const chat = responsesRequestToChat({
      ...base,
      input: [
        { type: "reasoning", id: "rs_1" },
        { role: "user", content: "hi" },
      ],
    });
    assert.equal(chat.messages.length, 1);
    assert.equal(chat.messages[0].role, "user");
  });

  test("renames max_output_tokens and reasoning.effort", () => {
    const chat = responsesRequestToChat({
      ...base,
      input: "hi",
      max_output_tokens: 256,
      reasoning: { effort: "high" },
    });
    assert.equal(chat.max_tokens, 256);
    assert.equal(chat.reasoning_effort, "high");
  });

  test("never produces an empty messages array", () => {
    assert.equal(responsesRequestToChat({ ...base, input: [] }).messages.length, 1);
  });
});

describe("convertResponsesTools", () => {
  test("nests the flat function shape", () => {
    assert.deepEqual(
      convertResponsesTools([
        {
          type: "function",
          name: "get_weather",
          description: "Look up weather",
          parameters: { type: "object", properties: {} },
        },
      ]),
      [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Look up weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ]
    );
  });

  test("skips non-function tools", () => {
    assert.deepEqual(
      convertResponsesTools([{ type: "web_search" } as never]),
      []
    );
  });
});

describe("convertResponsesToolChoice", () => {
  test("passes the string forms through", () => {
    assert.equal(convertResponsesToolChoice("required"), "required");
    assert.equal(convertResponsesToolChoice("none"), "none");
  });

  test("nests the named-function form", () => {
    assert.deepEqual(convertResponsesToolChoice({ type: "function", name: "f" }), {
      type: "function",
      function: { name: "f" },
    });
  });
});

describe("convertTextFormat", () => {
  test("maps json_schema onto response_format", () => {
    const rf = convertTextFormat({
      format: {
        type: "json_schema",
        name: "Person",
        strict: true,
        schema: { type: "object" },
      },
    });
    assert.deepEqual(rf, {
      type: "json_schema",
      json_schema: { name: "Person", strict: true, schema: { type: "object" } },
    });
  });

  test("maps json_object", () => {
    assert.deepEqual(convertTextFormat({ format: { type: "json_object" } }), {
      type: "json_object",
    });
  });

  test("treats plain text as no constraint", () => {
    assert.equal(convertTextFormat({ format: { type: "text" } }), undefined);
    assert.equal(convertTextFormat(undefined), undefined);
  });
});

describe("chatToResponse", () => {
  const completion = (over: Partial<OpenAIResponse> = {}): OpenAIResponse => ({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1700000000,
    model: "gemini-3.8-flash",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello", refusal: null },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    ...over,
  });

  test("emits a message item and the output_text shortcut", () => {
    const res = chatToResponse(completion(), { ...base, input: "hi" });
    assert.equal(res.object, "response");
    assert.equal(res.status, "completed");
    assert.equal(res.output_text, "hello");
    assert.equal(res.output[0].type, "message");
    assert.deepEqual((res.output[0] as { content: unknown }).content, [
      { type: "output_text", text: "hello", annotations: [] },
    ]);
  });

  test("renames usage to the Responses vocabulary", () => {
    const res = chatToResponse(
      completion({
        usage: {
          prompt_tokens: 10,
          completion_tokens: 25,
          total_tokens: 35,
          completion_tokens_details: { reasoning_tokens: 20 },
          prompt_tokens_details: { cached_tokens: 4 },
        },
      }),
      { ...base, input: "hi" }
    );
    assert.deepEqual(res.usage, {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 25,
      output_tokens_details: { reasoning_tokens: 20 },
      total_tokens: 35,
    });
  });

  test("emits a reasoning item before the message", () => {
    const res = chatToResponse(
      completion({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "answer",
              refusal: null,
              reasoning_content: "thinking",
            },
            logprobs: null,
            finish_reason: "stop",
          },
        ],
      }),
      { ...base, input: "hi" }
    );
    assert.deepEqual(res.output.map((i) => i.type), ["reasoning", "message"]);
    assert.deepEqual((res.output[0] as { summary: unknown }).summary, [
      { type: "summary_text", text: "thinking" },
    ]);
  });

  test("finds a signature nested under extra_content", () => {
    const res = chatToResponse(
      completion({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              refusal: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "f", arguments: "{}" },
                  // Shape returned by Vertex's OpenAI-compatible endpoint.
                  extra_content: { google: { thought_signature: "NESTED" } },
                } as never,
              ],
            },
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
      }),
      { ...base, input: "hi" }
    );
    assert.equal(
      (res.output[0] as Record<string, unknown>).thought_signature,
      "NESTED"
    );
  });

  test("emits function_call items with call_id", () => {
    const res = chatToResponse(
      completion({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              refusal: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "f", arguments: '{"a":1}' },
                  thought_signature: "SIG",
                },
              ],
            },
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
      }),
      { ...base, input: "hi" }
    );
    const item = res.output[0] as Record<string, unknown>;
    assert.equal(item.type, "function_call");
    assert.equal(item.call_id, "call_1");
    assert.equal(item.arguments, '{"a":1}');
    assert.equal(item.thought_signature, "SIG");
    assert.equal(res.status, "completed");
  });

  test("reports truncation as incomplete", () => {
    const res = chatToResponse(
      completion({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "part", refusal: null },
            logprobs: null,
            finish_reason: "length",
          },
        ],
      }),
      { ...base, input: "hi" }
    );
    assert.equal(res.status, "incomplete");
    assert.deepEqual(res.incomplete_details, { reason: "length" });
  });

  test("echoes the request settings the spec requires on the object", () => {
    const res = chatToResponse(completion(), {
      ...base,
      input: "hi",
      instructions: "be terse",
      max_output_tokens: 99,
      temperature: 0.5,
    });
    assert.equal(res.instructions, "be terse");
    assert.equal(res.max_output_tokens, 99);
    assert.equal(res.temperature, 0.5);
    assert.equal(res.error, null);
    assert.equal(res.previous_response_id, null);
  });
});

describe("buildOutputItems", () => {
  test("orders reasoning, message, then calls", () => {
    const items = buildOutputItems("resp_x", {
      reasoning: "r",
      text: "t",
      toolCalls: [
        { id: "c1", type: "function", function: { name: "f", arguments: "{}" } },
      ],
    });
    assert.deepEqual(items.map((i) => i.type), ["reasoning", "message", "function_call"]);
  });

  test("gives every item a distinct id", () => {
    const items = buildOutputItems("resp_x", {
      toolCalls: [
        { id: "c1", type: "function", function: { name: "f", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "f", arguments: "{}" } },
      ],
    });
    assert.equal(new Set(items.map((i) => i.id)).size, 2);
  });
});

// ----- streaming -----

async function pumpEvents(frames: string[]): Promise<Array<Record<string, unknown>>> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(encoder.encode(f));
      c.close();
    },
  });
  const reader = source
    .pipeThrough(createResponsesStreamTransformer(base, "gemini-3.8-flash"))
    .getReader();
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
    .map((block) => {
      const line = block.split("\n").find((l) => l.startsWith("data: "))!;
      return JSON.parse(line.slice(6));
    });
}

const chatChunk = (delta: unknown, finish: string | null = null, usage?: unknown) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gemini-3.8-flash",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;

describe("createResponsesStreamTransformer", () => {
  test("brackets a text response with the documented event sequence", async () => {
    const events = await pumpEvents([
      chatChunk({ role: "assistant" }),
      chatChunk({ content: "Hel" }),
      chatChunk({ content: "lo" }),
      chatChunk({}, "stop"),
      "data: [DONE]\n\n",
    ]);

    assert.deepEqual(events.map((e) => e.type), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
  });

  test("numbers every event sequentially from zero", async () => {
    const events = await pumpEvents([
      chatChunk({ content: "hi" }),
      chatChunk({}, "stop"),
    ]);
    assert.deepEqual(
      events.map((e) => e.sequence_number),
      events.map((_, i) => i)
    );
  });

  test("names the event on the SSE event: line too", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(chatChunk({ content: "hi" })));
        c.close();
      },
    });
    const reader = source
      .pipeThrough(createResponsesStreamTransformer(base, "gemini-3.8-flash"))
      .getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value as Uint8Array), /^event: response\.created\n/);
  });

  test("accumulates the full text on the done and completed events", async () => {
    const events = await pumpEvents([
      chatChunk({ content: "Hel" }),
      chatChunk({ content: "lo" }),
      chatChunk({}, "stop"),
    ]);
    const done = events.find((e) => e.type === "response.output_text.done")!;
    assert.equal(done.text, "Hello");
    const completed = events.find((e) => e.type === "response.completed")!;
    assert.equal((completed.response as { output_text: string }).output_text, "Hello");
  });

  test("emits reasoning as its own item before the message", async () => {
    const events = await pumpEvents([
      chatChunk({ reasoning_content: "think" }),
      chatChunk({ content: "answer" }),
      chatChunk({}, "stop"),
    ]);
    const types = events.map((e) => e.type);
    assert.ok(types.includes("response.reasoning_text.delta"));
    // The reasoning item closes before the message item opens.
    assert.ok(
      types.indexOf("response.output_item.done") < types.lastIndexOf("response.output_item.added")
    );
  });

  test("streams function call arguments", async () => {
    const events = await pumpEvents([
      chatChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
          },
        ],
      }),
      chatChunk({}, "tool_calls"),
    ]);

    const added = events.find((e) => e.type === "response.output_item.added")!;
    assert.equal((added.item as { type: string }).type, "function_call");
    assert.equal((added.item as { call_id: string }).call_id, "call_1");

    const argsDone = events.find(
      (e) => e.type === "response.function_call_arguments.done"
    )!;
    assert.equal(argsDone.arguments, '{"city":"Tokyo"}');

    const completed = events.at(-1)!;
    assert.equal(completed.type, "response.completed");
    const output = (completed.response as { output: Array<{ type: string }> }).output;
    assert.equal(output[0].type, "function_call");
  });

  test("gives parallel calls distinct output indexes", async () => {
    const events = await pumpEvents([
      chatChunk({
        tool_calls: [
          { index: 0, id: "a", type: "function", function: { name: "f", arguments: "{}" } },
        ],
      }),
      chatChunk({
        tool_calls: [
          { index: 1, id: "b", type: "function", function: { name: "g", arguments: "{}" } },
        ],
      }),
      chatChunk({}, "tool_calls"),
    ]);
    const indexes = events
      .filter((e) => e.type === "response.output_item.added")
      .map((e) => e.output_index);
    assert.deepEqual(indexes, [0, 1]);
  });

  test("carries usage onto the completed event", async () => {
    const events = await pumpEvents([
      chatChunk({ content: "hi" }),
      chatChunk({}, "stop", {
        prompt_tokens: 3,
        completion_tokens: 10,
        total_tokens: 13,
        completion_tokens_details: { reasoning_tokens: 6 },
      }),
    ]);
    const completed = events.at(-1)!;
    assert.deepEqual((completed.response as { usage: unknown }).usage, {
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 10,
      output_tokens_details: { reasoning_tokens: 6 },
      total_tokens: 13,
    });
  });

  test("marks a truncated stream incomplete", async () => {
    const events = await pumpEvents([
      chatChunk({ content: "part" }),
      chatChunk({}, "length"),
    ]);
    const completed = events.at(-1)!;
    const response = completed.response as {
      status: string;
      incomplete_details: unknown;
    };
    assert.equal(response.status, "incomplete");
    assert.deepEqual(response.incomplete_details, { reason: "length" });
  });

  test("always finishes with response.completed even with no content", async () => {
    const events = await pumpEvents([]);
    assert.deepEqual(events.map((e) => e.type), [
      "response.created",
      "response.in_progress",
      "response.completed",
    ]);
  });

  test("ignores malformed frames", async () => {
    const events = await pumpEvents([
      "data: {not json}\n\n",
      chatChunk({ content: "ok" }),
      chatChunk({}, "stop"),
    ]);
    const completed = events.at(-1)!;
    assert.equal((completed.response as { output_text: string }).output_text, "ok");
  });
});
