import { log } from "./log.js";

/**
 * LM Studio's `/v1/chat/completions` accepts `reasoning_effort` values from
 * `none | minimal | low | medium | high | xhigh` and rejects anything else
 * with HTTP 400. OpenCode passes `"max"` through to the wire unchanged (a
 * configured variant, agent, or another plugin can set it), so demote it to
 * the closest accepted value.
 *
 * Runs on the native HTTP request, the only layer that sees the effort after
 * model settings, variants, and request overrides have all been merged — the
 * `context` hook's options start empty and never show the resolved value.
 * Returns a replacement request, or `undefined` when nothing needs to change.
 */
export async function demoteReasoningEffort(request: Request): Promise<Request | undefined> {
  if (request.method !== "POST" || !request.body) return undefined;
  if (!request.headers.get("content-type")?.includes("json")) return undefined;
  const text = await request.clone().text();
  // Cheap pre-check before parsing every completion body.
  if (!text.includes('"max"')) return undefined;

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  if (record.reasoning_effort !== "max") return undefined;
  record.reasoning_effort = "xhigh";

  log(
    `[opencode-lms] Reasoning effort "max" demoted to "xhigh" ` +
      `(LM Studio's /v1/chat/completions accepts: none, minimal, low, medium, high, xhigh)`,
  );
  // The length changed; let the runtime recompute it.
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request, { headers, body: JSON.stringify(record) });
}
