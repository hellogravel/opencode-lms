import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ModelLifecycle, ModelStatusCache } from "../src/model-lifecycle.js";
import type { LMSClient } from "../src/api-client.js";
import type { LMSDownloadStatusResponse, LMSModelInfo } from "../src/types.js";

const fakeModel = (key: string, overrides: Partial<LMSModelInfo> = {}): LMSModelInfo => ({
  type: "llm",
  publisher: "test",
  key,
  display_name: key,
  architecture: null,
  quantization: null,
  size_bytes: 0,
  params_string: null,
  loaded_instances: [],
  max_context_length: 4096,
  format: null,
  capabilities: { vision: false, trained_for_tool_use: false },
  description: null,
  ...overrides,
});

// SSE helper — encode a sequence of {event, data} pairs as a single stream.
function sseStreamFromEvents(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const text = events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  const encoder = new TextEncoder();
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

// Minimal stand-in for LMSClient that records calls and lets tests script outcomes.
function makeStubClient(overrides: Partial<Record<keyof LMSClient, unknown>> = {}): LMSClient {
  const base = {
    baseURLWithTrailingSlash: "http://stub",
    getModels: vi.fn(),
    loadModel: vi.fn(),
    unloadModel: vi.fn(),
    streamChat: vi.fn(),
    downloadModel: vi.fn(),
    getDownloadStatus: vi.fn(),
  };
  return Object.assign(base, overrides) as unknown as LMSClient;
}

describe("ModelStatusCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a cached result within TTL without re-invoking the fetch", async () => {
    const cache = new ModelStatusCache();
    const fetch = vi.fn().mockResolvedValue([fakeModel("a")]);

    await cache.getModels("http://x", fetch);
    await cache.getModels("http://x", fetch);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    const cache = new ModelStatusCache();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce([fakeModel("first")])
      .mockResolvedValueOnce([fakeModel("second")]);

    const r1 = await cache.getModels("http://x", fetch);
    expect(r1[0].key).toBe("first");

    // TTL is 15s; advance just past it
    vi.advanceTimersByTime(15_001);

    const r2 = await cache.getModels("http://x", fetch);
    expect(r2[0].key).toBe("second");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keys caches per baseURL — different URLs don't share results", async () => {
    const cache = new ModelStatusCache();
    const fetchA = vi.fn().mockResolvedValue([fakeModel("from-a")]);
    const fetchB = vi.fn().mockResolvedValue([fakeModel("from-b")]);

    const a = await cache.getModels("http://host-a", fetchA);
    const b = await cache.getModels("http://host-b", fetchB);

    expect(a[0].key).toBe("from-a");
    expect(b[0].key).toBe("from-b");
    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
  });

  it("invalidate() forces the next call to refetch", async () => {
    const cache = new ModelStatusCache();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce([fakeModel("v1")])
      .mockResolvedValueOnce([fakeModel("v2")]);

    await cache.getModels("http://x", fetch);
    cache.invalidate("http://x");
    const result = await cache.getModels("http://x", fetch);

    expect(result[0].key).toBe("v2");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns defensive copies — mutating the result doesn't poison the cache", async () => {
    const cache = new ModelStatusCache();
    const fetch = vi.fn().mockResolvedValue([fakeModel("a")]);

    const r1 = await cache.getModels("http://x", fetch);
    r1.pop(); // mutate
    const r2 = await cache.getModels("http://x", fetch);

    expect(r2).toHaveLength(1);
  });
});

