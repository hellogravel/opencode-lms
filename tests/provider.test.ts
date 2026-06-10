import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildProvider, resolveProviderConfig } from "../src/provider.js";

function installFetchMock(handler: (url: string) => { ok: boolean; status: number; body?: unknown }) {
  vi.stubGlobal("fetch", async (url: string) => {
    const r = handler(url);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body ?? {},
      text: async () => (r.body ? JSON.stringify(r.body) : ""),
      body: null,
    } as unknown as Response;
  });
}

describe("resolveProviderConfig", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("uses default name and baseURL when no user config is provided", async () => {
    installFetchMock(() => ({ ok: false, status: 0 }));
    const result = await resolveProviderConfig(null);
    expect(result.name).toBe("LM Studio");
    expect(result.baseURL).toBe("http://127.0.0.1:1234"); // fallback default
  });

  it("respects user-provided baseURL without auto-detect", async () => {
    const result = await resolveProviderConfig({ baseURL: "http://custom:9999" });
    expect(result.baseURL).toBe("http://custom:9999");
  });

  it("invokes auto-detect when no baseURL is set and autoDetect is not false", async () => {
    installFetchMock((url) =>
      url.includes("127.0.0.1:8080") ? { ok: true, status: 200, body: { models: [] } } : { ok: false, status: 0 },
    );
    const result = await resolveProviderConfig({ autoDetect: true });
    expect(result.baseURL).toBe("http://127.0.0.1:8080");
  });
});

