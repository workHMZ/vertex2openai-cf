import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseModelName,
  buildGenerationConfig,
  convertMessagesToVertex,
  buildVertexGenerateContentBody,
  buildOpenAICompatibleBody,
} from "../src/converters/request";
import {
  convertResponseFormat,
  stripUnsupportedSchemaKeys,
  signToolCallsForOpenAIEndpoint,
} from "../src/converters/request";
import { SIGNATURE_PLACEHOLDER } from "../src/converters/thought-signature";
import type { OpenAIMessage, OpenAIRequest } from "../src/types";

const req = (over: Partial<OpenAIRequest> = {}): OpenAIRequest => ({
  model: "gemini-3.8-flash",
  messages: [{ role: "user", content: "hi" }],
  ...over,
});

describe("parseModelName", () => {
  test("strips the [EXPRESS] prefix", () => {
    const m = parseModelName("[EXPRESS] gemini-3.1-pro-preview");
    assert.equal(m.baseModel, "gemini-3.1-pro-preview");
    assert.equal(m.isExpress, true);
    assert.equal(m.isPay, false);
  });

  test("strips the [PAY] prefix with or without a space", () => {
    for (const name of ["[PAY]gemini-3.8-flash", "[PAY] gemini-3.8-flash"]) {
      const m = parseModelName(name);
      assert.equal(m.baseModel, "gemini-3.8-flash", name);
      assert.equal(m.isPay, true, name);
    }
  });

  test("-openaisearch wins over the -openai prefix match", () => {
    const m = parseModelName("gemini-3.1-pro-preview-openaisearch");
    assert.equal(m.baseModel, "gemini-3.1-pro-preview");
    assert.equal(m.isOpenAISearch, true);
    assert.equal(m.isOpenAIDirect, true);
  });

  test("flags image models", () => {
    assert.equal(parseModelName("gemini-3.1-flash-image").isImage, true);
    assert.equal(parseModelName("gemini-3-pro-image-preview-4k").isImage, true);
    assert.equal(parseModelName("gemini-3.8-flash").isImage, false);
  });
});

describe("buildGenerationConfig", () => {
  test("wraps a bare stop string in an array", () => {
    const cfg = buildGenerationConfig(
      req({ stop: "\n\n" }),
      parseModelName("gemini-3.8-flash")
    );
    assert.deepEqual(cfg.stopSequences, ["\n\n"]);
  });

  test("passes a stop array through", () => {
    const cfg = buildGenerationConfig(
      req({ stop: ["a", "b"] }),
      parseModelName("gemini-3.8-flash")
    );
    assert.deepEqual(cfg.stopSequences, ["a", "b"]);
  });

  test("never sends thinkingConfig to an image model", () => {
    for (const model of [
      "gemini-3.1-flash-image",
      "gemini-3-pro-image-preview",
      "gemini-3.1-flash-image-preview-4k",
    ]) {
      const cfg = buildGenerationConfig(req(), parseModelName(model));
      assert.equal(cfg.thinkingConfig, undefined, model);
    }
  });

  test("asks image models for the IMAGE modality even without a size suffix", () => {
    const cfg = buildGenerationConfig(
      req(),
      parseModelName("gemini-3.1-flash-image")
    );
    assert.deepEqual(cfg.responseModalities, ["TEXT", "IMAGE"]);
    assert.equal(cfg.imageConfig, undefined);
  });

  test("maps the size suffixes to imageConfig", () => {
    assert.deepEqual(
      buildGenerationConfig(req(), parseModelName("gemini-3.1-flash-image-2k"))
        .imageConfig,
      { imageSize: "2K" }
    );
    assert.deepEqual(
      buildGenerationConfig(req(), parseModelName("gemini-3.1-flash-image-4k"))
        .imageConfig,
      { imageSize: "4K" }
    );
  });

  test("maps reasoning_effort to a Gemini 3 thinking level", () => {
    const cfg = buildGenerationConfig(
      req({ reasoning_effort: "high" }),
      parseModelName("gemini-3-pro-preview")
    );
    assert.equal(cfg.thinkingConfig?.thinkingLevel, "HIGH");
  });

  test("uses thinkingLevel — never a budget — across the Gemini 3 series", () => {
    for (const model of [
      "gemini-3-flash-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.6-flash",
      "gemini-3.7-flash",
      "gemini-3.8-flash",
    ]) {
      const cfg = buildGenerationConfig(
        req({ reasoning_effort: "high" }),
        parseModelName(model)
      );
      assert.equal(cfg.thinkingConfig?.thinkingLevel, "HIGH", model);
      assert.equal(cfg.thinkingConfig?.thinkingBudget, undefined, model);
    }
  });

  test("gemini-3.8-flash never receives thinkingLevel MINIMAL", () => {
    for (const effort of ["none", "minimal"]) {
      const cfg = buildGenerationConfig(
        req({ reasoning_effort: effort }),
        parseModelName("gemini-3.8-flash")
      );
      assert.equal(cfg.thinkingConfig?.thinkingLevel, "LOW", effort);
    }
  });

  test("other Gemini 3 models still get MINIMAL", () => {
    const cfg = buildGenerationConfig(
      req({ reasoning_effort: "none" }),
      parseModelName("gemini-3.1-pro-preview")
    );
    assert.equal(cfg.thinkingConfig?.thinkingLevel, "MINIMAL");
  });

  test("3.x flash-lite keeps thinkingLevel rather than the 2.5 lite behaviour", () => {
    const cfg = buildGenerationConfig(
      req(),
      parseModelName("gemini-3.5-flash-lite")
    );
    assert.equal(cfg.thinkingConfig?.includeThoughts, true);
    assert.equal(cfg.thinkingConfig?.thinkingBudget, undefined);
  });

  test("the -nothinking and -max suffixes set levels, not budgets", () => {
    const low = buildGenerationConfig(req(), parseModelName("gemini-3.5-flash-nothinking"));
    assert.equal(low.thinkingConfig?.thinkingLevel, "MINIMAL");
    assert.equal(low.thinkingConfig?.thinkingBudget, undefined);

    const high = buildGenerationConfig(req(), parseModelName("gemini-3.5-flash-max"));
    assert.equal(high.thinkingConfig?.thinkingLevel, "HIGH");
    assert.equal(high.thinkingConfig?.thinkingBudget, undefined);
  });

  test("-nothinking is clamped on a model that rejects MINIMAL", () => {
    const cfg = buildGenerationConfig(req(), parseModelName("gemini-3.8-flash-nothinking"));
    assert.equal(cfg.thinkingConfig?.thinkingLevel, "LOW");
  });

  test("retired Gemini 2.x gets no thinking config", () => {
    for (const model of ["gemini-2.5-pro", "gemini-2.0-flash-001"]) {
      assert.equal(
        buildGenerationConfig(req(), parseModelName(model)).thinkingConfig,
        undefined,
        model
      );
    }
  });
});

