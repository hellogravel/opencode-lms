import type { Plugin } from "@opencode/plugin";
import { LMSClient } from "./api-client.js";
import { ModelLifecycle, resolveContextLength } from "./model-lifecycle.js";
import { PROVIDER_ID, applyModelPolicy, buildCatalog, type Catalog } from "./model-policy.js";
import { resolveOptions, serverRoot } from "./options.js";
import { demoteReasoningEffort } from "./reasoning-effort.js";
import type { LMSModelInfo } from "./types.js";
import {
  isModelLoadStart,
  isModelLoadProgress,
  isModelLoadEnd,
  isError,
} from "./streaming.js";
import { log } from "./log.js";

/**
 * OpenCode 2 ships a built-in LM Studio provider that discovers models,
 * filters embeddings, and refreshes on its own. This plugin layers on top of
 * it — it registers no provider — and adds what the built-in doesn't do:
 *
 *   1. auto-load a cold model at a capped context window, and reload a
 *      resident instance that was loaded too small (`model.request` hook);
 *   2. idle `ttl` eviction (model transform: request body overlay);
 *   3. tool calling always on (model transform);
 *   4. reasoning: effort variants for graduated models, none for on/off-only
 *      ones (model transform), and `"max"` demoted to `"xhigh"` on the wire
 *      (`http.request` hook).
 */
