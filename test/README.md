# Tests

Run the repository gate before committing or deploying:

```bash
npm ci
npm run verify
```

`verify` runs TypeScript checking and every unit test using Node's built-in runner. On Node 22.18+ with TypeScript stripping and module hooks, sources run directly and coverage must reach **99% lines, 90% branches and 100% functions**. Older supported Node versions use the esbuild bundled with Wrangler and skip coverage enforcement. No additional test framework is required.

For a focused change on a supported modern Node version:

```bash
node --import ./test/support/register.mjs --test test/streaming.test.ts
```

## Live end-to-end tests

Put the adapter and Vertex credentials in the ignored `.dev.vars`, then start `npm run dev`. Restart it after changing secrets. In a separate shell, export `E2E_API_KEY` with the matching adapter key, then run:

```bash
E2E_BASE_URL=http://localhost:8787 E2E_REQUIRE_BOTH_ROUTES=1 npm run test:e2e
```

The suite makes **real, billable Vertex calls**. It uses `/v1/models` to discover configured credential types; use the route requirement above to prevent a missing credential type from silently reducing coverage.

| Environment variable | Default / purpose |
| --- | --- |
| `E2E_API_KEY` | Required adapter key; keep it out of Git and logs |
| `E2E_BASE_URL` | `http://localhost:8787`; can target an explicitly selected deployed Worker |
| `E2E_REQUIRE_BOTH_ROUTES` | Set `1` to require both Express and service-account credentials |
| `E2E_MODEL` | `gemini-3.8-flash` |
| `E2E_IMAGE_MODEL` | `gemini-3.1-flash-lite-image` |
| `E2E_SKIP_IMAGES` | Set `1` to skip billable image generation; the run then has reduced coverage |

Chat and Responses tests exercise both available credential types. Image generation always uses native Vertex, including for service accounts. Scenarios cover authentication, invalid input, streaming, truncation, reasoning, multi-turn/tool signature round trips, tool choice, schemas, image input, search and image output. Retryable upstream failures are logged; exhausted retries fail the test. Test cancellation aborts active reads and backoff waits.

## Gemini 4 checks with an existing gcloud login

On a machine with Node 22.18+ and `gcloud` already authenticated:

```bash
npm run test:carbon:gcloud
npm run test:argon:gcloud
```

`test:carbon:gcloud` runs against `gemini-4-carbon`; `test:argon:gcloud` runs against `gemini-4-argon` (or override `VERTEX_TEST_MODEL`). Each command uses the active gcloud project, or `GCP_PROJECT_ID` when provided, and keeps the access token in process memory. It makes real, billable short requests to the global project-scoped native and OpenAI-compatible APIs, using the current request/response/streaming converters. The 14 scenarios cover filtered parameters, minimum/maximum thinking, Chat and Responses streaming, structured output and signed tool round trips. Transient retries are bounded and logged. This does **not** validate Express-key authentication, service-account token exchange, Cloudflare execution, search/image generation, or long decode. Use the deployed E2E suite for production verification.

## CPU benchmark

`npm run bench` uses synthetic upstream replies, without real Vertex calls. It reports local CPU and a historical ×7 projection; that projection is not production Cloudflare evidence. See [validation results and historical timings](../docs/testing.md) for measured values, test scope and known upstream failures.
