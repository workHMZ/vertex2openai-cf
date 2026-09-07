// ============================================================
// OpenAI → Vertex AI request conversion
// ============================================================

import type {
  OpenAIRequest,
  OpenAIMessage,
  OpenAIContentPart,
  VertexContent,
  VertexPart,
  VertexSafetySetting,
  VertexGenerationConfig,
  VertexRequest,
  ParsedModelInfo,
  OpenAIResponseFormat,
} from "../types";
import {
  convertToolsToVertex,
  convertToolChoiceToVertex,
} from "./tools";
import {
  SIGNATURE_PLACEHOLDER,
  readToolCallSignature,
} from "./thought-signature";
import {
  getModelCapabilities,
  resolveThinkingLevel,
  clampThinkingLevel,
  type ModelCapabilities,
  type ThinkingLevel,
} from "../model-capabilities";

// ----- Model Name Parsing -----

const EXPRESS_PREFIX = "[EXPRESS] ";
const PAY_PREFIX = "[PAY]";
const OPENAI_DIRECT_SUFFIX = "-openai";
const OPENAI_SEARCH_SUFFIX = "-openaisearch";

/**
 * Parse model name to extract base model and feature flags.
 */
export function parseModelName(model: string): ParsedModelInfo {
  let name = model;
  let isExpress = false;
  let isPay = false;

  // Strip prefixes. /v1/models emits "[EXPRESS] " with a trailing space and
  // "[PAY]" without one, and users retype them by hand, so tolerate both.
  if (name.startsWith(EXPRESS_PREFIX.trim())) {
    isExpress = true;
    name = name.slice(EXPRESS_PREFIX.trim().length).trimStart();
  }
  if (name.startsWith(PAY_PREFIX)) {
    isPay = true;
    name = name.slice(PAY_PREFIX.length).trimStart();
  }
  name = name.trim();

  // Detect suffixes
  const isOpenAISearch = name.endsWith(OPENAI_SEARCH_SUFFIX);
  const isOpenAIDirect =
    name.endsWith(OPENAI_DIRECT_SUFFIX) || isOpenAISearch;
  const isSearch = name.endsWith("-search");
  const isNoThinking = name.endsWith("-nothinking");
  const isMaxThinking = name.endsWith("-max");
  const is2kImage = name.endsWith("-2k");
  const is4kImage = name.endsWith("-4k");

  // Strip suffixes to get base model
  let baseModel = name;
  const suffixes = [
    OPENAI_SEARCH_SUFFIX,
    OPENAI_DIRECT_SUFFIX,
    "-search",
    "-nothinking",
    "-max",
    "-2k",
    "-4k",
  ];
  for (const suffix of suffixes) {
    if (baseModel.endsWith(suffix)) {
      baseModel = baseModel.slice(0, -suffix.length);
      break;
    }
  }

  return {
    baseModel,
    isExpress,
    isPay,
    isOpenAIDirect,
    isOpenAISearch,
    isSearch,
    isNoThinking,
    isMaxThinking,
    is2kImage,
    is4kImage,
    isImage: getModelCapabilities(baseModel).isImage,
  };
}

// ----- Safety Settings -----

const SAFETY_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
];

export function buildSafetySettings(): VertexSafetySetting[] {
  return SAFETY_CATEGORIES.map((category) => ({
    category,
    threshold: "BLOCK_NONE",
  }));
}

// ----- Generation Config -----

