import { test, describe, beforeEach, afterEach } from "node:test";
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
    assert.equal(cfg.responseMimeType, "application/json");
    assert.deepEqual(cfg.responseSchema, { type: "object" });
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

  test("needs auth and rejects GET", async () => {
    assert.equal((await call("/v1/responses", { method: "POST" })).status, 401);
    assert.equal(
      (await call("/v1/responses", { method: "GET", headers: authed() })).status,
      405
    );
  });
});
