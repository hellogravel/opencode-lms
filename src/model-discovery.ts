import type { LMSModelInfo, MappedModelConfig, LMSModelOverride } from "./types.js";

/**
 * Map a single LM Studio model to OpenCode model config format.
 */
function mapSingleModel(model: LMSModelInfo): MappedModelConfig {
  const isLoaded = model.loaded_instances.length > 0;
  const loadedInstance = isLoaded ? model.loaded_instances[0] : undefined;
  const isEmbedding = model.type === "embedding";
  const hasReasoning = Boolean(model.capabilities?.reasoning);
  const hasVision = Boolean(model.capabilities?.vision);
  const hasToolUse = Boolean(model.capabilities?.trained_for_tool_use);

  // OpenCode auto-generates reasoning_effort variants (low/medium/high) for
  // any reasoning-capable model on @ai-sdk/openai-compatible. For LMS models
  // that only support on/off internally (allowed_options is just ["off"|"on"]),
  // the picker is misleading — every level just maps to "on" inside LMS, and
  // the user is forced to choose between meaningless options. Detect graduated
  // reasoning by looking for any of the OpenAI-scale levels in allowed_options;
  // emit `variants` that disable the auto-generated entries when absent so
  // OpenCode skips the picker.
  const allowedOptions = model.capabilities?.reasoning?.allowed_options ?? [];
  const hasGraduatedReasoning = allowedOptions.some(
    (o) => o === "low" || o === "medium" || o === "high",
  );
  const suppressReasoningVariants = hasReasoning && !hasGraduatedReasoning;

  // Modalities. Embedding models intentionally output nothing OpenCode treats
  // as a chat-renderable modality — that keeps them out of the chat model
  // picker by default while still letting them be referenced for embeddings.
  let modalities: MappedModelConfig["modalities"];
  if (isEmbedding) {
    modalities = { input: ["text"], output: [] };
  } else {
    const inputMods: Array<"text" | "image"> = ["text"];
    if (hasVision) inputMods.push("image");
    modalities = { input: inputMods, output: ["text"] };
  }

  return {
    id: model.key,
    name: model.display_name || formatModelName(model.key),
    family: model.architecture || undefined,
    // LMS chat models support a temperature parameter; embedding models don't.
    temperature: !isEmbedding,
    reasoning: hasReasoning,
    // Vision-capable models accept image attachments alongside the message.
    attachment: hasVision,
    tool_call: hasToolUse,
    // The key user-visible setting: tells OpenCode's renderer to interleave
    // the streaming `delta.reasoning_content` chunks the OpenAI-compat
    // endpoint already emits for reasoning-capable models. Without this set,
    // the data arrives on the wire but the TUI never shows it.
    //
    // OpenCode's config schema only accepts `true | {field}` for this — must
    // be undefined for non-reasoning models; explicit `false` is rejected.
    interleaved: hasReasoning ? { field: "reasoning_content" as const } : undefined,
    // Local models incur no per-token cost; mark explicitly so OpenCode's
    // cost display doesn't surface placeholder noise.
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    modalities,
    // OpenCode's ProviderConfig schema requires both context and output when
    // `limit` is present. LMS doesn't expose a separate output cap (output
    // is bounded by remaining context), so default output to the full
    // context window.
    limit: { context: model.max_context_length, output: model.max_context_length },
    // Two reasons we touch variants:
    //   1) LMS file-level variants (e.g. @q4_0, @q8_0) are useless in the
    //      OpenCode picker — selecting one is a no-op since file changes
    //      happen at the LM Studio side, not via OpenAI-compat. Don't emit.
    //   2) OpenCode auto-generates reasoning_effort variants (low/medium/high)
    //      for any reasoning-capable model on @ai-sdk/openai-compatible. For
    //      LMS models that only do on/off (the common case), every picker
    //      option silently maps to the same "on" inside LMS. Suppress by
    //      emitting the same keys with disabled:true; OpenCode's parser
    //      filters them after merging and the picker stays hidden.
    variants: suppressReasoningVariants
      ? {
          low: { disabled: true },
          medium: { disabled: true },
          high: { disabled: true },
        }
      : undefined,
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

  // Then, merge discovered models. Skip embedding models by default —
  // OpenCode's chat picker doesn't filter on output modality, and OpenCode
  // has no config slot that consumes embedding models (no embedding_model
  // field; small_model is for chat title generation, not embeddings). Users
  // who explicitly want one in the picker can list it in their `models`
  // overrides — that path bypasses this filter.
  for (const model of discovered) {
    if (model.type === "embedding") continue;

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
