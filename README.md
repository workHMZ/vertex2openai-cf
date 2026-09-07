# Vertex2OpenAI on Cloudflare Workers

An OpenAI-compatible front end for Google Vertex AI's Gemini 3 models. Point any OpenAI client at it and use Gemini.

It serves both wire formats, `/v1/chat/completions` and `/v1/responses`, over the same conversion code, so tool calling, reasoning, streaming and structured output behave the same either way.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/workHMZ/vertex2openai-cf)

## Do you actually need this?

If you just want Gemini, you probably don't. Google runs its own OpenAI layer at `https://generativelanguage.googleapis.com/v1beta/openai/` that takes a plain AI Studio key and needs no deployment.

This adapter is for when you want **Vertex** specifically, for its quota, data handling terms, or regional routing. Vertex won't take a static credential: its OpenAI endpoint wants an OAuth token that expires hourly, which you can't put in a client config. The Worker turns a service account into a URL you can paste anywhere, and fills in what the raw endpoint lacks: model variants, reasoning extraction, Gemini 3 thought signatures, multi-key failover, and your own key in front of it all.

## Setup

```bash
git clone https://github.com/workHMZ/vertex2openai-cf.git
cd vertex2openai-cf
npm install
npm run deploy
```

`npm run deploy` asks for the secrets and deploys. By hand it's:

```bash
npx wrangler secret put API_KEY                  # protects this adapter
npx wrangler secret put GOOGLE_CREDENTIALS_JSON  # service account JSON, one line
npx wrangler deploy
```

Then in your client:

```
base_url  https://vertex2openai.<subdomain>.workers.dev/v1
api_key   <your API_KEY>
model     gemini-3.8-flash
```

## Configuration

Secrets go through `wrangler secret put`. You need `API_KEY` plus one credential:

| Name | |
| ---- | --- |
| `API_KEY` | Required. Guards this adapter |
| `GOOGLE_CREDENTIALS_JSON` | Service account JSON, comma-separated for several |
| `VERTEX_EXPRESS_API_KEY` / `VERTEX_API_KEY` | Express API keys, comma-separated |

Plain variables live in `wrangler.toml` under `[vars]`:

| Name | Default | |
| ---- | ------- | --- |
| `GCP_LOCATION` | `global` | A region, or `global` |
| `GCP_PROJECT_ID` | from the key | Overrides the service account's own project |
| `MODELS_CONFIG` | built in | Custom model list |

Give it several credentials and it rotates through them, moving to the next on 429s, 5xx and network errors. A 400 stops the request, since another key would fail identically.

## Endpoints

| | |
| --- | --- |
| `GET /` | Health check, no auth |
| `GET /v1/models` | Model list |
| `POST /v1/chat/completions` | Chat Completions |
| `POST /v1/responses` | Responses |

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.8-flash","messages":[{"role":"user","content":"Hi"}]}'
```

## Models

Gemini 3 and newer only.

- Flash: `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`
- Flash-Lite: `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`
- Preview: `gemini-3.1-pro-preview`, `gemini-3-flash-preview`
- Image: `gemini-3-pro-image`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`

Capabilities come from the version number in the id rather than a hardcoded list, so `gemini-3.10` sorts above `gemini-3.8` and a future `gemini-4-*` works as soon as you add it to `MODELS_CONFIG`.

Suffix any id to change its behaviour:

| | |
| --- | --- |
| `-search` | Google Search grounding |
| `-nothinking` / `-max` | Lowest / highest thinking level |
| `-2k` / `-4k` | Image resolution |
| `-openai` / `-openaisearch` | Force the OpenAI-compatible endpoint, service account only |

Prefix with `[EXPRESS] ` or `[PAY] ` to pin the credential type. Without a prefix it prefers an Express key and falls back to the service account.

### Reasoning

`reasoning_effort` on Chat Completions, `reasoning.effort` on Responses. Both accept `none`, `minimal`, `low`, `medium`, `high`, plus `xhigh` and `max` from the Responses spec, which fold into `high` since Gemini stops there.

Thoughts come back as `reasoning_content` on Chat Completions and as a `reasoning` item on Responses.

### Structured output

`response_format` and `text.format` both map to Gemini's `responseSchema`. Schemas from OpenAI's strict mode work unchanged: the keywords Vertex rejects (`$schema`, `additionalProperties`, `$defs`) get stripped at every level on the way through.

## Gotchas

**Your `API_KEY` is the only thing between the internet and your billing account.** Use a strong random value and set a budget alert. `npm run deploy` generates one if you type `random`.

**A normal GCP API key is not a Vertex Express key.** Making one with `gcloud services api-keys create` gets you `API keys are not supported by this API`, even scoped to `aiplatform.googleapis.com`. Express keys come from the Express mode sign-up. On an ordinary project, use `GOOGLE_CREDENTIALS_JSON`.

