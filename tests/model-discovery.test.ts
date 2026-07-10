import { describe, it, expect } from "vitest";
import {
  discoverAndMapModels,
  formatModelName,
  categorizeModel,
  groupModelsByToolUse,
} from "../src/model-discovery.js";
import type { LMSModelInfo } from "../src/types.js";

function llmModel(overrides: Partial<LMSModelInfo> = {}): LMSModelInfo {
  return {
    type: "llm",
    publisher: "test",
    key: "test/model-1",
    display_name: "Test Model 1",
    architecture: "test-arch",
    quantization: { name: "Q4_K_M", bits_per_weight: 4 },
    size_bytes: 1000,
    params_string: "8B",
    loaded_instances: [],
    max_context_length: 8192,
    format: "gguf",
    capabilities: { vision: false, trained_for_tool_use: false },
    description: null,
    ...overrides,
  };
}

describe("discoverAndMapModels", () => {
  it("maps a basic LLM with all fields", () => {
    const result = discoverAndMapModels([llmModel()], undefined);
    const m = result["test/model-1"];
    expect(m).toMatchObject({
      id: "test/model-1",
      name: "Test Model 1",
      family: "test-arch",
      temperature: true,
      reasoning: false,
      attachment: false,
      // Tools are always advertised on for discovered LLMs (Phase 3).
      tool_call: true,
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      modalities: { input: ["text"], output: ["text"] },
      // Cold model: context = max; output = min(floor(8192/4), 8192) = 2048.
      limit: { context: 8192, output: 2048 },
      isLoaded: false,
      quantization: "Q4_K_M",
      format: "gguf",
      size_bytes: 1000,
    });
    // OpenCode's config schema rejects interleaved:false — left undefined
    // (and we omit it on the emit side) so the runtime parser falls through
    // to its own default.
    expect(m.interleaved).toBeUndefined();
  });

  it("sets interleaved:{field:'reasoning_content'} for reasoning-capable models", () => {
    const result = discoverAndMapModels(
      [
        llmModel({
          capabilities: {
            vision: false,
            trained_for_tool_use: false,
            reasoning: { allowed_options: ["off", "on"], default: "on" },
          },
        }),
      ],
      undefined,
    );
    expect(result["test/model-1"].interleaved).toEqual({ field: "reasoning_content" });
  });

  it("sets attachment:true for vision-capable models", () => {
    const result = discoverAndMapModels(
      [llmModel({ capabilities: { vision: true, trained_for_tool_use: false } })],
      undefined,
    );
    expect(result["test/model-1"].attachment).toBe(true);
  });

  it("skips embedding models from auto-discovery (they have no role in OpenCode's chat picker)", () => {
    const result = discoverAndMapModels(
      [
        llmModel({ key: "chat-llm" }),
        llmModel({ type: "embedding", key: "embed-1", capabilities: undefined as never }),
      ],
      undefined,
    );
    expect(result["chat-llm"]).toBeDefined();
    expect(result["embed-1"]).toBeUndefined();
  });

  it("keeps an embedding model in the result if the user explicitly added it to overrides", () => {
    const result = discoverAndMapModels(
      [llmModel({ type: "embedding", key: "embed-1", capabilities: undefined as never })],
      {
        "embed-1": { id: "embed-1", name: "My Embedder" },
      },
    );
    expect(result["embed-1"]).toBeDefined();
    expect(result["embed-1"].name).toBe("My Embedder");
  });

  it("adds 'image' to input modalities when vision is true", () => {
    const result = discoverAndMapModels(
      [llmModel({ capabilities: { vision: true, trained_for_tool_use: false } })],
      undefined,
    );
    expect(result["test/model-1"].modalities?.input).toEqual(["text", "image"]);
  });

  it("marks reasoning: true when capabilities.reasoning is present (any default)", () => {
    const result = discoverAndMapModels(
      [
        llmModel({
          capabilities: {
            vision: false,
            trained_for_tool_use: false,
            reasoning: { allowed_options: ["off", "on"], default: "on" },
          },
        }),
      ],
      undefined,
    );
    expect(result["test/model-1"].reasoning).toBe(true);
  });

  it("advertises tool_call: true regardless of trained_for_tool_use (Phase 3)", () => {
    const withFlag = discoverAndMapModels(
      [llmModel({ key: "a", capabilities: { vision: false, trained_for_tool_use: true } })],
      undefined,
    );
    const withoutFlag = discoverAndMapModels(
      [llmModel({ key: "b", capabilities: { vision: false, trained_for_tool_use: false } })],
      undefined,
    );
    expect(withFlag["a"].tool_call).toBe(true);
    expect(withoutFlag["b"].tool_call).toBe(true);
  });

  it("limit.context reflects the smallest loaded instance; output is context/4 capped 8192", () => {
    const result = discoverAndMapModels(
      [
        llmModel({
          key: "multi",
          max_context_length: 131072,
          loaded_instances: [
            { id: "i1", config: { context_length: 32768 } },
            { id: "i2", config: { context_length: 16384 } },
          ],
        }),
      ],
      undefined,
    );
    // min active context = 16384; output = floor(16384/4) = 4096.
    expect(result["multi"].limit).toEqual({ context: 16384, output: 4096 });
  });

  it("a cold model advertises its full max_context_length, output capped at 8192", () => {
    // No load policy (the disableAutoLoad path) — legacy advertising rules.
    const result = discoverAndMapModels(
      [llmModel({ key: "cold", max_context_length: 131072 })],
      undefined,
    );
    // cold → context = max = 131072; output = min(floor(131072/4), 8192) = 8192.
    expect(result["cold"].limit).toEqual({ context: 131072, output: 8192 });
  });

  it("with a load policy, a cold model advertises the resolved load context, not max", () => {
    const result = discoverAndMapModels(
      [llmModel({ key: "cold", max_context_length: 131072 })],
      undefined,
      { contextLength: 32768 },
    );
    // The model will be loaded at 32768 — advertising 131072 would let
    // OpenCode build prompts the loaded instance rejects.
    expect(result["cold"].limit).toEqual({ context: 32768, output: 8192 });
  });

  it("with a load policy, an undersized resident instance advertises the policy window (it gets reloaded)", () => {
    const result = discoverAndMapModels(
      [
        llmModel({
          key: "stale",
          max_context_length: 131072,
          loaded_instances: [{ id: "i1", config: { context_length: 8192 } }],
        }),
      ],
      undefined,
      { contextLength: 32768 },
    );
    expect(result["stale"].limit).toEqual({ context: 32768, output: 8192 });
  });

  it("with a load policy, a roomier resident instance advertises its own window (it is kept)", () => {
    const result = discoverAndMapModels(
      [
        llmModel({
          key: "roomy",
          max_context_length: 131072,
          loaded_instances: [{ id: "i1", config: { context_length: 65536 } }],
        }),
      ],
      undefined,
      { contextLength: 32768 },
    );
    expect(result["roomy"].limit).toEqual({ context: 65536, output: 8192 });
  });

  it("a per-model policy override feeds the advertised context for that model", () => {
    const result = discoverAndMapModels(
      [llmModel({ key: "special", max_context_length: 131072 })],
      undefined,
      { contextLength: 16384, perModel: { special: { contextLength: 65536 } } },
    );
    expect(result["special"].limit).toEqual({ context: 65536, output: 8192 });
  });

  it("a user limit.output override wins over the reserve formula", () => {
    const result = discoverAndMapModels(
      [llmModel({ key: "over", max_context_length: 131072 })],
      { over: { id: "over", name: "Over", limit: { context: 131072, output: 512 } } },
    );
    expect(result["over"].limit).toEqual({ context: 131072, output: 512 });
  });

  it("groupModelsByToolUse buckets models by their reported tool-use signal", () => {
    const buckets = groupModelsByToolUse([
      llmModel({ key: "native-1", capabilities: { vision: false, trained_for_tool_use: true } }),
      llmModel({ key: "default-1", capabilities: { vision: false, trained_for_tool_use: false } }),
      llmModel({ key: "unknown-1", capabilities: undefined }),
      llmModel({ key: "embed-1", type: "embedding", capabilities: undefined as never }),
    ]);
    expect(buckets).toEqual({
      native: ["native-1"],
      default: ["default-1"],
      unknown: ["unknown-1"],
    });
  });

  it("flags isLoaded with the first loaded_instances entry", () => {
    const result = discoverAndMapModels(
      [
        llmModel({
          loaded_instances: [
            { id: "instance-abc", config: { context_length: 4096 } },
          ],
        }),
      ],
      undefined,
    );
    const m = result["test/model-1"];
    expect(m.isLoaded).toBe(true);
    expect(m.loadedInstance).toEqual({ id: "instance-abc", context_length: 4096 });
  });

  it("falls back to formatModelName when display_name is empty", () => {
    const result = discoverAndMapModels(
      [llmModel({ display_name: "", key: "qwen-coder-7b" })],
      undefined,
    );
    expect(result["qwen-coder-7b"].name).toBe("Qwen Coder 7B");
  });


  it("preserves user-configured overrides as the source of truth", () => {
    const result = discoverAndMapModels(
      [llmModel({ key: "qwen", display_name: "Discovered Name" })],
      {
        qwen: {
          id: "qwen",
          name: "User Custom Name",
          reasoning: true,
        },
      },
    );
    expect(result["qwen"].name).toBe("User Custom Name");
    expect(result["qwen"].reasoning).toBe(true);
  });

  it("updates loaded status on overrides from discovery data", () => {
    const result = discoverAndMapModels(
      [
        llmModel({
          key: "qwen",
          loaded_instances: [{ id: "inst-1", config: { context_length: 2048 } }],
        }),
      ],
      { qwen: { id: "qwen", name: "Qwen" } },
    );
    expect(result["qwen"].isLoaded).toBe(true);
    expect(result["qwen"].loadedInstance).toEqual({ id: "inst-1", context_length: 2048 });
  });

  it("does not emit variants for non-reasoning models (no LMS quantization clutter)", () => {
    const result = discoverAndMapModels(
      [
        llmModel({
          variants: ["q4_0", "q8_0", "f16"],
          selected_variant: "q4_0",
          // capabilities default: no reasoning
        }),
      ],
      undefined,
    );
    expect(result["test/model-1"].variants).toBeUndefined();
  });

  it("disables auto-generated reasoning-effort variants for on/off-only reasoning models", () => {
    // Most LMS reasoning models — gemma, mistral, llama variants — advertise
    // only on/off. Without intervention, OpenCode would show a misleading
    // low/medium/high picker. Disable those keys; the parse-time filter
    // clears them and the picker stays hidden.
    const result = discoverAndMapModels(
      [
        llmModel({
          capabilities: {
            vision: false,
            trained_for_tool_use: false,
            reasoning: { allowed_options: ["off", "on"], default: "on" },
          },
        }),
      ],
      undefined,
    );
    expect(result["test/model-1"].variants).toEqual({
      low: { disabled: true },
      medium: { disabled: true },
      high: { disabled: true },
    });
  });

  it("leaves variants undefined for reasoning models that DO support graduated levels", () => {
    // Hypothetical LMS model that exposes graduated effort levels — let
    // OpenCode's auto-generated picker stand.
    const result = discoverAndMapModels(
      [
        llmModel({
          capabilities: {
            vision: false,
            trained_for_tool_use: false,
            reasoning: { allowed_options: ["off", "low", "medium", "high"], default: "medium" },
          },
        }),
      ],
      undefined,
    );
    expect(result["test/model-1"].variants).toBeUndefined();
  });

  it("preserves variants when the user sets them in an override", () => {
    const result = discoverAndMapModels(
      [],
      {
        "custom-id": {
          id: "custom-id",
          name: "Custom",
          variants: { "v1": { disabled: false } },
        },
      },
    );
    expect(result["custom-id"].variants).toEqual({ "v1": { disabled: false } });
  });

  it("preserves the verbatim model key, including slashes", () => {
    // OpenCode looks models up as "<provider>/<model id>". The id may contain
    // "/" itself ("google/gemma-4-e4b") — rewriting it would break configs.
    const result = discoverAndMapModels(
      [llmModel({ key: "google/gemma-4-e4b" })],
      undefined,
    );
    expect(Object.keys(result)).toEqual(["google/gemma-4-e4b"]);
    expect(result["google/gemma-4-e4b"].id).toBe("google/gemma-4-e4b");
  });
});

