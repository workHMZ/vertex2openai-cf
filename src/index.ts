// ============================================================
// Worker Entry Point — routing, CORS, and health check
// ============================================================

import type { Env } from "./types";
import { authenticateRequest, jsonError } from "./auth";
import { handleModels } from "./handlers/models";
import { handleChatCompletions } from "./handlers/chat";
import { handleResponses } from "./handlers/responses";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return handleCORS(request);
    }

    try {
      const url = new URL(request.url);
      const path = normalizePath(url.pathname);

      // Health check — no auth needed
      if (path === "/") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return withCORS(
            jsonError(405, "Method not allowed.", "invalid_request_error")
          );
        }
        return withCORS(
          new Response(
            JSON.stringify({
              status: "ok",
              message: "Vertex2OpenAI adapter is running on Cloudflare Workers.",
            }),
            { headers: { "Content-Type": "application/json" } }
          )
        );
      }

      // All /v1 routes require authentication
      if (path === "/v1" || path.startsWith("/v1/")) {
        const authResult = await authenticateRequest(request, env);
        if (authResult) return withCORS(authResult);
      }

      switch (path) {
        case "/v1/models":
          if (request.method !== "GET") {
            return withCORS(
              jsonError(405, "Method not allowed.", "invalid_request_error")
            );
          }
          return withCORS(await handleModels(env));

        case "/v1/chat/completions":
          if (request.method !== "POST") {
            return withCORS(
              jsonError(405, "Method not allowed.", "invalid_request_error")
            );
          }
          return withCORS(await handleChatCompletions(request, env));

        case "/v1/responses":
          if (request.method !== "POST") {
            return withCORS(
              jsonError(405, "Method not allowed.", "invalid_request_error")
            );
          }
          return withCORS(await handleResponses(request, env));

        default:
          return withCORS(
            jsonError(404, `Unknown endpoint: ${url.pathname}`, "not_found")
          );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Unhandled error: ${msg}`);
      return withCORS(
        jsonError(500, `Internal server error: ${msg}`, "server_error")
      );
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Clients configured with a base URL of `.../v1/` produce paths with a
 * trailing slash, which would otherwise 404.
 */
function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.replace(/\/+$/, "") || "/";
  }
  return pathname || "/";
}

// ----- CORS Helpers -----

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

/**
 * The OpenAI SDKs send their own headers (x-stainless-*, OpenAI-Beta, ...)
 * from the browser, so a fixed allow-list fails their preflight. Echo back
 * whatever the browser asks for; Authorization is still checked per request.
 */
function handleCORS(request: Request): Response {
  const headers = new Headers(CORS_HEADERS);
  const requested = request.headers.get("Access-Control-Request-Headers");
  if (requested) {
    headers.set("Access-Control-Allow-Headers", requested);
    headers.set("Vary", "Access-Control-Request-Headers");
  }
  return new Response(null, { status: 204, headers });
}

function withCORS(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
