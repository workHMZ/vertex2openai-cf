// ============================================================
// OpenAI Responses API <-> Chat Completions bridge
// ============================================================
//
// The Responses API is the second wire format OpenAI clients speak. Rather
// than converting Vertex twice, everything is routed through the Chat
// Completions shape this adapter already produces and translated here.
//
// Schemas follow the published OpenAI OpenAPI spec: `Response`, `OutputItem`
// (OutputMessage / FunctionToolCall / ReasoningItem) and the
// `response.*` streaming events.

import type {
  OpenAIMessage,
  OpenAIRequest,
  OpenAIResponse,
  OpenAIToolCall,
  OpenAITool,
  OpenAIResponseFormat,
  ResponsesRequest,
  ResponsesInputItem,
  ResponseObject,
  ResponseOutputItem,
  ResponseUsage,
} from "../types";
import { readToolCallSignature } from "./thought-signature";

// ----- Request: Responses -> Chat Completions -----

/** Content parts an input message may carry, in either API's spelling. */
function partsToChatContent(
  content: unknown
): OpenAIMessage["content"] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const out: NonNullable<Exclude<OpenAIMessage["content"], string>> = [];
  for (const raw of content) {
    const part = raw as Record<string, unknown>;
    const type = part.type;
    if (type === "input_text" || type === "output_text" || type === "text") {
      out.push({ type: "text", text: String(part.text ?? "") });
    } else if (type === "input_image" || type === "image_url") {
      // `image_url` is a bare string in Responses and an object in Chat.
      const url =
        typeof part.image_url === "string"
          ? part.image_url
          : (part.image_url as { url?: string } | undefined)?.url;
      if (url) out.push({ type: "image_url", image_url: { url } });
    } else if (type === "refusal") {
      out.push({ type: "text", text: String(part.refusal ?? "") });
    }
  }
  return out;
}

/**
 * Convert a Responses request into the Chat Completions shape used
 * internally. Items are a flat list, so function calls and their outputs
 * have to be re-associated into assistant/tool message pairs.
 */
export function responsesRequestToChat(
  request: ResponsesRequest
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  if (request.instructions) {
    messages.push({ role: "system", content: request.instructions });
  }

  const input = request.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const raw of input) {
      const item = raw as ResponsesInputItem & Record<string, unknown>;

      if (item.type === "function_call") {
        const toolCall: OpenAIToolCall = {
          id: String(item.call_id ?? item.id ?? ""),
          type: "function",
          function: {
            name: String(item.name ?? ""),
            arguments: String(item.arguments ?? "{}"),
          },
        };
        // Preserve a Gemini 3 signature the client echoed back on the item.
        const sig = item.thought_signature;
        if (typeof sig === "string" && sig) toolCall.thought_signature = sig;

        const last = messages[messages.length - 1];
        if (last?.role === "assistant" && last.tool_calls) {
          last.tool_calls.push(toolCall);
        } else {
          messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
        }
        continue;
      }

      if (item.type === "function_call_output") {
        const output = item.output;
        messages.push({
          role: "tool",
          tool_call_id: String(item.call_id ?? ""),
          content:
            typeof output === "string" ? output : JSON.stringify(output ?? ""),
        });
        continue;
      }

      if (item.type === "reasoning") continue; // no Chat Completions equivalent

      // message / EasyInputMessage
      const role = item.role === "developer" ? "system" : item.role;
      if (role !== "system" && role !== "user" && role !== "assistant") continue;
      messages.push({
        role,
        content: partsToChatContent(item.content),
      } as OpenAIMessage);
    }
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: "" });
  }

  const chat: OpenAIRequest = {
    model: request.model,
    messages,
    stream: Boolean(request.stream),
  };

  if (request.max_output_tokens != null) chat.max_tokens = request.max_output_tokens;
  if (request.temperature != null) chat.temperature = request.temperature;
  if (request.top_p != null) chat.top_p = request.top_p;
  if (request.parallel_tool_calls != null) {
    chat.parallel_tool_calls = request.parallel_tool_calls;
  }
  if (request.reasoning?.effort) chat.reasoning_effort = request.reasoning.effort;

  const tools = convertResponsesTools(request.tools);
  if (tools.length > 0) chat.tools = tools;

  const toolChoice = convertResponsesToolChoice(request.tool_choice);
  if (toolChoice) chat.tool_choice = toolChoice;

  const responseFormat = convertTextFormat(request.text);
  if (responseFormat) chat.response_format = responseFormat;

  return chat;
}