describe("buildProvider", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns an empty models map and a model-less provider entry when the server is unreachable", async () => {
    installFetchMock(() => ({ ok: false, status: 0 }));
    const result = await buildProvider({ baseURL: "http://unreachable:1234" });
    expect(result.models).toEqual({});
    expect(result.health?.healthy).toBeFalsy();
    expect(result.lifecycle).toBeNull();
    const entry = result.providerEntry as { options: { baseURL: string }; models: Record<string, unknown> };
    expect(entry.options.baseURL).toBe("http://unreachable:1234/v1");
    expect(entry.models).toEqual({});
  });

  it("discovers models and returns them in ModelV2 shape via the hook map", async () => {
    installFetchMock((url) => {
      if (url.endsWith("/api/v1/models")) {
        return {
          ok: true,
          status: 200,
          body: {
            models: [
              {
                type: "llm",
                publisher: "google",
                key: "google/gemma-4-e4b",
                display_name: "Gemma 4 E4B",
                architecture: "gemma4",
                quantization: { name: "Q4_K_M", bits_per_weight: 4 },
                size_bytes: 1000,
                params_string: "4B",
                loaded_instances: [],
                max_context_length: 131072,
                format: "gguf",
                capabilities: {
                  vision: true,
                  trained_for_tool_use: true,
                  reasoning: { allowed_options: ["off", "on"], default: "on" },
                },
                description: null,
              },
            ],
          },
        };
      }
      return { ok: false, status: 404 };
    });
    const result = await buildProvider({ baseURL: "http://host:1234" });
    expect(result.health?.healthy).toBe(true);
    const model = result.models["google/gemma-4-e4b"];
    expect(model).toMatchObject({
      id: "google/gemma-4-e4b",
      providerID: "lmstudio",
      name: "Gemma 4 E4B",
      api: { id: "google/gemma-4-e4b", url: "http://host:1234/v1", npm: "@ai-sdk/openai-compatible" },
      capabilities: { reasoning: true, toolcall: true, attachment: true },
    });
    // baseURL gets the /v1 suffix the OpenAI-style SDK expects.
    const entry = result.providerEntry as { options: { baseURL: string; apiKey: string } };
    expect(entry.options.baseURL).toBe("http://host:1234/v1");
    expect(entry.options.apiKey).toBe("lm-studio"); // default placeholder when none provided
  });

  it("propagates user apiKey into the provider entry", async () => {
    installFetchMock(() => ({ ok: true, status: 200, body: { models: [] } }));
    const result = await buildProvider({ baseURL: "http://h:1234", apiKey: "sk-real" });
    const entry = result.providerEntry as { options: { apiKey: string } };
    expect(entry.options.apiKey).toBe("sk-real");
  });

  it("produces a complete ModelV2 object for a plain non-reasoning model", async () => {
    installFetchMock((url) => {
      if (url.endsWith("/api/v1/models")) {
        return {
          ok: true,
          status: 200,
          body: {
            models: [
              {
                type: "llm",
                publisher: "x",
                key: "m1",
                display_name: "M1",
                architecture: "test-arch",
                quantization: { name: "Q4", bits_per_weight: 4 },
                size_bytes: 1000,
                params_string: "1B",
                loaded_instances: [{ id: "inst", config: { context_length: 4096 } }],
                max_context_length: 4096,
                format: "gguf",
                capabilities: { vision: false, trained_for_tool_use: false },
                description: null,
              },
            ],
          },
        };
      }
      return { ok: false, status: 404 };
    });
    const result = await buildProvider({ baseURL: "http://h:1234" });
    const model = result.models["m1"];
    // LMS-internal fields never cross into the ModelV2 shape.
    expect(model).not.toHaveProperty("isLoaded");
    expect(model).not.toHaveProperty("quantization");
    expect(model).toMatchObject({
      id: "m1",
      name: "M1",
      family: "test-arch",
      status: "active",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: false,
        // ModelV2 accepts a plain boolean here — no more omit-or-reject dance.
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 4096, output: 4096 },
    });
  });

  it("sets interleaved:{field:'reasoning_content'} for reasoning-capable models", async () => {
    installFetchMock((url) => {
      if (url.endsWith("/api/v1/models")) {
        return {
          ok: true,
          status: 200,
          body: {
            models: [
              {
                type: "llm",
                publisher: "g",
                key: "g/r1",
                display_name: "R1",
                architecture: "test",
                quantization: { name: "Q4", bits_per_weight: 4 },
                size_bytes: 1000,
                params_string: "4B",
                loaded_instances: [],
                max_context_length: 8192,
                format: "gguf",
                capabilities: {
                  vision: true,
                  trained_for_tool_use: true,
                  reasoning: { allowed_options: ["off", "on"], default: "on" },
                },
                description: null,
              },
            ],
          },
        };
      }
      return { ok: false, status: 404 };
    });
    const result = await buildProvider({ baseURL: "http://h:1234" });
    expect(result.models["g/r1"].capabilities).toMatchObject({
      reasoning: true,
      attachment: true, // vision-capable
      toolcall: true,
      interleaved: { field: "reasoning_content" },
    });
  });

  it("carries variant-suppression for on/off-only reasoning models in the provider entry, not the hook model", async () => {
    installFetchMock((url) => {
      if (url.endsWith("/api/v1/models")) {
        return {
          ok: true,
          status: 200,
          body: {
            models: [
              {
                type: "llm",
                publisher: "g",
                key: "g/r1",
                display_name: "R1",
                architecture: "test",
                quantization: { name: "Q4", bits_per_weight: 4 },
                size_bytes: 1000,
                params_string: "4B",
                loaded_instances: [],
                max_context_length: 8192,
                format: "gguf",
                capabilities: {
                  vision: false,
                  trained_for_tool_use: false,
                  reasoning: { allowed_options: ["off", "on"], default: "on" },
                },
                description: null,
              },
            ],
          },
        };
      }
      return { ok: false, status: 404 };
    });
    const result = await buildProvider({ baseURL: "http://h:1234" });
    // The hook model carries no variants (so OpenCode's auto-gen would fire)...
    expect(result.models["g/r1"]).not.toHaveProperty("variants");
    // ...and the config entry disables the auto-generated effort levels, which
    // is the one path where OpenCode actually filters disabled variants.
    const entry = result.providerEntry as { models: Record<string, { variants: Record<string, unknown> }> };
    expect(entry.models["g/r1"].variants).toEqual({
      low: { disabled: true },
      medium: { disabled: true },
      high: { disabled: true },
    });
  });
});
