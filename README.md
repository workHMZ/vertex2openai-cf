# Vertex2OpenAI on Cloudflare Workers

An OpenAI-compatible adapter for Google Vertex AI **Gemini 3** models, running on Cloudflare Workers. Point any OpenAI client at it and use Gemini.

Speaks **both** OpenAI wire formats — `/v1/chat/completions` and `/v1/responses` — over one conversion pipeline, so tool calling, reasoning, streaming and structured output behave identically on either.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/workHMZ/vertex2openai-cf)

## Why this exists

Vertex AI does not accept a static credential. Its OpenAI-compatible endpoint requires an OAuth token that expires every hour, so you cannot put it in a client config. This Worker turns a Service Account into a stable endpoint you can paste anywhere, and adds what the raw endpoint lacks: model variants, reasoning extraction, Gemini 3 thought-signature handling, multi-key failover, and your own access key in front.

> If you only need Gemini and not Vertex specifically, Google's own OpenAI layer at `https://generativelanguage.googleapis.com/v1beta/openai/` works with a plain AI Studio key and needs no deployment. Use this adapter when you want Vertex — its quota, data-governance terms, or regional routing.

## Read this first

- **Your `API_KEY` is the only thing between the internet and your billing account.** Use a strong random value (`npm run deploy` generates one) and set a budget alert.
- **A plain GCP API key is not a Vertex Express key.** One made with `gcloud services api-keys create` is rejected with *"API keys are not supported by this API"*, even when scoped to `aiplatform.googleapis.com`. Express keys come from the Express mode sign-up flow. With a normal project, use `GOOGLE_CREDENTIALS_JSON`.
- **Gemini 2.x is not supported** and returns `400` with a message pointing at `/v1/models`. The 2.5 family retired in October 2026; 2.0 shut down before it.
- **Thinking tokens are billed as output** and dominate cost on reasoning models. A one-word answer can burn hundreds of them.
- **`wrangler dev` reads `.dev.vars` only at startup.** Restart after editing it.

## Quick start

```bash
git clone https://github.com/workHMZ/vertex2openai-cf.git
cd vertex2openai-cf
npm install
npm run deploy
```

`npm run deploy` prompts for the secrets and deploys. To do it by hand:

```bash
npx wrangler secret put API_KEY                  # protects this adapter
npx wrangler secret put GOOGLE_CREDENTIALS_JSON  # Service Account JSON, one line
npx wrangler deploy
```

Then point your client at it:

```
base_url  https://vertex2openai.<subdomain>.workers.dev/v1
api_key   <your API_KEY>
model     gemini-3.8-flash
```

## Configuration

**Secrets** (`wrangler secret put`) — one of the two credential options is required:

| Name | Description |
| ---- | ----------- |
| `API_KEY` | **Required.** Key that protects this adapter |
| `GOOGLE_CREDENTIALS_JSON` | Service Account JSON key(s), comma-separated |
| `VERTEX_EXPRESS_API_KEY` / `VERTEX_API_KEY` | Vertex AI Express API key(s), comma-separated |

**Variables** (`wrangler.toml` `[vars]`):

| Name | Default | Description |
| ---- | ------- | ----------- |
| `GCP_LOCATION` | `global` | Region, or `global` |
| `GCP_PROJECT_ID` | from the SA key | Overrides the key's `project_id` |
| `MODELS_CONFIG` | built-in | Custom model list JSON |

Configure several credentials and the Worker rotates round-robin, retrying the next one on `429`/`5xx`/network errors. A `400` is not retried — another key would fail the same way.

## Endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/` | Health check (no auth) |
| `GET` | `/v1/models` | List models |
| `POST` | `/v1/chat/completions` | Chat Completions API |
| `POST` | `/v1/responses` | Responses API |

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.8-flash","messages":[{"role":"user","content":"Hi"}]}'
```

## Models

| Family | IDs |
| ------ | --- |
| Flash (GA) | `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash` |
| Flash-Lite (GA) | `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` |
| Preview | `gemini-3.1-pro-preview`, `gemini-3-flash-preview` |
| Image | `gemini-3-pro-image`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image` |

Capabilities come from the parsed version number ([`src/model-capabilities.ts`](src/model-capabilities.ts)), not hardcoded prefixes, so `gemini-3.10` sorts above `gemini-3.8` and a future `gemini-4-*` works by adding the id to `MODELS_CONFIG` — no code change.

### Variants

Append a suffix to any model id:

| Suffix | Effect |
| ------ | ------ |
| `-search` | Google Search grounding |
| `-nothinking` / `-max` | Lowest / highest thinking level |
| `-2k` / `-4k` | Image resolution (image models) |
| `-openai` / `-openaisearch` | Force the OpenAI-compatible endpoint (Service Account only) |

Prefix with `[EXPRESS] ` or `[PAY] ` to pin the credential type. Unprefixed prefers Express and falls back to the Service Account.

### Per-model quirks

Some models reject parameters their siblings accept. Rather than letting the request fail, the adapter degrades them. Verified against the live API on 2026-09-07:

| Model | Rejects | Behaviour |
| ----- | ------- | --------- |
| `gemini-3.8-flash` | `thinkingLevel: MINIMAL` | `none`/`minimal` become `low` |
| `gemini-3.8-flash` | `frequencyPenalty` / `presencePenalty` | dropped |

