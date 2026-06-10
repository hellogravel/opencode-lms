// Core types for LM Studio API and plugin internals

import type { ProviderHook } from "@opencode-ai/plugin";

// ─── OpenCode v2 model shape ───
//
// The `provider.models` hook returns OpenCode's strict `Model` (a.k.a.
// ModelV2) objects. Rather than depend on `@opencode-ai/sdk/v2` directly,
// derive the type from the plugin's own ProviderHook signature so it always
// tracks whatever @opencode-ai/plugin version is installed.
export type ModelV2 = Awaited<ReturnType<NonNullable<ProviderHook["models"]>>>[string];

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

export interface LMSDownloadRequest {
  model: string;
}

export interface LMSDownloadStatusResponse {
  job_id: string;
  status: "pending" | "downloading" | "completed" | "failed";
  progress?: number;
  error?: string;
}

// ─── LM Studio REST v0 types ───

export interface LMSV0Model {
  id: string;
  object: string;
  type: "llm" | "vlm" | "embeddings";
  publisher: string;
  arch: string;
  compatibility_type: "gguf" | "mlx";
  quantization: string;
  state: "loaded" | "not-loaded";
  max_context_length: number;
}

export interface LMSV0ModelsResponse {
  object: string;
  data: LMSV0Model[];
}

// ─── OpenAI-compatible types ───

export interface LMSOpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface LMSOpenAIModelsResponse {
  object: string;
  data: LMSOpenAIModel[];
}

// ─── Streaming event types ───

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

export interface LMSChatStartEvent extends LMSStreamEvent {
  type: "chat.start";
  model_instance_id: string;
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

export interface LMSReasoningStartEvent extends LMSStreamEvent {
  type: "reasoning.start";
}

export interface LMSReasoningDeltaEvent extends LMSStreamEvent {
  type: "reasoning.delta";
  content: string;
}

export interface LMSReasoningEndEvent extends LMSStreamEvent {
  type: "reasoning.end";
}

export interface LMSMessageStartEvent extends LMSStreamEvent {
  type: "message.start";
}

export interface LMSMessageDeltaEvent extends LMSStreamEvent {
  type: "message.delta";
  content: string;
}

export interface LMSMessageEndEvent extends LMSStreamEvent {
  type: "message.end";
}

export interface LMSChatEndEvent extends LMSStreamEvent {
  type: "chat.end";
  result: {
    model_instance_id: string;
    output: Array<
      | { type: "reasoning"; content: string }
      | {
          type: "tool_call";
          tool: string;
          arguments: Record<string, unknown>;
          output: string;
          provider_info?: Record<string, unknown>;
        }
      | { type: "message"; content: string }
    >;
    stats: {
      input_tokens: number;
      total_output_tokens: number;
      reasoning_output_tokens: number;
      tokens_per_second: number;
      time_to_first_token_seconds: number;
    };
    response_id?: string;
  };
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

export interface LMSToolCallStartEvent extends LMSStreamEvent {
  type: "tool_call.start";
  tool: string;
  provider_info?: Record<string, unknown>;
}

export interface LMSToolCallArgumentsEvent extends LMSStreamEvent {
  type: "tool_call.arguments";
  tool: string;
  arguments: Record<string, unknown>;
  provider_info?: Record<string, unknown>;
}

export interface LMSToolCallSuccessEvent extends LMSStreamEvent {
  type: "tool_call.success";
  tool: string;
  arguments: Record<string, unknown>;
  output: string;
  provider_info?: Record<string, unknown>;
}

export interface LMSToolCallFailureEvent extends LMSStreamEvent {
  type: "tool_call.failure";
  reason: string;
  metadata: {
    type: "invalid_name" | "invalid_arguments";
    tool_name: string;
    arguments?: Record<string, unknown>;
    provider_info?: Record<string, unknown>;
  };
}

// ─── Plugin config types ───

export interface LMSProviderConfig {
  name?: string;
  baseURL?: string;
  apiKey?: string;
  autoDetect?: boolean;
  models?: Record<string, LMSModelOverride>;
  disableAutoLoad?: boolean;
  /**
   * When a referenced model isn't on disk, automatically download it before
   * loading. OFF by default — a typo in a model id could trigger a 30+ GB
   * download. Enable explicitly when you want this convenience.
   */
  autoDownload?: boolean;
  /** Override timeout for load/unload operations in ms. Default 600000 (10 min). */
  loadTimeout?: number;
  /** Override timeout for download operations in ms. Default 1800000 (30 min). */
  downloadTimeout?: number;
}

export interface LMSModelOverride {
  id: string;
  name: string;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: {
    input: Array<"text" | "image" | "audio" | "video" | "pdf">;
    output: Array<"text" | "audio" | "image" | "video" | "pdf">;
  };
  limit?: {
    context: number;
    input?: number;
    output: number;
  };
  variants?: Record<string, { disabled?: boolean }>;
  options?: Record<string, unknown>;
}

// ─── Internal state types ───

export interface ModelCacheEntry {
  models: LMSModelInfo[];
  timestamp: number;
  ttl: number;
}

export interface HealthCheckResult {
  healthy: boolean;
  baseURL: string;
  apiVersion: "v1" | "v0" | "openai";
  latency: number;
}

// ─── Capability mapping types ───

export interface MappedModelConfig {
  id: string;
  name: string;
  family?: string;
  /**
   * Whether this model accepts a temperature parameter. Lets OpenCode's UI
   * surface temperature controls. True for LLMs, false for embedding models.
   */
  temperature?: boolean;
  reasoning?: boolean;
  /**
   * Whether the model accepts file/image attachments alongside the message.
   * True for vision-capable LLMs. Distinct from `modalities.input.image` —
   * `attachment` gates the UI "attach a file" affordance.
   */
  attachment?: boolean;
  tool_call?: boolean;
  /**
   * Tells OpenCode to interleave a structured reasoning content field from
   * the upstream's streaming response. Set to `{ field: "reasoning_content" }`
   * for reasoning-capable LMS models — without this, the reasoning trace
   * arrives on the wire (from /v1/chat/completions delta.reasoning_content)
   * but OpenCode's renderer skips it.
   *
   * OpenCode's config schema accepts `true | {field}` or omitted — explicit
   * `false` is rejected. Leave undefined for non-reasoning models.
   */
  interleaved?: true | { field: "reasoning_content" | "reasoning_details" };
  /**
   * Per-token cost. LMS models are local, so always zero. Setting this
   * explicitly suppresses noise in OpenCode's cost display.
   */
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  modalities?: {
    input: Array<"text" | "image" | "audio" | "video" | "pdf">;
    output: Array<"text" | "audio" | "image" | "video" | "pdf" | "embedding">;
  };
  limit?: {
    context: number;
    input?: number;
    output?: number;
  };
  /**
   * Keyed by variant id. Each value carries per-variant flags. `disabled: true`
   * tells OpenCode to filter the variant out at parse time. Shape matches
   * OpenCode's schema at provider.ts:1023:
   *   variants: Record<string, Record<string, any>>
   */
  variants?: Record<string, { disabled?: boolean }>;
  isLoaded: boolean;
  loadedInstance?: {
    id: string;
    context_length: number;
  };
  quantization?: string;
  format?: string;
  size_bytes?: number;
}