**Gemini 2.x is gone.** The 2.5 family retired in October 2026, 2.0 before it. Asking for one returns a 400 that points you at `/v1/models`.

**Thinking tokens bill as output** and usually dominate the cost. A one-word answer can spend hundreds of them.

**`wrangler dev` reads `.dev.vars` once, at startup.** Restart it after you edit that file.

**Some models reject parameters their siblings accept.** Rather than let the request fail, the adapter quietly downgrades:

| Model | Rejects | What happens |
| ----- | ------- | ------------ |
| `gemini-3.8-flash` | `thinkingLevel: MINIMAL` | `none` and `minimal` become `low` |
| `gemini-3.8-flash` | frequency and presence penalties | dropped |

Add more to `NO_MINIMAL_THINKING_LEVEL` and `NO_PENALTIES` in [`src/model-capabilities.ts`](src/model-capabilities.ts) as Google flags them.

## Thought signatures

Gemini 3 attaches a `thoughtSignature` to the first function call of every step and rejects the following request with a 400 if you don't send it back. OpenAI's format has nowhere to keep it, so the adapter hands it to you as `thought_signature` on the tool call, or on the `function_call` item under Responses.

Clients that preserve unknown fields round-trip it and keep full quality. Most OpenAI SDKs strip it, which would otherwise break every multi-turn tool call, so the adapter substitutes Vertex's `skip_thought_signature_validator` placeholder instead. That costs some reasoning continuity but the request goes through. Coming back in, `thought_signature`, `thoughtSignature` and `extra_content.google.thought_signature` are all accepted.

## Responses API

The translation, if you're curious what maps to what:

| Responses | Chat Completions |
| --------- | ---------------- |
| `input` | `messages` |
| `instructions` | leading `system` message |
| `max_output_tokens` | `max_tokens` |
| `reasoning.effort` | `reasoning_effort` |
| `text.format` | `response_format` |
| `tools: [{type, name, parameters}]` | `tools: [{type, function}]` |
| `function_call` / `function_call_output` | `tool_calls` and `tool` messages |

Streaming emits the typed events, `response.created` through `response.output_text.delta` to `response.completed`, each with an incrementing `sequence_number`.

Server-side conversation state is not implemented: no `store`, `previous_response_id`, or `GET`/`DELETE /v1/responses/{id}`. Neither are OpenAI's hosted tools; for search, use the `-search` model suffix.

## Cost and limits

For text, conversion overhead is nothing: about 0.01 ms of CPU per request against the free plan's 10 ms budget.

Images are a different story, because the reply carries the whole picture as base64 and the Worker has to parse and re-serialise it. Measured in workerd on real replies:

| Model | base64 | CPU | Free plan |
| ----- | ------ | --- | --------- |
| `gemini-3.1-flash-image` | 2.9 MB | 1.9 ms | fits |
| `gemini-3.1-flash-image-2k` | 11.6 MB | 8.5 ms | too close to the 10 ms cap |
| `gemini-3-pro-image-4k` | 36.1 MB | 31 ms | over by 3x |

Those timings come off a fast laptop and Cloudflare's shared hardware is slower, so treat them as a floor. **Image generation above the default resolution wants the paid plan**, which gives you 30 seconds of CPU. A 4K reply is also a ~54 MB HTTP response, which gets uncomfortable against the 128 MB memory an isolate has to work with.

The Worker bundles to 75 KiB, 17 KiB gzipped.

Free plan also caps you at 100,000 requests a day, 50 subrequests per request (this uses one per credential it tries) and 128 MB of memory. The paid plan raises CPU to 30 seconds.

## Notes

Safety settings go out as `BLOCK_NONE` on the four standard harm categories. Vertex also accepts `OFF` if you need it; that's `buildSafetySettings()` in [`src/converters/request.ts`](src/converters/request.ts).

Express keys travel in the `x-goog-api-key` header rather than a `?key=` query parameter, so they stay out of request logs.

Vertex reports thinking tokens outside `completion_tokens`, which leaves prompt plus completion short of the total. The adapter folds them back in to match OpenAI, where `reasoning_tokens` is a subset of `completion_tokens`.

## Development

```bash
npm run verify   # typecheck and tests
npm run dev      # local worker on :8787
```

Local secrets go in `.dev.vars`:

```
API_KEY=test123
GOOGLE_CREDENTIALS_JSON={"type":"service_account",...}
```

Tests bundle the sources with the esbuild binary that comes with wrangler and run on Node's test runner, so there's nothing extra to install.

## Acknowledgments

Inspired by [vertex2openai](https://github.com/gzzhongqi/vertex2openai) by gzzhongqi. This is a TypeScript rewrite for the edge with no runtime dependencies.

## License

MIT, see [LICENSE](LICENSE).