export function buildGenerationConfig(
  request: OpenAIRequest,
  modelInfo: ParsedModelInfo
): VertexGenerationConfig {
  const config: VertexGenerationConfig = {};
  const caps = getModelCapabilities(modelInfo.baseModel);

  if (request.temperature != null) config.temperature = request.temperature;
  const maxTokens = request.max_tokens ?? request.max_completion_tokens;
  if (maxTokens != null) config.maxOutputTokens = maxTokens;
  if (request.top_p != null) config.topP = request.top_p;
  if (request.top_k != null) config.topK = request.top_k;
  // OpenAI accepts a bare string here; Vertex only accepts an array.
  if (request.stop) {
    config.stopSequences = Array.isArray(request.stop)
      ? request.stop
      : [request.stop];
  }
  if (request.seed != null) config.seed = request.seed;
  if (request.n != null) config.candidateCount = request.n;
  // Dropped rather than forwarded on models that reject them outright.
  if (caps.supportsPenalties) {
    if (request.frequency_penalty != null) {
      config.frequencyPenalty = request.frequency_penalty;
    }
    if (request.presence_penalty != null) {
      config.presencePenalty = request.presence_penalty;
    }
  }

  const responseFormat = convertResponseFormat(request.response_format);
  if (responseFormat) Object.assign(config, responseFormat);

  // Gemini 3 takes a coarse thinkingLevel; the numeric thinkingBudget was a
  // Gemini 2.5 control and is not sent.
  if (caps.supportsThinking) {
    config.thinkingConfig = { includeThoughts: true };
    const level = thinkingLevelFor(request, modelInfo, caps);
    if (level) config.thinkingConfig.thinkingLevel = level;
  }

  // Image generation config. An image model has to be told to emit the IMAGE
  // modality even when no explicit size variant was requested.
  if (modelInfo.isImage) {
    config.responseModalities = ["TEXT", "IMAGE"];
    if (modelInfo.is2kImage) config.imageConfig = { imageSize: "2K" };
    else if (modelInfo.is4kImage) config.imageConfig = { imageSize: "4K" };
  }

  return config;
}

/**
 * The `-nothinking` / `-max` model suffixes are shorthand that overrides an
 * explicit reasoning_effort.
 */
function thinkingLevelFor(
  request: OpenAIRequest,
  modelInfo: ParsedModelInfo,
  caps: ModelCapabilities
): ThinkingLevel | undefined {
  if (modelInfo.isNoThinking) return clampThinkingLevel("MINIMAL", caps);
  if (modelInfo.isMaxThinking) return "HIGH";
  return resolveThinkingLevel(request.reasoning_effort, caps);
}

/**
 * Vertex's OpenAI-compatible endpoint carries Gemini 3 thought signatures in
 * `extra_content.google.thought_signature` on each tool call, and rejects the
 * next turn if the first call of a step arrives without one. Clients that drop
 * unknown fields cannot echo it back, so restore it — or fall back to the
 * documented skip value — before forwarding.
 */
export function signToolCallsForOpenAIEndpoint(
  messages: OpenAIMessage[]
): OpenAIMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant" || !msg.tool_calls?.length) return msg;

    let signed = false;
    const toolCalls = msg.tool_calls.map((tc, i) => {
      const signature =
        readToolCallSignature(tc) ??
        (i === 0 && !signed ? SIGNATURE_PLACEHOLDER : undefined);
      if (!signature) return tc;
      signed = true;
      const { thought_signature: _dropped, ...rest } = tc;
      return {
        ...rest,
        extra_content: { google: { thought_signature: signature } },
      } as typeof tc;
    });

    return { ...msg, tool_calls: toolCalls };
  });
}

/**
 * OpenAI's `response_format` maps onto Gemini's responseMimeType /
 * responseSchema pair. Without this, structured-output requests silently
 * return prose.
 */
export function convertResponseFormat(
  format: OpenAIResponseFormat | undefined
): Pick<VertexGenerationConfig, "responseMimeType" | "responseSchema"> | undefined {
  if (!format) return undefined;

  if (format.type === "json_object") {
    return { responseMimeType: "application/json" };
  }

  if (format.type === "json_schema") {
    const schema = format.json_schema?.schema;
    return {
      responseMimeType: "application/json",
      ...(schema ? { responseSchema: stripUnsupportedSchemaKeys(schema) } : {}),
    };
  }

  return undefined;
}

/**
 * Vertex rejects JSON Schema drafts' bookkeeping keywords outright, and
 * OpenAI's strict mode always emits additionalProperties.
 */
const UNSUPPORTED_SCHEMA_KEYS = ["$schema", "additionalProperties", "$id", "definitions", "$defs"];

export function stripUnsupportedSchemaKeys(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.includes(key)) continue;
    if (Array.isArray(value)) {
      out[key] = value.map((v) =>
        v && typeof v === "object"
          ? stripUnsupportedSchemaKeys(v as Record<string, unknown>)
          : v
      );
    } else if (value && typeof value === "object") {
      out[key] = stripUnsupportedSchemaKeys(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ----- Message Conversion -----

/**
 * Convert a single OpenAI message to Vertex AI content parts.
 */
function convertMessageParts(msg: OpenAIMessage): VertexPart[] {
  const parts: VertexPart[] = [];

  if (msg.content === null || msg.content === undefined) {
    return parts;
  }

  if (typeof msg.content === "string") {
    if (msg.content.length > 0) {
      parts.push({ text: msg.content });
    }
    return parts;
  }

  // Array of content parts
  for (const part of msg.content as OpenAIContentPart[]) {
    if (part.type === "text") {
      parts.push({ text: part.text });
    } else if (part.type === "image_url") {
      const url = part.image_url.url;
      if (url.startsWith("data:")) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          parts.push({
            inlineData: { mimeType: match[1], data: match[2] },
          });
        }
      } else if (url.length > 0) {
        parts.push({
          fileData: { fileUri: url },
        });
      }
    }
  }

  return parts;
}