async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  const options = resolveOptions(ctx.options);
  log("[opencode-lms] LM Studio plugin initialized");

  // Where LM Studio lives. Not a plugin option: the built-in provider owns it
  // (`providers.lmstudio.settings`), and the model transform captures it from
  // the provider definition on every registry rebuild.
  const source: { baseURL?: string; apiKey?: string } = {};
  // Per-model facts the built-in drops (reasoning options, loaded instances).
  // Read by the synchronous model transform; refreshed asynchronously.
  let catalog: Catalog = new Map();
  let catalogHash = "[]";
  let refreshInFlight: Promise<void> | null = null;
  let current: { root: string; apiKey?: string; lifecycle: ModelLifecycle } | null = null;

  /** One lifecycle per server, so its status cache and load single-flight are shared. */
  function lifecycleFor(root: string): ModelLifecycle {
    if (current && current.root === root && current.apiKey === source.apiKey) return current.lifecycle;
    const client = new LMSClient({
      baseURL: root,
      apiKey: source.apiKey,
      loadTimeout: options.loadTimeout,
    });
    current = { root, apiKey: source.apiKey, lifecycle: new ModelLifecycle(client, options.loadPolicy) };
    return current.lifecycle;
  }

  /**
   * Re-read LM Studio's model list and, if anything the transform reads
   * changed, have OpenCode replay it. A failed read keeps the last catalog.
   * Single-flight; the lifecycle's status cache absorbs bursts.
   */
  function refreshCatalog(): Promise<void> {
    if (refreshInFlight) return refreshInFlight;
    const root = serverRoot(source.baseURL);
    if (!root) return Promise.resolve();
    refreshInFlight = (async () => {
      const models = await lifecycleFor(root).getAllModels(root);
      const next = buildCatalog(models);
      const hash = JSON.stringify([...next]);
      if (hash === catalogHash) return;
      catalog = next;
      catalogHash = hash;
      await ctx.model.reload();
    })()
      .catch((err) => log(`[opencode-lms] Catalog refresh failed: ${(err as Error).message}`))
      .finally(() => {
        refreshInFlight = null;
      });
    return refreshInFlight;
  }

  async function ensureLoadedWithLogging(
    lifecycle: ModelLifecycle,
    root: string,
    model: LMSModelInfo,
  ): Promise<void> {
    const ctxLength = resolveContextLength(options.loadPolicy, model);
    const adequate = model.loaded_instances.some((inst) => inst.config.context_length >= ctxLength);
    if (!adequate) {
      log(
        model.loaded_instances.length > 0
          ? `[opencode-lms] Reloading ${model.key} at context ${ctxLength} (resident instance too small)`
          : `[opencode-lms] Auto-loading ${model.key} at context ${ctxLength}`,
      );
    }
    let lastReportedPct = -1;
    await lifecycle.ensureModelLoaded(root, model, (event) => {
      if (isModelLoadStart(event)) {
        log(`[opencode-lms] Load started (${event.model_instance_id})`);
      } else if (isModelLoadProgress(event)) {
        const pct = Math.floor(event.progress * 100);
        if (pct >= lastReportedPct + 10) {
          log(`[opencode-lms] Loading ${model.key}: ${pct}%`);
          lastReportedPct = pct;
        }
      } else if (isModelLoadEnd(event)) {
        log(`[opencode-lms] Model loaded in ${event.load_time_seconds.toFixed(1)}s`);
      } else if (isError(event)) {
        console.warn(`[opencode-lms] Stream error: ${event.error.message}`);
      }
    });
  }

  // Behaviours 2–4 (and the advertised window that goes with 1): edit the
  // models the built-in provider discovered. Runs after the built-in's
  // provider transform; user `providers.lmstudio.models` overrides apply after
  // plugin transforms, so explicit config still wins.
  await ctx.model.transform((editor) => {
    const settings = editor.provider.get(PROVIDER_ID)?.provider.settings;
    source.baseURL = typeof settings?.baseURL === "string" ? settings.baseURL : undefined;
    source.apiKey = typeof settings?.apiKey === "string" && settings.apiKey ? settings.apiKey : undefined;
    applyModelPolicy(editor, {
      catalog,
      ttlSeconds: options.ttlSeconds,
      loadPolicy: options.disableAutoLoad ? undefined : options.loadPolicy,
    });
  });

  // Behaviour 1: auto-load before the model call leaves OpenCode. Awaited, so
  // the completion only goes out once the model is resident at the capped
  // window — otherwise LM Studio would JIT-load it at its own defaults. A
  // throwing hook would fail the request, so every error is swallowed: worst
  // case LM Studio JIT-loads, as it would without the plugin.
  await ctx.session.hook(
    "model.request",
    async (event) => {
      if (options.disableAutoLoad) return;
      const root = serverRoot(event.baseURL) ?? serverRoot(source.baseURL);
      if (!root) return;
      const modelKey = event.model.id;
      try {
        const lifecycle = lifecycleFor(root);
        const match = (await lifecycle.getAllModels(root)).find((m) => m.key === modelKey);
        // Not on disk — let LM Studio surface its own error.
        if (!match) return;
        await ensureLoadedWithLogging(lifecycle, root, match);
      } catch (err) {
        console.warn(`[opencode-lms] Auto-load failed for ${modelKey}: ${(err as Error).message}`);
      }
      void refreshCatalog();
    },
    { providerID: PROVIDER_ID },
  );

  // Behaviour 4, wire side: LM Studio rejects reasoning_effort "max".
  await ctx.session.hook(
    "http.request",
    async (event) => {
      try {
        const demoted = await demoteReasoningEffort(event.request);
        if (demoted) event.request = demoted;
      } catch (err) {
        console.warn(`[opencode-lms] Reasoning-effort check failed: ${(err as Error).message}`);
      }
    },
    { providerID: PROVIDER_ID },
  );

  // Follow the built-in's discovery instead of polling LM Studio a second
  // time: each time the model registry changes (a model appeared, the server
  // came up, config moved baseURL), re-read the catalog.
  const controller = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type === "model.updated") void refreshCatalog();
    }
  })().catch(() => {
    // Aborted on unload, or the stream closed; nothing to clean up.
  });

  return () => controller.abort();
}

// V2 plugin module shape: OpenCode reads only the default export's `id` and
// `setup`. Types only — the module carries no runtime import of
// @opencode/plugin, whose `Plugin.define` is an identity function.
export default { id: "opencode-lms", setup } satisfies Plugin.Plugin;
