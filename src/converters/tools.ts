// ============================================================
// Tool / Function Calling conversion between OpenAI and Vertex
// ============================================================

import type {
  OpenAITool,
  OpenAIToolCall,
  VertexFunctionDeclaration,
  VertexToolConfig,
  VertexPart,
} from "../types";

/**
 * Convert OpenAI tools to Vertex AI function declarations.
 */
export function convertToolsToVertex(
  tools: OpenAITool[] | undefined
): VertexFunctionDeclaration[] {
  if (!tools) return [];

  const declarations: VertexFunctionDeclaration[] = [];
  for (const tool of tools) {
    if (tool.type === "function" && tool.function) {
      const decl: VertexFunctionDeclaration = {
        name: tool.function.name,
      };
      if (tool.function.description) {
        decl.description = tool.function.description;
      }
      if (tool.function.parameters) {
        // Remove $schema if present (Vertex doesn't accept it)
        const params = { ...tool.function.parameters };
        delete params["$schema"];
        decl.parameters = params;
      }
      declarations.push(decl);
    }
  }
  return declarations;
}

/**
 * Convert OpenAI tool_choice to Vertex tool_config.
 */
export function convertToolChoiceToVertex(
  toolChoice: string | { type: string; function?: { name: string } } | undefined
): VertexToolConfig | undefined {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === "string") {
    if (toolChoice === "none") {
      return { functionCallingConfig: { mode: "NONE" } };
    }
    if (toolChoice === "auto") {
      return { functionCallingConfig: { mode: "AUTO" } };
    }
    if (toolChoice === "required") {
      return { functionCallingConfig: { mode: "ANY" } };
    }
    if (toolChoice === "validated") {
      return { functionCallingConfig: { mode: "VALIDATED" } };
    }
    return undefined;
  }

  if (toolChoice.type === "function" && toolChoice.function?.name) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [toolChoice.function.name],
      },
    };
  }
  return undefined;
}

/**
 * Convert Vertex AI function_call parts to OpenAI tool_calls.
 */
export function convertFunctionCallsToOpenAI(
  parts: VertexPart[],
  responseId: string,
  candidateIndex: number,
  /** Offset for synthesised ids so streamed chunks keep numbering upward. */
  startIndex = 0
): OpenAIToolCall[] {
  const toolCalls: OpenAIToolCall[] = [];

  for (const part of parts) {
    if (part.functionCall) {
      const fc = part.functionCall;
      // Two parallel calls to the same function land in the same millisecond,
      // so the position in the response — not the clock — makes the id unique.
      const callId =
        fc.id ||
        `call_${responseId}_${candidateIndex}_${startIndex + toolCalls.length}`;
      const toolCall: OpenAIToolCall = {
        id: callId,
        type: "function",
        function: {
          name: fc.name,
          arguments: JSON.stringify(fc.args || {}),
        },
      };
      // Gemini 3 requires this back on the next turn; surface it so clients
      // that preserve unknown fields can round-trip it.
      if (part.thoughtSignature) {
        toolCall.thought_signature = part.thoughtSignature;
      }
      toolCalls.push(toolCall);
    }
  }

  return toolCalls;
}
