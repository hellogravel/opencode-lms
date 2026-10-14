import type {
  LMSStreamEvent,
  LMSModelLoadStartEvent,
  LMSModelLoadProgressEvent,
  LMSModelLoadEndEvent,
  LMSErrorEvent,
} from "./types.js";

/**
 * Parse a Server-Sent Events (SSE) stream from LM Studio's /api/v1/chat endpoint.
 *
 * Implements the field-accumulation model from the WHATWG SSE spec: per
 * connection we hold a pending event type and data buffer, and dispatch on a
 * blank line. This is robust to chunk boundaries falling anywhere in the
 * stream — the previous implementation lost events when "event:" and "data:"
 * landed in separate network reads.
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<LMSStreamEvent> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  let eventType: string | null = null;
  let dataLines: string[] = [];

  function* dispatch(): Generator<LMSStreamEvent> {
    if (dataLines.length === 0) {
      eventType = null;
      return;
    }
    const data = dataLines.join("\n");
    const type = eventType;
    dataLines = [];
    eventType = null;
    if (data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (type && !parsed.type) parsed.type = type;
      yield parsed as unknown as LMSStreamEvent;
    } catch {
      // Unparseable JSON — drop silently. Surfacing a fake error event would
      // pollute the stream with non-LMS errors that callers can't act on.
    }
  }

  function processLine(line: string): Generator<LMSStreamEvent> | null {
    // Strip optional CR (CRLF endings)
    const s = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (s === "") return dispatch();
    if (s.startsWith(":")) return null; // SSE comment
    // Field is everything up to the first ":"; value is everything after it,
    // with one optional leading space stripped.
    const colon = s.indexOf(":");
    const field = colon === -1 ? s : s.substring(0, colon);
    let value = colon === -1 ? "" : s.substring(colon + 1);
    if (value.startsWith(" ")) value = value.substring(1);
    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      // id / retry / unknown fields: spec says ignore
    }
    return null;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any trailing event (some servers omit the final blank line)
        yield* dispatch();
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.substring(0, newlineIdx);
        buffer = buffer.substring(newlineIdx + 1);
        const events = processLine(line);
        if (events) yield* events;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Type guard helpers for the load-progress events auto-load observes.
 */
export function isModelLoadStart(e: LMSStreamEvent): e is LMSModelLoadStartEvent {
  return e.type === "model_load.start";
}

export function isModelLoadProgress(e: LMSStreamEvent): e is LMSModelLoadProgressEvent {
  return e.type === "model_load.progress";
}

export function isModelLoadEnd(e: LMSStreamEvent): e is LMSModelLoadEndEvent {
  return e.type === "model_load.end";
}

export function isError(e: LMSStreamEvent): e is LMSErrorEvent {
  return e.type === "error";
}
