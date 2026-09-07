import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseModelVersion,
  atLeast,
  getModelCapabilities,
  resolveThinkingLevel,
  unsupportedModelMessage,
} from "../src/model-capabilities";
import defaultModels from "../src/models.json";

describe("parseModelVersion", () => {
  test("reads major.minor from every current id shape", () => {
    const cases: Array<[string, number, number]> = [
      ["gemini-3.8-flash", 3, 8],
      ["gemini-3.7-flash", 3, 7],
      ["gemini-3.5-flash-lite", 3, 5],
      ["gemini-3.1-pro-preview", 3, 1],
      ["gemini-3-flash-preview", 3, 0],
      ["gemini-3-pro-image", 3, 0],
      ["gemini-2.5-flash", 2, 5],
      ["gemini-2.0-flash-001", 2, 0],
    ];
    for (const [id, major, minor] of cases) {
      assert.deepEqual(parseModelVersion(id), { major, minor }, id);
    }
  });

  test("returns null for ids it cannot read", () => {
    assert.equal(parseModelVersion("text-bison"), null);
    assert.equal(parseModelVersion("gemini-pro"), null);
  });

  test("keeps 3.10 above 3.8 instead of comparing as text", () => {
    const v310 = parseModelVersion("gemini-3.10-flash")!;
    const v38 = parseModelVersion("gemini-3.8-flash")!;
    assert.ok(v310.minor > v38.minor);
  });
});

describe("atLeast", () => {
  test("compares across major and minor", () => {
    assert.equal(atLeast(parseModelVersion("gemini-3.8-flash"), 3), true);
    assert.equal(atLeast(parseModelVersion("gemini-2.5-flash"), 3), false);
    assert.equal(atLeast(parseModelVersion("gemini-2.5-flash"), 2, 5), true);
    assert.equal(atLeast(parseModelVersion("gemini-2.0-flash-001"), 2, 5), false);
    assert.equal(atLeast(null, 2), false);
  });
});

describe("getModelCapabilities", () => {
  test("supports Gemini 3 and newer", () => {
    for (const id of [
      "gemini-3-flash-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash",
      "gemini-3.8-flash",
    ]) {
      const caps = getModelCapabilities(id);
      assert.equal(caps.isSupported, true, id);
      assert.equal(caps.supportsThinking, true, id);
    }
  });

  test("rejects the retired Gemini 2.x family", () => {
    for (const id of ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash-001"]) {
      const caps = getModelCapabilities(id);
      assert.equal(caps.isSupported, false, id);
      assert.equal(caps.supportsThinking, false, id);
    }
  });

  test("rejects ids it cannot parse", () => {
    assert.equal(getModelCapabilities("text-bison").isSupported, false);
    assert.equal(getModelCapabilities("gemini-pro").isSupported, false);
  });

  test("image models are supported but never claim thinking", () => {
    for (const id of [
      "gemini-3-pro-image",
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite-image",
    ]) {
      const caps = getModelCapabilities(id);
      assert.equal(caps.isSupported, true, id);
      assert.equal(caps.isImage, true, id);
      assert.equal(caps.supportsThinking, false, id);
    }
  });

  test("does not mistake other models for image models", () => {
    assert.equal(getModelCapabilities("gemini-3.8-flash").isImage, false);
    assert.equal(getModelCapabilities("gemini-3.5-transcribe").isImage, false);
  });

  test("detects pro and lite as whole segments", () => {
    assert.equal(getModelCapabilities("gemini-3.1-pro-preview").isPro, true);
    assert.equal(getModelCapabilities("gemini-3.5-flash-lite").isLite, true);
    assert.equal(getModelCapabilities("gemini-3.8-flash").isPro, false);
    assert.equal(getModelCapabilities("gemini-3.8-flash").isLite, false);
  });

  test("only gemini-3.8-flash is flagged as rejecting MINIMAL", () => {
    assert.equal(
      getModelCapabilities("gemini-3.8-flash").supportsMinimalThinkingLevel,
      false
    );
    assert.equal(
      getModelCapabilities("gemini-3.7-flash").supportsMinimalThinkingLevel,
      true
    );
  });

  test("only gemini-3.8-flash is flagged as rejecting penalties", () => {
    assert.equal(getModelCapabilities("gemini-3.8-flash").supportsPenalties, false);
    assert.equal(getModelCapabilities("gemini-3.5-flash").supportsPenalties, true);
    assert.equal(getModelCapabilities("gemini-3.1-pro-preview").supportsPenalties, true);
  });

  test("a future major version is supported without a code change", () => {
    const caps = getModelCapabilities("gemini-4-flash");
    assert.equal(caps.isSupported, true);
    assert.equal(caps.supportsThinking, true);
  });
});

describe("unsupportedModelMessage", () => {
  test("names the retired family when the version parses", () => {
    assert.match(unsupportedModelMessage("gemini-2.5-pro"), /2\.x family/);
    assert.match(unsupportedModelMessage("gemini-2.5-pro"), /end of life/);
  });

  test("falls back to a generic message for unparseable ids", () => {
    assert.match(unsupportedModelMessage("text-bison"), /Unrecognised model/);
  });
});

describe("resolveThinkingLevel", () => {
  const flash38 = getModelCapabilities("gemini-3.8-flash");
  const pro31 = getModelCapabilities("gemini-3.1-pro-preview");

  test("maps every documented reasoning_effort value", () => {
    assert.equal(resolveThinkingLevel("none", pro31), "MINIMAL");
    assert.equal(resolveThinkingLevel("minimal", pro31), "MINIMAL");
    assert.equal(resolveThinkingLevel("low", pro31), "LOW");
    assert.equal(resolveThinkingLevel("medium", pro31), "MEDIUM");
    assert.equal(resolveThinkingLevel("high", pro31), "HIGH");
  });

  test("folds the Responses API's xhigh and max into HIGH", () => {
    assert.equal(resolveThinkingLevel("xhigh", pro31), "HIGH");
    assert.equal(resolveThinkingLevel("max", pro31), "HIGH");
  });

  test("is case-insensitive", () => {
    assert.equal(resolveThinkingLevel("HIGH", pro31), "HIGH");
  });

  test("clamps MINIMAL to LOW where MINIMAL is rejected", () => {
    assert.equal(resolveThinkingLevel("none", flash38), "LOW");
    assert.equal(resolveThinkingLevel("minimal", flash38), "LOW");
    assert.equal(resolveThinkingLevel("medium", flash38), "MEDIUM");
  });

  test("ignores values that are not thinking levels", () => {
    assert.equal(resolveThinkingLevel("extreme", pro31), undefined);
    assert.equal(resolveThinkingLevel(undefined, pro31), undefined);
  });
});

describe("bundled model list", () => {
  test("every id parses to a known version", () => {
    for (const id of [
      ...defaultModels.vertex_models,
      ...defaultModels.vertex_express_models,
    ]) {
      assert.notEqual(parseModelVersion(id), null, id);
    }
  });

  test("includes the current GA Gemini 3 flash series", () => {
    for (const id of [
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
    ]) {
      assert.ok(defaultModels.vertex_models.includes(id), `missing ${id}`);
    }
  });

  test("lists only supported Gemini 3+ models", () => {
    for (const id of [
      ...defaultModels.vertex_models,
      ...defaultModels.vertex_express_models,
    ]) {
      assert.equal(getModelCapabilities(id).isSupported, true, `${id} is retired`);
    }
  });

  test("has no duplicates", () => {
    for (const list of [
      defaultModels.vertex_models,
      defaultModels.vertex_express_models,
    ]) {
      assert.equal(new Set(list).size, list.length);
    }
  });
});
