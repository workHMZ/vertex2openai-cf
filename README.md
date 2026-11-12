# Vertex2OpenAI on Cloudflare Workers

**v2.1.4** — Use Gemini 3 and 4 through OpenAI-compatible APIs. Runs on Cloudflare Workers with zero runtime dependencies.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/workHMZ/vertex2openai-cf)

https://github.com/user-attachments/assets/f39a1f83-e61e-45f7-a0a9-5f0f157b9295

## Features

| Feature | Support |
| --- | --- |
| APIs | Chat Completions and Responses, with streaming, tools and JSON Schema |
| Models | Gemini 3 and **Gemini 4** (**Carbon** and **Argon**); reasoning, Google Search, image and document input, image generation |
| Credentials | Service accounts and Vertex Express keys, with token refresh, rotation and failover |

## Deploy

Requires a patched Node.js release (22.23.4+, 24.22.1+, or 26.12.1+) and npm. Node.js 24.22.1 is pinned in .nvmrc. For service accounts, enable Vertex AI and billing on your GCP project.

```bash
git clone https://github.com/workHMZ/vertex2openai-cf.git
cd vertex2openai-cf
npm ci
npm run verify
npx wrangler secret put API_KEY
npx wrangler secret put GOOGLE_CREDENTIALS_JSON
npx wrangler deploy --keep-vars
```

Use a strong random value for `API_KEY`. Paste the service-account JSON on one line when setting `GOOGLE_CREDENTIALS_JSON`.

For Vertex Express, set `VERTEX_EXPRESS_API_KEY` instead. `npm run deploy` provides interactive setup for the adapter key and Express key.

| Setting | Purpose |
| --- | --- |
| `API_KEY` | Adapter key used by your clients |
| `GOOGLE_CREDENTIALS_JSON` / `VERTEX_EXPRESS_API_KEY` | Vertex credentials; supports multiple service accounts or comma-separated Express keys |
| `GCP_PROJECT_ID`, `GCP_LOCATION`, `MODELS_CONFIG` | Optional project, region (`global`) and [model-list](src/models.json) overrides |

Set secrets with `wrangler secret put`. Set plain variables in `wrangler.toml`.

## Connect

Set your client's **Base URL** to `https://vertex2openai.<subdomain>.workers.dev/v1`, use your **`API_KEY`**, and select a model from **`GET /v1/models`**.

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-4-carbon",
    "reasoning_effort": "medium",
    "messages": [{"role": "user", "content": "Hi"}]
  }'
```

For Responses, send `{"model":"gemini-4-carbon","input":"Hi","reasoning":{"effort":"medium"}}` to `/v1/responses`.

| Model option | Use |
| --- | --- |
| `[PAY] ` / `[EXPRESS] ` prefix | Select service-account or Express credentials |
| `-search`, `-nothinking`, `-max` | Google Search, lowest thinking or highest thinking on text models |
| `-2k` / `-4k` | Image generation resolution |

Keep `thought_signature` in tool-call history. Send the full conversation in Responses `input`.

## Thinking

Use `reasoning_effort` in Chat Completions and `reasoning.effort` in Responses. For **Gemini 4 Carbon**, **Gemini 4 Argon**, **Gemini 3.8 Flash** and **Gemini 3.1 Pro Preview**:

| Client value | Vertex level | Use |
| --- | --- | --- |
| `none`, `minimal`, `low` | `LOW` | Fast replies and extraction |
| `medium` | `MEDIUM` | General coding and analysis |
| `high`, `xhigh`, `max` | `HIGH` | More complex reasoning |

When omitted, Carbon, Argon and 3.8 Flash default to `MEDIUM`; 3.1 Pro Preview defaults to `HIGH`. `none` selects the lowest thinking level; thinking stays enabled.

The `-nothinking` and `-max` model suffixes select `LOW` and `HIGH` respectively, overriding the request field. For example, `gemini-4-carbon-max` uses `HIGH` even with `reasoning_effort: "low"`.

`max_tokens` (Chat) and `max_output_tokens` (Responses) cover thinking tokens and the final answer. Leave enough output tokens for both.

## Development

```bash
npm run dev       # Local Worker; secrets in .dev.vars
npm run verify    # Typecheck, unit tests and coverage
npm run bench     # CPU benchmark
```

[Test setup](test/README.md) · [Test results and CPU measurements](docs/testing.md)

Workers Free allows **10 ms CPU per request**. Use Workers Paid for image generation. [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/).

Vertex usage is billed to your GCP project. Set a [Vertex spend cap](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps) to control usage.

Inspired by [gzzhongqi/vertex2openai](https://github.com/gzzhongqi/vertex2openai). [MIT License](LICENSE).
