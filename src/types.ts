// ============================================================
// TypeScript Type Definitions for Vertex2OpenAI CF Worker
// ============================================================

// ----- Cloudflare Worker Environment Bindings -----

export interface Env {
  /** Required. API key to protect this adapter service. */
  API_KEY: string;
  /** Vertex AI Express API key(s). Comma-separated for multiple. */
  VERTEX_EXPRESS_API_KEY?: string;
  /** Alias for VERTEX_EXPRESS_API_KEY. */
  VERTEX_API_KEY?: string;
  /** Service Account JSON key content(s). Comma-separated for multiple. */
  GOOGLE_CREDENTIALS_JSON?: string;
  /** Explicit GCP Project ID. */
  GCP_PROJECT_ID?: string;
  /** GCP location/region. Defaults to "global". */
  GCP_LOCATION?: string;
  /** Custom model list JSON override. */
  MODELS_CONFIG?: string;
}

// ----- OpenAI-Compatible Request Types -----

export interface OpenAIImageUrl {
  url: string;
  detail?: string;
}

export interface OpenAIContentPartText {
  type: "text";
  text: string;
}

export interface OpenAIContentPartImage {
  type: "image_url";
  image_url: OpenAIImageUrl;
}

export type OpenAIContentPart = OpenAIContentPartText | OpenAIContentPartImage;

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIToolFunction;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  /**
   * Gemini 3 thought signature for this call. Not part of the OpenAI schema —
   * clients that echo it back in the assistant turn keep full model quality on
   * multi-turn tool use. See converters/thought-signature.ts.
   */
  thought_signature?: string;
}

export interface OpenAIResponseFormat {
  type: "text" | "json_object" | "json_schema";
  json_schema?: {
    name?: string;
    description?: string;
    strict?: boolean;
    schema?: Record<string, unknown>;
  };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  n?: number;
  tools?: OpenAITool[];
  tool_choice?: string | { type: "function"; function: { name: string } };
  reasoning_effort?: string;
  stream_options?: { include_usage?: boolean };
  response_format?: OpenAIResponseFormat;
  parallel_tool_calls?: boolean;
  [key: string]: unknown; // Allow extra fields
}

// ----- OpenAI-Compatible Response Types -----

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: { reasoning_tokens: number };
  prompt_tokens_details?: { cached_tokens: number };
}

export interface OpenAIResponseMessage {
  role: "assistant";
  content: string | null;
  /** Required by the OpenAI schema; null unless the model refused. */
  refusal: string | null;
  reasoning_content?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIChoice {
  index: number;
  message: OpenAIResponseMessage;
  /** Required by the OpenAI schema; null unless logprobs were requested. */
  logprobs: null;
  finish_reason: string;
}

export interface OpenAIResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: OpenAIUsage;
}

// ----- Vertex AI Types -----

export interface VertexPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string; // base64
  };
  fileData?: {
    mimeType?: string;
    fileUri: string;
  };
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
    id?: string;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
    id?: string;
  };
  thought?: boolean;
  thoughtSignature?: string; // base64
}

export interface VertexContent {
  role: string;
  parts: VertexPart[];
}

export interface VertexSafetySetting {
  category: string;
  threshold: string;
}

export interface VertexThinkingConfig {
  includeThoughts?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: "LOW" | "MEDIUM" | "HIGH" | "MINIMAL";
}

export interface VertexGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  seed?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  candidateCount?: number;
  thinkingConfig?: VertexThinkingConfig;
  responseModalities?: string[];
  imageConfig?: { imageSize: string };
}

export interface VertexFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface VertexToolConfig {
  functionCallingConfig?: {
    mode: string;
    allowedFunctionNames?: string[];
  };
}

export interface VertexRequest {
  contents: VertexContent[];
  generationConfig?: VertexGenerationConfig;
  systemInstruction?: {
    parts: VertexPart[];
  };
  safetySettings?: VertexSafetySetting[];
  tools?: Array<{
    functionDeclarations?: VertexFunctionDeclaration[];
    googleSearch?: Record<string, unknown>;
  }>;
  toolConfig?: VertexToolConfig;
}

export interface VertexCandidate {
  content?: {
    role: string;
    parts: VertexPart[];
  };
  finishReason?: string;
  safetyRatings?: unknown[];
}

export interface VertexUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface VertexResponse {
  candidates?: VertexCandidate[];
  usageMetadata?: VertexUsageMetadata;
  modelVersion?: string;
}

// ----- Internal Types -----

export interface ParsedModelInfo {
  baseModel: string;
  isExpress: boolean;
  isPay: boolean;
  isOpenAIDirect: boolean;
  isOpenAISearch: boolean;
  isSearch: boolean;
  isNoThinking: boolean;
  isMaxThinking: boolean;
  is2kImage: boolean;
  is4kImage: boolean;
  /** True for image-generation models, which reject thinkingConfig. */
  isImage: boolean;
}

export interface ModelsConfig {
  vertex_models: string[];
  vertex_express_models: string[];
}

// ----- OpenAI Responses API (/v1/responses) -----
// Field names follow the published OpenAI OpenAPI spec.

export interface ResponsesTextFormat {
  type: "text" | "json_object" | "json_schema";
  name?: string;
  description?: string;
  strict?: boolean;
  schema?: Record<string, unknown>;
}

export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: unknown;
  /** function_call */
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  /** function_call_output */
  output?: unknown;
  /** Gemini 3 signature, echoed back by clients that preserve it. */
  thought_signature?: string;
}

export interface ResponsesRequest {
  model: string;
  input?: string | ResponsesInputItem[];
  instructions?: string | null;
  max_output_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  stream?: boolean;
  parallel_tool_calls?: boolean;
  previous_response_id?: string | null;
  metadata?: Record<string, unknown>;
  reasoning?: { effort?: string; summary?: string | null } | null;
  text?: { format?: ResponsesTextFormat };
  tools?: ResponsesFunctionTool[];
  tool_choice?: string | { type: string; name?: string };
  [key: string]: unknown;
}

export interface ResponseUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

export type ResponseItemStatus = "in_progress" | "completed" | "incomplete";

export interface ResponseReasoningItem {
  id: string;
  type: "reasoning";
  summary: Array<{ type: "summary_text"; text: string }>;
  status?: ResponseItemStatus;
}

export interface ResponseMessageItem {
  id: string;
  type: "message";
  role: "assistant";
  status: ResponseItemStatus;
  content: Array<{
    type: "output_text";
    text: string;
    annotations: unknown[];
  }>;
}

export interface ResponseFunctionCallItem {
  id: string;
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status?: ResponseItemStatus;
  thought_signature?: string;
}

export type ResponseOutputItem =
  | ResponseReasoningItem
  | ResponseMessageItem
  | ResponseFunctionCallItem;

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  status: "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete";
  model: string;
  output: ResponseOutputItem[];
  output_text: string;
  error: null | { code: string; message: string };
  incomplete_details: null | { reason: string };
  instructions: string | null;
  max_output_tokens: number | null;
  parallel_tool_calls: boolean;
  previous_response_id: string | null;
  reasoning: ResponsesRequest["reasoning"];
  temperature: number | null;
  text: { format?: ResponsesTextFormat };
  tool_choice: ResponsesRequest["tool_choice"];
  tools: ResponsesFunctionTool[];
  top_p: number | null;
  metadata: Record<string, unknown>;
  usage?: ResponseUsage;
}