describe("ModelLifecycle.downloadModelAndWait", () => {
  it("resolves when status transitions to 'completed', invalidates the cache", async () => {
    const statuses: LMSDownloadStatusResponse[] = [
      { job_id: "j1", status: "pending" },
      { job_id: "j1", status: "downloading", progress: 0.5 },
      { job_id: "j1", status: "completed", progress: 1 },
    ];
    const client = makeStubClient({
      downloadModel: vi.fn().mockResolvedValue({ job_id: "j1" }),
      getDownloadStatus: vi.fn().mockImplementation(async () => statuses.shift()!),
    });
    const lifecycle = new ModelLifecycle(client);
    const progress: LMSDownloadStatusResponse[] = [];

    await lifecycle.downloadModelAndWait("test/model", (s) => progress.push(s), {
      pollIntervalMs: 0, // no real delay between polls
    });

    expect(progress.map((p) => p.status)).toEqual(["pending", "downloading", "completed"]);
    expect(client.downloadModel).toHaveBeenCalledWith("test/model");
  });

  it("rejects when status is 'failed', surfacing the error detail", async () => {
    const client = makeStubClient({
      downloadModel: vi.fn().mockResolvedValue({ job_id: "j1" }),
      getDownloadStatus: vi.fn().mockResolvedValue({
        job_id: "j1",
        status: "failed",
        error: "out of disk space",
      }),
    });
    const lifecycle = new ModelLifecycle(client);

    await expect(
      lifecycle.downloadModelAndWait("test/model", undefined, { pollIntervalMs: 0 }),
    ).rejects.toThrow(/out of disk space/);
  });

  it("rejects when the server returns no job_id", async () => {
    const client = makeStubClient({
      downloadModel: vi.fn().mockResolvedValue({ job_id: "" }),
    });
    const lifecycle = new ModelLifecycle(client);

    await expect(
      lifecycle.downloadModelAndWait("test/model"),
    ).rejects.toThrow(/no job_id/);
  });

  it("times out when the download never completes", async () => {
    const client = makeStubClient({
      downloadModel: vi.fn().mockResolvedValue({ job_id: "j1" }),
      // Stuck in "downloading" forever
      getDownloadStatus: vi.fn().mockResolvedValue({
        job_id: "j1",
        status: "downloading",
        progress: 0.1,
      }),
    });
    const lifecycle = new ModelLifecycle(client);

    // Tight loop so this returns fast; timeoutMs is checked against Date.now().
    await expect(
      lifecycle.downloadModelAndWait("test/model", undefined, {
        pollIntervalMs: 0,
        timeoutMs: 1, // expires basically immediately
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("ModelLifecycle.ensureModelLoaded", () => {
  it("short-circuits when the model is already loaded", async () => {
    const loaded = fakeModel("already-loaded", {
      loaded_instances: [{ id: "inst-1", config: { context_length: 4096 } }],
    });
    const client = makeStubClient({
      getModels: vi.fn().mockResolvedValue([loaded]),
      streamChat: vi.fn(),
      loadModel: vi.fn(),
    });
    const lifecycle = new ModelLifecycle(client);

    await lifecycle.ensureModelLoaded("http://stub", loaded);

    expect(client.streamChat).not.toHaveBeenCalled();
    expect(client.loadModel).not.toHaveBeenCalled();
  });

  it("reloads a resident instance whose window is below the resolved policy", async () => {
    // Loaded at 8192 (e.g. under the old default) but the policy resolves to
    // 32768 — the undersized instance must be evicted and reloaded, or the
    // first agent-sized prompt dies server-side.
    const stale = fakeModel("stale", {
      max_context_length: 131072,
      loaded_instances: [{ id: "inst-small", config: { context_length: 8192 } }],
    });
    const client = makeStubClient({
      getModels: vi.fn().mockResolvedValue([stale]),
      unloadModel: vi.fn().mockResolvedValue({ instance_id: "inst-small" }),
      streamChat: vi.fn().mockResolvedValue(
        sseStreamFromEvents([
          { type: "model_load.end", model_instance_id: "inst-big", load_time_seconds: 0.5 },
        ]),
      ),
      loadModel: vi.fn(),
    });
    const lifecycle = new ModelLifecycle(client, { contextLength: 32768 });

    await lifecycle.ensureModelLoaded("http://stub", stale);

    expect(client.unloadModel).toHaveBeenCalledWith("inst-small");
    const call = (client.streamChat as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((call[2] as { context_length?: number }).context_length).toBe(32768);
  });

  it("keeps a resident instance whose window meets or exceeds the policy", async () => {
    const roomy = fakeModel("roomy", {
      max_context_length: 131072,
      loaded_instances: [{ id: "inst-big", config: { context_length: 65536 } }],
    });
    const client = makeStubClient({
      getModels: vi.fn().mockResolvedValue([roomy]),
      unloadModel: vi.fn(),
      streamChat: vi.fn(),
      loadModel: vi.fn(),
    });
    const lifecycle = new ModelLifecycle(client, { contextLength: 32768 });

    await lifecycle.ensureModelLoaded("http://stub", roomy);

    expect(client.unloadModel).not.toHaveBeenCalled();
    expect(client.streamChat).not.toHaveBeenCalled();
    expect(client.loadModel).not.toHaveBeenCalled();
  });

  it("uses the synchronous load endpoint for embedding models, skipping /api/v1/chat", async () => {
    const embed = fakeModel("embed-1", { type: "embedding", max_context_length: 512 });
    const client = makeStubClient({
      getModels: vi.fn().mockResolvedValue([embed]),
      loadModel: vi.fn().mockResolvedValue({ instance_id: "inst-x" }),
      streamChat: vi.fn(),
    });
    const lifecycle = new ModelLifecycle(client);

    await lifecycle.ensureModelLoaded("http://stub", embed);

    expect(client.streamChat).not.toHaveBeenCalled();
    expect(client.loadModel).toHaveBeenCalledWith("embed-1", expect.objectContaining({
      context_length: 512,
    }));
  });

  it("streams events from /api/v1/chat and forwards them to onEvent", async () => {
    const llm = fakeModel("llm-1");
    const client = makeStubClient({
      getModels: vi.fn().mockResolvedValue([llm]),
      streamChat: vi.fn().mockResolvedValue(
        sseStreamFromEvents([
          { type: "model_load.start", model_instance_id: "inst-a" },
          { type: "model_load.progress", model_instance_id: "inst-a", progress: 0.5 },
          { type: "model_load.end", model_instance_id: "inst-a", load_time_seconds: 1.2 },
        ]),
      ),
      loadModel: vi.fn(),
    });
    const lifecycle = new ModelLifecycle(client);
    const events: string[] = [];

    await lifecycle.ensureModelLoaded("http://stub", llm, (e) => events.push(e.type));

    expect(events).toContain("model_load.start");
    expect(events).toContain("model_load.progress");
    expect(events).toContain("model_load.end");
    expect(client.loadModel).not.toHaveBeenCalled();
  });

  it("falls back to synchronous load when streamChat throws to open the connection", async () => {
    const llm = fakeModel("llm-1");
    const client = makeStubClient({
      getModels: vi.fn().mockResolvedValue([llm]),
      streamChat: vi.fn().mockRejectedValue(new Error("connection refused")),
      loadModel: vi.fn().mockResolvedValue({ instance_id: "inst-fallback" }),
    });
    const lifecycle = new ModelLifecycle(client);

    await lifecycle.ensureModelLoaded("http://stub", llm);

    expect(client.streamChat).toHaveBeenCalled();
    expect(client.loadModel).toHaveBeenCalledWith("llm-1", expect.objectContaining({
      context_length: 4096,
    }));
  });

  it("passes an AbortSignal to streamChat so it can be cancelled", async () => {
    const llm = fakeModel("llm-1");
    const client = makeStubClient({
      getModels: vi.fn().mockResolvedValue([llm]),
      streamChat: vi.fn().mockResolvedValue(
        sseStreamFromEvents([
          { type: "model_load.end", model_instance_id: "inst-a", load_time_seconds: 0.5 },
        ]),
      ),
      loadModel: vi.fn(),
    });
    const lifecycle = new ModelLifecycle(client);

    await lifecycle.ensureModelLoaded("http://stub", llm);

    const call = (client.streamChat as ReturnType<typeof vi.fn>).mock.calls[0];
    const opts = call[2] as { signal?: AbortSignal };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    // After model_load.end the lifecycle calls controller.abort().
    expect(opts.signal!.aborted).toBe(true);
  });
});

describe("ModelLifecycle context-length policy", () => {
  // Stream the load to completion so ensureModelLoaded exercises the streamChat
  // path (the primary load site). Returns the context_length streamChat saw.
  async function loadAndCaptureStreamCtx(
    model: LMSModelInfo,
    policy?: ConstructorParameters<typeof ModelLifecycle>[1],
  ): Promise<number | undefined> {
    const client = makeStubClient({
      getModels: vi.fn().mockResolvedValue([model]),
      streamChat: vi.fn().mockResolvedValue(
        sseStreamFromEvents([
          { type: "model_load.end", model_instance_id: "inst-a", load_time_seconds: 0.3 },
        ]),
      ),
      loadModel: vi.fn(),
    });
    const lifecycle = new ModelLifecycle(client, policy);
    await lifecycle.ensureModelLoaded("http://stub", model);
    const call = (client.streamChat as ReturnType<typeof vi.fn>).mock.calls[0];
    return (call[2] as { context_length?: number }).context_length;
  }

  it("caps the load context at the 32768 default on a large-window model", async () => {
    const big = fakeModel("big", { max_context_length: 131072 });
    expect(await loadAndCaptureStreamCtx(big)).toBe(32768);
  });

  it("a per-model override raises the load context toward max", async () => {
    const big = fakeModel("big", { max_context_length: 131072 });
    const ctx = await loadAndCaptureStreamCtx(big, {
      perModel: { big: { contextLength: 32768 } },
    });
    expect(ctx).toBe(32768);
  });

  it("a global contextLength override applies to all models", async () => {
    const big = fakeModel("big", { max_context_length: 131072 });
    expect(await loadAndCaptureStreamCtx(big, { contextLength: 16384 })).toBe(16384);
  });

  it("never exceeds the model's max_context_length, even when asked to", async () => {
    const small = fakeModel("small", { max_context_length: 4096 });
    // Global cap above the model max — must clamp down to max.
    expect(await loadAndCaptureStreamCtx(small, { contextLength: 100000 })).toBe(4096);
    // Per-model override above the model max — must also clamp.
    const clamped = await loadAndCaptureStreamCtx(small, {
      perModel: { small: { contextLength: 100000 } },
    });
    expect(clamped).toBe(4096);
  });

  it("a model whose max is below the 32768 default loads at its max", async () => {
    const small = fakeModel("small", { max_context_length: 4096 });
    expect(await loadAndCaptureStreamCtx(small)).toBe(4096);
  });

  it("applies the resolved context to the embedding synchronous-load path too", async () => {
    const embed = fakeModel("embed", { type: "embedding", max_context_length: 131072 });
    const client = makeStubClient({
      getModels: vi.fn().mockResolvedValue([embed]),
      loadModel: vi.fn().mockResolvedValue({ instance_id: "inst-x" }),
      streamChat: vi.fn(),
    });
    const lifecycle = new ModelLifecycle(client);
    await lifecycle.ensureModelLoaded("http://stub", embed);
    expect(client.loadModel).toHaveBeenCalledWith("embed", expect.objectContaining({
      context_length: 32768,
    }));
  });

  it("applies the resolved context to the synchronous-load fallback", async () => {
    const big = fakeModel("big", { max_context_length: 131072 });
    const client = makeStubClient({
      getModels: vi.fn().mockResolvedValue([big]),
      streamChat: vi.fn().mockRejectedValue(new Error("connection refused")),
      loadModel: vi.fn().mockResolvedValue({ instance_id: "inst-fallback" }),
    });
    const lifecycle = new ModelLifecycle(client, { contextLength: 16384 });
    await lifecycle.ensureModelLoaded("http://stub", big);
    expect(client.loadModel).toHaveBeenCalledWith("big", expect.objectContaining({
      context_length: 16384,
    }));
  });
});

