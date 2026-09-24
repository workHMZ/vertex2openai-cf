// ============================================================
// SSE Streaming response processing
// ============================================================

import type { OpenAIUsage, VertexPart, VertexResponse } from "../types";
import { convertFunctionCallsToOpenAI } from "./tools";
import { mapFinishReason } from "./finish-reason";
import { buildUsage, normalizeUsage } from "./response";
import { SseLineBuffer } from "./sse-lines";

const THINKING_TAG = "vertex_think_tag";

/**
 * Processor for extracting reasoning content from streamed chunks.
 * Tracks tag state across multiple chunks.
 */
export class StreamingReasoningProcessor {
  private openTag = `<${THINKING_TAG}>`;
  private closeTag = `</${THINKING_TAG}>`;
  private buffer = "";
  private insideTag = false;
  private partialTagBuffer = "";
  // Vertex follows the closing tag with "\n\n"; the non-streaming path trims
  // it, so strip whitespace ahead of the first visible text after a thought.
  private sawThought = false;
  private sawVisible = false;

  private visible(text: string): string {
    if (this.sawThought && !this.sawVisible) text = text.replace(/^\s+/, "");
    if (/\S/.test(text)) this.sawVisible = true;
    return text;
  }

  /**
   * Process a content chunk, separating reasoning from normal content.
   * Returns [processedContent, currentReasoning].
   */
  processChunk(content: string): [string, string] {
    if (this.partialTagBuffer) {
      content = this.partialTagBuffer + content;
      this.partialTagBuffer = "";
    }

    this.buffer += content;
    let processed = "";
    let reasoning = "";

    while (this.buffer.length > 0) {
      if (!this.insideTag) {
        const openPos = this.buffer.indexOf(this.openTag);
        if (openPos === -1) {
          // Check for partial tag match at end
          let partial = false;
          for (let i = 1; i < Math.min(this.openTag.length, this.buffer.length + 1); i++) {
            if (this.buffer.slice(-i) === this.openTag.slice(0, i)) {
              if (this.buffer.length > i) {
                processed += this.buffer.slice(0, -i);
              }
              this.partialTagBuffer = this.buffer.slice(-i);
              this.buffer = "";
              partial = true;
              break;
            }
          }
          if (!partial) {
            processed += this.buffer;
            this.buffer = "";
          }
          break;
        } else {
          processed += this.buffer.slice(0, openPos);
          this.buffer = this.buffer.slice(openPos + this.openTag.length);
          this.insideTag = true;
          this.sawThought = true;
        }
      } else {
        const closePos = this.buffer.indexOf(this.closeTag);
        if (closePos === -1) {
          // Check for partial close tag
          let partial = false;
          for (let i = 1; i < Math.min(this.closeTag.length, this.buffer.length + 1); i++) {
            if (this.buffer.slice(-i) === this.closeTag.slice(0, i)) {
              if (this.buffer.length > i) {
                reasoning += this.buffer.slice(0, -i);
              }
              this.partialTagBuffer = this.buffer.slice(-i);
              this.buffer = "";
              partial = true;
              break;
            }
          }
          if (!partial) {
            reasoning += this.buffer;
            this.buffer = "";
          }
          break;
        } else {
          reasoning += this.buffer.slice(0, closePos);
          this.buffer = this.buffer.slice(closePos + this.closeTag.length);
          this.insideTag = false;
        }
      }
    }

    return [this.visible(processed), reasoning];
  }

  /** Flush remaining buffered content. Returns [content, reasoning]. */
  flushRemaining(): [string, string] {
    // A half-received tag belongs to whichever side it was cut off in.
    const rest = this.buffer + this.partialTagBuffer;
    this.buffer = "";
    this.partialTagBuffer = "";
    if (this.insideTag) {
      this.insideTag = false;
      return ["", rest];
    }
    return [this.visible(rest), ""];
  }
}

/**
 * Transform a Vertex AI SSE stream into an OpenAI-compatible SSE stream.
 * Reads from the upstream Response body line-by-line.
 */