Add further models to `NO_MINIMAL_THINKING_LEVEL` / `NO_PENALTIES` in [`src/model-capabilities.ts`](src/model-capabilities.ts).

### Reasoning

`reasoning_effort` (Chat) and `reasoning.effort` (Responses) map to Gemini's `thinkingLevel`: `none`, `minimal`, `low`, `medium`, `high`, plus the Responses API's `xhigh`/`max`, which fold into `high`.

Thoughts come back as `reasoning_content` on Chat Completions and as a `reasoning` output item on Responses.

### Structured output

`response_format` (Chat) and `text.format` (Responses) map to Gemini's `responseSchema`. Keywords Vertex rejects — `$schema`, `additionalProperties`, `$defs` — are stripped at every depth, so schemas from OpenAI SDK strict mode work unchanged.

## Thought signatures (Gemini 3 + tools)

Gemini 3 attaches a `thoughtSignature` to the first function call of each step and **rejects the next request with 400 if it is not sent back**. The OpenAI format has nowhere to put it, so the adapter surfaces it as `thought_signature` on the tool call (and on the `function_call` item in Responses).

Clients that preserve it round-trip at full quality. Clients that strip unknown fields — most OpenAI SDKs — would otherwise break, so the adapter substitutes Vertex's documented `skip_thought_signature_validator` placeholder, trading some reasoning continuity for a request that succeeds. Incoming signatures are accepted as `thought_signature`, `thoughtSignature`, or `extra_content.google.thought_signature`.

## Responses API

| Responses | Chat Completions |
| --------- | ---------------- |
| `input` (string or items) | `messages` |
| `instructions` | leading `system` message |
| `max_output_tokens` | `max_tokens` |
| `reasoning.effort` | `reasoning_effort` |
| `text.format` | `response_format` |
| `tools: [{type, name, parameters}]` | `tools: [{type, function}]` |
| `function_call` / `function_call_output` items | `tool_calls` + `tool` message |

Streaming emits the typed event sequence (`response.created` → `response.output_item.added` → `response.output_text.delta` → `response.completed`) with an incrementing `sequence_number`.

**Not implemented:** server-side conversation state (`store`, `previous_response_id`, `GET`/`DELETE /v1/responses/{id}`) and OpenAI's hosted tools. Gemini's own search grounding is available via the `-search` suffix.

## Performance

Measured **inside workerd** (the actual Workers runtime, via `wrangler dev`), timing the full non-streaming path: `JSON.parse` → convert → `JSON.stringify`.

| Workload | CPU | of the 10 ms free cap |
| -------- | --- | --------------------- |
| Typical text chat (~12 KB response) | 0.01 ms | 0.1% |
| 30-turn conversation, request conversion | 0.01 ms | 0.1% |
| Image response, 1 MB base64 | 0.50 ms | 5% |
| Image response, 2.4 MB base64 *(a real `gemini-3.1-flash-image` reply)* | 1.20 ms | 12% |
| Image response, 4 MB base64 | 2.15 ms | 22% |
| Image response, 8 MB base64 | 4.84 ms | 48% |

**Image generation works on the Free plan.** An earlier version of this README claimed it consumed 50–130 ms and would "very likely fail" — that was wrong by two orders of magnitude. A real 2.4 MB image reply costs about 1.2 ms.

These numbers come from Apple silicon; Cloudflare's shared production hardware is slower. Even allowing a 3× factor, a typical 2–3 MB image stays comfortably under the cap, though 8 MB+ replies could get tight — check `wrangler tail`, which reports per-request CPU, if you generate very large images on the free plan.

Worker bundle: **75 KiB / 17 KiB gzipped** (free-plan limit is 3 MB gzipped).

Other free-plan limits worth knowing: 100,000 requests/day, 50 subrequests per request (this adapter uses at most one per configured credential), 128 MB memory, 10 ms CPU. The Paid plan raises CPU to 30 s.

## Notes

- **Safety settings** are sent as `BLOCK_NONE` for the four standard harm categories, which the live API accepts. Vertex also supports `OFF`; change `buildSafetySettings()` in [`src/converters/request.ts`](src/converters/request.ts) if your project needs it.
- **Express keys travel in the `x-goog-api-key` header**, never a `?key=` query parameter, so they stay out of request logs.
- **Token accounting.** Vertex reports thinking tokens outside `candidatesTokenCount` (native) and outside `completion_tokens` (OpenAI-compatible), so the numbers do not sum to the total. The adapter folds them back in, matching OpenAI's semantics where `reasoning_tokens` is a subset of `completion_tokens`.

## Development

```bash
npm run verify   # typecheck + tests
npm run dev      # local worker on :8787
```

```bash
cat > .dev.vars <<'EOF'
API_KEY=test123
GOOGLE_CREDENTIALS_JSON={"type":"service_account",...}
EOF
```

Tests bundle the sources with the esbuild binary inside `wrangler` and run on Node's built-in test runner — no extra dependencies.

## Acknowledgments

Inspired by [vertex2openai](https://github.com/gzzhongqi/vertex2openai) by gzzhongqi. This is a ground-up TypeScript rewrite for the edge with zero runtime dependencies.

## License

MIT — see [LICENSE](LICENSE).