/**
 * Convert OpenAI messages array to Vertex AI contents array.
 */
export function convertMessagesToVertex(
  messages: OpenAIMessage[],
  options: { signPlaceholder?: boolean } = {}
): VertexContent[] {
  const contents: VertexContent[] = [];
  const pendingFunctionResponses: VertexPart[] = [];
  const toolCallNames = new Map<string, string>();

  function flushFunctionResponses() {
    if (pendingFunctionResponses.length > 0) {
      // Vertex only accepts "user" or "model" here — "function" is rejected.
      // Function responses belong to the user side of the exchange.
      contents.push({
        role: "user",
        parts: [...pendingFunctionResponses],
      });
      pendingFunctionResponses.length = 0;
    }
  }

  for (const msg of messages) {
    // Handle tool (function response) messages
    if (msg.role === "tool") {
      const toolCallId = msg.tool_call_id || "";
      const funcName = msg.name || toolCallNames.get(toolCallId) || "function_response";
      let responseData: Record<string, unknown>;

      try {
        const content =
          typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        if (content && (content.trim().startsWith("{") || content.trim().startsWith("["))) {
          responseData = JSON.parse(content);
        } else {
          responseData = { result: content };
        }
      } catch {
        responseData = { result: String(msg.content) };
      }

      pendingFunctionResponses.push({
        functionResponse: {
          name: funcName,
          response: responseData,
          id: toolCallId || undefined,
        },
      });
      continue;
    }

    // Handle assistant messages with tool_calls
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      flushFunctionResponses();
      const parts: VertexPart[] = [];

      for (const tc of msg.tool_calls) {
        if (tc.id) {
          toolCallNames.set(tc.id, tc.function.name);
        }
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          /* empty args */
        }

        const part: VertexPart = {
          functionCall: {
            name: tc.function.name,
            args,
            id: tc.id || undefined,
          },
        };

        const signature = readToolCallSignature(tc);
        if (signature) {
          part.thoughtSignature = signature;
        } else if (options.signPlaceholder && parts.length === 0) {
          // Gemini 3 rejects the whole request unless the first functionCall
          // part of each step carries a signature. The client did not echo
          // one back, so fall back to the documented skip value.
          part.thoughtSignature = SIGNATURE_PLACEHOLDER;
        }

        parts.push(part);
      }

      // Also include text content if present
      if (typeof msg.content === "string" && msg.content.length > 0) {
        parts.push({ text: msg.content });
      }

      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    // Regular messages
    flushFunctionResponses();

    const parts = convertMessageParts(msg);
    if (parts.length === 0) continue;

    // Map roles
    let role: string;
    switch (msg.role) {
      case "system":
        role = "user";
        break;
      case "assistant":
        role = "model";
        break;
      default:
        role = "user";
    }

    contents.push({ role, parts });
  }

  flushFunctionResponses();

  if (contents.length === 0) {
    contents.push({
      role: "user",
      parts: [{ text: "Hello" }],
    });
  }

  return contents;
}

function extractSystemInstruction(messages: OpenAIMessage[]): { parts: VertexPart[] } | undefined {
  const parts: VertexPart[] = [];

  for (const msg of messages) {
    if (msg.role !== "system") continue;
    if (typeof msg.content === "string" && msg.content.length > 0) {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text.length > 0) {
          parts.push({ text: part.text });
        }
      }
    }
  }

  return parts.length > 0 ? { parts } : undefined;
}

/**
 * Build a native Vertex generateContent request body.
 * This path is required for Vertex AI Express API keys.
 */
