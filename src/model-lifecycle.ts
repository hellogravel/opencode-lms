import type { LMSClient } from "./api-client.js";
import type { LMSModelInfo, LMSStreamEvent, LMSDownloadStatusResponse } from "./types.js";
import { parseSSEStream } from "./streaming.js";

const DEFAULT_TTL = 15000; // 15 seconds
const MAX_CACHE_SIZE = 50;

// Default cap for the context window a model is loaded with. LM Studio would
// otherwise load at each model's max_context_length; capping keeps VRAM in
// check. 32768, not smaller: an OpenCode agent session opens at well over 8k
// tokens (system prompt + tool schemas + rules), so an 8k window rejects the
// very first request — fatal for headless sessions, which have no retry. A
// model whose max is below this loads at its max (see resolveContextLength).
const DEFAULT_CONTEXT_LENGTH = 32768;

/**
 * Load-time knobs threaded from provider config into the lifecycle — the single
 * seam that carries all VRAM policy to the model-load sites. Kept distinct from
 * the UI-facing `limit.context`, which is never sent to LMS.
 *
 * NB: idle TTL is NOT threaded here. LM Studio's REST load/chat endpoints reject
 * a `ttl` key; TTL is applied per-completion on the OpenAI-compat path (see
 * applyCompletionTtl in ttl.ts), which is where OpenCode's inference goes.
 */
export interface ModelLoadPolicy {
  /** Global default cap for the load-time context window. Default 32768. */
  contextLength?: number;
  /** Per-model load-time overrides, keyed by model key. */
  perModel?: Record<string, { contextLength?: number }>;
}

/**
 * Resolve the load-time context window for a model: a per-model override
 * wins, else the global cap (default 32768), always clamped to the model's
 * own max_context_length. This is the VRAM knob; model discovery also uses it
 * so the advertised `limit.context` matches what requests will actually get.
 */
export function resolveContextLength(
  policy: ModelLoadPolicy,
  modelInfo: LMSModelInfo,
): number {
  const desired =
    policy.perModel?.[modelInfo.key]?.contextLength ??
    policy.contextLength ??
    DEFAULT_CONTEXT_LENGTH;
  return Math.min(desired, modelInfo.max_context_length);
}

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
  private policy: ModelLoadPolicy;
  // Single-flight guard for ensureModelLoaded, keyed by model key. Concurrent
  // sessions (e.g. a kanban board dispatching several headless agents at once)
  // all hit chat.params for the same cold model inside the status cache's TTL,
  // so each would pass the loaded-check and load its own instance — and the
  // undersized-reload path would interleave unload/load. Joiners await the
  // first caller's load instead.
  private inflightLoads = new Map<string, Promise<void>>();

  constructor(client: LMSClient, policy: ModelLoadPolicy = {}) {
    this.client = client;
    this.cache = new ModelStatusCache();
    this.policy = policy;
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
   *
   * Single-flight per model key: concurrent callers join the in-progress load
   * (only the first caller's onEvent sees the load events).
   */
  ensureModelLoaded(
    baseURL: string,
    modelInfo: LMSModelInfo,
    onEvent?: (event: LMSStreamEvent) => void,
  ): Promise<void> {
    const existing = this.inflightLoads.get(modelInfo.key);
    if (existing) return existing;
    const load = this.ensureModelLoadedNow(baseURL, modelInfo, onEvent).finally(() => {
      this.inflightLoads.delete(modelInfo.key);
    });
    this.inflightLoads.set(modelInfo.key, load);
    return load;
  }

  private async ensureModelLoadedNow(
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

    // Resolve the load-time context window once (VRAM knob; capped at the
    // model's own max), then use it at every load site below.
    const ctx = resolveContextLength(this.policy, modelInfo);

    if (current && current.loaded_instances.length > 0) {
      // Reuse any resident instance whose window already covers the policy.
      // One below it (e.g. loaded under an older, smaller default) would
      // reject an agent-sized prompt outright — fatal for headless sessions,
      // which have no retry — so evict undersized instances and fall through
      // to a fresh load at the resolved window.
      if (
        current.loaded_instances.some(
          (inst) => inst.config.context_length >= ctx,
        )
      ) {
        return;
      }
      for (const inst of current.loaded_instances) {
        try {
          await this.client.unloadModel(inst.id);
        } catch {
          // Best-effort: even if the unload fails, the fresh load below still
          // produces an instance with an adequate window.
        }
      }
    }

    // Embedding models can't be loaded via /api/v1/chat — that endpoint is
    // LLM-only and returns model_not_found. Use the synchronous load endpoint.
    if (modelInfo.type === "embedding") {
      await this.client.loadModel(modelInfo.key, {
        context_length: ctx,
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
          context_length: ctx,
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
          context_length: ctx,
          echo_load_config: true,
        });
        streamLoaded = true;
      }
    }

    this.cache.invalidate(this.client.baseURLWithTrailingSlash);
  }

  /**
   * Unload a specific model instance. Intentionally un-wired: idle eviction is
   * delegated to the per-completion `ttl` sent on the OpenAI-compat path (see
   * applyCompletionTtl in ttl.ts / LMSProviderConfig.ttl), so the plugin never
   * drives an unload loop. Kept as an explicit method for callers that want to
   * force-evict.
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
