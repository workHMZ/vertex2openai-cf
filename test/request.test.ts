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
  signToolCallsForOpenAIEndpoint,
  guessImageMimeType,
} from "../src/converters/request";
import { convertToolsToVertex, convertToolChoiceToVertex } from "../src/converters/tools";
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

  test("gives http image URLs the MIME type Vertex requires", () => {
    // Live Vertex: "empty mimeType parameter in fileData" without one.
    const contents = convertMessagesToVertex([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://x.test/a/cat.PNG?w=1" } },
          { type: "image_url", image_url: { url: "https://x.test/img/12345" } },
        ],
      },
    ]);
    assert.deepEqual(contents[0].parts[0].fileData, {
      mimeType: "image/png",
      fileUri: "https://x.test/a/cat.PNG?w=1",
    });
    assert.equal(contents[0].parts[1].fileData?.mimeType, "image/jpeg");
  });

  test("never returns an empty contents array", () => {
    assert.equal(convertMessagesToVertex([]).length, 1);
  });
});

describe("convertToolsToVertex", () => {
  test("sends the client's JSON Schema unchanged as parametersJsonSchema", () => {
    // Both of these 400 in the OpenAPI-subset `parameters` field.
    const parameters = {
      type: "object",
      properties: {
        party: { $ref: "#/$defs/Party" },
        note: { type: ["string", "null"] },
      },
      $defs: { Party: { type: "object", properties: { size: { type: "integer" } } } },
    };
    const [decl] = convertToolsToVertex([
      { type: "function", function: { name: "book", description: "d", parameters } },
    ]);
    assert.deepEqual(decl, { name: "book", description: "d", parametersJsonSchema: parameters });
  });

  test("omits the schema for a tool without parameters", () => {
    const [decl] = convertToolsToVertex([{ type: "function", function: { name: "ping" } }]);
    assert.deepEqual(decl, { name: "ping" });
  });
});

describe("tool results on the native path", () => {
  const withToolResult = (content: OpenAIMessage["content"]) =>
    convertMessagesToVertex([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "f", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content },
    ])[2].parts[0].functionResponse?.response;

  test("passes a JSON object through as the response", () => {
    assert.deepEqual(withToolResult('{"temp":21}'), { temp: 21 });
  });

  test("wraps a JSON array, which Vertex rejects as a Struct", () => {
    // Live Vertex: "Proto field is not repeating, cannot start list".
    assert.deepEqual(withToolResult('["Tokyo","Osaka"]'), {
      result: ["Tokyo", "Osaka"],
    });
  });

  test("reads text out of a content-part array", () => {
    assert.deepEqual(
      withToolResult([
        { type: "text", text: "sunny, " },
        { type: "text", text: "21C" },
      ]),
      { result: "sunny, 21C" }
    );
  });

  test("keeps plain text and malformed JSON as text", () => {
    assert.deepEqual(withToolResult("sunny"), { result: "sunny" });
    assert.deepEqual(withToolResult("{oops"), { result: "{oops" });
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
    // The endpoint rejects it; image models are routed natively instead.
    assert.equal(google.response_modalities, undefined);
  });

  test("never forwards reasoning_effort, only thinking_level", () => {
    const body = buildOpenAICompatibleBody(
      req({ reasoning_effort: "high" }),
      parseModelName("gemini-3.8-flash")
    );
    assert.equal(body.reasoning_effort, undefined);
    const google = (body.extra_body as { google: Record<string, unknown> }).google;
    assert.deepEqual(google.thinking_config, { include_thoughts: true, thinking_level: "high" });
  });
});

