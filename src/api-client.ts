import type {
  LMSModelsResponse,
  LMSModelInfo,
  LMSModelLoadResponse,
  LMSModelUnloadResponse,
} from "./types.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:1234";

export interface LMSClientOptions {
  baseURL?: string;
  apiKey?: string;
  /** Timeout for quick operations (listing). Default 30s. */
  timeout?: number;
  /** Timeout for load/unload operations. Default 10 min — big models can
   *  take several minutes to mmap and warm up. */
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

/**
 * Client for LM Studio's native REST API (`/api/v1/*`). Discovery for the
 * model picker is OpenCode's built-in provider's job; this client only reads
 * the model list for what the built-in drops (reasoning options, loaded
 * instances) and drives loads.
 */
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

  // ─── Model listing ───

  async getModels(): Promise<LMSModelInfo[]> {
    const url = buildURL(this.baseURL, "/api/v1/models");
    const response = await fetch(url, {
      method: "GET",
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Failed to list models: ${response.status} ${text.slice(0, 200)}`);
    }
    const data = (await response.json()) as LMSModelsResponse;
    return data.models || [];
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
    // NB: LM Studio 0.4.19's /api/v1/models/load rejects a `ttl` key with HTTP
    // 400 (Unrecognized key). TTL rides the OpenAI-compat completion instead
    // (the model body overlay in model-policy.ts), not the load body.
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

  // ─── Streaming chat via /api/v1/chat ───
  //
  // Used only to load a model while observing model_load.* progress events.
  // LMS expects `input` as an array of typed parts: [{type:"text",content:"..."}].
  // There is no `max_tokens` field — callers who want to stop inference early
  // should pass a signal and abort it on the event they care about.

  async streamChat(
    model: string,
    input: Array<{ type: "text"; content: string }>,
    options: {
      context_length?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const url = buildURL(this.baseURL, "/api/v1/chat");
    // NB: this native /api/v1/chat endpoint also rejects a `ttl` key (HTTP 400,
    // Unrecognized key on 0.4.19).
    const body: Record<string, unknown> = {
      model,
      input,
      stream: true,
    };
    if (options.context_length !== undefined) body.context_length = options.context_length;

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
