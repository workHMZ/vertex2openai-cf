// End-to-end tests against a running adapter and the real Vertex AI.
//
//   E2E_BASE_URL=http://localhost:8787 E2E_API_KEY=... npm run test:e2e
//
// Point it at `wrangler dev` or a deployed Worker. It reads GET /v1/models to
// see which credentials are configured and runs every route it can reach:
// [EXPRESS] models take Vertex's native generateContent, [PAY] models the
// OpenAI-compatible endpoint. Each request is kept small (low thinking,
// short replies); set E2E_SKIP_IMAGES=1 to leave out image generation, which
// costs noticeably more than the rest of the run put together.
//
// Optional: E2E_MODEL (default gemini-3.8-flash),
//           E2E_IMAGE_MODEL (default gemini-3.1-flash-lite-image).

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const KEY = process.env.E2E_API_KEY;
const TEXT_MODEL = process.env.E2E_MODEL ?? "gemini-3.8-flash";
const IMAGE_MODEL = process.env.E2E_IMAGE_MODEL ?? "gemini-3.1-flash-lite-image";
const WITH_IMAGES = process.env.E2E_SKIP_IMAGES !== "1";

if (!KEY) {
  console.error("Set E2E_API_KEY (and E2E_BASE_URL unless it is http://localhost:8787).");
  process.exit(1);
}

// Generous on purpose: when Vertex throttles, one request can spend a minute
// waiting and the adapter may retry a stalled stream, and a test sends several.
const SLOW = { timeout: 600_000 };

// Transient upstream states worth retrying from the client, as Google's own
// SDKs do. Anything else — a wrong answer, a 400, a 500 — fails the test.
const TRANSIENT = new Set([429, 503, 504]);

// ---------------------------------------------------------------- transport

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST (or GET) with auth. Retries transient upstream states with backoff
 * so one busy minute does not fail the run; each retry is logged. */
async function api(path, body, { method = body ? "POST" : "GET", headers = {}, auth = true } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${KEY}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!TRANSIENT.has(res.status) || attempt === 3) return res;
    console.log(`# ${res.status} from ${path}, retry ${attempt + 1}/3`);
    await res.body?.cancel();
    await sleep(5000 * 2 ** attempt);
  }
}

