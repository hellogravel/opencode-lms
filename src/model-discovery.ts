import type { LMSModelInfo, MappedModelConfig, LMSModelOverride } from "./types.js";

/**
 * Map a single LM Studio model to OpenCode model config format.
 */
function mapSingleModel(model: LMSModelInfo): MappedModelConfig {
  const isLoaded = model.loaded_instances.length > 0;
  const loadedInstance = isLoaded ? model.loaded_instances[0] : undefined;

  // Determine modalities
  let modalities: MappedModelConfig["modalities"];
  if (model.type === "embedding") {
    modalities = { input: ["text"], output: ["text"] as unknown as Array<"text" | "audio" | "image" | "video" | "pdf" | "embedding"> };
  } else {
    const inputMods: Array<"text" | "image"> = ["text"];
    if (model.capabilities?.vision) {
      inputMods.push("image");
    }
    modalities = { input: inputMods, output: ["text"] };
  }

  // Build variants array if available
  let variants: MappedModelConfig["variants"];
  if (model.variants && model.variants.length > 0) {
    variants = model.variants.map((v) => ({
      id: v,
      disabled: v !== model.selected_variant,
    }));
  }

  return {
    id: model.key,
    name: model.display_name || formatModelName(model.key),
    family: model.architecture || undefined,
    reasoning: model.capabilities?.reasoning ? true : false,
    tool_call: model.capabilities?.trained_for_tool_use ? true : false,
    modalities,
    // OpenCode's ProviderConfig schema requires both context and output when
    // `limit` is present. LMS doesn't expose a separate output cap (output
    // is bounded by remaining context), so default output to the full
    // context window.
    limit: { context: model.max_context_length, output: model.max_context_length },
    variants,
    isLoaded,
    loadedInstance: loadedInstance
      ? { id: loadedInstance.id, context_length: loadedInstance.config.context_length }
      : undefined,
    quantization: model.quantization?.name || undefined,
    format: model.format || undefined,
    size_bytes: model.size_bytes || undefined,
  };
}

/**
 * Discover and map all models from LM Studio.
 * Merges discovered models with any user-configured overrides.
 */
export function discoverAndMapModels(
  discovered: LMSModelInfo[],
  userOverrides: Record<string, LMSModelOverride> | null | undefined,
): Record<string, typeof discovered[0] extends LMSModelInfo ? MappedModelConfig : never> {
  const result: Record<string, MappedModelConfig> = {};

  // First, apply user overrides (they take priority for explicitly configured models)
  if (userOverrides) {
    for (const [key, override] of Object.entries(userOverrides)) {
      const mapped: MappedModelConfig = {
        id: override.id,
        name: override.name,
        family: override.family,
        reasoning: override.reasoning,
        tool_call: override.tool_call,
        modalities: override.modalities,
        limit: override.limit,
        variants: override.variants,
        isLoaded: false,
        loadedInstance: undefined,
      };
      // Use override key as the map key
      result[key] = mapped;
    }
  }

  // Then, merge discovered models
  for (const model of discovered) {
    // Check if already overridden
    const existingKey = Object.keys(result).find(
      (key) => result[key].id === model.key || key === model.key,
    );

    if (existingKey) {
      // Override exists - update loaded status only
      result[existingKey].isLoaded = model.loaded_instances.length > 0;
      if (model.loaded_instances.length > 0) {
        result[existingKey].loadedInstance = {
          id: model.loaded_instances[0].id,
          context_length: model.loaded_instances[0].config.context_length,
        };
      }
      continue;
    }

    // Use the model key verbatim. OpenCode references models as
    // "<provider>/<model id>", and the model id may itself contain "/"
    // (e.g. "google/gemma-4-e4b"); rewriting those into underscores would
    // silently break user configs that reference the canonical key.
    result[model.key] = mapSingleModel(model);
  }

  return result;
}

/**
 * Format model name for display.
 */
export function formatModelName(displayName: string): string {
  if (!displayName) return "Unknown Model";

  // Split by common separators
  const parts = displayName.split(/[-_\s]/).filter(Boolean);
  const acronyms = new Set(["gpt", "oss", "api", "gguf", "ggml", "vl", "it", "mlx", "qat"]);

  return parts
    .map((token) => {
      const lower = token.toLowerCase();
      if (acronyms.has(lower)) return token.toUpperCase();
      if (/^\d+[bkmg]$/i.test(token)) return token.toUpperCase();
      if (/^q\d+$/i.test(token)) return token.toUpperCase();
      if (/^\d+\.\d+/.test(token)) return token;
      if (/^[a-z]\d+[a-z]$/i.test(token) || /^\d+[a-z]$/i.test(token)) return token.toUpperCase();
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    })
    .join(" ");
}

/**
 * Categorize a model by type.
 */
export function categorizeModel(modelKey: string): "llm" | "embedding" | "unknown" {
  const lower = modelKey.toLowerCase();
  if (lower.includes("embedding") || lower.includes("embed")) return "embedding";
  return "llm";
}
