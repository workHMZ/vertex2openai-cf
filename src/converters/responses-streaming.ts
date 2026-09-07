// ============================================================
// chat.completion.chunk SSE -> Responses API typed SSE events
// ============================================================

import type {
  OpenAIToolCall,
  ResponsesRequest,
  ResponseObject,
  ResponseOutputItem,
  ResponseUsage,
} from "../types";
import { buildOutputItems, makeResponseId } from "./responses";

interface PendingToolCall {
  outputIndex: number;
  itemId: string;
  callId: string;
  name: string;
  args: string;
  signature?: string;
}

const EMPTY_USAGE: ResponseUsage = {
  input_tokens: 0,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 0,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 0,
};

/**
 * Wrap the Chat Completions SSE this adapter already produces in the
 * Responses API's typed event stream. Every event carries an incrementing
 * `sequence_number`, and items are opened and closed in the order the model
 * emits them: reasoning, message, then function calls.
 */
export function createResponsesStreamTransformer(
  request: ResponsesRequest,
  model: string
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const responseId = makeResponseId();
  let leftover = "";
  let sequence = 0;
  let outputIndex = 0;
  let started = false;
  let finished = false;

  let reasoningItemId: string | null = null;
  let reasoningIndex = 0;
  let reasoningText = "";

  let messageItemId: string | null = null;
  let messageIndex = 0;
  let messageText = "";

  const toolCalls = new Map<number, PendingToolCall>();
  let finishReason: string | null = null;
  let usage: ResponseUsage = EMPTY_USAGE;

  type Controller = TransformStreamDefaultController<Uint8Array>;

  function emit(event: Record<string, unknown>, controller: Controller) {
    const payload = { ...event, sequence_number: sequence++ };
    // Responses events are named on the SSE `event:` line as well as in `type`.
    controller.enqueue(
      encoder.encode(
        `event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`
      )
    );
  }

  function snapshot(
    status: ResponseObject["status"],
    output: ResponseOutputItem[]
  ): ResponseObject {
    return {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status,
      model,
      output,
      output_text: messageText,
      error: null,
      incomplete_details:
        status === "incomplete" && finishReason
          ? { reason: finishReason }
          : null,
      instructions: request.instructions ?? null,
      max_output_tokens: request.max_output_tokens ?? null,
      parallel_tool_calls: request.parallel_tool_calls ?? true,
      previous_response_id: request.previous_response_id ?? null,
      reasoning: request.reasoning ?? null,
      temperature: request.temperature ?? null,
      text: request.text ?? { format: { type: "text" } },
      tool_choice: request.tool_choice ?? "auto",
      tools: request.tools ?? [],
      top_p: request.top_p ?? null,
      metadata: request.metadata ?? {},
      usage,
    };
  }

  function start(controller: Controller) {
    if (started) return;
    started = true;
    const initial = snapshot("in_progress", []);
    emit({ type: "response.created", response: initial }, controller);
    emit({ type: "response.in_progress", response: initial }, controller);
  }

  // ----- reasoning item -----

  function openReasoning(controller: Controller) {
    if (reasoningItemId) return;
    reasoningItemId = `rs_${responseId}_0`;
    reasoningIndex = outputIndex++;
    emit(
      {
        type: "response.output_item.added",
        output_index: reasoningIndex,
        item: {
          id: reasoningItemId,
          type: "reasoning",
          summary: [],
          content: [],
          status: "in_progress",
        },
      },
      controller
    );
  }

  function closeReasoning(controller: Controller) {
    if (!reasoningItemId) return;
    emit(
      {
        type: "response.output_item.done",
        output_index: reasoningIndex,
        item: {
          id: reasoningItemId,
          type: "reasoning",
          summary: [{ type: "summary_text", text: reasoningText }],
          content: [{ type: "reasoning_text", text: reasoningText }],
          status: "completed",
        },
      },
      controller
    );
    reasoningItemId = null;
  }

  // ----- message item -----

  function openMessage(controller: Controller) {
    if (messageItemId) return;
    messageItemId = `msg_${responseId}_0`;
    messageIndex = outputIndex++;
    emit(
      {
        type: "response.output_item.added",
        output_index: messageIndex,
        item: {
          id: messageItemId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      controller
    );
    emit(
      {
        type: "response.content_part.added",
        item_id: messageItemId,
        output_index: messageIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      controller
    );
  }

  function closeMessage(controller: Controller, status: string) {
    if (!messageItemId) return;
    const part = { type: "output_text", text: messageText, annotations: [] };
    emit(
      {
        type: "response.output_text.done",
        item_id: messageItemId,
        output_index: messageIndex,
        content_index: 0,
        text: messageText,
        logprobs: [],
      },
      controller
    );
    emit(
      {
        type: "response.content_part.done",
        item_id: messageItemId,
        output_index: messageIndex,
        content_index: 0,
        part,
      },
      controller
    );
    emit(
      {
        type: "response.output_item.done",
        output_index: messageIndex,
        item: {
          id: messageItemId,
          type: "message",
          role: "assistant",
          status,
          content: [part],
        },
      },
      controller
    );
    messageItemId = null;
  }

  // ----- function call items -----

  function handleToolCallDelta(
    delta: {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
      thought_signature?: string;
    },
    controller: Controller
  ) {
    const index = delta.index ?? 0;
    let pending = toolCalls.get(index);

    if (!pending) {
      // Reasoning and text are finished once tool calls begin.
      closeReasoning(controller);
      closeMessage(controller, "completed");

      pending = {
        outputIndex: outputIndex++,
        itemId: `fc_${responseId}_${index}`,
        callId: delta.id ?? `call_${responseId}_${index}`,
        name: delta.function?.name ?? "",
        args: "",
        signature: delta.thought_signature,
      };
      toolCalls.set(index, pending);

      emit(
        {
          type: "response.output_item.added",
          output_index: pending.outputIndex,
          item: {
            id: pending.itemId,
            type: "function_call",
            call_id: pending.callId,
            name: pending.name,
            arguments: "",
            status: "in_progress",
          },
        },
        controller
      );
    }

    if (delta.function?.name) pending.name = delta.function.name;
    if (delta.thought_signature) pending.signature = delta.thought_signature;

    const argsDelta = delta.function?.arguments;
    if (argsDelta) {
      pending.args += argsDelta;
      emit(
        {
          type: "response.function_call_arguments.delta",
          item_id: pending.itemId,
          output_index: pending.outputIndex,
          delta: argsDelta,
        },
        controller
      );
    }
  }

  function closeToolCalls(controller: Controller) {
    for (const pending of toolCalls.values()) {
      emit(
        {
          type: "response.function_call_arguments.done",
          item_id: pending.itemId,
          output_index: pending.outputIndex,
          arguments: pending.args,
        },
        controller
      );
      emit(
        {
          type: "response.output_item.done",
          output_index: pending.outputIndex,
          item: {
            id: pending.itemId,
            type: "function_call",
            call_id: pending.callId,
            name: pending.name,
            arguments: pending.args,
            status: "completed",
            ...(pending.signature
              ? { thought_signature: pending.signature }
              : {}),
          },
        },
        controller
      );
    }
  }

  function finish(controller: Controller) {
    if (finished) return;
    finished = true;
    start(controller);

    const incomplete =
      finishReason === "length" || finishReason === "content_filter";
    closeReasoning(controller);
    closeMessage(controller, incomplete ? "incomplete" : "completed");
    closeToolCalls(controller);

    const calls: OpenAIToolCall[] = [...toolCalls.values()].map((p) => ({
      id: p.callId,
      type: "function",
      function: { name: p.name, arguments: p.args },
      ...(p.signature ? { thought_signature: p.signature } : {}),
    }));

    const output = buildOutputItems(responseId, {
      reasoning: reasoningText || undefined,
      text: messageText || null,
      toolCalls: calls,
      incomplete,
    });

    emit(
      {
        type: "response.completed",
        response: snapshot(incomplete ? "incomplete" : "completed", output),
      },
      controller
    );
  }

  function processChunk(raw: string, controller: Controller) {
    const data = JSON.parse(raw) as {
      choices?: Array<{
        delta?: {
          content?: string;
          reasoning_content?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
            thought_signature?: string;
          }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };

    if (data.usage) {
      usage = {
        input_tokens: data.usage.prompt_tokens ?? 0,
        input_tokens_details: {
          cached_tokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
        },
        output_tokens: data.usage.completion_tokens ?? 0,
        output_tokens_details: {
          reasoning_tokens:
            data.usage.completion_tokens_details?.reasoning_tokens ?? 0,
        },
        total_tokens: data.usage.total_tokens ?? 0,
      };
    }

    const choice = data.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta ?? {};

    if (delta.reasoning_content) {
      openReasoning(controller);
      reasoningText += delta.reasoning_content;
      emit(
        {
          type: "response.reasoning_text.delta",
          item_id: reasoningItemId,
          output_index: reasoningIndex,
          content_index: 0,
          delta: delta.reasoning_content,
        },
        controller
      );
    }

    if (delta.content) {
      closeReasoning(controller);
      openMessage(controller);
      messageText += delta.content;
      emit(
        {
          type: "response.output_text.delta",
          item_id: messageItemId,
          output_index: messageIndex,
          content_index: 0,
          delta: delta.content,
          logprobs: [],
        },
        controller
      );
    }

    for (const tc of delta.tool_calls ?? []) {
      handleToolCallDelta(tc, controller);
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      start(controller);
      const text = leftover + decoder.decode(chunk, { stream: true });
      const lines = text.split("\n");
      leftover = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          processChunk(payload, controller);
        } catch {
          // Skip malformed frames rather than tearing down the stream.
        }
      }
    },

    flush(controller) {
      finish(controller);
    },
  });
}
