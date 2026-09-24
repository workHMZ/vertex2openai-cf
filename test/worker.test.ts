import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

// workerd exposes a non-standard crypto.subtle.timingSafeEqual; Node does not.
if (!(crypto.subtle as { timingSafeEqual?: unknown }).timingSafeEqual) {
  (crypto.subtle as unknown as Record<string, unknown>).timingSafeEqual = (
    a: ArrayBuffer,
    b: ArrayBuffer
  ) => nodeTimingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const worker = (await import("../src/index")).default;
import { loadModelsConfig } from "../src/handlers/models";
import { STREAM_START_TIMEOUT_MS } from "../src/vertex/dispatch";
import type { Env } from "../src/types";

/**
 * A throwaway service account whose key is generated at test time, so the
 * Service Account path exercises real JWT signing without committing any key.
 */
async function makeServiceAccountJson(): Promise<string> {
  const { privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const der = await crypto.subtle.exportKey("pkcs8", privateKey);
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  return JSON.stringify({
    type: "service_account",
    project_id: "my-project",
    private_key: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
    client_email: "sa@my-project.iam.gserviceaccount.com",
  });
}

const SA_JSON = await makeServiceAccountJson();

const ENV: Env = {
  API_KEY: "secret-key",
  VERTEX_EXPRESS_API_KEY: "express-1",
};

const call = (path: string, init: RequestInit = {}, env: Env = ENV) =>
  worker.fetch(new Request(`https://adapter.example${path}`, init), env);

const authed = (extra: HeadersInit = {}) => ({
  Authorization: "Bearer secret-key",
  "Content-Type": "application/json",
  ...(extra as Record<string, string>),
});

// ----- fetch stubbing -----

interface Upstream {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let calls: Upstream[] = [];
let realFetch: typeof globalThis.fetch;

/** Replace global fetch with a queue of canned upstream responses. */
function stubFetch(responses: Array<() => Response>) {
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    // The Service Account path exchanges a JWT for a token first; that is not
    // one of the canned Vertex responses and must not consume one.
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({ access_token: "stub-token", expires_in: 3600 }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return next();
  }) as typeof globalThis.fetch;
}

const jsonResponse = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const OK_VERTEX = jsonResponse({
  candidates: [
    { content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" },
  ],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
});

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("routing", () => {
  test("health check needs no auth", async () => {
    const res = await call("/");
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { status: string }).status, "ok");
  });

  test("health check rejects POST", async () => {
    assert.equal((await call("/", { method: "POST" })).status, 405);
  });

  test("preflight is answered without auth", async () => {
    const res = await call("/v1/chat/completions", { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  test("preflight allows the headers the OpenAI SDK sends from a browser", async () => {
    const requested = "authorization,content-type,x-stainless-os,x-stainless-retry-count";
    const res = await call("/v1/chat/completions", {
      method: "OPTIONS",
      headers: { "Access-Control-Request-Headers": requested },
    });
    assert.equal(res.headers.get("Access-Control-Allow-Headers"), requested);
    assert.equal(res.headers.get("Vary"), "Access-Control-Request-Headers");
  });

  test("a trailing slash still routes", async () => {
    const res = await call("/v1/models/", { headers: authed() });
    assert.equal(res.status, 200);
  });

  test("unknown endpoints 404 with CORS", async () => {
    const res = await call("/v1/embeddings", { headers: authed() });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  test("wrong method on a known route is 405", async () => {
    const res = await call("/v1/models", { method: "POST", headers: authed() });
    assert.equal(res.status, 405);
  });
});

describe("authentication", () => {
  test("rejects a missing header", async () => {
    assert.equal((await call("/v1/models")).status, 401);
  });

  test("rejects a non-Bearer header", async () => {
    const res = await call("/v1/models", { headers: { Authorization: "secret-key" } });
    assert.equal(res.status, 401);
  });

  test("rejects a wrong key", async () => {
    const res = await call("/v1/models", { headers: { Authorization: "Bearer nope" } });
    assert.equal(res.status, 401);
  });

  test("fails closed when API_KEY is unset", async () => {
    const res = await call(
      "/v1/models",
      { headers: { Authorization: "Bearer anything" } },
      { ...ENV, API_KEY: "" } as Env
    );
    assert.equal(res.status, 401);
  });

  test("accepts the configured key", async () => {
    assert.equal((await call("/v1/models", { headers: authed() })).status, 200);
  });
});

describe("GET /v1/models", () => {
  test("lists Express models when only an Express key is set", async () => {
    const res = await call("/v1/models", { headers: authed() });
    const ids = (await res.json() as { data: { id: string }[] }).data.map((m) => m.id);
    assert.ok(ids.includes("[EXPRESS] gemini-3.8-flash"));
    assert.ok(!ids.some((id) => id.startsWith("[PAY]")));
  });

  test("every id round-trips back to a usable model name", async () => {
    const { parseModelName } = await import("../src/converters/request");
    const res = await call("/v1/models", { headers: authed() });
    for (const { id } of (await res.json() as { data: { id: string }[] }).data) {
      const parsed = parseModelName(id);
      assert.ok(parsed.baseModel.length > 0, id);
      assert.ok(!parsed.baseModel.includes("["), id);
      assert.ok(!parsed.baseModel.startsWith(" "), `leading space in ${id}`);
    }
  });

  test("never advertises thinking or search variants for image models", async () => {
    const res = await call("/v1/models", { headers: authed() });
    const ids = (await res.json() as { data: { id: string }[] }).data.map((m) => m.id);
    for (const id of ids.filter((i) => i.includes("image"))) {
      assert.ok(!id.endsWith("-nothinking"), id);
      assert.ok(!id.endsWith("-max"), id);
      assert.ok(!id.endsWith("-search"), id);
    }
  });

  test("offers image models no OpenAI-endpoint or search variants", async () => {
    // Image models always go native, and search 400s or comes back empty on them.
    const res = await call("/v1/models", { headers: authed() }, {
      API_KEY: "secret-key",
      GOOGLE_CREDENTIALS_JSON: SA_JSON,
    });
    const ids = (await res.json() as { data: { id: string }[] }).data.map((m) => m.id);
    const image = ids.filter((i) => i.includes("image"));
    assert.ok(image.length > 0);
    for (const id of image) {
      assert.match(id, /image(-2k|-4k)?$/, id);
    }
    assert.ok(ids.includes("[PAY] gemini-3.8-flash-openaisearch"));
  });

  test("returns an empty list when nothing is configured", async () => {
    const res = await call("/v1/models", { headers: authed() }, { API_KEY: "secret-key" });
    assert.deepEqual((await res.json() as { data: unknown[] }).data, []);
  });
});

describe("loadModelsConfig", () => {
  test("falls back to the built-in list on malformed JSON", () => {
    assert.ok(loadModelsConfig("{not json").vertex_models.length > 0);
  });

  test("falls back when neither array is present", () => {
    assert.ok(loadModelsConfig('{"foo":1}').vertex_models.length > 0);
  });

  test("accepts a partial override", () => {
    const cfg = loadModelsConfig('{"vertex_express_models":["m"]}');
    assert.deepEqual(cfg.vertex_express_models, ["m"]);
    assert.deepEqual(cfg.vertex_models, []);
  });
});

describe("POST /v1/chat/completions", () => {
  test("rejects a malformed body", async () => {
    const res = await call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: "{",
    });
    assert.equal(res.status, 400);
  });

  test("requires model and messages", async () => {
    for (const body of [{ messages: [{ role: "user", content: "x" }] }, { model: "m" }]) {
      const res = await call("/v1/chat/completions", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  test("calls the Express endpoint and returns OpenAI shape", async () => {
    stubFetch([OK_VERTEX]);
    const res = await call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as {
      object: string;
      model: string;
      choices: { message: { content: string }; finish_reason: string }[];
    };
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "gemini-3.8-flash");
    assert.equal(body.choices[0].message.content, "hello");
    assert.equal(body.choices[0].finish_reason, "stop");

    assert.equal(
      calls[0].url,
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent"
    );
  });

  test("sends the Express key as a header, never in the URL", async () => {
    stubFetch([OK_VERTEX]);
    await call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.ok(!calls[0].url.includes("express-1"), calls[0].url);
    assert.equal(calls[0].headers["x-goog-api-key"], "express-1");
  });

  test("adds alt=sse only when streaming", async () => {
    stubFetch([
      () =>
        new Response(
          'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP"}]}\n\n',
          { headers: { "Content-Type": "text/event-stream" } }
        ),
    ]);
    const res = await call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    assert.equal(res.headers.get("Content-Type"), "text/event-stream");
    assert.ok(calls[0].url.endsWith(":streamGenerateContent?alt=sse"), calls[0].url);
    assert.ok((await res.text()).trimEnd().endsWith("data: [DONE]"));
  });

  test("rotates to the next Express key after a 429", async () => {
    stubFetch([jsonResponse({ error: "quota" }, 429), OK_VERTEX]);
    const res = await call(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({
          model: "gemini-3.8-flash",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      { ...ENV, VERTEX_EXPRESS_API_KEY: "key-a,key-b" }
    );

    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].headers["x-goog-api-key"], calls[1].headers["x-goog-api-key"]);
  });

  test("does not retry a 400 — another key would fail the same way", async () => {
    stubFetch([jsonResponse({ error: "bad request" }, 400)]);
    const res = await call(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({
          model: "gemini-3.8-flash",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      { ...ENV, VERTEX_EXPRESS_API_KEY: "key-a,key-b" }
    );

    assert.equal(res.status, 400);
    assert.equal(calls.length, 1);
  });

  test("reports a clear error when a [PAY] model has no service account", async () => {
    const res = await call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "[PAY] gemini-3.1-pro-preview",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(res.status, 500);
    const body = await res.json() as { error: { message: string } };
    assert.match(body.error.message, /GOOGLE_CREDENTIALS_JSON/);
  });

  test("-openai requires a service account rather than silently using Express", async () => {
    const res = await call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-3.1-pro-preview-openai",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(res.status, 500);
    assert.match(
      (await res.json() as { error: { message: string } }).error.message,
      /GOOGLE_CREDENTIALS_JSON/
    );
  });

  test("rejects a retired Gemini 2.x model with a clear message", async () => {
    stubFetch([OK_VERTEX]);
    const res = await call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(res.status, 400);
    assert.match(
      (await res.json() as { error: { message: string } }).error.message,
      /end of life/
    );
    // Nothing should reach Vertex.
    assert.equal(calls.length, 0);
  });

  test("keeps an upstream 5xx as a 5xx", async () => {
    stubFetch([jsonResponse({ error: "boom" }, 503)]);
    const res = await call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(res.status, 503);
  });

  test("does not report an upstream credential failure as a client 401", async () => {
    stubFetch([jsonResponse({ error: "API keys are not supported" }, 401)]);
    const res = await call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    // A 401 here would be indistinguishable from a bad adapter API_KEY.
    assert.equal(res.status, 502);
    assert.match(
      (await res.json() as { error: { message: string } }).error.message,
      /API keys are not supported/
    );
  });

  test("turns an unusable upstream status into 502", async () => {
    stubFetch([() => new Response("moved", { status: 302 })]);
    const res = await call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(res.status, 502);
  });

  test("survives a network failure without throwing", async () => {
    stubFetch([
      () => {
        throw new Error("connection reset");
      },
    ]);
    const res = await call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(res.status, 502);
    assert.match(
      (await res.json() as { error: { message: string } }).error.message,
      /connection reset/
    );
  });

  test("sends gemini-3.8-flash a thinkingLevel, never a thinkingBudget", async () => {
    stubFetch([OK_VERTEX]);
    await call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "none",
      }),
    });

    const cfg = (calls[0].body.generationConfig as {
      thinkingConfig?: Record<string, unknown>;
    }).thinkingConfig!;
    // "none" would map to MINIMAL, which gemini-3.8-flash rejects with a 400.
    assert.equal(cfg.thinkingLevel, "LOW");
    assert.equal(cfg.thinkingBudget, undefined);
    assert.ok(
      calls[0].url.includes("gemini-3.8-flash:generateContent"),
      calls[0].url
    );
  });

  test("signs Gemini 3.8 tool history so the request is not rejected", async () => {
    stubFetch([OK_VERTEX]);
    await call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "w", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: "{}" },
        ],
      }),
    });

    const contents = calls[0].body.contents as {
      parts: { thoughtSignature?: string }[];
    }[];
    assert.equal(contents[1].parts[0].thoughtSignature, "skip_thought_signature_validator");
  });

  test("sends image models no thinking config and asks for the IMAGE modality", async () => {
    stubFetch([OK_VERTEX]);
    await call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-3.1-flash-image",
        messages: [{ role: "user", content: "a cat" }],
      }),
    });

    const cfg = calls[0].body.generationConfig as Record<string, unknown>;
    assert.equal(cfg.thinkingConfig, undefined);
    assert.deepEqual(cfg.responseModalities, ["TEXT", "IMAGE"]);
  });

  test("routes image models to native generateContent, not the OpenAI endpoint", async () => {
    // The OpenAI-compatible endpoint rejects response_modalities outright, so
    // an image model must take the native route even on a service account.
    stubFetch([OK_VERTEX]);
    await call(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({
          model: "[PAY] gemini-3.1-flash-image",
          messages: [{ role: "user", content: "a cat" }],
        }),
      },
      { ...ENV, VERTEX_EXPRESS_API_KEY: undefined, GOOGLE_CREDENTIALS_JSON: SA_JSON } as Env
    );

    assert.match(calls[0].url, /publishers\/google\/models\/gemini-3\.1-flash-image:generateContent$/);
    assert.ok(!calls[0].url.includes("endpoints/openapi"), calls[0].url);
    const cfg = calls[0].body.generationConfig as Record<string, unknown>;
    assert.deepEqual(cfg.responseModalities, ["TEXT", "IMAGE"]);
    assert.equal(calls[0].body.extra_body, undefined);
  });

  test("keeps text models on the OpenAI-compatible endpoint", async () => {
    stubFetch([jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: {} })]);
    await call(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({
          model: "[PAY] gemini-3.8-flash",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      { ...ENV, VERTEX_EXPRESS_API_KEY: undefined, GOOGLE_CREDENTIALS_JSON: SA_JSON } as Env
    );
    assert.match(calls[0].url, /endpoints\/openapi\/chat\/completions$/);
  });

  test("sends only roles Vertex accepts", async () => {
    stubFetch([OK_VERTEX]);
    await call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "w", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: "{}" },
        ],
      }),
    });

    const contents = calls[0].body.contents as { role: string }[];
    for (const c of contents) {
      assert.ok(["user", "model"].includes(c.role), `bad role: ${c.role}`);
    }
  });
});

