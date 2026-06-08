import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildProviderConfig, resolveProviderConfig } from "../src/provider.js";

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

describe("buildProviderConfig", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns an empty models map when the server is unreachable", async () => {
    installFetchMock(() => ({ ok: false, status: 0 }));
    const result = await buildProviderConfig({ baseURL: "http://unreachable:1234" });
    expect(result).not.toBeNull();
    expect(result!.models).toEqual({});
    expect(result!.health?.healthy).toBeFalsy();
    expect((result!.providerConfig as { id: string }).id).toBe("lms");
  });

  it("discovers and maps models when the server is reachable", async () => {
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
    const result = await buildProviderConfig({ baseURL: "http://host:1234" });
    expect(result).not.toBeNull();
    expect(result!.health?.healthy).toBe(true);
    expect(result!.models["google/gemma-4-e4b"]).toMatchObject({
      id: "google/gemma-4-e4b",
      name: "Gemma 4 E4B",
      reasoning: true,
      tool_call: true,
    });
    // Provider config emits an /v1 suffix for the AI SDK (which is OpenAI-style)
    const pc = result!.providerConfig as {
      options: { baseURL: string; apiKey: string };
      models: Record<string, unknown>;
    };
    expect(pc.options.baseURL).toBe("http://host:1234/v1");
    expect(pc.options.apiKey).toBe("lm-studio"); // default placeholder when none provided
    expect(Object.keys(pc.models)).toEqual(["google/gemma-4-e4b"]);
  });

  it("propagates user apiKey into the provider config", async () => {
    installFetchMock(() => ({ ok: true, status: 200, body: { models: [] } }));
    const result = await buildProviderConfig({ baseURL: "http://h:1234", apiKey: "sk-real" });
    const pc = result!.providerConfig as { options: { apiKey: string } };
    expect(pc.options.apiKey).toBe("sk-real");
  });

  it("emits every capability field OpenCode reads, but keeps LMS-internal fields out", async () => {
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
    const result = await buildProviderConfig({ baseURL: "http://h:1234" });
    const model = (result!.providerConfig as { models: Record<string, Record<string, unknown>> })
      .models["m1"];
    // LMS-internal fields stay out of the emitted config.
    expect(model).not.toHaveProperty("isLoaded");
    expect(model).not.toHaveProperty("loadedInstance");
    expect(model).not.toHaveProperty("quantization");
    expect(model).not.toHaveProperty("format");
    expect(model).not.toHaveProperty("size_bytes");
    expect(model.options).toBeUndefined(); // no per-model options dump
    // Everything OpenCode's parser reads should be present.
    expect(model).toMatchObject({
      id: "m1",
      name: "M1",
      family: "test-arch",
      temperature: true,
      reasoning: false,
      attachment: false,
      tool_call: false,
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      limit: { context: 4096, output: 4096 },
    });
    // OpenCode's config schema rejects interleaved:false — must be omitted
    // for non-reasoning models, not emitted as a falsy value.
    expect(model).not.toHaveProperty("interleaved");
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
    const result = await buildProviderConfig({ baseURL: "http://h:1234" });
    const model = (result!.providerConfig as { models: Record<string, Record<string, unknown>> })
      .models["g/r1"];
    expect(model).toMatchObject({
      reasoning: true,
      attachment: true, // vision-capable
      tool_call: true,
      interleaved: { field: "reasoning_content" },
    });
  });
});