describe("convertResponseFormat", () => {
  test("maps json_object to a JSON mime type", () => {
    assert.deepEqual(convertResponseFormat({ type: "json_object" }), {
      responseMimeType: "application/json",
    });
  });

  // Pydantic-style: $defs/$ref, additionalProperties, $schema. The old
  // responseSchema field 400s on "$ref"; responseFormat takes it as-is.
  const pydanticSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { city: { type: "string" }, party: { $ref: "#/$defs/Party" } },
    required: ["city", "party"],
    additionalProperties: false,
    $defs: {
      Party: {
        type: "object",
        properties: { size: { type: "integer" } },
        additionalProperties: false,
      },
    },
  };

  test("passes a json_schema through responseFormat untouched", () => {
    assert.deepEqual(
      convertResponseFormat({
        type: "json_schema",
        json_schema: { name: "Booking", schema: pydanticSchema },
      }),
      {
        responseFormat: {
          text: { mimeType: "APPLICATION_JSON", schema: pydanticSchema },
        },
      }
    );
  });

  test("falls back to a JSON mime type for json_schema without a schema", () => {
    assert.deepEqual(
      convertResponseFormat({ type: "json_schema", json_schema: { name: "x" } }),
      { responseMimeType: "application/json" }
    );
  });

  test("ignores plain text", () => {
    assert.equal(convertResponseFormat({ type: "text" }), undefined);
    assert.equal(convertResponseFormat(undefined), undefined);
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

describe("multi-turn conversations on the native path", () => {
  test("maps a plain chat history onto alternating user/model turns", () => {
    const body = buildVertexGenerateContentBody(
      req({
        messages: [
          { role: "system", content: [{ type: "text", text: "be brief" }] },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello!" },
          { role: "user", content: "and again" },
        ],
      }),
      parseModelName("gemini-3.8-flash")
    );
    assert.deepEqual(body.systemInstruction, { parts: [{ text: "be brief" }] });
    assert.deepEqual(
      body.contents.map((c) => [c.role, c.parts[0].text]),
      [["user", "hi"], ["model", "hello!"], ["user", "and again"]]
    );
  });

  test("skips messages with no content at all", () => {
    const contents = convertMessagesToVertex([
      { role: "user", content: null },
      { role: "user", content: "real" },
    ]);
    assert.deepEqual(contents, [{ role: "user", parts: [{ text: "real" }] }]);
  });

  test("keeps the text an assistant sent alongside its tool calls", () => {
    const contents = convertMessagesToVertex([
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [
          { id: "a", type: "function", function: { name: "f", arguments: "not json" } },
        ],
      },
    ]);
    assert.deepEqual(contents[0].parts[0].functionCall?.args, {});
    assert.deepEqual(contents[0].parts[1], { text: "Let me check." });
  });
});

describe("guessImageMimeType", () => {
  test("reads the extension, ignoring query strings and case", () => {
    assert.equal(guessImageMimeType("https://x.test/a.WEBP?v=2"), "image/webp");
    assert.equal(guessImageMimeType("gs://bucket/scan.pdf"), "application/pdf");
  });

  test("falls back to JPEG for anything it cannot place", () => {
    assert.equal(guessImageMimeType("https://x.test/photo"), "image/jpeg");
    assert.equal(guessImageMimeType("not a url.heic"), "image/heic");
  });
});

describe("convertToolChoiceToVertex", () => {
  const mode = (c: Parameters<typeof convertToolChoiceToVertex>[0]) =>
    convertToolChoiceToVertex(c)?.functionCallingConfig;

  test("maps every OpenAI string choice", () => {
    assert.deepEqual(mode("none"), { mode: "NONE" });
    assert.deepEqual(mode("auto"), { mode: "AUTO" });
    assert.deepEqual(mode("required"), { mode: "ANY" });
    assert.deepEqual(mode("validated"), { mode: "VALIDATED" });
    assert.equal(mode("bogus"), undefined);
    assert.equal(mode(undefined), undefined);
  });

  test("pins a named function with ANY + allowedFunctionNames", () => {
    assert.deepEqual(mode({ type: "function", function: { name: "get_weather" } }), {
      mode: "ANY",
      allowedFunctionNames: ["get_weather"],
    });
    assert.equal(mode({ type: "allowed_tools" }), undefined);
  });

  test("reaches the native request body", () => {
    const body = buildVertexGenerateContentBody(
      req({ tool_choice: "required", tools: [{ type: "function", function: { name: "f" } }] }),
      parseModelName("gemini-3.8-flash")
    );
    assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: "ANY" } });
  });
});

describe("buildOpenAICompatibleBody passthrough", () => {
  test("forwards the OpenAI parameters the endpoint understands", () => {
    const body = buildOpenAICompatibleBody(
      req({
        max_completion_tokens: 50,
        parallel_tool_calls: false,
        stop: ["END"],
        seed: 7,
        n: 1,
        top_p: 0.5,
        temperature: 0.2,
        response_format: { type: "json_object" },
        tool_choice: "none",
      }),
      parseModelName("gemini-3.8-flash")
    );
    assert.equal(body.max_completion_tokens, 50);
    assert.equal(body.parallel_tool_calls, false);
    assert.deepEqual(body.stop, ["END"]);
    assert.equal(body.seed, 7);
    assert.equal(body.top_p, 0.5);
    assert.equal(body.temperature, 0.2);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.tool_choice, "none");
  });

  test("-openaisearch turns on web search", () => {
    const body = buildOpenAICompatibleBody(req(), parseModelName("gemini-3.8-flash-openaisearch"));
    assert.deepEqual(body.web_search_options, {});
    assert.equal(body.model, "google/gemini-3.8-flash");
  });
});

test("convertMessagesToVertex maps a stray system message to user", () => {
  // buildVertexGenerateContentBody lifts system messages out first; called
  // directly, the converter must still only emit roles Vertex accepts.
  const contents = convertMessagesToVertex([{ role: "system", content: "rules" }]);
  assert.equal(contents[0].role, "user");
});
