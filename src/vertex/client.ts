// ============================================================
// Vertex AI REST API client for Cloudflare Workers
// ============================================================

import type { Env } from "../types";
import { getExpressKeys, parseServiceAccountJsons, getLocation } from "../config";
import { getServiceAccountToken } from "./auth";

export interface VertexClientOptions {
  authType: "express" | "service_account";
  projectId?: string;
  location: string;
  authHeader?: string;
  apiKey?: string;
}

export type CredentialPreference = "express" | "service_account";

/**
 * One configured credential, resolved lazily: obtaining a Service Account
 * token costs a network round trip, so only the credential actually used
 * pays for it.
 */
export interface CredentialSource {
  authType: "express" | "service_account";
  /** Safe to log — never contains key material. */
  label: string;
  resolve(): Promise<VertexClientOptions>;
}

interface ServiceAccountJson {
  client_email: string;
  private_key: string;
  project_id: string;
}

/**
 * Round-robin cursors, keyed by the credential set so rotation survives across
 * requests handled by the same isolate.
 */
const cursors = new Map<string, number>();

/** Order `items` so a different one leads each call, keeping the rest as fallbacks. */
function rotate<T>(cacheKey: string, items: T[]): T[] {
  if (items.length <= 1) return items;
  const start = (cursors.get(cacheKey) ?? 0) % items.length;
  cursors.set(cacheKey, start + 1);
  return items.map((_, i) => items[(start + i) % items.length]);
}

function expressSources(env: Env): CredentialSource[] {
  const keys = getExpressKeys(env);
  if (keys.length === 0) return [];
  const location = getLocation(env);

  return rotate(`express:${keys.join(",")}`, keys).map((apiKey, i) => ({
    authType: "express" as const,
    label: `express key #${i + 1}/${keys.length}`,
    resolve: async () => ({ authType: "express" as const, location, apiKey }),
  }));
}

function serviceAccountSources(env: Env): CredentialSource[] {
  const saJsons = parseServiceAccountJsons(
    env.GOOGLE_CREDENTIALS_JSON
  ) as unknown as ServiceAccountJson[];
  if (saJsons.length === 0) return [];
  const location = getLocation(env);

  return rotate(
    `sa:${saJsons.map((sa) => sa.client_email).join(",")}`,
    saJsons
  ).map((sa) => ({
    authType: "service_account" as const,
    label: `service account ${sa.client_email}`,
    resolve: async () => ({
      authType: "service_account" as const,
      projectId: env.GCP_PROJECT_ID || sa.project_id,
      location,
      authHeader: `Bearer ${await getServiceAccountToken(sa)}`,
    }),
  }));
}

/**
 * Every credential worth trying for this request, in the order to try them.
 * Without an explicit preference, Express keys come first and Service
 * Accounts act as a fallback.
 */
export function getCredentialSources(
  env: Env,
  preference?: CredentialPreference
): CredentialSource[] {
  if (preference === "express") return expressSources(env);
  if (preference === "service_account") return serviceAccountSources(env);
  return [...expressSources(env), ...serviceAccountSources(env)];
}

/** Human-readable reason why no credential is available. */
export function missingCredentialMessage(
  preference?: CredentialPreference
): string {
  if (preference === "express") {
    return "No Vertex Express API key configured. Set VERTEX_EXPRESS_API_KEY.";
  }
  if (preference === "service_account") {
    return "No Service Account JSON configured. Set GOOGLE_CREDENTIALS_JSON. This model variant requires it.";
  }
  return "No credentials configured. Set VERTEX_EXPRESS_API_KEY or GOOGLE_CREDENTIALS_JSON.";
}

/**
 * Build the Vertex AI OpenAI-compatible endpoint URL.
 */
export function buildOpenAIEndpointUrl(
  opts: VertexClientOptions,
  path: string
): string {
  if (opts.authType !== "service_account" || !opts.projectId) {
    throw new Error("OpenAI-compatible endpoint requires Service Account credentials.");
  }

  const host =
    opts.location === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${opts.location}-aiplatform.googleapis.com`;
  return `${host}/v1/projects/${opts.projectId}/locations/${opts.location}/endpoints/openapi${path}`;
}

/**
 * Build the project-scoped native generateContent URL.
 *
 * Image models need this even on a Service Account: Vertex's
 * OpenAI-compatible endpoint rejects `response_modalities` outright
 * ("no such field"), so there is no way to ask it for an image.
 */
export function buildProjectGenerateContentUrl(
  opts: VertexClientOptions,
  model: string,
  stream: boolean
): string {
  if (opts.authType !== "service_account" || !opts.projectId) {
    throw new Error("Project-scoped generateContent requires Service Account credentials.");
  }

  const host =
    opts.location === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${opts.location}-aiplatform.googleapis.com`;
  const action = stream ? "streamGenerateContent" : "generateContent";
  const query = stream ? "?alt=sse" : "";
  return `${host}/v1/projects/${opts.projectId}/locations/${opts.location}/publishers/google/models/${encodeURIComponent(
    model
  )}:${action}${query}`;
}

/**
 * Build the official Vertex AI Express generateContent URL.
 */
export function buildExpressGenerateContentUrl(
  opts: VertexClientOptions,
  model: string,
  stream: boolean
): string {
  if (opts.authType !== "express" || !opts.apiKey) {
    throw new Error("Express generateContent endpoint requires an Express API key.");
  }

  const action = stream ? "streamGenerateContent" : "generateContent";
  const params = new URLSearchParams();
  if (stream) params.set("alt", "sse");

  const query = params.toString();
  return `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(
    model
  )}:${action}${query ? `?${query}` : ""}`;
}

/**
 * Build headers for a Vertex AI request.
 */
export function buildHeaders(opts: VertexClientOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.authHeader) {
    headers["Authorization"] = opts.authHeader;
  }
  // Sending the Express key as a header keeps it out of the request line,
  // where proxies and Cloudflare's own logs would capture it.
  if (opts.apiKey) {
    headers["x-goog-api-key"] = opts.apiKey;
  }
  return headers;
}
