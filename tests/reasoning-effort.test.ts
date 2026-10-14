import { describe, it, expect } from "vitest";
import { demoteReasoningEffort } from "../src/reasoning-effort.js";

const URL = "http://lms.test:1234/v1/chat/completions";

const completion = (body: Record<string, unknown>) =>
  new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer x" },
    body: JSON.stringify(body),
  });

describe("demoteReasoningEffort", () => {
  it('rewrites reasoning_effort "max" to "xhigh" and keeps the rest of the request', async () => {
    const original = completion({ model: "m", reasoning_effort: "max", stream: true });
    const demoted = await demoteReasoningEffort(original);

    expect(demoted).toBeDefined();
    expect(await demoted!.json()).toEqual({ model: "m", reasoning_effort: "xhigh", stream: true });
    expect(demoted!.url).toBe(URL);
    expect(demoted!.method).toBe("POST");
    expect(demoted!.headers.get("authorization")).toBe("Bearer x");
    // The original body is still readable — the hook only cloned it.
    expect((await original.json()).reasoning_effort).toBe("max");
  });

  it.each(["none", "minimal", "low", "medium", "high", "xhigh"])(
    "leaves accepted value %s untouched",
    async (effort) => {
      expect(await demoteReasoningEffort(completion({ model: "m", reasoning_effort: effort }))).toBeUndefined();
    },
  );

  it('ignores "max" that appears elsewhere in the body', async () => {
    const request = completion({ model: "m", messages: [{ role: "user", content: '"max"' }] });
    expect(await demoteReasoningEffort(request)).toBeUndefined();
  });

  it("ignores requests without a JSON body", async () => {
    expect(await demoteReasoningEffort(new Request(URL))).toBeUndefined();
    const text = new Request(URL, { method: "POST", headers: { "content-type": "text/plain" }, body: '"max"' });
    expect(await demoteReasoningEffort(text)).toBeUndefined();
  });
});
