import { describe, it, expect, beforeEach, vi } from "vitest";
import { LMSPlugin } from "../src/index.js";

// Regression net for the chat.params provider-id gate. OpenCode ≤1.16 passed a
// ProviderContext ({ source, info, options }); 1.17 passes Provider.Info
// directly (core reads `input.provider.id`). The old `input.provider.info.id`
// guard silently no-op'd EVERY chat.params behavior (TTL injection, reasoning
// demotion, auto-load) on 1.17.x — invisible to unit tests that stubbed the
// old shape, and invisible live because the early return has no logging.
// These tests drive the real hook through both shapes.

function freshOutput() {
  return {
    temperature: undefined,
    topP: undefined,
    topK: undefined,
    maxOutputTokens: undefined,
    options: {} as Record<string, any>,
  };
}

async function armedHooks(ttl: number) {
  // Health checks against `unreachable` fail fast and are tolerated: the
  // config hook still caches ttl/lifecycle state before chat.params runs.
  const hooks = await LMSPlugin({} as any);
  await hooks.config!({
    provider: {
      lmstudio: {
        options: { baseURL: "http://unreachable:1234", apiKey: "x", ttl },
      },
    },
  } as any);
  return hooks;
}

describe("chat.params provider-id gate (1.16 vs 1.17 input shapes)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("1.17 shape (provider.id) reaches TTL injection", async () => {
    const hooks = await armedHooks(42);
    const output = freshOutput();
    await hooks["chat.params"]!(
      { provider: { id: "lmstudio" }, model: { id: "m" } } as any,
      output as any,
    );
    expect(output.options.providerOptions?.openaiCompatible?.ttl).toBe(42);
  });

  it("1.16 shape (provider.info.id) still reaches TTL injection", async () => {
    const hooks = await armedHooks(42);
    const output = freshOutput();
    await hooks["chat.params"]!(
      { provider: { info: { id: "lmstudio" } }, model: { id: "m" } } as any,
      output as any,
    );
    expect(output.options.providerOptions?.openaiCompatible?.ttl).toBe(42);
  });

  it("other providers are left untouched (both shapes)", async () => {
    const hooks = await armedHooks(42);
    for (const provider of [{ id: "openai" }, { info: { id: "openai" } }]) {
      const output = freshOutput();
      await hooks["chat.params"]!({ provider, model: { id: "m" } } as any, output as any);
      expect(output.options.providerOptions).toBeUndefined();
    }
  });
});
