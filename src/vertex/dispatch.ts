// ============================================================
// Credential selection, retry, and the upstream Vertex call
// ============================================================

import type { Env, OpenAIRequest, ParsedModelInfo } from "../types";
import { jsonError } from "../auth";
import {
  getCredentialSources,
  missingCredentialMessage,
  buildOpenAIEndpointUrl,
  buildExpressGenerateContentUrl,
  buildProjectGenerateContentUrl,
  buildHeaders,
  type CredentialPreference,
  type VertexClientOptions,
} from "./client";
import {
  buildOpenAICompatibleBody,
  buildVertexGenerateContentBody,
} from "../converters/request";
import {
  getModelCapabilities,
  unsupportedModelMessage,
} from "../model-capabilities";

/**
 * Upstream failures worth retrying with the next configured credential.
 * A 400 means the request itself is wrong, so another key would fail the
 * same way; 401/403/429 and 5xx are per-key or transient.
 */
const RETRYABLE_STATUSES = new Set([401, 403, 408, 429, 500, 502, 503, 504]);

export type DispatchResult =
  | { ok: true; upstream: Response; nativeVertex: boolean }
  | { ok: false; error: Response };

/**
 * Send an OpenAI-shaped request to Vertex AI, walking the configured
 * credentials until one succeeds. Returns the raw upstream response so the
 * caller can render it as Chat Completions or as a Response object.
 */
export async function dispatchToVertex(
  env: Env,
  body: OpenAIRequest,
  modelInfo: ParsedModelInfo,
  stream: boolean
): Promise<DispatchResult> {
  const caps = getModelCapabilities(modelInfo.baseModel);
  if (!caps.isSupported) {
    return {
      ok: false,
      error: jsonError(
        400,
        unsupportedModelMessage(modelInfo.baseModel),
        "invalid_request_error"
      ),
    };
  }

  const preference = credentialPreference(modelInfo);
  const sources = getCredentialSources(env, preference);
  if (sources.length === 0) {
    const msg = missingCredentialMessage(preference);
    console.error(`Credential error: ${msg}`);
    return { ok: false, error: jsonError(500, msg, "server_error") };
  }

  let lastFailure: Response | null = null;

  for (const [attempt, source] of sources.entries()) {
    let creds: VertexClientOptions;
    try {
      creds = await source.resolve();
    } catch (e) {
      lastFailure = jsonError(
        500,
        `Failed to authenticate with ${source.label}: ${errorMessage(e)}`,
        "server_error"
      );
      continue;
    }

    const result = await callVertex(creds, body, modelInfo, source.label, stream);
    if (result.ok) return result;

    lastFailure = result.error;
    if (!result.retryable || attempt === sources.length - 1) break;

    console.warn(
      `${source.label} failed with ${result.status}; trying next credential.`
    );
  }

  return {
    ok: false,
    error:
      lastFailure ??
      jsonError(500, "No credential produced a response.", "server_error"),
  };
}

/**
 * `-openai` / `-openaisearch` and `[PAY]` name the OpenAI-compatible endpoint,
 * which only accepts Service Account auth. `[EXPRESS]` pins the Express path.
 * Anything else lets the configured credentials decide.
 */
function credentialPreference(
  modelInfo: ParsedModelInfo
): CredentialPreference | undefined {
  if (modelInfo.isExpress) return "express";
  if (modelInfo.isPay || modelInfo.isOpenAIDirect) return "service_account";
  return undefined;
}

type Attempt =
  | { ok: true; upstream: Response; nativeVertex: boolean }
  | { ok: false; error: Response; retryable: boolean; status?: number };

async function callVertex(
  creds: VertexClientOptions,
  body: OpenAIRequest,
  modelInfo: ParsedModelInfo,
  label: string,
  stream: boolean
): Promise<Attempt> {
  // The OpenAI-compatible endpoint cannot express `response_modalities`, so
  // image models take the native route whichever credential is in play.
  const nativeVertex =
    creds.authType === "express" ||
    getModelCapabilities(modelInfo.baseModel).isImage;

  let url: string;
  let payload: unknown;
  try {
    if (nativeVertex) {
      url =
        creds.authType === "express"
          ? buildExpressGenerateContentUrl(creds, modelInfo.baseModel, stream)
          : buildProjectGenerateContentUrl(creds, modelInfo.baseModel, stream);
      payload = buildVertexGenerateContentBody(body, modelInfo);
    } else {
      url = buildOpenAIEndpointUrl(creds, "/chat/completions");
      payload = { ...buildOpenAICompatibleBody(body, modelInfo), stream };
    }
  } catch (e) {
    return {
      ok: false,
      retryable: false,
      error: jsonError(400, errorMessage(e), "invalid_request_error"),
    };
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: buildHeaders(creds),
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // Network-level failure: another credential may reach a healthier region.
    return {
      ok: false,
      retryable: true,
      error: jsonError(
        502,
        `Error calling Vertex AI: ${errorMessage(e)}`,
        "server_error"
      ),
    };
  }

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(
      `Vertex error ${resp.status} via ${label}: ${errText.slice(0, 500)}`
    );
    return {
      ok: false,
      status: resp.status,
      retryable: RETRYABLE_STATUSES.has(resp.status),
      error: jsonError(
        clientStatus(resp.status),
        `Vertex AI error: ${errText.slice(0, 500)}`,
        resp.status >= 500 ? "server_error" : "invalid_request_error"
      ),
    };
  }

  if (stream && !resp.body) {
    return {
      ok: false,
      retryable: true,
      error: jsonError(502, "No response body from Vertex AI.", "server_error"),
    };
  }

  return { ok: true, upstream: resp, nativeVertex };
}

/**
 * Translate an upstream status into one the caller can act on.
 *
 * 401/403 from Vertex means *our* credentials are wrong, not the caller's —
 * passing it through would look identical to a bad adapter API_KEY and send
 * clients into a pointless token-refresh loop. Statuses outside 400-599 would
 * throw when used to build a Response.
 */
function clientStatus(status: number): number {
  if (status === 401 || status === 403) return 502;
  return status >= 400 && status <= 599 ? status : 502;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Headers every SSE response from this adapter carries. */
export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
  "Access-Control-Allow-Origin": "*",
};

export const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};