async function ok(path, body) {
  const res = await api(path, body);
  const text = await res.text();
  assert.equal(res.status, 200, `${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

/** Read an SSE response into [{ event, data }] with data JSON-parsed. */
async function events(path, body) {
  const res = await api(path, body);
  assert.equal(res.status, 200, `${path} -> ${res.status}: ${(await res.clone().text()).slice(0, 400)}`);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const raw = await res.text();
  const out = [];
  for (const block of raw.split("\n\n")) {
    const lines = block.split("\n");
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (data === undefined) continue;
    const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
    out.push({ event, data: data === "[DONE]" ? "[DONE]" : JSON.parse(data) });
  }
  return out;
}

// ------------------------------------------------------------- chat helpers

/** Fold chat.completion.chunk events back into one message. */
function assembleChat(stream) {
  const result = {
    content: "",
    reasoning: "",
    toolCalls: [],
    finishes: [],
    usage: [],
    errors: [],
    done: 0,
    hasRole: false,
  };
  for (const { data } of stream) {
    if (data === "[DONE]") {
      result.done++;
      continue;
    }
    if (data.error) result.errors.push(data.error);
    if (data.usage) result.usage.push(data.usage);
    for (const choice of data.choices ?? []) {
      assert.ok("finish_reason" in choice, "every streamed choice needs finish_reason");
      const d = choice.delta ?? {};
      if (d.role) result.hasRole = true;
      if (d.content) result.content += d.content;
      if (d.reasoning_content) result.reasoning += d.reasoning_content;
      for (const tc of d.tool_calls ?? []) {
        const slot = (result.toolCalls[tc.index] ??= { id: "", name: "", args: "", raw: {} });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        Object.assign(slot.raw, tc);
      }
      if (choice.finish_reason) result.finishes.push(choice.finish_reason);
    }
  }
  return result;
}

/** A Gemini 3 thought signature, wherever this route put it. */
const signatureOf = (toolCall) =>
  toolCall.thought_signature ?? toolCall.extra_content?.google?.thought_signature;

function assertUsage(usage) {
  assert.ok(usage, "usage missing");
  for (const k of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    assert.equal(typeof usage[k], "number", k);
  }
  assert.ok(usage.prompt_tokens > 0);
  // Reasoning tokens are part of completion_tokens, so the three add up.
  assert.equal(usage.prompt_tokens + usage.completion_tokens, usage.total_tokens, JSON.stringify(usage));
}

const LOW = { reasoning_effort: "low" };

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Current weather for one city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
};

// What Pydantic emits for a nested model with an Optional field: $defs/$ref,
// a nullable union and $schema. The native API only accepts this through
// parametersJsonSchema / responseFormat.
const BOOKING_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Booking",
  type: "object",
  properties: {
    city: { type: "string" },
    party: { $ref: "#/$defs/Party" },
    note: { type: ["string", "null"] },
  },
  required: ["city", "party", "note"],
  additionalProperties: false,
  $defs: {
    Party: {
      type: "object",
      properties: { size: { type: "integer" } },
      required: ["size"],
      additionalProperties: false,
    },
  },
};

function assertBooking(value) {
  assert.equal(typeof value.city, "string");
  assert.equal(typeof value.party?.size, "number", JSON.stringify(value));
  assert.ok(value.note === null || typeof value.note === "string");
}

// 1x1 PNG, so the inline-image path costs next to nothing.
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
// A public image Vertex is allowed to fetch (robots.txt permits it).
const DICE_PNG =
  "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png";

// ------------------------------------------------------------ route discovery

const modelIds = [];
const routes = [];
let imageModel = null;

before(async () => {
  const listing = await ok("/v1/models");
  modelIds.push(...listing.data.map((m) => m.id));
  if (modelIds.includes(`[EXPRESS] ${TEXT_MODEL}`)) {
    routes.push({ name: "Express key (native generateContent)", model: `[EXPRESS] ${TEXT_MODEL}`, native: true });
  }
  if (modelIds.includes(`[PAY] ${TEXT_MODEL}`)) {
    routes.push({ name: "service account (OpenAI-compatible endpoint)", model: `[PAY] ${TEXT_MODEL}`, native: false });
  }
  imageModel = modelIds.find((id) => id.endsWith(` ${IMAGE_MODEL}`)) ?? null;
  assert.ok(routes.length > 0, `No credentials serve ${TEXT_MODEL}; listed: ${modelIds.slice(0, 5).join(", ")}`);
  console.log(`# target ${BASE}`);
  console.log(`# routes: ${routes.map((r) => r.name).join(" | ")}`);
});

// ------------------------------------------------------------------ plumbing

describe("service plumbing", () => {
  test("health check answers without auth", async () => {
    const res = await api("/", undefined, { auth: false });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ok");
  });

  test("rejects a missing or wrong key", async () => {
    assert.equal((await api("/v1/models", undefined, { auth: false })).status, 401);
    const res = await api("/v1/models", undefined, {
      auth: false,
      headers: { Authorization: "Bearer definitely-wrong" },
    });
    assert.equal(res.status, 401);
  });

  test("404s unknown routes and 405s wrong methods, with CORS", async () => {
    const missing = await api("/v1/embeddings", { input: "x" });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("access-control-allow-origin"), "*");
    assert.equal((await api("/v1/chat/completions")).status, 405);
  });

  test("preflight accepts the OpenAI SDK's browser headers", async () => {
    const res = await api("/v1/chat/completions", undefined, {
      method: "OPTIONS",
      auth: false,
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,x-stainless-os",
      },
    });
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /x-stainless-os/);
  });

  test("lists models whose names all route back to something", async () => {
    assert.ok(modelIds.length > 0);
    for (const id of modelIds.filter((i) => i.includes("-image"))) {
      assert.match(id, /image(-2k|-4k)?$/, `image models get size variants only: ${id}`);
    }
  });

  test("refuses a retired Gemini 2 model with a clear message", async () => {
    const res = await api("/v1/chat/completions", {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /end of life|no longer supported/);
  });
});

