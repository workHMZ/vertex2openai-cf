// ============================================================
// POST /v1/responses handler (OpenAI Responses API)
// ============================================================

import type { Env, ResponsesRequest } from "../types";
import { jsonError } from "../auth";
import {
  dispatchToVertex,
  errorMessage,
  JSON_HEADERS,
  SSE_HEADERS,
} from "../vertex/dispatch";
import { parseModelName } from "../converters/request";
import { processOpenAIResponse, processVertexResponse } from "../converters/response";
import {
  createStreamTransformer,
  createVertexStreamTransformer,
} from "../converters/streaming";
import { responsesRequestToChat, chatToResponse } from "../converters/responses";
import { createResponsesStreamTransformer } from "../converters/responses-streaming";

/**
 * Handle POST /v1/responses.
 *
 * The request is translated into the Chat Completions shape, sent through the
 * same Vertex dispatch path, and the result is rendered back as a Response
 * object — so both wire formats share one conversion pipeline.
 */
export async function handleResponses(
  request: Request,
  env: Env
): Promise<Response> {
  let body: ResponsesRequest;
  try {
    body = (await request.json()) as ResponsesRequest;
  } catch {
    return jsonError(400, "Invalid JSON in request body.", "invalid_request_error");
  }

  if (!body.model || typeof body.model !== "string") {
    return jsonError(400, "Missing required field: model.", "invalid_request_error");
  }
  if (body.input == null && !body.instructions) {
    return jsonError(400, "Missing required field: input.", "invalid_request_error");
  }

  const chatRequest = responsesRequestToChat(body);
  const modelInfo = parseModelName(body.model);
  const stream = Boolean(body.stream);
  console.log(
    `Responses request: model=${body.model}, base=${modelInfo.baseModel}, stream=${stream}`
  );

  const dispatched = await dispatchToVertex(env, chatRequest, modelInfo, stream);
  if (!dispatched.ok) return dispatched.error;

  const { upstream, nativeVertex } = dispatched;

  if (stream) {
    const toChatChunks = nativeVertex
      ? createVertexStreamTransformer(body.model)
      : createStreamTransformer(body.model);

    const events = upstream
      .body!.pipeThrough(toChatChunks)
      .pipeThrough(createResponsesStreamTransformer(body, body.model));

    return new Response(events, { headers: SSE_HEADERS });
  }

  let data: Record<string, unknown>;
  try {
    data = (await upstream.json()) as Record<string, unknown>;
  } catch (e) {
    return jsonError(
      502,
      `Malformed response from Vertex AI: ${errorMessage(e)}`,
      "server_error"
    );
  }

  const completion = nativeVertex
    ? processVertexResponse(data, body.model)
    : processOpenAIResponse(data, body.model);

  return new Response(JSON.stringify(chatToResponse(completion, body)), {
    headers: JSON_HEADERS,
  });
}
