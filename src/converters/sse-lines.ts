// ============================================================
// Splitting a byte stream into SSE lines in linear time
// ============================================================

/**
 * A generated image arrives as one SSE line several megabytes long, spread
 * over thousands of small network chunks. Appending each chunk to a string
 * and splitting it again re-scans everything buffered so far, which is
 * quadratic: a 2.9 MB image in 1 KB chunks cost 339 ms of CPU that way,
 * against the Free plan's 10 ms. Here a chunk without a newline is just
 * set aside, and the pieces are joined once, when the line ends.
 */
export class SseLineBuffer {
  private readonly decoder = new TextDecoder();
  private pending: string[] = [];

  /** Feed a chunk; returns the lines it completed, without their "\n". */
  push(chunk: Uint8Array): string[] {
    const text = this.decoder.decode(chunk, { stream: true });
    this.pending.push(text);
    if (!text.includes("\n")) return [];

    const lines = this.pending.join("").split("\n");
    this.pending = [lines.pop()!];
    return lines;
  }

  /** Whatever followed the last newline once the stream has ended. */
  rest(): string {
    const tail = this.pending.join("") + this.decoder.decode();
    this.pending = [];
    return tail;
  }
}
