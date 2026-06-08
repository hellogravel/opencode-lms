import type {
  LMSModelsResponse,
  LMSModelInfo,
  LMSModelLoadResponse,
  LMSModelUnloadResponse,
  LMSDownloadStatusResponse,
  LMSV0ModelsResponse,
  LMSOpenAIModelsResponse,
  HealthCheckResult,
} from "./types.js";
import { categorizeModel } from "./model-discovery.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:1234";

export interface LMSClientOptions {
  baseURL?: string;
  apiKey?: string;
  /** Timeout for quick operations (health, listing). Default 30s. */
  timeout?: number;
  /** Timeout for load/unload/download operations. Default 10 min — big
   *  models can take several minutes to mmap and warm up. */
  loadTimeout?: number;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_LOAD_TIMEOUT = 600_000;

function getHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

function buildURL(baseURL: string, path: string): string {
  const normalized = baseURL.replace(/\/+$/, "");
  return `${normalized}${path}`;
}

export class LMSClient {
  private baseURL: string;
  private apiKey?: string;
  private timeout: number;
  private loadTimeout: number;

  constructor(options: LMSClientOptions = {}) {
    this.baseURL = options.baseURL || DEFAULT_BASE_URL;
    this.apiKey = options.apiKey;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.loadTimeout = options.loadTimeout ?? DEFAULT_LOAD_TIMEOUT;
  }

  get headers(): Record<string, string> {
    return getHeaders(this.apiKey);
  }

  get baseURLWithTrailingSlash(): string {
    return this.baseURL.replace(/\/+$/, "");
  }

  // ─── Health check ───

  async checkHealth(): Promise<HealthCheckResult> {
    const start = Date.now();
    const attempts: Array<{ path: string; version: HealthCheckResult["apiVersion"] }> = [
      { path: "/api/v1/models", version: "v1" },
      { path: "/api/v0/models", version: "v0" },
      { path: "/v1/models", version: "openai" },
    ];
    const failures: string[] = [];

    for (const { path, version } of attempts) {
      const url = buildURL(this.baseURL, path);
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: this.headers,
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          return {
            healthy: true,
            baseURL: this.baseURL,
            apiVersion: version,
            latency: Date.now() - start,
          };
        }
        // Pull a short body excerpt for diagnostic context — most LMS error
        // bodies are tiny JSON ({"error":{"message":"..."}}).
        const body = (await response.text().catch(() => "")).slice(0, 200);
        failures.push(`${url} → HTTP ${response.status}${body ? `: ${body}` : ""}`);
      } catch (err) {
        const e = err as Error;
        const detail = e.name === "TimeoutError"
          ? "timeout after 5s"
          : `${e.name}: ${e.message}`;
        failures.push(`${url} → ${detail}`);
      }
    }

    console.warn(`[opencode-lms] health check failed at ${this.baseURL}:`);
    for (const f of failures) console.warn(`[opencode-lms]   ${f}`);