describe("POST /v1/responses", () => {
  test("returns a Response object, not a chat completion", async () => {
    stubFetch([OK_VERTEX]);
    const res = await call("/v1/responses", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ model: "gemini-3.8-flash", input: "hi" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as {
      object: string;
      status: string;
      output: Array<{ type: string }>;
      output_text: string;
      usage: Record<string, unknown>;
    };
    assert.equal(body.object, "response");
    assert.equal(body.status, "completed");
    assert.equal(body.output[0].type, "message");
    assert.equal(body.output_text, "hello");
    assert.ok("input_tokens" in body.usage);
  });

  test("routes through the same Vertex endpoint as chat", async () => {
    stubFetch([OK_VERTEX]);
    await call("/v1/responses", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ model: "gemini-3.8-flash", input: "hi" }),
    });
    assert.equal(
      calls[0].url,
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent"
    );
  });

  test("translates instructions and tools before dispatch", async () => {
    stubFetch([OK_VERTEX]);
    await call("/v1/responses", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        instructions: "be terse",
        input: "weather?",
        tools: [
          {
            type: "function",
            name: "get_weather",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    });

    assert.deepEqual(calls[0].body.systemInstruction, {
      parts: [{ text: "be terse" }],
    });
    const tools = calls[0].body.tools as Array<{
      functionDeclarations?: Array<{ name: string }>;
    }>;
    assert.equal(tools[0].functionDeclarations?.[0].name, "get_weather");
  });

  test("maps text.format onto Gemini structured output", async () => {
    stubFetch([OK_VERTEX]);
    await call("/v1/responses", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        input: "hi",
        text: {
          format: {
            type: "json_schema",
            name: "Person",
            schema: { type: "object", additionalProperties: false },
          },
        },
      }),
    });

    const cfg = calls[0].body.generationConfig as Record<string, unknown>;
    assert.deepEqual(cfg.responseFormat, {
      text: {
        mimeType: "APPLICATION_JSON",
        schema: { type: "object", additionalProperties: false },
      },
    });
  });

  test("streams typed response.* events", async () => {
    stubFetch([
      () =>
        new Response(
          'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP"}]}\n\n',
          { headers: { "Content-Type": "text/event-stream" } }
        ),
    ]);
    const res = await call("/v1/responses", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        input: "hi",
        stream: true,
      }),
    });

    assert.equal(res.headers.get("Content-Type"), "text/event-stream");
    const text = await res.text();
    assert.match(text, /event: response\.created/);
    assert.match(text, /event: response\.output_text\.delta/);
    assert.match(text, /event: response\.completed/);
    // The Chat Completions sentinel must not leak into a Responses stream.
    assert.ok(!text.includes("data: [DONE]"));
  });

  test("rejects a retired model the same way chat does", async () => {
    const res = await call("/v1/responses", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ model: "gemini-2.5-flash", input: "hi" }),
    });
    assert.equal(res.status, 400);
    assert.match(
      (await res.json() as { error: { message: string } }).error.message,
      /end of life/
    );
  });

  test("requires model and input", async () => {
    for (const body of [{ input: "hi" }, { model: "gemini-3.8-flash" }]) {
      const res = await call("/v1/responses", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  test("refuses server-side state instead of silently dropping history", async () => {
    stubFetch([OK_VERTEX]);
    for (const [field, value] of [
      ["previous_response_id", "resp_123"],
      ["conversation", "conv_123"],
    ] as const) {
      const res = await call("/v1/responses", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ model: "gemini-3.8-flash", input: "and then?", [field]: value }),
      });
      assert.equal(res.status, 400, field);
      const err = (await res.json() as { error: { param: string } }).error;
      assert.equal(err.param, field);
    }
    assert.equal(calls.length, 0, "nothing should reach Vertex");
  });

  test("accepts an explicit null previous_response_id", async () => {
    stubFetch([OK_VERTEX]);
    const res = await call("/v1/responses", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ model: "gemini-3.8-flash", input: "hi", previous_response_id: null }),
    });
    assert.equal(res.status, 200);
  });

  test("needs auth and rejects GET", async () => {
    assert.equal((await call("/v1/responses", { method: "POST" })).status, 401);
    assert.equal(
      (await call("/v1/responses", { method: "GET", headers: authed() })).status,
      405
    );
  });
});