describe("convertMessagesToVertex", () => {
  const toolExchange: OpenAIMessage[] = [
    { role: "user", content: "weather?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"temp":21}' },
  ];

  test("uses role 'user' for function responses (Vertex rejects 'function')", () => {
    const contents = convertMessagesToVertex(toolExchange);
    const roles = contents.map((c) => c.role);
    assert.deepEqual(roles, ["user", "model", "user"]);
    for (const c of contents) {
      assert.ok(c.role === "user" || c.role === "model", `bad role: ${c.role}`);
    }
    assert.equal(
      contents[2].parts[0].functionResponse?.name,
      "get_weather"
    );
  });

  test("restores a thought signature the client echoed back", () => {
    const contents = convertMessagesToVertex([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "f", arguments: "{}" },
            thought_signature: "REAL_SIG",
          },
        ],
      } as OpenAIMessage,
    ]);
    assert.equal(contents[0].parts[0].thoughtSignature, "REAL_SIG");
  });

  test("accepts a signature nested under extra_content", () => {
    const contents = convertMessagesToVertex([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "f", arguments: "{}" },
            extra_content: { google: { thought_signature: "NESTED" } },
          },
        ],
      } as unknown as OpenAIMessage,
    ]);
    assert.equal(contents[0].parts[0].thoughtSignature, "NESTED");
  });

  test("falls back to the skip placeholder on the first call only", () => {
    const contents = convertMessagesToVertex(
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "a", type: "function", function: { name: "f", arguments: "{}" } },
            { id: "b", type: "function", function: { name: "g", arguments: "{}" } },
          ],
        } as OpenAIMessage,
      ],
      { signPlaceholder: true }
    );
    assert.equal(contents[0].parts[0].thoughtSignature, SIGNATURE_PLACEHOLDER);
    assert.equal(contents[0].parts[1].thoughtSignature, undefined);
  });

  test("adds no placeholder when not requested", () => {
    const contents = convertMessagesToVertex([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a", type: "function", function: { name: "f", arguments: "{}" } },
        ],
      } as OpenAIMessage,
    ]);
    assert.equal(contents[0].parts[0].thoughtSignature, undefined);
  });

  test("converts data: image URLs to inlineData", () => {
    const contents = convertMessagesToVertex([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA" },
          },
        ],
      },
    ]);
    assert.deepEqual(contents[0].parts[1].inlineData, {
      mimeType: "image/png",
      data: "AAAA",
    });
  });

  test("never returns an empty contents array", () => {
    assert.equal(convertMessagesToVertex([]).length, 1);
  });
});

