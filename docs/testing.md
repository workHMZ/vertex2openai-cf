# Validation and performance history

This record preserves measurements from v1.x through v2.1.4. **Wall time, local CPU and Cloudflare CPU are different measurements.** Historical values are not a controlled cross-version benchmark. See the [README](../README.md#deploy) for current deployment guidance.

## Gemini 4 Carbon compatibility, v2.1.4 — 2026-11-12

The compatibility release passed `npm run verify`: **294/294 unit tests**, with **99.84% line**, **93.60% branch** and **100% function** coverage. Deployment build: **83.82 KiB**, **19.68 KiB gzipped**, **6 ms startup time** reported by Wrangler. Regression coverage includes `gemini-4-carbon` and allowlist `gemini-4-carbon-cyber-permissive` capability flags, `/v1/models` advertisement (`gemini-4-carbon` only, raising the service-account list from 63 to 69 variants), thinking-level clamping, removal of unsupported sampling/penalty/`n=1` fields on both routes, local 400 rejection of `n != 1`, native `CONTINUATION` reporting, and Office/OpenDocument/plain-text URL MIME mapping.

Before patching, probing `gemini-4-carbon` through the deployed v2.1.3 Cloudflare Worker (service-account route) returned HTTP 200 and `CARBON_CF_OK` (40 input, 9 output tokens) on a clean request, while `reasoning_effort: "none"` reproduced upstream HTTP 400 (`Thinking level is unsupported: THINKING_LEVEL_MINIMAL`). Direct upstream probes also confirmed HTTP 400 (`Penalty is not enabled for this model`) when forwarding penalties.

Real upstream checks ran on Linux with Node 24.22.2 and an existing gcloud login against `gemini-4-carbon` in `global`:

| Run | API route | Scenarios | Result |
| --- | --- | ---: | --- |
| Initial full run (old 180 s script timeout) | Native GenerateContent + OpenAI compatibility | 14 | 12 passed, 2 aborted at 180 s during `global` queue waits (17 HTTP requests, 1 recovered 429) |
| Targeted rerun (300 s script timeout) | Native structured output + OpenAI `-nothinking` stream | 2 | **2/2 passed** (21.29 s and 22.62 s; 2 HTTP requests, no retries) |
| **Combined coverage** | **Both project-scoped routes** | **14** | **All 14 scenarios verified** |

During the initial run, upstream `global` queue waits ranged from 22.49 s to 176.76 s per call; aligning the test script timeout with the Worker's 300 s `STREAM_START_TIMEOUT_MS` resolved the two client-side aborts. Each route covered parameter filtering with `reasoning_effort: "none"` (`LOW`), `-nothinking` streaming, `-max`, JSON Schema output, a signed function-call round trip, and streaming/non-streaming Responses conversion. Direct probes also verified native `googleSearch`, OpenAI `web_search_options`, `stop` and `seed`.

After deploying v2.1.4 to Cloudflare Workers (service-account authentication, `global` location), production checks verified all endpoints end to end:

| Production check | Result | Wall time |
| --- | --- | ---: |
| `GET /` health and `GET /v1/models` | HTTP 200 · **69 model variants** (including 6 `[PAY] gemini-4-carbon*` ids) | 0.077 s / 0.026 s |
| Chat `n=2` local validation | HTTP 400 · `only supports n=1` before contacting Vertex | 0.027 s |
| Chat (`[PAY] gemini-4-carbon`, `reasoning_effort: "none"`, filtered penalties/sampling) | HTTP 200 · `CARBON_CF_OK` · stop (40 in, 9 out) | 31.15 s |
| Chat streaming (`[PAY] gemini-4-carbon-nothinking` overriding `high`) | HTTP 200 · `CARBON_CF_OK` · `[DONE]` (after one transient 524 during upstream queue hold) | 17.39 s |
| Responses (`[PAY] gemini-4-carbon`, `reasoning.effort: "minimal"`) | HTTP 200 · completed · `CARBON_CF_OK` (40 in, 9 out) | 31.06 s |
| Responses streaming (`[PAY] gemini-4-carbon`, `reasoning.effort: "minimal"`) | HTTP 200 · `CARBON_CF_OK` · completed event (40 in, 9 out) | 30.84 s |

Run the reproducible converter checks with `npm run test:carbon:gcloud`; see [test instructions](../test/README.md#gemini-4-checks-with-an-existing-gcloud-login). As with Argon, `gemini-4-carbon` defaults to `MEDIUM` (`gemini-4-carbon-cyber-permissive` defaults to `HIGH`), clamps `none`/`minimal`/`-nothinking` to `LOW`, and reports native `CONTINUATION` as partial output (`length` / `response.incomplete`). See [Google's Carbon guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-carbon).

## Thinking-level checks, v2.1.3 — 2026-10-15

Live checks used the deployed Cloudflare Worker, service-account authentication and the global Vertex endpoint. Each explicit-level case also asserted the native and OpenAI-compatible request converters' outgoing thinking level. The focused model-capability, request and Responses tests passed **140/140**.

| Check | Scope | Result |
| --- | --- | --- |
| Explicit effort values | Gemini 4 Argon and Gemini 3.8 Flash; seven values through Chat and Responses | **28/28 passed**; HTTP 200, `THINK_OK`, complete response |
| Suffix overrides, streaming | Gemini 4 Argon; `-nothinking` with `high`, `-max` with `none`; both APIs | **4/4 passed**; suffix took precedence, complete stream |
| Omitted effort | Chat, both models | **2/2 passed**; upstream default preserved |
| Reasoning output | Gemini 4 Argon, Chat with `high`; count primes below 60 | Correct answer `17`; 432 reasoning tokens |

For Argon and 3.8 Flash, `none` / `minimal` / `low` mapped to `LOW`, `medium` to `MEDIUM`, and `high` / `xhigh` / `max` to `HIGH`. The suffixes `-nothinking` and `-max` mapped to `LOW` and `HIGH`. `none` keeps thinking enabled at the lowest supported level. Both models default to `MEDIUM`, as documented in Google's [Argon guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon) and [3.8 Flash guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash).

The checks also exposed a Gemini 3.1 Pro Preview adapter bug: `none` sent unsupported `MINIMAL` and returned HTTP 400. The fix maps `none`, `minimal` and `-nothinking` to `LOW`, preserving explicit `MEDIUM` / `HIGH` and the upstream default. See the [README examples and mapping](../README.md#thinking).

Post-fix checks used the current converters with an existing gcloud login against real Vertex native GenerateContent and OpenAI-compatible endpoints: **8/8 passed** with HTTP 200, `PRO_THINK_OK` and complete responses. Each endpoint covered Chat `none`, `minimal`, `-nothinking` with conflicting `high`, and Responses conversion with `none`. These exercised the patched converters directly. The earlier Cloudflare checks above used the deployed version.

The new regression tests reproduced the incorrect `MINIMAL` before the fix and passed afterward: **142/142 focused tests**. The final `npm run verify` passed TypeScript checks and **294/294 unit tests**, with **99.84% line**, **93.60% branch** and **100% function** coverage.

## Production checks, v2.1.2 — 2026-10-15

`npm run verify` passed **292/292 unit tests** and TypeScript checks. Coverage: **99.84% lines**, **93.59% branches**, **100% functions**.

Live requests ran through the deployed Cloudflare Worker with service-account authentication and the global Vertex endpoint:

| Model | Request | Result | Wall time |
| --- | --- | --- | ---: |
| Gemini 3.8 Flash | Chat | HTTP 200 · `CREDIT_OK` | 2.143 s |
| Gemini 3.8 Flash | Responses | HTTP 200 · completed · `CREDIT_OK` | 2.028 s |
| Gemini 3.8 Flash | Chat streaming | HTTP 200 · `CREDIT_OK` · `[DONE]` | 40.158 s |
| Gemini 4 Argon | Chat | HTTP 200 · `ARGON_CF_OK` · stop | 4.36 s |
| Gemini 4 Argon | Responses | HTTP 200 · completed · `ARGON_CF_OK` | 2.82 s |
| Gemini 4 Argon | Chat streaming | HTTP 200 · `ARGON_CF_OK` · `[DONE]` | 2.31 s |
| Gemini 4 Argon | Responses streaming | HTTP 200 · `ARGON_CF_OK` · completed event | 3.40 s |

The Gemini 4 requests used `[PAY] gemini-4-argon`. Each returned usage of **41 input tokens and 10 output tokens**. The Chat requests also exercised filtering of `n=1`, sampling controls and penalty parameters. Both streaming checks verified the complete response text and terminal event.

`GET /v1/models` returned HTTP 200 and **63 model variants**, including the Argon variants. The two model-list probes took 0.124 s and 0.18 s.

## Gemini 4 Argon compatibility, v2.1.2 — 2026-10-14

The local compatibility patch passed `npm run verify`: **292/292 unit tests**, with **99.84% line**, **93.59% branch** and **100% function** coverage. Regression coverage includes Argon model variants, thinking-level clamping, removal of unsupported parameters on both routes, local rejection of unsupported `n` values, and partial-output reporting for `CONTINUATION` in Chat and Responses.

Real upstream checks ran on Linux with Node 24.18.0 and an existing gcloud login, using the patch's converters against `gemini-4-argon` in `global`:

| API route | Scenarios | Result |
| --- | ---: | --- |
| Project-scoped native GenerateContent | 7 | All passed |
| Project-scoped OpenAI compatibility | 7 | All passed |
| **Total** | **14** | **14 passed, 0 failed; 16 HTTP requests, no retries** |

Each route covered parameter filtering with minimum thinking, the `-nothinking` and `-max` variants, Chat streaming, JSON Schema output, a signed function-call round trip, and both streaming and non-streaming Responses conversion. An earlier minimal direct native probe also returned HTTP 200 and `ARGON_OK`.

Run the reproducible checks with `npm run test:argon:gcloud`; see [test instructions](../test/README.md#gemini-4-checks-with-an-existing-gcloud-login). These results validate real Vertex calls and the conversion code. They do **not** validate Express-key credentials, service-account token exchange, a deployed Cloudflare Worker, search/image generation, or long decode. No production deployment was performed for this validation.

Argon keeps the upstream default thinking level (`medium`); `none`, `minimal` and `-nothinking` select `low`, and `-max` selects `high`. Both upstream routes omit ignored sampling controls, unsupported penalties and `n=1`; other `n` values return a local 400. Long decode is not implemented: outputs beyond the per-request limit require the native `v1beta1` continuation protocol. Native `CONTINUATION` results are reported as partial output (`length` / `response.incomplete`). See [Google's Argon guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon).

## Production follow-up — 2026-09-27

v2.1.1 was subsequently deployed to Cloudflare from the released source. The deployment fork was fast-forwarded to the same commit; production variables and secrets were preserved. This installation has **service-account credentials only**, so production results cover that configured route. Express coverage remains the earlier Linux evidence below.

| Production check | Result | Elapsed wall time |
| --- | --- | ---: |
| Predeployment `npm run verify` | Typecheck and 284/284 unit tests passed | 0.83 s |
| Routing, authentication and input validation | 7/7 passed | 0.25 s |
| Chat Completions | 12/12 passed | 110.62 s |
| Image generation: Chat non-streaming, Chat streaming, Responses streaming | Passed all three modes | 64.38 s |
| Responses | 6/6 passed | 19.67 s |
| **Complete production E2E runner** | **26/26 passed; 0 failed, 0 cancelled, 0 skipped** | **194.98 s (3m 14.98s)** |
| Runner including the outer process wrapper | Exit code 0 | 195.01 s |

The run made **50 HTTP requests**, all matched to production log entries with `outcome: ok` and no runtime exceptions. Four upstream 429 responses recovered through the test client's existing backoff: one during image-input chat, three during Responses image generation. Expected 400/401/404/405 checks are included in the request count. A green scenario suite therefore does not mean every HTTP attempt was 200 or that Vertex capacity is guaranteed.

The earlier Linux SA image failure remains in the historical record; this later production run **successfully verifies SA image generation end to end**. It does not change the earlier run's 25/26 result. No new production credentials were created. The log collector stopped after the run and retained only request IDs, endpoint paths, model/stream labels, status and timing metadata, without authorization headers or bodies.

### Production CPU and request time

CPU and wall time below come directly from `wrangler tail`, joined to each test request. Only successful model requests are included. Text uses `gemini-3.8-flash`; images use `gemini-3.1-flash-lite-image` with a simple red-circle prompt.

| Successful request | Samples | CPU range | Median CPU | Worker wall-time range |
| --- | ---: | ---: | ---: | ---: |
| Chat text, non-streaming | 17 | 1–7 ms | 1 ms | 1.24–20.15 s |
| Chat text, streaming | 3 | 3–10 ms | 5 ms | 1.61–2.63 s |
| Responses text, non-streaming | 5 | 1–4 ms | 2 ms | 0.98–4.86 s |
| Responses text, streaming | 3 | 5–17 ms | 5 ms | 1.80–3.32 s |
| Image, Chat non-streaming | 1 | 4 ms | 4 ms | 2.57 s |
| Image, Chat streaming | 1 | 11 ms | 11 ms | 2.69 s |
| Image, Responses streaming | 1 | 14 ms | 14 ms | 2.99 s |

Image response byte sizes were not captured. Each image row is one successful Flash-Lite sample, **not the historical 2.9 MB fixture**, and cannot establish a cross-version speedup. CPU includes the work done for that request; cold-token/connection effects were not isolated. Streaming samples still exceed Free's 10 ms budget even though this run completed without runtime errors.

Deployment build: **82.18 KiB**, **19.26 KiB gzipped**, with **1 ms startup time** reported by Wrangler.

### Individual production scenario timings

Durations include all calls and retry waits within each scenario.

| Scenario | Wall time |
| --- | ---: |
| Invalid JSON shapes | 0.103 s |
| Health without authentication | 0.011 s |
| Missing/wrong adapter key | 0.021 s |
| Unknown routes and wrong methods, with CORS | 0.022 s |
| OpenAI SDK CORS preflight | 0.011 s |
| Model-list validation | 0.00038 s |
| Gemini 2 rejection | 0.012 s |
| Chat plain text | 2.96 s |
| Chat streaming | 2.64 s |
| Chat truncation, streaming and non-streaming | 7.53 s |
| `-max` / `-nothinking` | 6.55 s |
| Developer instructions and multi-turn chat | 1.29 s |
| Tool/signature round trip | 4.63 s |
| Streamed tool calls | 1.98 s |
| `tool_choice`: none and named function | 2.81 s |
| Structured JSON output | 3.01 s |
| Strict tool schema | 3.15 s |
| Inline and URL image input, including one recovered 429 | 66.77 s |
| Search grounding | 7.31 s |
| Image output in all three modes, including three recovered 429s | 64.38 s |
| Responses plain text | 1.02 s |
| Responses streaming | 3.33 s |
| Responses truncation | 7.00 s |
| Responses tool round trip | 6.72 s |
| Responses `text.format` schema | 1.58 s |
| Responses `previous_response_id` rejection | 0.020 s |

## v2.1.1 predeployment validation — 2026-09-27

Local checks used Node.js 24.21.0. Live tests used Node.js 24.18.0 on a Linux development machine, the repository's locked workerd runtime and compatibility date `2026-09-03`. Text: `gemini-3.8-flash`; images: `gemini-3.1-flash-lite-image`. Both Express and service-account credentials were required.

The full E2E run tested the streaming, validation and performance changes. A final affected rerun covered Responses and images after the last output-item ID/snapshot fixes. The release gate below ran against the final source and v2.1.1 package version. The new code was tested locally and in Linux workerd; these are **not v2.1.1 production Cloudflare measurements**.

| Check | Result | Elapsed wall time | Measurement scope |
| --- | --- | ---: | --- |
| Release `npm run verify` | Typecheck passed; **284/284** unit tests passed | **0.69 s** | Complete command, timed with a monotonic clock; dependencies already installed |
| Unit runner inside that gate | 284 passed; no failures, cancellations or skips | **0.27 s** | Node's `duration_ms`, excluding npm/typecheck startup |
| Earlier full unit run | 284/284 passed | **0.38 s** | Node runner only; retained for comparison |
| Linux workerd, full real E2E | **25 passed / 26 scenarios**, 1 failed, 0 cancelled, 0 skipped | **331.84 s (5m 31.84s)** | Includes real upstream latency and retries |
| Final affected E2E rerun | Responses 6/6 passed; image scenario failed | **183.55 s (3m 3.55s)** | 7 scenarios total; remaining failure is SA image 429 |
| Direct Vertex image probe | Same SA and request body also returned `429 RESOURCE_EXHAUSTED` | **0.19 s** | Bypassed the Worker |

Coverage: **99.84% lines, 93.21% branches, 100% functions**. Enforced gates: 99%, 90%, 100% respectively. `npm run bench` and `git diff --check` also passed.

The image failure is an upstream capacity/quota response, reproducible without the adapter. Express image generation passed in non-streaming, Chat streaming and Responses streaming modes, with some 429 retries. **At that point, SA image generation still needed a successful end-to-end run**; 25/26 was not a fully green live suite. The subsequent production run above passed, while this earlier result is retained unchanged. Google's [429 troubleshooting documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deploy/error-code-429) describes capacity/quota causes and retry guidance.

The isolated reruns used IPv4 outbound connectivity for the test process only. An earlier run with default networking encountered long waits and timeouts; the IPv4 run completed without test timeouts, but this alone does not establish the cause. Temporary SA/API keys, isolated test files and processes were removed after testing; existing credentials were preserved.

### Full real E2E timings

These are **scenario durations**, not per-request latency or CPU. A scenario can issue multiple requests across both credential types and include retry backoff. Suite totals include their own overhead; rounding can prevent exact addition.

| Suite | Result | Wall time |
| --- | --- | ---: |
| Routing, authentication and validation | 7/7 passed | 0.18 s |
| Chat Completions | 12/12 passed | 179.83 s |
| Image generation | Failed on SA upstream 429 | 103.50 s |
| Responses | 6/6 passed | 48.09 s |
| **Complete runner** | **25/26 passed** | **331.84 s** |

| Chat scenario | Wall time |
| --- | ---: |
| Plain text | 4.90 s |
| Streaming text | 6.06 s |
| Token-limit truncation, streaming and non-streaming | 45.56 s |
| `-max` / `-nothinking` | 20.88 s |
| Developer instructions and multi-turn chat | 8.05 s |
| Tool call and thought-signature round trip | 19.70 s |
| Streamed tool calls | 9.88 s |
| `tool_choice`: none and named tool | 10.51 s |
| Structured JSON output | 9.08 s |
| Strict tool definitions | 5.16 s |
| Image input: inline and URL | 26.45 s |
| Search grounding | 13.59 s |

| Responses scenario | Full run | Final affected rerun |
| --- | ---: | ---: |
| Plain text | 4.10 s | 3.18 s |
| Streaming text | 5.88 s | 5.71 s |
| Token-limit truncation | 20.62 s | 21.86 s |
| Tool round trip | 13.16 s | 42.39 s |
| `text.format` schema | 4.32 s | 6.45 s |
| Reject `previous_response_id` | 0.013 s | 0.012 s |
| **Responses suite, 6/6 passed** | **48.09 s** | **79.60 s** |
| Image scenario, SA 429 | 103.50 s | 103.66 s |
| **Runner total** | **331.84 s, all suites** | **183.55 s, Responses + images** |

## v2.1.1 local CPU benchmarks

`npm run bench` feeds synthetic upstream replies through the Worker handlers on local Node, with streamed data split into 4 KB chunks. These are median local CPU times, excluding a real Vertex network call. The script also prints a historical **×7 projection**; it is a heuristic, not a Cloudflare measurement or a Free-plan guarantee. Only measured local values are reproduced here.

| Request | Median local CPU |
| --- | ---: |
| Text, native endpoint, non-streaming | 0.24 ms |
| Text, native endpoint, streaming | 0.28 ms |
| Text, OpenAI-compatible endpoint, non-streaming | 0.15 ms |
| Text, OpenAI-compatible endpoint, streaming | 0.32 ms |
| Responses text, streaming | 0.42 ms |
| 40-turn tool history, request side | 0.29 ms |
| Default/1K image, ~2.9 MB base64, non-streaming | 7.93 ms |
| Default/1K image, Chat streaming | 4.72 ms |
| Default/1K image, Responses streaming | 25.88 ms |
| 2K image, ~11.6 MB base64, non-streaming | 28.73 ms |

A separate paired experiment isolates the **Responses conversion pipeline**, using 2,900,000 base64 bytes, 4 KB chunks and 24 alternating sample pairs in the same Node process:

| Pipeline | Median CPU | Output bytes |
| --- | ---: | ---: |
| Intermediate Chat SSE encode → parse → Responses | 16.782 ms | 17,403,850 |
| Direct normalized objects → Responses | 13.768 ms | 17,403,850 |
| **CPU reduction** | **17.96% (~18%)** | Same byte count |

The paired experiment excludes the rest of the Worker handler, so its 13.768 ms is not directly comparable to the 25.88 ms full-handler measurement. Responses delta, item and final response events still repeat image data; removing the intermediate conversion does not eliminate large output or make streamed images fit Workers Free.

## Historical measurements

The following numbers are retained from earlier committed READMEs and Releases. Local fixtures, machines and measurement scopes differ. **Earlier claims that default-size images fit Free were superseded by the 2026-09-24 Cloudflare measurements.** The legacy estimate of 50–130 ms did not specify a reproducible fixture and must not be used as a matched performance baseline.

| Version / source | Environment and scope | Recorded measurement |
| --- | --- | --- |
| [v1.0.0 README][v1] | Initial release | No recorded test duration or CPU benchmark |
| [Post-v1.0 README][legacy] | Legacy estimate; measurement method unspecified | Image JSON parsing/conversion: **50–130 ms CPU** |
| [v2.0.0 README][v2] | Local text conversion only | **~0.01 ms CPU** |
| [v2.0.0 README][v2] | Local workerd, real default image reply, 2.9 MB base64 | **1.9 ms CPU** |
| [v2.0.0 README][v2] | Local workerd, 2K image, 11.6 MB base64 | **8.5 ms CPU** |
| [v2.0.0 README][v2] | Local workerd, 4K image, 36.1 MB base64 | **31 ms CPU**; ~54 MB HTTP response |
| [v2.0.1 Release][v201] | Live native image generation after routing fix | **1.46 MB reply**; **211 unit tests** passed; elapsed time not recorded |
| [v2.1.0 tagged README][v21] | Local text, streaming and non-streaming | **0.1–0.5 ms CPU** |
| [v2.1.0 tagged README][v21] | Local default image, 2.9 MB, streaming/non-streaming | **~5 ms CPU** |
| [v2.1.0 tagged README][v21] | Local 2K image, 11.6 MB | **~18 ms CPU** |
| [v2.1.0 tagged README][v21] | Old repeated SSE line scanning, 2.9 MB image | **90+ ms CPU** before linear parsing |
| [Later README correction][correction] | Same old parsing issue on a slower machine | Up to **8 seconds CPU**; a different environment from the 90 ms report |
| [v2.1.0 tagged README][v21] | Initial Cloudflare text sample | **2–4 ms CPU**; first SA request **~16 ms** |
| [v2.1.0 Release][v210] | Cloudflare text CPU range in the release summary | **2–10 ms CPU**; the later README separates streaming and non-streaming samples |
| [v2.1.0 Release][v210] | Separate small-image SSE sample on Cloudflare, before/after linear parsing | **123 → 23 ms CPU**; different payload from the default image below |
| [v2.1.0 Release][v210] | Unit and real Vertex E2E suites | **272 unit tests**, **25/25 E2E**; total elapsed times not recorded |
| [v2.0.0][v2] / [v2.1.0][v21] READMEs | Historical Worker bundle size | **75 KiB**, **17 KiB gzipped**; not a v2.1.1 build measurement |
| [v2.1.0 tagged README][v21] | Upstream stream-start wall time | Normally **2–4 s**; successful throttled samples **36 / 143 / 184 s**; timeout **300 s per credential** |

### Cloudflare production CPU — 2026-09-24

These corrected v2.1.0 measurements came from `wrangler tail` request `cpuTime`, as recorded in [commit a5a1972][correction], which is **after the v2.1.0 tag**. They are retained as the historical baseline; the v2.1.1 production follow-up above uses different live samples.

| Request | Cloudflare CPU |
| --- | ---: |
| Text, non-streaming | 2–6 ms |
| Chat or Responses text, streaming | 3–12 ms |
| First service-account request on a fresh isolate, before cached OAuth token | ~16 ms |
| Default image, 2.9 MB base64, non-streaming | ~36 ms |
| Same image, streaming | ~100 ms |

CPU time does not include network waiting. See [Cloudflare's limits](https://developers.cloudflare.com/workers/platform/limits/) for CPU, memory and request budgets. For the later v2.1.1 samples, see the production follow-up above; the fixtures differ.

[v1]: https://github.com/workHMZ/vertex2openai-cf/blob/v1.0.0/README.md
[legacy]: https://github.com/workHMZ/vertex2openai-cf/blob/ea482a2/README.md
[v2]: https://github.com/workHMZ/vertex2openai-cf/blob/v2.0.0/README.md
[v201]: https://github.com/workHMZ/vertex2openai-cf/releases/tag/v2.0.1
[v21]: https://github.com/workHMZ/vertex2openai-cf/blob/v2.1.0/README.md
[v210]: https://github.com/workHMZ/vertex2openai-cf/releases/tag/v2.1.0
[correction]: https://github.com/workHMZ/vertex2openai-cf/blob/a5a1972/README.md