// ------------------------------------------------------- chat, every route

describe("chat completions", () => {
  // Routes are only known after before() ran, so each test loops over them.
  const eachRoute = async (fn) => {
    for (const route of routes) {
      try {
        await fn(route);
      } catch (e) {
        e.message = `[${route.name}] ${e.message}`;
        throw e;
      }
    }
  };

  test("answers a plain prompt", SLOW, () =>
    eachRoute(async ({ model }) => {
      const res = await ok("/v1/chat/completions", {
        model,
        ...LOW,
        max_tokens: 400,
        messages: [{ role: "user", content: "What is 17 + 25? Reply with just the number." }],
      });
      assert.equal(res.object, "chat.completion");
      assert.equal(res.model, model);
      const choice = res.choices[0];
      assert.match(choice.message.content, /42/);
      assert.equal(choice.finish_reason, "stop");
      assert.ok(!choice.message.content.includes("vertex_think_tag"));
      assertUsage(res.usage);
    }));

  test("streams with one finish, one [DONE] and usage", SLOW, () =>
    eachRoute(async ({ model }) => {
      const s = assembleChat(
        await events("/v1/chat/completions", {
          model,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 1500,
          messages: [{ role: "user", content: "Is 1001 prime? Answer in one short sentence." }],
        })
      );
      assert.deepEqual(s.errors, []);
      assert.equal(s.done, 1);
      assert.deepEqual(s.finishes, ["stop"]);
      assert.ok(s.hasRole, "some chunk must carry role");
      assert.match(s.content, /not|no/i);
      // Vertex follows a thought with "\n\n"; it must not lead the answer.
      assert.equal(s.content, s.content.trimStart());
      assert.ok(!s.content.includes("vertex_think_tag"));
      assert.equal(s.usage.length, 1, "exactly one usage chunk");
      assertUsage(s.usage[0]);
    }));

  test("reports truncation as length, with usage, streamed or not", SLOW, () =>
    eachRoute(async ({ model }) => {
      const body = {
        model,
        max_tokens: 24,
        messages: [{ role: "user", content: "Explain in detail why the sky is blue." }],
      };
      const plain = await ok("/v1/chat/completions", body);
      assert.equal(plain.choices[0].finish_reason, "length");
      assertUsage(plain.usage);

      const s = assembleChat(
        await events("/v1/chat/completions", {
          ...body,
          stream: true,
          stream_options: { include_usage: true },
        })
      );
      assert.deepEqual(s.finishes, ["length"]);
      assert.equal(s.usage.length, 1, "usage must survive the chunk that carries finish_reason");
      assertUsage(s.usage[0]);
    }));

  test("-max thinks and reports reasoning tokens; -nothinking still answers", SLOW, () =>
    eachRoute(async ({ model }) => {
      const deep = await ok("/v1/chat/completions", {
        model: `${model}-max`,
        max_tokens: 4000,
        messages: [{ role: "user", content: "How many primes are there below 60? Just the number." }],
      });
      assert.match(deep.choices[0].message.content, /17/);
      assert.ok(deep.usage.completion_tokens_details?.reasoning_tokens > 0);

      const quick = await ok("/v1/chat/completions", {
        model: `${model}-nothinking`,
        max_tokens: 200,
        messages: [{ role: "user", content: "Say OK." }],
      });
      assert.ok(quick.choices[0].message.content.length > 0);
    }));

  test("keeps a multi-turn conversation", SLOW, () =>
    eachRoute(async ({ model }) => {
      const res = await ok("/v1/chat/completions", {
        model,
        ...LOW,
        max_tokens: 300,
        messages: [
          { role: "system", content: "You are terse." },
          { role: "user", content: "My name is Kazuki." },
          { role: "assistant", content: "Nice to meet you, Kazuki." },
          { role: "user", content: "What is my name? One word." },
        ],
      });
      assert.match(res.choices[0].message.content, /Kazuki/);
    }));

  test("calls tools with a signature and completes the round trip", SLOW, () =>
    eachRoute(async ({ model }) => {
      const question = {
        role: "user",
        content: "Get the weather for Tokyo and for Osaka. Call the tool for both cities.",
      };
      const first = await ok("/v1/chat/completions", {
        model,
        ...LOW,
        tools: [WEATHER_TOOL],
        tool_choice: "required",
        messages: [question],
      });
      const choice = first.choices[0];
      assert.equal(choice.finish_reason, "tool_calls");
      const calls = choice.message.tool_calls;
      assert.ok(calls.length >= 1);
      assert.equal(new Set(calls.map((c) => c.id)).size, calls.length, "call ids must be unique");
      for (const c of calls) {
        assert.equal(c.function.name, "get_weather");
        assert.equal(typeof JSON.parse(c.function.arguments).city, "string");
      }
      assert.ok(signatureOf(calls[0]), "Gemini 3 signs the first call of a step");

      // Answer each call; one tool returns a bare JSON array, which Vertex
      // only accepts once it is wrapped into an object.
      const results = calls.map((c, i) => ({
        role: "tool",
        tool_call_id: c.id,
        content: i === 0 ? '["sunny", 21]' : '{"sky":"rain","celsius":17}',
      }));
      const final = await ok("/v1/chat/completions", {
        model,
        ...LOW,
        tools: [WEATHER_TOOL],
        messages: [question, choice.message, ...results],
      });
      assert.equal(final.choices[0].finish_reason, "stop");
      assert.ok(final.choices[0].message.content.length > 0);

      // A client that drops unknown fields loses the signature; the adapter
      // must fill in the documented placeholder rather than get a 400.
      const unsigned = {
        role: "assistant",
        content: null,
        tool_calls: calls.map(({ id, type, function: fn }) => ({ id, type, function: fn })),
      };
      const again = await ok("/v1/chat/completions", {
        model,
        ...LOW,
        tools: [WEATHER_TOOL],
        messages: [question, unsigned, ...results],
      });
      assert.ok(again.choices[0].message.content.length > 0);
    }));

  test("streams tool calls that reassemble into valid JSON", SLOW, () =>
    eachRoute(async ({ model }) => {
      const s = assembleChat(
        await events("/v1/chat/completions", {
          model,
          ...LOW,
          stream: true,
          tools: [WEATHER_TOOL],
          tool_choice: "required",
          messages: [{ role: "user", content: "Weather in Tokyo and in Paris? Use the tool for each." }],
        })
      );
      assert.deepEqual(s.finishes, ["tool_calls"]);
      assert.ok(s.toolCalls.length >= 1);
      for (const tc of s.toolCalls) {
        assert.ok(tc.id);
        assert.equal(tc.name, "get_weather");
        assert.equal(typeof JSON.parse(tc.args).city, "string");
      }
      assert.ok(signatureOf(s.toolCalls[0].raw), "signature must survive streaming");
    }));

  test("tool_choice none suppresses calls; a named function forces one", SLOW, () =>
    eachRoute(async ({ model }) => {
      const none = await ok("/v1/chat/completions", {
        model,
        ...LOW,
        tools: [WEATHER_TOOL],
        tool_choice: "none",
        messages: [{ role: "user", content: "What's the weather in Tokyo? If you can't check, say so briefly." }],
      });
      assert.equal(none.choices[0].message.tool_calls, undefined);

      const forced = await ok("/v1/chat/completions", {
        model,
        ...LOW,
        tools: [WEATHER_TOOL],
        tool_choice: { type: "function", function: { name: "get_weather" } },
        messages: [{ role: "user", content: "Hello there." }],
      });
      assert.equal(forced.choices[0].message.tool_calls?.[0]?.function.name, "get_weather");
    }));

  test("structured output follows a Pydantic-style schema", SLOW, () =>
    eachRoute(async ({ model }) => {
      const res = await ok("/v1/chat/completions", {
        model,
        ...LOW,
        max_tokens: 2000,
        messages: [{ role: "user", content: "Make up a dinner booking for 2 people in Tokyo." }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "Booking", strict: true, schema: BOOKING_SCHEMA },
        },
      });
      assertBooking(JSON.parse(res.choices[0].message.content));

      const loose = await ok("/v1/chat/completions", {
        model,
        ...LOW,
        max_tokens: 500,
        messages: [{ role: "user", content: "Return a JSON object with keys a=1 and b=2." }],
        response_format: { type: "json_object" },
      });
      assert.deepEqual(JSON.parse(loose.choices[0].message.content), { a: 1, b: 2 });
    }));

  test("accepts a strict tool schema with $defs and nullable fields", SLOW, () =>
    eachRoute(async ({ model }) => {
      const res = await ok("/v1/chat/completions", {
        model,
        ...LOW,
        tools: [{ type: "function", function: { name: "book", strict: true, parameters: BOOKING_SCHEMA } }],
        tool_choice: { type: "function", function: { name: "book" } },
        messages: [{ role: "user", content: "Book a table for 2 in Tokyo, no special note." }],
      });
      assertBooking(JSON.parse(res.choices[0].message.tool_calls[0].function.arguments));
    }));

  test("reads images inline and by URL", SLOW, () =>
    eachRoute(async ({ model }) => {
      const ask = (url, text) =>
        ok("/v1/chat/completions", {
          model,
          ...LOW,
          max_tokens: 800,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text },
                { type: "image_url", image_url: { url } },
              ],
            },
          ],
        });
      const inline = await ask(TINY_PNG, "Describe this image in a few words.");
      assert.ok(inline.choices[0].message.content.length > 0);
      const byUrl = await ask(DICE_PNG, "What objects are in this image? A few words.");
      assert.match(byUrl.choices[0].message.content, /dic?e|cube/i);
    }));

  test("-search grounds the answer with Google Search", SLOW, () =>
    eachRoute(async ({ model, native }) => {
      const variants = native ? ["-search"] : ["-search", "-openaisearch"];
      for (const suffix of variants) {
        const res = await ok("/v1/chat/completions", {
          model: model + suffix,
          ...LOW,
          max_tokens: 1500,
          messages: [{ role: "user", content: "Search the web: what is the capital of Australia? One word." }],
        });
        assert.match(res.choices[0].message.content, /Canberra/, suffix);
      }
    }));
});