describe("buildVertexGenerateContentBody", () => {
  test("lifts system messages into systemInstruction", () => {
    const body = buildVertexGenerateContentBody(
      req({
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      }),
      parseModelName("gemini-3.8-flash")
    );
    assert.deepEqual(body.systemInstruction, { parts: [{ text: "be terse" }] });
    assert.equal(body.contents.length, 1);
    assert.equal(body.contents[0].role, "user");
  });

  test("signs tool history for every supported Gemini 3 model", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a", type: "function", function: { name: "f", arguments: "{}" } },
        ],
      },
    ];
    for (const model of ["gemini-3-flash-preview", "gemini-3.8-flash"]) {
      const body = buildVertexGenerateContentBody(
        req({ messages }),
        parseModelName(model)
      );
      assert.equal(
        body.contents[0].parts[0].thoughtSignature,
        SIGNATURE_PLACEHOLDER,
        model
      );
    }
  });

  test("adds the googleSearch tool for -search models", () => {
    const body = buildVertexGenerateContentBody(
      req(),
      parseModelName("gemini-3.5-flash-search")
    );
    assert.ok(body.tools?.some((t) => "googleSearch" in t));
  });
});

describe("buildOpenAICompatibleBody", () => {
  test("prefixes the model with google/", () => {
    const body = buildOpenAICompatibleBody(
      req(),
      parseModelName("[PAY] gemini-3.1-pro-preview")
    );
    assert.equal(body.model, "google/gemini-3.1-pro-preview");
  });

  test("forwards stream_options so usage is reported", () => {
    const body = buildOpenAICompatibleBody(
      req({ stream: true, stream_options: { include_usage: true } }),
      parseModelName("gemini-3.8-flash")
    );
    assert.deepEqual(body.stream_options, { include_usage: true });
  });

  test("expresses reasoning_effort as thinking_level on Gemini 3", () => {
    const body = buildOpenAICompatibleBody(
      req({ reasoning_effort: "minimal" }),
      parseModelName("gemini-3.1-pro-preview")
    );
    const google = (body.extra_body as { google: Record<string, unknown> }).google;
    assert.deepEqual(google.thinking_config, {
      include_thoughts: true,
      thinking_level: "minimal",
    });
    // thinking_level is authoritative; a stale reasoning_effort would fight it.
    assert.equal(body.reasoning_effort, undefined);
  });

  test("downgrades minimal to low on gemini-3.8-flash", () => {
    const body = buildOpenAICompatibleBody(
      req({ reasoning_effort: "minimal" }),
      parseModelName("gemini-3.8-flash")
    );
    const google = (body.extra_body as { google: Record<string, unknown> }).google;
    assert.deepEqual(google.thinking_config, {
      include_thoughts: true,
      thinking_level: "low",
    });
  });

  test("drops an unknown reasoning_effort", () => {
    const body = buildOpenAICompatibleBody(
      req({ reasoning_effort: "extreme" }),
      parseModelName("gemini-3-pro-preview")
    );
    assert.equal(body.reasoning_effort, undefined);
  });

  test("sends no thinking config for image models", () => {
    const body = buildOpenAICompatibleBody(
      req(),
      parseModelName("gemini-3-pro-image-preview")
    );
    const google = (body.extra_body as { google: Record<string, unknown> }).google;
    assert.equal(google.thinking_config, undefined);
    assert.deepEqual(google.response_modalities, ["TEXT", "IMAGE"]);
  });
});

describe("convertResponseFormat", () => {
  test("maps json_object to a JSON mime type", () => {
    assert.deepEqual(convertResponseFormat({ type: "json_object" }), {
      responseMimeType: "application/json",
    });
  });

  test("maps json_schema to responseSchema", () => {
    assert.deepEqual(
      convertResponseFormat({
        type: "json_schema",
        json_schema: {
          name: "Person",
          schema: { type: "object", properties: { name: { type: "string" } } },
        },
      }),
      {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      }
    );
  });

  test("ignores plain text", () => {
    assert.equal(convertResponseFormat({ type: "text" }), undefined);
    assert.equal(convertResponseFormat(undefined), undefined);
  });
});