    return {
      healthy: false,
      baseURL: this.baseURL,
      apiVersion: "v1",
      latency: Date.now() - start,
    };
  }

  // ─── Model listing ───

  async getModels(): Promise<LMSModelInfo[]> {
    // Try v1 first
    try {
      const url = buildURL(this.baseURL, "/api/v1/models");
      const response = await fetch(url, {
        method: "GET",
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeout),
      });
      if (response.ok) {
        const data = (await response.json()) as LMSModelsResponse;
        return data.models || [];
      }
    } catch {
      // Fall through to v0
    }

    // Try v0
    try {
      const url = buildURL(this.baseURL, "/api/v0/models");
      const response = await fetch(url, {
        method: "GET",
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeout),
      });
      if (response.ok) {
        const data = (await response.json()) as LMSV0ModelsResponse;
        // Convert v0 models to v1 format
        return (data.data || []).map((m) => ({
          type: (m.type === "embeddings" ? "embedding" : "llm") as "llm" | "embedding",
          publisher: m.publisher,
          key: m.id,
          display_name: m.id,
          architecture: m.arch,
          quantization: {
            name: m.quantization,
            bits_per_weight: null,
          },
          size_bytes: 0,
          params_string: null,
          loaded_instances: m.state === "loaded" ? [{ id: m.id, config: { context_length: m.max_context_length } }] : [],
          max_context_length: m.max_context_length,
          format: m.compatibility_type,
          capabilities: m.type === "vlm" ? { vision: true, trained_for_tool_use: false } : { vision: false, trained_for_tool_use: false },
          description: null,
        }));
      }
    } catch {
      // Fall through to OpenAI compat
    }

    // Try OpenAI-compatible /v1/models (minimal info)
    try {
      const url = buildURL(this.baseURL, "/v1/models");
      const response = await fetch(url, {
        method: "GET",
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeout),
      });
      if (response.ok) {
        const data = (await response.json()) as LMSOpenAIModelsResponse;
        return (data.data || []).map((m) => ({
          type: categorizeModel(m.id) === "embedding" ? ("embedding" as const) : ("llm" as const),
          publisher: m.owned_by || "unknown",
          key: m.id,
          display_name: m.id,
          architecture: null,
          quantization: null,
          size_bytes: 0,
          params_string: null,
          loaded_instances: [],
          max_context_length: 4096,
          format: null,
          capabilities: { vision: false, trained_for_tool_use: false },
          description: null,
        }));
      }
    } catch {
      // No models available
    }

    return [];
  }

  // ─── Model lifecycle ───

  async loadModel(
    modelKey: string,
    options: {
      context_length?: number;
      echo_load_config?: boolean;
    } = {},
  ): Promise<LMSModelLoadResponse> {
    const url = buildURL(this.baseURL, "/api/v1/models/load");
    const body: Record<string, unknown> = { model: modelKey };
    if (options.context_length) body.context_length = options.context_length;
    if (options.echo_load_config !== undefined) body.echo_load_config = options.echo_load_config;

    const response = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.loadTimeout),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to load model: ${response.status} ${text}`);
    }

    return response.json() as Promise<LMSModelLoadResponse>;
  }

  async unloadModel(instanceId: string): Promise<LMSModelUnloadResponse> {
    const url = buildURL(this.baseURL, "/api/v1/models/unload");
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ instance_id: instanceId }),
      signal: AbortSignal.timeout(this.loadTimeout),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to unload model: ${response.status} ${text}`);
    }

    return response.json() as Promise<LMSModelUnloadResponse>;
  }

  async downloadModel(modelKey: string): Promise<{ job_id: string }> {
    const url = buildURL(this.baseURL, "/api/v1/models/download");
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ model: modelKey }),
      signal: AbortSignal.timeout(this.loadTimeout),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to start download: ${response.status} ${text}`);
    }

    const data = await response.json();
    return { job_id: data.job_id || data.id || "" };
  }

  async getDownloadStatus(jobId: string): Promise<LMSDownloadStatusResponse> {
    const url = buildURL(this.baseURL, `/api/v1/models/download/status/${jobId}`);
    const response = await fetch(url, {
      method: "GET",
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to get download status: ${response.status} ${text}`);
    }

    return response.json() as Promise<LMSDownloadStatusResponse>;
  }

  // ─── Streaming chat via /api/v1/chat ───
  //
  // LMS expects `input` as an array of typed parts: [{type:"text",content:"..."}].
  // There is no `max_tokens` field — callers who want to stop inference early
  // should pass a signal and abort it on the event they care about.

  async streamChat(
    model: string,
    input: Array<{ type: "text"; content: string } | { type: "image"; content: string }>,
    options: {
      context_length?: number;
      temperature?: number;
      reasoning?: Record<string, unknown>;
      signal?: AbortSignal;
    } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const url = buildURL(this.baseURL, "/api/v1/chat");
    const body: Record<string, unknown> = {
      model,
      input,
      stream: true,
    };
    if (options.context_length !== undefined) body.context_length = options.context_length;
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.reasoning !== undefined) body.reasoning = options.reasoning;

    const response = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
      signal: options.signal ?? AbortSignal.timeout(this.loadTimeout),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Streaming chat failed: ${response.status} ${text}`);
    }

    if (!response.body) {
      throw new Error("Streaming chat: no response body");
    }

    return response.body;
  }
}
