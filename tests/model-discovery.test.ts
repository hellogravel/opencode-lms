import { describe, it, expect } from "vitest";
import {
  discoverAndMapModels,
  formatModelName,
  categorizeModel,
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
    expect(result["test/model-1"]).toMatchObject({
      id: "test/model-1",
      name: "Test Model 1",
      family: "test-arch",
      reasoning: false,
      tool_call: false,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 8192 },
      isLoaded: false,
      quantization: "Q4_K_M",
      format: "gguf",
      size_bytes: 1000,
    });
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

  it("marks tool_call: true when trained_for_tool_use", () => {
    const result = discoverAndMapModels(
      [llmModel({ capabilities: { vision: false, trained_for_tool_use: true } })],
      undefined,
    );
    expect(result["test/model-1"].tool_call).toBe(true);
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

  it("maps embedding type to text input/output modalities", () => {
    const result = discoverAndMapModels(
      [llmModel({ type: "embedding", key: "embed-1", capabilities: undefined as never })],
      undefined,
    );
    expect(result["embed-1"].modalities?.input).toEqual(["text"]);
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

  it("emits variants from selected_variant + variants list", () => {
    const result = discoverAndMapModels(
      [
        llmModel({
          variants: ["q4_0", "q8_0", "f16"],
          selected_variant: "q4_0",
        }),
      ],
      undefined,
    );
    expect(result["test/model-1"].variants).toEqual([
      { id: "q4_0", disabled: false },
      { id: "q8_0", disabled: true },
      { id: "f16", disabled: true },
    ]);
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
