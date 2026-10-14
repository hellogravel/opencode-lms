// Core types for the LM Studio REST API and plugin options

// ─── LM Studio REST v1 API types ───

export interface LMSModelInfo {
  type: "llm" | "embedding";
  publisher: string;
  key: string;
  display_name: string;
  architecture: string | null;
  quantization: {
    name: string | null;
    bits_per_weight: number | null;
  } | null;
  size_bytes: number;
  params_string: string | null;
  loaded_instances: Array<{
    id: string;
    config: {
      context_length: number;
      eval_batch_size?: number;
      parallel?: number;
      flash_attention?: boolean;
      num_experts?: number;
      offload_kv_cache_to_gpu?: boolean;
    };
  }>;
  max_context_length: number;
  format: "gguf" | "mlx" | null;
  capabilities?: {
    vision: boolean;
    trained_for_tool_use: boolean;
    reasoning?: {
      allowed_options: Array<"off" | "on" | "low" | "medium" | "high">;
      default: "off" | "on" | "low" | "medium" | "high";
    };
  };
  description: string | null;
  variants?: string[];
  selected_variant?: string;
}

export interface LMSModelsResponse {
  models: LMSModelInfo[];
}

export interface LMSModelLoadResponse {
  type: "llm" | "embedding";
  instance_id: string;
  load_time_seconds: number;
  status: "loaded";
  load_config?: Record<string, unknown>;
}

export interface LMSModelUnloadResponse {
  instance_id: string;
}

// ─── Streaming event types (/api/v1/chat, used only to observe a load) ───

export type LMSStreamEventType =
  | "chat.start"
  | "model_load.start"
  | "model_load.progress"
  | "model_load.end"
  | "prompt_processing.start"
  | "prompt_processing.progress"
  | "prompt_processing.end"
  | "reasoning.start"
  | "reasoning.delta"
  | "reasoning.end"
  | "tool_call.start"
  | "tool_call.arguments"
  | "tool_call.success"
  | "tool_call.failure"
  | "message.start"
  | "message.delta"
  | "message.end"
  | "error"
  | "chat.end";

export interface LMSStreamEvent {
  type: LMSStreamEventType;
}

export interface LMSModelLoadStartEvent extends LMSStreamEvent {
  type: "model_load.start";
  model_instance_id: string;
}

export interface LMSModelLoadProgressEvent extends LMSStreamEvent {
  type: "model_load.progress";
  model_instance_id: string;
  progress: number;
}

export interface LMSModelLoadEndEvent extends LMSStreamEvent {
  type: "model_load.end";
  model_instance_id: string;
  load_time_seconds: number;
}

export interface LMSErrorEvent extends LMSStreamEvent {
  type: "error";
  error: {
    type: "invalid_request" | "unknown" | "mcp_connection_error" | "plugin_connection_error" | "not_implemented" | "model_not_found" | "job_not_found" | "internal_error";
    message: string;
    code?: string;
    param?: string;
  };
}

// ─── Plugin options ───

/**
 * Options read from the plugin's config entry:
 * `"plugins": [{ "package": "@hellogravel/opencode-lms", "options": { ... } }]`.
 * Where LM Studio lives (baseURL, apiKey) is NOT here: that is the built-in
 * provider's `providers.lmstudio.settings`, and the plugin reads it from there.
 */
export interface LMSPluginOptions {
  /**
   * Global default cap for the context window a model is *loaded* with (the
   * VRAM knob). LM Studio would otherwise load at each model's
   * `max_context_length`, which can dominate VRAM on large-window models.
   * Default 32768 — an OpenCode agent session opens at well over 8k tokens,
   * so smaller defaults reject the first request. A model whose max is below
   * this loads at its max; `models[<key>].contextLength` adjusts per model. A
   * resident instance with a smaller window than the resolved value is
   * unloaded and reloaded at it on first use; the advertised `limit.context`
   * follows this value so OpenCode budgets against the real window.
   */
  contextLength?: number;
  /** Per-model load-time overrides, keyed by LM Studio model key. */
  models?: Record<string, { contextLength?: number }>;
  /**
   * Idle time-to-live in seconds applied to each chat completion. LM Studio
   * resets the countdown on every request, so a model stays resident under
   * active use and auto-evicts only after `ttl` idle seconds. Default 3600
   * (1h). `0` = resident (no `ttl` sent).
   */
  ttl?: number;
  /** Skip auto-loading; LM Studio JIT-loads at its own defaults instead. */
  disableAutoLoad?: boolean;
  /** Timeout for load/unload operations in ms. Default 600000 (10 min). */
  loadTimeout?: number;
}
