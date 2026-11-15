# Vertex2OpenAI — cinematic English introduction

33 s · 1920 × 1080 · 60 fps · H.264 ~2 Mbps / AAC 160 kbps · ~8.8 MB (fits GitHub's 10 MB attachment limit)

Final film: [`../../docs/videos/vertex2openai-intro-en.mp4`](../../docs/videos/vertex2openai-intro-en.mp4). Replaces the earlier card-style edit in `../vertex-launch-en/`.

Direction: dark, continuous camera; zoom-through transitions instead of slide cuts; per-letter blur-in typography; glass panels; light packets for request flow; bloom, grain and vignette in post. Low-saturation cool/warm accents only.

| Time | Scene | Copy |
| --- | --- | --- |
| 00–04 | Signal | Speak OpenAI. Run Gemini. |
| 04–08 | Bridge | Your app → Vertex2OpenAI (Cloudflare Worker) → Vertex AI |
| 08–12 | Drop-in | Same SDK. New engine. OpenAI SDK snippet, streamed reply |
| 12–16 | Capabilities | Streaming · Tool calling · Reasoning · JSON Schema · Google Search · Images & documents · Image generation |
| 16–20 | Resilience | Keys rotate. Requests fail over. Tokens refresh. (illustrative 429 → next credential) |
| 20–24 | Edge | 0 runtime dependencies. Runs on Cloudflare Workers. |
| 24–28 | Models | Gemini 4. Ready. Model list, `reasoning_effort`, `-search` / `-max` suffixes |
| 28–33 | Finale | Logo, name, tagline, repository URL |

Copy was checked against README.md, `src/models.json` and `package.json` on 2026-11-15. The key, URL and reply are placeholders; no real API traffic was used.

## Soundtrack

**Signal Path** — original procedural score, 120 BPM, D minor resolving to F major. Additive pads, plucks, bells, synthesized drums and noise sweeps; hits land on every cut. No samples or recordings. Mastered to −16 LUFS, true peak ≈ −2.7 dBTP.

## Re-render

Requires Node.js with `@napi-rs/canvas`, `uv` (NumPy), FFmpeg 7, and macOS system fonts (Helvetica Neue, SF Mono). Set `CANVAS_MODULE` / `FFMPEG` to override tool paths.

```sh
node source/render.cjs --stills     # storyboard.jpg, poster.jpg, qa/still-*.png
uv run --with numpy python source/score.py
node source/render.cjs              # assets/picture.mp4 + qa/layout.json (text safe-area check on all frames)
```

Then encode and mux:

```sh
ffmpeg -y -i assets/picture.mp4 -c:v libx264 -preset slow -b:v 1950k -pass 1 -an -f null -
ffmpeg -y -i assets/picture.mp4 -i assets/original-score.wav -map 0:v -map 1:a \
  -c:v libx264 -preset slow -b:v 1950k -maxrate 4000k -bufsize 8000k -pass 2 -pix_fmt yuv420p \
  -c:a aac -b:a 160k -ar 48000 -af "loudnorm=I=-16:TP=-3:LRA=9,alimiter=limit=0.7:level=false" \
  -t 33 -movflags +faststart ../../docs/videos/vertex2openai-intro-en.mp4
```

Note: SF Pro (variable) renders bold weights with wrong advances in Skia, so display type uses Helvetica Neue.