describe("stripUnsupportedSchemaKeys", () => {
  test("removes the keywords Vertex rejects, at every depth", () => {
    const cleaned = stripUnsupportedSchemaKeys({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        nested: {
          type: "object",
          additionalProperties: false,
          properties: { a: { type: "string" } },
        },
        list: {
          type: "array",
          items: { type: "object", additionalProperties: false },
        },
      },
      required: ["nested"],
    });

    assert.deepEqual(cleaned, {
      type: "object",
      properties: {
        nested: { type: "object", properties: { a: { type: "string" } } },
        list: { type: "array", items: { type: "object" } },
      },
      required: ["nested"],
    });
  });

  test("leaves a clean schema untouched", () => {
    const schema = { type: "string", enum: ["a", "b"] };
    assert.deepEqual(stripUnsupportedSchemaKeys(schema), schema);
  });
});

describe("penalties and structured output on the native path", () => {
  test("forwards penalties to models that accept them", () => {
    const cfg = buildGenerationConfig(
      req({ frequency_penalty: 0.5, presence_penalty: -0.2 }),
      parseModelName("gemini-3.5-flash")
    );
    assert.equal(cfg.frequencyPenalty, 0.5);
    assert.equal(cfg.presencePenalty, -0.2);
  });

  test("drops penalties on gemini-3.8-flash, which rejects them", () => {
    // Live API: 400 "Penalty is not enabled for this model".
    const cfg = buildGenerationConfig(
      req({ frequency_penalty: 0.5, presence_penalty: -0.2 }),
      parseModelName("gemini-3.8-flash")
    );
    assert.equal(cfg.frequencyPenalty, undefined);
    assert.equal(cfg.presencePenalty, undefined);
  });

  test("applies response_format to generationConfig", () => {
    const cfg = buildGenerationConfig(
      req({ response_format: { type: "json_object" } }),
      parseModelName("gemini-3.8-flash")
    );
    assert.equal(cfg.responseMimeType, "application/json");
  });
});

describe("signToolCallsForOpenAIEndpoint", () => {
  const assistant = (toolCalls: unknown[]): OpenAIMessage =>
    ({ role: "assistant", content: null, tool_calls: toolCalls } as OpenAIMessage);
  const sigOf = (msg: OpenAIMessage, i = 0) =>
    (msg.tool_calls![i] as unknown as {
      extra_content?: { google?: { thought_signature?: string } };
    }).extra_content?.google?.thought_signature;

  test("adds the placeholder when the client stripped the signature", () => {
    const out = signToolCallsForOpenAIEndpoint([
      assistant([{ id: "a", type: "function", function: { name: "f", arguments: "{}" } }]),
    ]);
    assert.equal(sigOf(out[0]), SIGNATURE_PLACEHOLDER);
  });

  test("keeps a real signature the client echoed back bare", () => {
    const out = signToolCallsForOpenAIEndpoint([
      assistant([
        {
          id: "a",
          type: "function",
          function: { name: "f", arguments: "{}" },
          thought_signature: "REAL",
        },
      ]),
    ]);
    assert.equal(sigOf(out[0]), "REAL");
  });

  test("keeps a signature already nested under extra_content", () => {
    const out = signToolCallsForOpenAIEndpoint([
      assistant([
        {
          id: "a",
          type: "function",
          function: { name: "f", arguments: "{}" },
          extra_content: { google: { thought_signature: "NESTED" } },
        },
      ]),
    ]);
    assert.equal(sigOf(out[0]), "NESTED");
  });

  test("signs only the first call of a step", () => {
    const out = signToolCallsForOpenAIEndpoint([
      assistant([
        { id: "a", type: "function", function: { name: "f", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "g", arguments: "{}" } },
      ]),
    ]);
    assert.equal(sigOf(out[0], 0), SIGNATURE_PLACEHOLDER);
    assert.equal(sigOf(out[0], 1), undefined);
  });

  test("leaves messages without tool calls untouched", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    assert.deepEqual(signToolCallsForOpenAIEndpoint(messages), messages);
  });

  test("the OpenAI-compatible body carries the signature through", () => {
    const body = buildOpenAICompatibleBody(
      req({
        messages: [
          { role: "user", content: "weather?" },
          assistant([
            { id: "a", type: "function", function: { name: "f", arguments: "{}" } },
          ]),
          { role: "tool", tool_call_id: "a", content: "{}" },
        ],
      }),
      parseModelName("[PAY] gemini-3.8-flash")
    );
    const messages = body.messages as OpenAIMessage[];
    assert.equal(sigOf(messages[1]), SIGNATURE_PLACEHOLDER);
  });
});
