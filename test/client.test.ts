import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildOpenAIEndpointUrl,
  buildExpressGenerateContentUrl,
  buildHeaders,
  getCredentialSources,
  type VertexClientOptions,
} from "../src/vertex/client";
import { parseServiceAccountJsons, getExpressKeys } from "../src/config";
import type { Env } from "../src/types";

const sa: VertexClientOptions = {
  authType: "service_account",
  projectId: "my-project",
  location: "global",
  authHeader: "Bearer token",
};

describe("buildOpenAIEndpointUrl", () => {
  test("uses the global host for the global location", () => {
    assert.equal(
      buildOpenAIEndpointUrl(sa, "/chat/completions"),
      "https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/endpoints/openapi/chat/completions"
    );
  });

  test("uses the regional host for a region", () => {
    assert.equal(
      buildOpenAIEndpointUrl({ ...sa, location: "us-central1" }, "/chat/completions"),
      "https://us-central1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1/endpoints/openapi/chat/completions"
    );
  });

  test("refuses Express credentials", () => {
    assert.throws(() =>
      buildOpenAIEndpointUrl(
        { authType: "express", location: "global", apiKey: "k" },
        "/chat/completions"
      )
    );
  });
});

describe("buildExpressGenerateContentUrl", () => {
  const express: VertexClientOptions = {
    authType: "express",
    location: "global",
    apiKey: "secret-key",
  };

  test("matches the documented express-mode path", () => {
    assert.equal(
      buildExpressGenerateContentUrl(express, "gemini-2.5-flash", false),
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent"
    );
  });

  test("adds alt=sse when streaming", () => {
    assert.equal(
      buildExpressGenerateContentUrl(express, "gemini-2.5-flash", true),
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    );
  });

  test("never puts the key in the URL", () => {
    for (const stream of [true, false]) {
      const url = buildExpressGenerateContentUrl(express, "gemini-2.5-flash", stream);
      assert.ok(!url.includes("secret-key"), url);
    }
  });

  test("carries the key in x-goog-api-key instead", () => {
    assert.equal(buildHeaders(express)["x-goog-api-key"], "secret-key");
    assert.equal(buildHeaders(sa)["Authorization"], "Bearer token");
  });
});

describe("getExpressKeys", () => {
  test("merges both env names and trims", () => {
    const env = {
      VERTEX_EXPRESS_API_KEY: " a , b ",
      VERTEX_API_KEY: "c",
    } as Env;
    assert.deepEqual(getExpressKeys(env), ["a", "b", "c"]);
  });

  test("returns nothing when unset", () => {
    assert.deepEqual(getExpressKeys({} as Env), []);
  });
});

describe("parseServiceAccountJsons", () => {
  const one = JSON.stringify({
    type: "service_account",
    project_id: "p1",
    private_key: "k1",
    client_email: "a@p1.iam.gserviceaccount.com",
  });
  const two = JSON.stringify({
    type: "service_account",
    project_id: "p2",
    private_key: "k2",
    client_email: "b@p2.iam.gserviceaccount.com",
  });

  test("reads several concatenated objects", () => {
    assert.equal(parseServiceAccountJsons(`${one},${two}`).length, 2);
  });

  test("skips objects missing required fields", () => {
    assert.equal(parseServiceAccountJsons('{"type":"service_account"}').length, 0);
  });

  test("handles an empty or absent value", () => {
    assert.deepEqual(parseServiceAccountJsons(undefined), []);
    assert.deepEqual(parseServiceAccountJsons(""), []);
  });
});

describe("getCredentialSources", () => {
  const env = {
    API_KEY: "x",
    VERTEX_EXPRESS_API_KEY: "k1,k2,k3",
  } as Env;

  test("offers every Express key so a failure can retry", () => {
    assert.equal(getCredentialSources(env, "express").length, 3);
  });

  test("rotates the starting key between requests", async () => {
    const first = await getCredentialSources(env, "express")[0].resolve();
    const second = await getCredentialSources(env, "express")[0].resolve();
    assert.notEqual(first.apiKey, second.apiKey);
  });

  test("returns nothing for a preference that is not configured", () => {
    assert.deepEqual(getCredentialSources(env, "service_account"), []);
  });
});
