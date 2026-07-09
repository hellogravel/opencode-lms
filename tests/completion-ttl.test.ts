import { describe, it, expect } from "vitest";
import { applyCompletionTtl } from "../src/ttl.js";

// applyCompletionTtl injects LM Studio's idle `ttl` into an outgoing chat
// completion. LM Studio's REST load/chat endpoints reject a `ttl` key (HTTP
// 400); only the OpenAI-compat /v1/chat/completions accepts it — and
// @ai-sdk/openai-compatible merges custom fields from
// providerOptions.<providerName> into the request body. The provider name is
// `openaiCompatible` (proven by the reasoning-effort path), mirrored to `openai`.

describe("applyCompletionTtl", () => {
  it("injects ttl under providerOptions.openaiCompatible and .openai", () => {
    const output: { options?: Record<string, any> } = { options: {} };
    applyCompletionTtl(output, 3600);
    expect(output.options!.providerOptions.openaiCompatible.ttl).toBe(3600);
    expect(output.options!.providerOptions.openai.ttl).toBe(3600);
  });

  it("creates output.options when absent", () => {
    const output: { options?: Record<string, any> } = {};
    applyCompletionTtl(output, 900);
    expect(output.options!.providerOptions.openaiCompatible.ttl).toBe(900);
  });

  it("preserves existing providerOptions entries (does not clobber reasoningEffort)", () => {
    const output: { options?: Record<string, any> } = {
      options: {
        temperature: 0.7,
        providerOptions: { openaiCompatible: { reasoningEffort: "high" } },
      },
    };
    applyCompletionTtl(output, 1200);
    expect(output.options!.temperature).toBe(0.7);
    expect(output.options!.providerOptions.openaiCompatible).toEqual({
      reasoningEffort: "high",
      ttl: 1200,
    });
  });

  it("is a no-op when ttl is 0 (resident)", () => {
    const output: { options?: Record<string, any> } = { options: { temperature: 0.5 } };
    applyCompletionTtl(output, 0);
    expect(output.options).toEqual({ temperature: 0.5 });
    expect(output.options!.providerOptions).toBeUndefined();
  });

  it("is a no-op when ttl is undefined", () => {
    const output: { options?: Record<string, any> } = { options: {} };
    applyCompletionTtl(output, undefined);
    expect(output.options).toEqual({});
  });

  it("is a no-op when ttl is negative", () => {
    const output: { options?: Record<string, any> } = { options: {} };
    applyCompletionTtl(output, -1);
    expect(output.options).toEqual({});
  });

  it("does not throw when output is undefined", () => {
    expect(() => applyCompletionTtl(undefined, 3600)).not.toThrow();
  });
});
