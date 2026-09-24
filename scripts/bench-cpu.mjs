// How much CPU does the adapter itself burn per request?
//
//   npm run bench
//
// Runs the whole Worker (auth, conversion, streaming) with Vertex replaced by
// canned replies, since time spent waiting on the network does not count
// toward the Workers CPU limit. Each case is compared with the Free plan's
// 10 ms budget after multiplying by SLOWDOWN: this runs on a developer
// machine, and Cloudflare's shared hardware is slower. Image replies are
// reported but do not fail the run; they need the paid plan either way.
//
// Needs Node 22.18+ (it imports the TypeScript sources directly).

import { timingSafeEqual } from "node:crypto";
import { randomBytes } from "node:crypto";

const FREE_PLAN_MS = 10;
// Calibrated against `wrangler tail` on 2026-09-24: a default-size image
// took ~5 ms here and ~36 ms of CPU on Cloudflare.
const SLOWDOWN = 7;

// workerd has crypto.subtle.timingSafeEqual; Node does not.
crypto.subtle.timingSafeEqual ??= (a, b) =>
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

const worker = (await import("../src/index.ts")).default;

// ------------------------------------------------------------- fixtures

const words = (n) => Array.from({ length: n }, (_, i) => `word${i % 97}`).join(" ");

const sse = (frames) => frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("");

const THOUGHT = words(300);
const ANSWER = words(250);

/** Split text into n streamed pieces. */
const pieces = (text, n) => {
  const size = Math.ceil(text.length / n);
  return Array.from({ length: n }, (_, i) => text.slice(i * size, (i + 1) * size));
};

const openaiJson = {
  id: "x",
  created: 1,
  choices: [{
    index: 0,
    message: { role: "assistant", content: `<vertex_think_tag>${THOUGHT}</vertex_think_tag>\n\n${ANSWER}` },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 40, completion_tokens: 400, total_tokens: 1200, completion_tokens_details: { reasoning_tokens: 760 } },
};

const openaiStream = sse([
  ...pieces(`<vertex_think_tag>${THOUGHT}</vertex_think_tag>\n\n${ANSWER}`, 80).map((content, i) => ({
    id: "x", created: 1,
    choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content } : { content }, finish_reason: null }],
  })),
  { id: "x", created: 1, choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage: openaiJson.usage },
  "[DONE]",
]);

const nativeJson = {
  candidates: [{
    content: { role: "model", parts: [{ text: THOUGHT, thought: true }, { text: ANSWER, thoughtSignature: "c2ln" }] },
    finishReason: "STOP",
  }],
  usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 400, thoughtsTokenCount: 760, totalTokenCount: 1200 },
};

const nativeStream = sse([
  ...pieces(ANSWER, 80).map((text) => ({ candidates: [{ content: { role: "model", parts: [{ text }] } }] })),
  { candidates: [{ content: { role: "model", parts: [{ text: "." }] }, finishReason: "STOP" }], usageMetadata: nativeJson.usageMetadata },
]);

/** A generated image as Vertex returns it: one inlineData part, base64. */
const imageJson = (base64Bytes) => ({
  candidates: [{
    content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: randomBytes(Math.floor(base64Bytes * 0.75)).toString("base64") } }] },
    finishReason: "STOP",
  }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1120, totalTokenCount: 1130 },
});

// A long agent session: 40 turns, a tool call and a tool result in each.
const longHistory = [{ role: "system", content: words(200) }];
for (let i = 0; i < 40; i++) {
  longHistory.push({ role: "user", content: words(40) });
  longHistory.push({
    role: "assistant",
    content: null,
    tool_calls: [{ id: `c${i}`, type: "function", function: { name: "search", arguments: JSON.stringify({ q: words(8) }) } }],
  });
  longHistory.push({ role: "tool", tool_call_id: `c${i}`, content: JSON.stringify({ hits: [words(30), words(30)] }) });
}

// ---------------------------------------------------------------- harness

const env = { API_KEY: "bench-key", VERTEX_EXPRESS_API_KEY: "express-key" };

// Network reads arrive in small pieces; feeding one big chunk would hide
// any cost that grows with the number of chunks.
const NETWORK_CHUNK = 4096;