describe("failure paths", () => {
  const chatBody = (model = "gemini-3.8-flash", extra: Record<string, unknown> = {}) =>
    JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra });
  const post = (path: string, body: string, env: Env = ENV) =>
    call(path, { method: "POST", headers: authed(), body }, env);
  const message = async (res: Response) =>
    (await res.json() as { error: { message: string } }).error.message;

  test("GET on the chat route is 405, not a crash", async () => {
    const res = await call("/v1/chat/completions", { headers: authed() });
    assert.equal(res.status, 405);
  });

  test("a non-JSON 200 from Vertex becomes a 502 on both endpoints", async () => {
    for (const path of ["/v1/chat/completions", "/v1/responses"]) {
      stubFetch([() => new Response("<html>gateway</html>", { status: 200 })]);
      const body = path === "/v1/responses"
        ? JSON.stringify({ model: "gemini-3.8-flash", input: "hi" })
        : chatBody();
      const res = await post(path, body);
      assert.equal(res.status, 502, path);
      assert.match(await message(res), /Malformed response/, path);
    }
  });

  test("the Responses endpoint rejects a malformed body", async () => {
    const res = await post("/v1/responses", "{nope");
    assert.equal(res.status, 400);
  });

  test("says which setting is missing when nothing is configured", async () => {
    const res = await post("/v1/chat/completions", chatBody(), { API_KEY: "secret-key" });
    assert.equal(res.status, 500);
    assert.match(await message(res), /VERTEX_EXPRESS_API_KEY or GOOGLE_CREDENTIALS_JSON/);
  });

  test("[EXPRESS] without an Express key names the missing key", async () => {
    const res = await post("/v1/chat/completions", chatBody("[EXPRESS] gemini-3.8-flash"), {
      API_KEY: "secret-key",
      GOOGLE_CREDENTIALS_JSON: SA_JSON,
    });
    assert.equal(res.status, 500);
    assert.match(await message(res), /VERTEX_EXPRESS_API_KEY/);
  });

  test("a failed token exchange is reported, not thrown", async () => {
    // A different client_email so the token cache from other tests is not hit.
    const sa = JSON.parse(SA_JSON);
    sa.client_email = "broken@my-project.iam.gserviceaccount.com";
    globalThis.fetch = (async () =>
      new Response('{"error":"invalid_grant"}', { status: 400 })) as typeof fetch;
    const res = await post("/v1/chat/completions", chatBody("[PAY] gemini-3.8-flash"), {
      API_KEY: "secret-key",
      GOOGLE_CREDENTIALS_JSON: JSON.stringify(sa),
    });
    assert.equal(res.status, 500);
    assert.match(await message(res), /invalid_grant/);
  });

  test("a streaming reply without a body tries the next key", async () => {
    stubFetch([() => new Response(null, { status: 200 }), OK_VERTEX]);
    const res = await post("/v1/chat/completions", chatBody("gemini-3.8-flash", { stream: true }), {
      API_KEY: "secret-key",
      VERTEX_EXPRESS_API_KEY: "k1,k2",
    });
    assert.equal(calls.length, 2);
    assert.equal(res.status, 200);
  });

  test("an unexpected exception becomes a 500 with CORS", async () => {
    const env = new Proxy({ API_KEY: "secret-key" } as Env, {
      get(target, key) {
        if (key === "VERTEX_EXPRESS_API_KEY") throw new Error("binding exploded");
        return target[key as keyof Env];
      },
    });
    const res = await post("/v1/chat/completions", chatBody(), env);
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(await message(res), /binding exploded/);
  });
});