/** Responses declares function tools flat; Chat Completions nests them. */
export function convertResponsesTools(
  tools: ResponsesRequest["tools"]
): OpenAITool[] {
  if (!Array.isArray(tools)) return [];
  const out: OpenAITool[] = [];
  for (const tool of tools) {
    if (tool?.type !== "function" || !tool.name) continue;
    out.push({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.parameters ? { parameters: tool.parameters } : {}),
      },
    });
  }
  return out;
}

export function convertResponsesToolChoice(
  choice: ResponsesRequest["tool_choice"]
): OpenAIRequest["tool_choice"] {
  if (!choice) return undefined;
  if (typeof choice === "string") return choice;
  // Responses names the function inline; Chat Completions nests it.
  if (choice.type === "function" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

/** `text.format` is the Responses spelling of `response_format`. */
export function convertTextFormat(
  text: ResponsesRequest["text"]
): OpenAIResponseFormat | undefined {
  const format = text?.format;
  if (!format) return undefined;

  if (format.type === "json_object") return { type: "json_object" };
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: format.name ?? "response",
        ...(format.description ? { description: format.description } : {}),
        ...(format.strict != null ? { strict: format.strict } : {}),
        ...(format.schema ? { schema: format.schema } : {}),
      },
    };
  }
  return undefined;
}

// ----- Response: Chat Completions -> Responses -----

const FINISH_TO_STATUS: Record<string, ResponseObject["status"]> = {
  stop: "completed",
  tool_calls: "completed",
  length: "incomplete",
  content_filter: "incomplete",
};

export function makeResponseId(seed: number = Date.now()): string {
  return `resp_${seed.toString(36)}`;
}

function usageToResponses(usage: OpenAIResponse["usage"]): ResponseUsage {
  return {
    input_tokens: usage.prompt_tokens,
    input_tokens_details: {
      cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    },
    output_tokens: usage.completion_tokens,
    output_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    },
    total_tokens: usage.total_tokens,
  };
}

/**
 * Build the output item list. Order matches what the model produced:
 * reasoning, then the assistant message, then any function calls.
 */
export function buildOutputItems(
  responseId: string,
  opts: {
    reasoning?: string;
    text?: string | null;
    toolCalls?: OpenAIToolCall[];
    incomplete?: boolean;
  }
): ResponseOutputItem[] {
  const status = opts.incomplete ? "incomplete" : "completed";
  const items: ResponseOutputItem[] = [];

  if (opts.reasoning) {
    items.push({
      id: `rs_${responseId}_0`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: opts.reasoning }],
      status,
    });
  }

  if (opts.text) {
    items.push({
      id: `msg_${responseId}_0`,
      type: "message",
      role: "assistant",
      status,
      content: [{ type: "output_text", text: opts.text, annotations: [] }],
    });
  }

  for (const [i, call] of (opts.toolCalls ?? []).entries()) {
    // The signature may arrive bare or nested under extra_content depending on
    // which Vertex endpoint served the request.
    const signature = readToolCallSignature(call);
    items.push({
      id: `fc_${responseId}_${i}`,
      type: "function_call",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status,
      ...(signature ? { thought_signature: signature } : {}),
    });
  }

  return items;
}

/** Convert a finished Chat Completion into a Response object. */
export function chatToResponse(
  completion: OpenAIResponse,
  request: ResponsesRequest
): ResponseObject {
  const responseId = makeResponseId();
  const choice = completion.choices[0];
  const finish = choice?.finish_reason ?? "stop";
  const status = FINISH_TO_STATUS[finish] ?? "completed";

  const output = buildOutputItems(responseId, {
    reasoning: choice?.message.reasoning_content,
    text: choice?.message.content,
    toolCalls: choice?.message.tool_calls,
    incomplete: status === "incomplete",
  });

  return {
    id: responseId,
    object: "response",
    created_at: completion.created,
    status,
    model: completion.model,
    output,
    output_text: choice?.message.content ?? "",
    error: null,
    incomplete_details:
      status === "incomplete" ? { reason: finish } : null,
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
    usage: usageToResponses(completion.usage),
  };
}