// ------------------------------------------------------ image generation

describe("image generation", () => {
  test("returns a data URL, streamed and not", { ...SLOW, skip: !WITH_IMAGES && "E2E_SKIP_IMAGES=1" }, async (t) => {
    if (!imageModel) return t.skip(`${IMAGE_MODEL} is not listed`);
    const body = {
      model: imageModel,
      messages: [{ role: "user", content: "Draw a plain red circle on a white background." }],
    };
    const plain = await ok("/v1/chat/completions", body);
    assert.match(plain.choices[0].message.content ?? "", /data:image\/\w+;base64,/);

    const s = assembleChat(await events("/v1/chat/completions", { ...body, stream: true }));
    assert.match(s.content, /data:image\/\w+;base64,/);
    assert.equal(s.done, 1);
  });
});

// --------------------------------------------------------- Responses API

describe("Responses API", () => {
  const model = () => routes[0].model;

  test("answers with a completed Response object", SLOW, async () => {
    const r = await ok("/v1/responses", {
      model: model(),
      reasoning: { effort: "low" },
      instructions: "Reply with just the number.",
      input: "What is 6 * 7?",
    });
    assert.equal(r.object, "response");
    assert.equal(r.status, "completed");
    assert.match(r.output_text, /42/);
    assert.ok(r.output.some((o) => o.type === "message"));
    assert.equal(r.usage.input_tokens + r.usage.output_tokens, r.usage.total_tokens);
  });

  test("streams the documented event sequence", SLOW, async () => {
    const ev = await events("/v1/responses", {
      model: model(),
      stream: true,
      input: "Is 91 prime? One short sentence.",
    });
    const types = ev.map((e) => e.data.type);
    assert.deepEqual(types.slice(0, 2), ["response.created", "response.in_progress"]);
    assert.equal(types.at(-1), "response.completed");
    ev.forEach((e, i) => {
      assert.equal(e.data.sequence_number, i);
      assert.equal(e.event, e.data.type, "SSE event: line must match type");
    });
    const done = ev.find((e) => e.data.type === "response.output_text.done").data.text;
    assert.equal(ev.at(-1).data.response.output_text, done);
    assert.match(done, /not|no/i);
    assert.equal(done, done.trimStart());
  });

  test("marks truncation incomplete with the spec's reason", SLOW, async () => {
    const body = { model: model(), max_output_tokens: 24, input: "Explain in detail why the sky is blue." };
    const r = await ok("/v1/responses", body);
    assert.equal(r.status, "incomplete");
    assert.deepEqual(r.incomplete_details, { reason: "max_output_tokens" });

    const ev = await events("/v1/responses", { ...body, stream: true });
    const last = ev.at(-1).data;
    assert.equal(last.type, "response.incomplete");
    assert.deepEqual(last.response.incomplete_details, { reason: "max_output_tokens" });
    assert.ok(last.response.usage.output_tokens > 0, "usage must reach the final event");
  });

  test("runs a function-call round trip, streamed and not", SLOW, async () => {
    const tool = {
      type: "function",
      name: "get_weather",
      parameters: WEATHER_TOOL.function.parameters,
    };
    const question = { role: "user", content: "What's the weather in Tokyo? Use the tool." };

    const first = await ok("/v1/responses", {
      model: model(),
      reasoning: { effort: "low" },
      tools: [tool],
      tool_choice: "required",
      input: [question],
    });
    const calls = first.output.filter((o) => o.type === "function_call");
    assert.ok(calls.length >= 1);
    assert.ok(calls[0].thought_signature, "non-streamed call keeps its signature");

    const ev = await events("/v1/responses", {
      model: model(),
      reasoning: { effort: "low" },
      stream: true,
      tools: [tool],
      tool_choice: "required",
      input: [question],
    });
    const streamed = ev.at(-1).data.response.output.filter((o) => o.type === "function_call");
    assert.ok(streamed.length >= 1);
    assert.equal(typeof JSON.parse(streamed[0].arguments).city, "string");
    assert.ok(streamed[0].thought_signature, "streamed call keeps its signature");

    const final = await ok("/v1/responses", {
      model: model(),
      reasoning: { effort: "low" },
      tools: [tool],
      input: [
        question,
        ...calls,
        ...calls.map((c) => ({
          type: "function_call_output",
          call_id: c.call_id,
          output: [{ type: "input_text", text: "sunny, 21C" }],
        })),
      ],
    });
    assert.equal(final.status, "completed");
    assert.ok(final.output_text.length > 0);
  });

  test("text.format follows a JSON schema", SLOW, async () => {
    const r = await ok("/v1/responses", {
      model: model(),
      reasoning: { effort: "low" },
      input: "Make up a dinner booking for 2 people in Tokyo.",
      text: { format: { type: "json_schema", name: "Booking", strict: true, schema: BOOKING_SCHEMA } },
    });
    assertBooking(JSON.parse(r.output_text));
  });

  test("refuses previous_response_id instead of dropping history", async () => {
    const res = await api("/v1/responses", {
      model: model(),
      input: "and then?",
      previous_response_id: "resp_123",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.param, "previous_response_id");
  });
});
