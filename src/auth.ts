// ============================================================
// API Key authentication for incoming requests to this adapter
// ============================================================

import type { Env } from "./types";

/**
 * Validate the incoming request's Authorization header against env.API_KEY.
 * Returns null on success, or a Response with 401 on failure.
 */
export async function authenticateRequest(
  request: Request,
  env: Env
): Promise<Response | null> {
  const authHeader = request.headers.get("Authorization");

  if (!authHeader) {
    return jsonError(
      401,
      "Missing API key. Include 'Authorization: Bearer YOUR_API_KEY' header."
    );
  }

  if (!authHeader.startsWith("Bearer ")) {
    return jsonError(
      401,
      "Invalid API key format. Use 'Authorization: Bearer YOUR_API_KEY'."
    );
  }

  if (!env.API_KEY) {
    // Fail closed: an unset secret must never mean "allow everyone".
    console.error("API_KEY is not configured; rejecting request.");
    return jsonError(401, "Invalid API key.");
  }

  const token = authHeader.slice(7);
  if (!(await secureCompare(token, env.API_KEY))) {
    return jsonError(401, "Invalid API key.");
  }

  return null; // Auth OK
}

/**
 * Compare two secrets without leaking their contents through timing.
 * Digesting first makes the comparison independent of the input lengths,
 * which a raw timingSafeEqual would otherwise reveal.
 */
async function secureCompare(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(digestA, digestB);
}

/** Return an OpenAI-style error JSON response. */
export function jsonError(
  status: number,
  message: string,
  type = "authentication_error"
): Response {
  return new Response(
    JSON.stringify({
      error: { message, type, code: status, param: null },
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    }
  );
}