export function buildVertexGenerateContentBody(
  request: OpenAIRequest,
  modelInfo: ParsedModelInfo
): VertexRequest {
  const nonSystemMessages = request.messages.filter((msg) => msg.role !== "system");
  const body: VertexRequest = {
    contents: convertMessagesToVertex(nonSystemMessages, {
      // Gemini 3 validates thought signatures on every functionCall part.
      signPlaceholder: getModelCapabilities(modelInfo.baseModel).isSupported,
    }),
    generationConfig: buildGenerationConfig(request, modelInfo),
    safetySettings: buildSafetySettings(),
  };

  const systemInstruction = extractSystemInstruction(request.messages);
  if (systemInstruction) body.systemInstruction = systemInstruction;

  const tools = [];
  const functionDeclarations = convertToolsToVertex(request.tools);
  if (functionDeclarations.length > 0) {
    tools.push({ functionDeclarations });
  }
  if (modelInfo.isSearch || modelInfo.isOpenAISearch) {
    tools.push({ googleSearch: {} });
  }
  if (tools.length > 0) body.tools = tools;

  const toolConfig = convertToolChoiceToVertex(request.tool_choice);
  if (toolConfig) body.toolConfig = toolConfig;

  return body;
}

/**
 * Build the complete request body for Vertex AI OpenAI-compatible endpoint.
 * This is used for the /chat/completions pass-through to Vertex's OpenAI endpoint.
 */
export function buildOpenAICompatibleBody(
  request: OpenAIRequest,
  modelInfo: ParsedModelInfo
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: `google/${modelInfo.baseModel}`,
    messages: signToolCallsForOpenAIEndpoint(request.messages),
    stream: request.stream ?? false,
  };

  // Pass through standard OpenAI params
  if (request.temperature != null) body.temperature = request.temperature;
  if (request.max_tokens != null) body.max_tokens = request.max_tokens;
  if (request.max_completion_tokens != null) {
    body.max_completion_tokens = request.max_completion_tokens;
  }
  if (request.top_p != null) body.top_p = request.top_p;
  if (request.stop) body.stop = request.stop;
  if (request.seed != null) body.seed = request.seed;
  if (request.n != null) body.n = request.n;
  if (getModelCapabilities(modelInfo.baseModel).supportsPenalties) {
    if (request.frequency_penalty != null) {
      body.frequency_penalty = request.frequency_penalty;
    }
    if (request.presence_penalty != null) {
      body.presence_penalty = request.presence_penalty;
    }
  }
  if (request.tools) body.tools = request.tools;
  if (request.tool_choice) body.tool_choice = request.tool_choice;
  // Without this the endpoint never emits the trailing usage chunk.
  if (request.stream_options) body.stream_options = request.stream_options;
  if (request.response_format) body.response_format = request.response_format;
  if (request.parallel_tool_calls != null) {
    body.parallel_tool_calls = request.parallel_tool_calls;
  }

  // Add reasoning_effort if valid
  if (
    request.reasoning_effort &&
    ["none", "minimal", "low", "medium", "high"].includes(
      request.reasoning_effort as string
    )
  ) {
    body.reasoning_effort = request.reasoning_effort;
  }

  // Google-specific extra body for thinking/safety
  const thinkingTag = "vertex_think_tag";
  const safetySettings = buildSafetySettings().map((s) => ({
    category: s.category,
    threshold: s.threshold,
  }));

  const google: Record<string, unknown> = {
    safety_settings: safetySettings,
  };

  // Adjust thinking based on model flags
  const caps = getModelCapabilities(modelInfo.baseModel);

  if (caps.supportsThinking) {
    google.thought_tag_marker = thinkingTag;
    const level = thinkingLevelFor(request, modelInfo, caps);
    google.thinking_config = level
      ? { include_thoughts: true, thinking_level: level.toLowerCase() }
      : { include_thoughts: true };
    // thinking_level is the authoritative control; a stale reasoning_effort
    // (e.g. "none" on a model that rejects MINIMAL) would contradict it.
    delete body.reasoning_effort;
  }

  // Image generation (for image models). The IMAGE modality has to be asked
  // for even when no explicit size variant was requested.
  if (modelInfo.isImage) {
    google.response_modalities = ["TEXT", "IMAGE"];
    if (modelInfo.is2kImage) google.image_config = { image_size: "2K" };
    else if (modelInfo.is4kImage) google.image_config = { image_size: "4K" };
  }

  // Search tool
  if (modelInfo.isSearch || modelInfo.isOpenAISearch) {
    body.web_search_options = {};
  }

  body.extra_body = { google };

  return body;
}
