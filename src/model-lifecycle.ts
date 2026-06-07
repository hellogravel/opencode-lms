import type { LMSClient } from "./api-client.js";
import type { LMSModelInfo, LMSStreamEvent, LMSDownloadStatusResponse } from "./types.js";
import { parseSSEStream } from "./streaming.js";

const DEFAULT_TTL = 15000; // 15 seconds
const MAX_CACHE_SIZE = 50;

interface CacheEntry {
  models: LMSModelInfo[];
  timestamp: number;
  ttl: number;
}

/**
 * Cache for model status to reduce API calls.
 */
export class ModelStatusCache {
  private cache = new Map<string, CacheEntry>();

  getModels(
    baseURL: string,
    fetchFn: () => Promise<LMSModelInfo[]>,
  ): Promise<LMSModelInfo[]> {
    const now = Date.now();
    const cached = this.cache.get(baseURL);

    if (cached && now - cached.timestamp < cached.ttl) {
      return Promise.resolve([...cached.models]);
    }

    return fetchFn().then((models) => {
      this.cache.set(baseURL, {
        models: [...models],
        timestamp: now,
        ttl: DEFAULT_TTL,
      });

      // Prevent memory leaks
      if (this.cache.size > MAX_CACHE_SIZE) {
        this.cleanup();
      }

      return [...models];
    });
  }

  invalidate(baseURL: string): void {
    this.cache.delete(baseURL);
  }

  private cleanup(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [baseURL, data] of this.cache.entries()) {
      if (now - data.timestamp > data.ttl * 5) {
        toDelete.push(baseURL);
      }
    }

    toDelete.forEach((baseURL) => this.cache.delete(baseURL));
  }
}

/**
 * Model lifecycle management.
 */
export class ModelLifecycle {
  private client: LMSClient;
  private cache: ModelStatusCache;

  constructor(client: LMSClient) {
    this.client = client;
    this.cache = new ModelStatusCache();
  }

  /**
   * Get loaded models, using cache when available.
   */
  /**
   * Get loaded model IDs, using cache when available.
   */
  async getLoadedModels(baseURL: string): Promise<string[]> {
    const models = await this.cache.getModels(baseURL, () =>
      this.client.getModels(),
    );
    return models
      .filter((m) => m.loaded_instances.length > 0)
      .flatMap((m) => m.loaded_instances.map((inst) => inst.id));
  }

  /**
   * Get all models, using cache when available.
   */
  getAllModels(baseURL: string): Promise<LMSModelInfo[]> {
    return this.cache.getModels(baseURL, () => this.client.getModels());
  }

  /**
   * Ensure a model is loaded. Streams load progress via /api/v1/chat so onEvent
   * can observe model_load.start/progress/end. The stream is aborted as soon as
   * model_load.end fires (or on error) to avoid running inference. Falls back to
   * /api/v1/models/load if the streaming endpoint can't be opened.
   */
  async ensureModelLoaded(
    baseURL: string,
    modelInfo: LMSModelInfo,
    onEvent?: (event: LMSStreamEvent) => void,
  ): Promise<void> {
    // Pull the freshest view of this specific model from the cache. Don't
    // compare modelInfo.key against the flat list of loaded instance IDs:
    // those are LMS instance identifiers, not model keys, and they only
    // happen to coincide for some servers.
    const current = (await this.getAllModels(baseURL)).find(
      (m) => m.key === modelInfo.key,
    );
    if (current && current.loaded_instances.length > 0) return;

    // Embedding models can't be loaded via /api/v1/chat — that endpoint is
    // LLM-only and returns model_not_found. Use the synchronous load endpoint.
    if (modelInfo.type === "embedding") {
      await this.client.loadModel(modelInfo.key, {
        context_length: modelInfo.max_context_length,
        echo_load_config: true,
      });
      this.cache.invalidate(this.client.baseURLWithTrailingSlash);
      return;
    }

    const controller = new AbortController();
    let streamLoaded = false;
    try {
      const stream = await this.client.streamChat(
        modelInfo.key,
        [{ type: "text", content: "ping" }],
        {
          context_length: modelInfo.max_context_length,
          signal: controller.signal,
        },
      );

      for await (const event of parseSSEStream(stream)) {
        if (onEvent) onEvent(event);
        if (event.type === "model_load.end") {
          streamLoaded = true;
          controller.abort();
          break;
        }
        if (event.type === "error") {
          controller.abort();
          break;
        }
        // If the model was already loaded server-side, we'll never see a
        // model_load.end — bail when the message phase begins.
        if (event.type === "message.start" || event.type === "chat.end") {
          streamLoaded = true;
          controller.abort();
          break;
        }
      }
    } catch (err) {
      // Distinguish abort (expected) from a real failure to open the stream.
      const name = (err as Error).name;
      if (name !== "AbortError" && !streamLoaded) {
        // Fall back to the non-streaming load endpoint.
        await this.client.loadModel(modelInfo.key, {
          context_length: modelInfo.max_context_length,
          echo_load_config: true,
        });
        streamLoaded = true;
      }
    }

    this.cache.invalidate(this.client.baseURLWithTrailingSlash);
  }

  /**
   * Unload a specific model instance.
   */
  async unloadModel(instanceId: string): Promise<void> {
    await this.client.unloadModel(instanceId);
    // Invalidate cache
    this.cache.invalidate(this.client.baseURLWithTrailingSlash);
  }

  /**
   * Start downloading a model. Returns a job_id for tracking.
   */
  async downloadModel(modelKey: string): Promise<{ job_id: string }> {
    return this.client.downloadModel(modelKey);
  }

  /**
   * Start a download and poll the status endpoint until it completes, fails,
   * or the deadline passes. The download API isn't SSE — we poll because
   * that's all LM Studio exposes.
   *
   * @param modelKey  the model id LM Studio knows it as
   * @param onProgress  called with each status snapshot (use to log progress)
   * @param options.pollIntervalMs  default 2000 — how often to hit the status endpoint
   * @param options.timeoutMs  default 1800000 (30 min) — hard upper bound
   */
  async downloadModelAndWait(
    modelKey: string,
    onProgress?: (status: LMSDownloadStatusResponse) => void,
    options: { pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<void> {
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const timeoutMs = options.timeoutMs ?? 30 * 60 * 1_000;

    const { job_id } = await this.client.downloadModel(modelKey);
    if (!job_id) {
      throw new Error("Download endpoint returned no job_id");
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.client.getDownloadStatus(job_id);
      if (onProgress) onProgress(status);

      if (status.status === "completed") {
        this.cache.invalidate(this.client.baseURLWithTrailingSlash);
        return;
      }
      if (status.status === "failed") {
        throw new Error(`Download failed: ${status.error ?? "(no detail)"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Download of ${modelKey} timed out after ${timeoutMs}ms`);
  }

  /**
   * Check if a specific model is currently loaded.
   */
  async isModelLoaded(baseURL: string, modelKey: string): Promise<boolean> {
    const loadedIds = await this.getLoadedModels(baseURL);
    return loadedIds.includes(modelKey);
  }

  /**
   * Get all available models on disk (downloaded).
   */
  async getAvailableModels(baseURL: string): Promise<LMSModelInfo[]> {
    return this.getAllModels(baseURL);
  }
}