describe("formatModelName", () => {
  it("title-cases ordinary words", () => {
    expect(formatModelName("gemma-medium-vision")).toBe("Gemma Medium Vision");
  });

  it("uppercases known acronyms", () => {
    expect(formatModelName("nomic-embed-mlx")).toBe("Nomic Embed MLX");
    expect(formatModelName("gpt-oss")).toBe("GPT OSS");
  });

  it("uppercases parameter counts and quantization tags", () => {
    expect(formatModelName("qwen-7b")).toBe("Qwen 7B");
    expect(formatModelName("model-q4")).toBe("Model Q4");
    expect(formatModelName("gemma-a4b")).toBe("Gemma A4B");
  });

  it("preserves embedded version numbers", () => {
    expect(formatModelName("gemma-3.5-pro")).toBe("Gemma 3.5 Pro");
  });

  it("handles empty / falsy input", () => {
    expect(formatModelName("")).toBe("Unknown Model");
  });
});

describe("categorizeModel", () => {
  it("recognizes embedding models by name", () => {
    expect(categorizeModel("text-embedding-mxbai-embed-large-v1")).toBe("embedding");
    expect(categorizeModel("nomic-embed-text-v1.5")).toBe("embedding");
  });

  it("defaults non-embedding names to llm", () => {
    expect(categorizeModel("qwen/qwen3.6-35b-a3b")).toBe("llm");
    expect(categorizeModel("google/gemma-4-e4b")).toBe("llm");
  });
});
