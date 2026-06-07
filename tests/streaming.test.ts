import { describe, it, expect } from "vitest";
import { parseSSEStream } from "../src/streaming.js";
import type { LMSStreamEvent } from "../src/types.js";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<LMSStreamEvent[]> {
  const events: LMSStreamEvent[] = [];
  for await (const event of parseSSEStream(stream)) events.push(event);
  return events;
}

describe("parseSSEStream", () => {
  it("parses a single complete event in one chunk", async () => {
    const events = await collect(
      streamFromChunks([
        `event: model_load.start\ndata: {"type":"model_load.start","model_instance_id":"abc"}\n\n`,
      ]),
    );
    expect(events).toEqual([{ type: "model_load.start", model_instance_id: "abc" }]);
  });

  it("parses multiple events in one chunk", async () => {
    const events = await collect(
      streamFromChunks([
        `event: model_load.progress\ndata: {"type":"model_load.progress","progress":0.5}\n\n` +
        `event: model_load.end\ndata: {"type":"model_load.end","load_time_seconds":1.2}\n\n`,
      ]),
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "model_load.progress", progress: 0.5 });
    expect(events[1]).toMatchObject({ type: "model_load.end", load_time_seconds: 1.2 });
  });

  it("handles event/data split across chunk boundaries", async () => {
    // The bug the old parser had: event: line in one chunk, data: line in the next.
    const events = await collect(
      streamFromChunks([
        `event: model_load.start\n`,
        `data: {"type":"model_load.start","model_instance_id":"abc"}\n\n`,
      ]),
    );
    expect(events).toEqual([{ type: "model_load.start", model_instance_id: "abc" }]);
  });

  it("handles a single line split mid-character", async () => {
    const events = await collect(
      streamFromChunks([
        `event: model_load.pro`,
        `gress\ndata: {"type":"model_load.progress","progress":0.5}\n\n`,
      ]),
    );
    expect(events).toEqual([{ type: "model_load.progress", progress: 0.5 }]);
  });

  it("handles JSON payload split across chunks", async () => {
    const events = await collect(
      streamFromChunks([
        `event: model_load.progress\ndata: {"type":"model_load.progress","prog`,
        `ress":0.42}\n\n`,
      ]),
    );
    expect(events).toEqual([{ type: "model_load.progress", progress: 0.42 }]);
  });

  it("infers event type from JSON 'type' field when SSE event field is missing", async () => {
    const events = await collect(
      streamFromChunks([
        `data: {"type":"message.delta","content":"hi"}\n\n`,
      ]),
    );
    expect(events).toEqual([{ type: "message.delta", content: "hi" }]);
  });

  it("uses SSE event field as type when JSON has no 'type'", async () => {
    const events = await collect(
      streamFromChunks([
        `event: chat.end\ndata: {"foo":"bar"}\n\n`,
      ]),
    );
    expect(events).toEqual([{ type: "chat.end", foo: "bar" }]);
  });

  it("ignores SSE comments", async () => {
    const events = await collect(
      streamFromChunks([
        `: this is a comment\n` +
        `event: model_load.start\n` +
        `: another comment\n` +
        `data: {"type":"model_load.start"}\n\n`,
      ]),
    );
    expect(events).toEqual([{ type: "model_load.start" }]);
  });

  it("handles CRLF line endings", async () => {
    const events = await collect(
      streamFromChunks([
        `event: model_load.end\r\ndata: {"type":"model_load.end","load_time_seconds":3}\r\n\r\n`,
      ]),
    );
    expect(events).toEqual([{ type: "model_load.end", load_time_seconds: 3 }]);
  });

  it("ignores [DONE] sentinel", async () => {
    const events = await collect(
      streamFromChunks([
        `data: {"type":"message.delta","content":"x"}\n\n` +
        `data: [DONE]\n\n`,
      ]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "message.delta" });
  });

  it("skips unparseable JSON without polluting the stream", async () => {
    const events = await collect(
      streamFromChunks([
        `event: model_load.progress\ndata: {malformed\n\n` +
        `event: model_load.end\ndata: {"type":"model_load.end","load_time_seconds":1}\n\n`,
      ]),
    );
    // Bad JSON dropped silently; good event still surfaces.
    expect(events).toEqual([{ type: "model_load.end", load_time_seconds: 1 }]);
  });

  it("flushes the final event when stream ends without trailing blank line", async () => {
    const events = await collect(
      streamFromChunks([
        `event: chat.end\ndata: {"type":"chat.end"}\n`,
        // no closing blank line
      ]),
    );
    expect(events).toEqual([{ type: "chat.end" }]);
  });

  it("does not emit anything for an event with no data field", async () => {
    const events = await collect(
      streamFromChunks([
        `event: heartbeat\n\n`,
        `event: model_load.end\ndata: {"type":"model_load.end","load_time_seconds":1}\n\n`,
      ]),
    );
    expect(events).toEqual([{ type: "model_load.end", load_time_seconds: 1 }]);
  });

  it("handles many fine-grained chunks (one byte at a time)", async () => {
    const payload =
      `event: model_load.progress\ndata: {"type":"model_load.progress","progress":0.5}\n\n` +
      `event: model_load.end\ndata: {"type":"model_load.end","load_time_seconds":2}\n\n`;
    const chunks = [...payload]; // split into single characters
    const events = await collect(streamFromChunks(chunks));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "model_load.progress", progress: 0.5 });
    expect(events[1]).toMatchObject({ type: "model_load.end", load_time_seconds: 2 });
  });
});