describe("a Vertex stream that never starts", () => {
  // Under rate limiting Vertex can hold a stream for minutes before answering.
  const STREAM_OK =
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP"}]}\n\n';

  /** Upstream that hangs for the first `hangs` calls until the caller aborts. */
  function stubHanging(hangs: number) {
    const seen: AbortSignal[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init!.signal!);
      if (seen.length <= hangs) {
        return new Promise<Response>((_, reject) =>
          init!.signal!.addEventListener("abort", () => reject(new Error("aborted")))
        );
      }
      return new Response(STREAM_OK, { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    return seen;
  }

  const until = async (cond: () => boolean) => {
    while (!cond()) await new Promise((r) => setImmediate(r));
  };

  const request = (stream: boolean, env: Env = ENV) =>
    call("/v1/chat/completions", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ model: "gemini-3.8-flash", stream, messages: [{ role: "user", content: "hi" }] }),
    }, env);

  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  test("waits out a long queue rather than giving up early", async () => {
    // 184 s was the longest successful wait measured; the cap must clear it.
    assert.ok(STREAM_START_TIMEOUT_MS >= 240_000);
    const seen = stubHanging(1);
    const pending = request(true);
    await until(() => seen.length === 1);
    mock.timers.tick(200_000);
    assert.equal(seen[0].aborted, false);
    mock.timers.tick(STREAM_START_TIMEOUT_MS);
    await pending;
  });

  test("returns a retryable 504 once the cap passes on a single key", async () => {
    const seen = stubHanging(1);
    const pending = request(true);
    await until(() => seen.length === 1);
    mock.timers.tick(STREAM_START_TIMEOUT_MS);
    const res = await pending;
    assert.equal(res.status, 504);
    assert.equal(seen.length, 1, "the same queue is not joined again");
    assert.match((await res.json() as { error: { message: string } }).error.message, /did not start responding/);
  });

  test("moves on to the next key once the cap passes", async () => {
    const seen = stubHanging(1);
    const pending = request(true, { API_KEY: "secret-key", VERTEX_EXPRESS_API_KEY: "k1,k2" });
    await until(() => seen.length === 1);
    mock.timers.tick(STREAM_START_TIMEOUT_MS);
    const res = await pending;
    assert.equal(res.status, 200);
    assert.equal(seen.length, 2);
    assert.match(await res.text(), /"content":"hi"[\s\S]*\[DONE\]/);
  });

  test("a non-streamed request is never cut off, however long it takes", async () => {
    let release!: () => void;
    let signal!: AbortSignal;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init!.signal!;
      await new Promise<void>((r) => (release = r));
      return OK_VERTEX();
    }) as typeof fetch;
    const pending = request(false);
    await until(() => signal !== undefined);
    mock.timers.tick(STREAM_START_TIMEOUT_MS * 10);
    assert.equal(signal.aborted, false);
    release();
    assert.equal((await pending).status, 200);
  });
});