export function createStreamTransformer(
  requestModel: string
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const input = new SseLineBuffer();
  const processor = new StreamingReasoningProcessor();
  let doneSent = false;
  // Upstream already terminates most streams with a finish_reason; emitting
  // our own on top of it would hand clients two finish chunks.
  let finishEmitted = false;

  return new TransformStream({
    transform(chunk, controller) {
      if (doneSent) return;
      for (const line of input.push(chunk)) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();

        if (jsonStr === "[DONE]") {
          // Flush remaining
          const [remContent, remReasoning] = processor.flushRemaining();
          if (remReasoning) {
            const rp = makeChunk(requestModel, { reasoning_content: remReasoning }, null);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(rp)}\n\n`));
          }
          if (remContent) {
            const cp = makeChunk(requestModel, { content: remContent }, null);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(cp)}\n\n`));
          }
          if (!finishEmitted) {
            const fp = makeChunk(requestModel, {}, "stop");
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(fp)}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          doneSent = true;
          return;
        }

        try {
          const data = JSON.parse(jsonStr);
          // Same fix as the non-streaming path: Vertex reports reasoning
          // tokens outside completion_tokens, so the totals do not add up.
          if (data.usage) data.usage = normalizeUsage(data.usage);
          const choices = data.choices;
          if (!choices || !Array.isArray(choices) || choices.length === 0) {
            // Pass through non-choice chunks
            data.model = requestModel;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            continue;
          }

          const choice = choices[0];
          const delta = choice.delta || {};
          choice.delta = delta;
          const content = typeof delta.content === "string" ? delta.content : "";
          // The OpenAI schema requires the key on every streamed choice.
          const finishReason = choice.finish_reason ?? null;
          choice.finish_reason = finishReason;

          // Remove extra_content if present
          delete delta.extra_content;

          let text = "";
          let reasoning = "";
          if (content) [text, reasoning] = processor.processChunk(content);
          // A finished candidate sends nothing more, so whatever the tag
          // parser is holding back has to go out ahead of the finish chunk.
          if (finishReason) {
            const [restText, restReasoning] = processor.flushRemaining();
            text += restText;
            reasoning += restReasoning;
            finishEmitted = true;
          }

          if (reasoning) {
            const rChunk = makeChunkFromBase(data, requestModel, { reasoning_content: reasoning }, null);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(rChunk)}\n\n`));
          }

          // Vertex puts finish_reason and usage on the chunk that carries the
          // last piece of text, so the rest of the upstream chunk — role, tool
          // calls, finish_reason, usage — travels with the visible text rather
          // than being rebuilt from scratch and losing fields.
          if (text) delta.content = text;
          else delete delta.content;
          const onlyReasoning =
            content && !text && !finishReason && !data.usage &&
            Object.keys(delta).length === 0;
          if (!onlyReasoning) {
            data.model = requestModel;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    },

    flush(controller) {
      if (doneSent) return;

      const [remContent, remReasoning] = processor.flushRemaining();
      if (remReasoning) {
        const rp = makeChunk(requestModel, { reasoning_content: remReasoning }, null);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(rp)}\n\n`));
      }
      if (remContent) {
        const cp = makeChunk(requestModel, { content: remContent }, null);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(cp)}\n\n`));
      }

      // The upstream connection can end without a [DONE] sentinel; OpenAI
      // clients hang waiting for it, so always close the stream ourselves.
      if (!finishEmitted) {
        const fp = makeChunk(requestModel, {}, "stop");
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(fp)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneSent = true;
    },
  });
}

/**
 * Transform a native Vertex streamGenerateContent SSE stream into an
 * OpenAI-compatible chat.completion.chunk SSE stream.
 */
export function createVertexStreamTransformer(
  requestModel: string
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const input = new SseLineBuffer();
  let doneSent = false;
  let sentRole = false;
  // OpenAI clients accumulate tool call deltas by index, so it has to keep
  // counting up across chunks instead of restarting at 0 for every frame.
  let toolCallIndex = 0;
  let sawToolCall = false;
  // Clients wait for a finish_reason; an upstream error replaces it.
  let finished = false;
  const responseId = `chatcmpl-${Date.now()}`;

  function enqueueChunk(
    controller: TransformStreamDefaultController<Uint8Array>,
    delta: Record<string, unknown>,
    finishReason: string | null,
    usage?: OpenAIUsage
  ) {
    const chunk = {
      id: responseId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: requestModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  }

  function processVertexChunk(
    data: VertexResponse & { error?: unknown },
    controller: TransformStreamDefaultController<Uint8Array>
  ) {
    // An error frame mid-stream: pass it on in the shape OpenAI SDKs raise
    // from, rather than ending the stream as if the answer were complete.
    if (data.error) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ error: data.error })}\n\n`)
      );
      finished = true;
      return;
    }

    // A blocked prompt arrives as a single frame with promptFeedback and no
    // candidates.
    if (!data.candidates?.length && data.promptFeedback?.blockReason) {
      if (!sentRole) enqueueChunk(controller, { role: "assistant" }, null);
      sentRole = true;
      enqueueChunk(
        controller,
        {},
        "content_filter",
        data.usageMetadata ? buildUsage(data.usageMetadata) : undefined
      );
      finished = true;
      return;
    }

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    if (!sentRole && (parts.length > 0 || candidate?.finishReason)) {
      enqueueChunk(controller, { role: "assistant" }, null);
      sentRole = true;
    }

    for (const part of parts) {
      if (part.text) {
        enqueueChunk(
          controller,
          part.thought
            ? { reasoning_content: part.text }
            : { content: part.text },
          null
        );
      } else if (part.inlineData?.data) {
        const mimeType = part.inlineData.mimeType || "application/octet-stream";
        enqueueChunk(
          controller,
          { content: `data:${mimeType};base64,${part.inlineData.data}` },
          null
        );
      }
    }

    const toolCalls = convertFunctionCallsToOpenAI(
      parts as VertexPart[],
      responseId,
      0,
      toolCallIndex
    );
    for (const toolCall of toolCalls) {
      sawToolCall = true;
      enqueueChunk(
        controller,
        {
          tool_calls: [
            {
              index: toolCallIndex,
              id: toolCall.id,
              type: toolCall.type,
              function: toolCall.function,
              ...(toolCall.thought_signature
                ? { thought_signature: toolCall.thought_signature }
                : {}),
            },
          ],
        },
        null
      );
      toolCallIndex++;
    }

    if (candidate?.finishReason) {
      const usage = data.usageMetadata
        ? buildUsage(data.usageMetadata)
        : undefined;
      enqueueChunk(
        controller,
        {},
        mapFinishReason(candidate.finishReason, sawToolCall),
        usage
      );
      finished = true;
    }
  }

  function processLine(
    line: string,
    controller: TransformStreamDefaultController<Uint8Array>
  ) {
    if (!line.startsWith("data: ")) return;
    const payload = line.slice(6).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneSent = true;
      return;
    }

    try {
      processVertexChunk(JSON.parse(payload) as VertexResponse, controller);
    } catch {
      // Skip malformed stream frames.
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      for (const line of input.push(chunk)) {
        processLine(line.trimEnd(), controller);
      }
    },

    flush(controller) {
      const tail = input.rest().trim();
      if (tail) processLine(tail, controller);
      // The connection can drop before the frame carrying finishReason.
      if (!finished && !doneSent) {
        enqueueChunk(controller, {}, sawToolCall ? "tool_calls" : "stop");
      }
      if (!doneSent) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        doneSent = true;
      }
    },
  });
}

function makeChunk(
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null
) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function makeChunkFromBase(
  base: Record<string, unknown>,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null | undefined
) {
  return {
    id: base.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: base.created || Math.floor(Date.now() / 1000),
    model,
    // finish_reason is required on every streamed choice; undefined would be
    // dropped by JSON.stringify and leave the key missing.
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  };
}