/** Serve `body` as the Vertex reply. It is encoded to bytes once, up front:
 * in production those bytes arrive off the network, which costs no CPU. */
function reply(body, contentType = "application/json") {
  const bytes = new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += NETWORK_CHUNK) c.enqueue(bytes.subarray(i, i + NETWORK_CHUNK));
          c.close();
        },
      }),
      { headers: { "Content-Type": contentType } }
    );
}

async function once(path, payload) {
  const res = await worker.fetch(
    new Request(`https://bench.example${path}`, {
      method: "POST",
      headers: { Authorization: "Bearer bench-key", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    env
  );
  await res.arrayBuffer(); // Streams do their work only as they are read.
  if (res.status !== 200) throw new Error(`${path} -> ${res.status}`);
}

/** Median CPU milliseconds for one request. */
async function measure(path, payload, runs) {
  for (let i = 0; i < 3; i++) await once(path, payload); // warm the JIT
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const start = process.cpuUsage();
    await once(path, payload);
    const used = process.cpuUsage(start);
    samples.push((used.user + used.system) / 1000);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const chat = (over = {}) => ({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }], ...over });

// The OpenAI-compatible endpoint needs a service account; the token exchange
// is stubbed and cached after the first call, as it is for an hour in prod.
const { generateKeyPairSync } = await import("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
env.GOOGLE_CREDENTIALS_JSON = JSON.stringify({
  type: "service_account",
  project_id: "bench",
  client_email: "bench@bench.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});
const withToken = (body, contentType) => {
  reply(body, contentType);
  const vertex = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).startsWith("https://oauth2.googleapis.com")
      ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }))
      : vertex(url, init);
};

const CASES = [
  ["text, native, non-streamed", () => reply(nativeJson), "/v1/chat/completions", chat()],
  ["text, native, streamed", () => reply(nativeStream, "text/event-stream"), "/v1/chat/completions", chat({ stream: true })],
  ["text, OpenAI endpoint, non-streamed", () => withToken(openaiJson), "/v1/chat/completions", chat({ model: "[PAY] gemini-3.8-flash" })],
  ["text, OpenAI endpoint, streamed", () => withToken(openaiStream, "text/event-stream"), "/v1/chat/completions", chat({ model: "[PAY] gemini-3.8-flash", stream: true })],
  ["Responses API, streamed", () => withToken(openaiStream, "text/event-stream"), "/v1/responses", { model: "[PAY] gemini-3.8-flash", input: "hi", stream: true }],
  ["40-turn tool history (request side)", () => reply(nativeJson), "/v1/chat/completions", chat({ messages: longHistory })],
  ["image 1K (~2.9 MB base64) [paid plan]", () => reply(imageJson(2.9e6)), "/v1/chat/completions", chat({ model: "gemini-3.1-flash-image" }), true],
  ["image 1K, streamed [paid plan]", () => reply(sse([imageJson(2.9e6)]), "text/event-stream"), "/v1/chat/completions", chat({ model: "gemini-3.1-flash-image", stream: true }), true],
  ["image 2K (~11.6 MB) [paid plan]", () => reply(imageJson(11.6e6)), "/v1/chat/completions", chat({ model: "gemini-3.1-flash-image-2k" }), true],
];

console.log(`CPU per request (median), x${SLOWDOWN} for Cloudflare hardware, vs the ${FREE_PLAN_MS} ms Free plan budget\n`);
let failed = false;
for (const [name, setup, path, payload, paidOnly] of CASES) {
  setup();
  const ms = await measure(path, payload, name.startsWith("image") ? 8 : 40);
  const projected = ms * SLOWDOWN;
  const fits = projected <= FREE_PLAN_MS;
  if (!fits && !paidOnly) failed = true;
  const verdict = fits ? "ok" : paidOnly ? "over: paid plan" : "OVER BUDGET";
  console.log(`${name.padEnd(40)} ${ms.toFixed(2).padStart(7)} ms  -> ${projected.toFixed(1).padStart(5)} ms  ${verdict}`);
}
process.exit(failed ? 1 : 0);
