import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SseLineBuffer } from "../src/converters/sse-lines";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("SseLineBuffer", () => {
  test("returns only completed lines and keeps the rest for later", () => {
    const b = new SseLineBuffer();
    assert.deepEqual(b.push(bytes("data: a\n\ndata: b")), ["data: a", ""]);
    assert.deepEqual(b.push(bytes("cd")), []);
    assert.deepEqual(b.push(bytes("e\n")), ["data: bcde"]);
    assert.equal(b.rest(), "");
  });

  test("hands back an unterminated last line at the end", () => {
    const b = new SseLineBuffer();
    b.push(bytes("data: x\ndata: tail"));
    assert.equal(b.rest(), "data: tail");
  });

  test("reassembles a multi-byte character split across chunks", () => {
    const b = new SseLineBuffer();
    const all = bytes("data: 東京\n");
    const lines = [...b.push(all.subarray(0, 8)), ...b.push(all.subarray(8))];
    assert.deepEqual(lines, ["data: 東京"]);
  });

  test("a multi-megabyte line in small chunks costs linear time", () => {
    // Compare 4x the data rather than an absolute time, which depends on the
    // machine: linear work grows ~4x, the old append-and-resplit ~16x.
    const ms = (size: number) => {
      const all = bytes(`data: {"data":"${"A".repeat(size)}"}\n`);
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const b = new SseLineBuffer();
        const start = performance.now();
        let lines = 0;
        for (let i = 0; i < all.length; i += 1024) lines += b.push(all.subarray(i, i + 1024)).length;
        best = Math.min(best, performance.now() - start);
        assert.equal(lines, 1);
      }
      return Math.max(best, 1);
    };
    const small = ms(1_000_000);
    const large = ms(4_000_000);
    assert.ok(large / small < 8, `4x the data took ${(large / small).toFixed(1)}x as long (${small.toFixed(1)} -> ${large.toFixed(1)} ms)`);
  });
});
