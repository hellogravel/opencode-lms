import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import type { LMSModelInfo, LMSProviderConfig } from "./types.js";
import { buildProviderConfig } from "./provider.js";
import { LMSClient } from "./api-client.js";
import { ModelLifecycle } from "./model-lifecycle.js";
import {
  isModelLoadStart,
  isModelLoadProgress,
  isModelLoadEnd,
  isError,
} from "./streaming.js";

const PROVIDER_ID = "lms";

export const LMSPlugin: Plugin = async (_input: PluginInput): Promise<Hooks> => {
  console.log("[opencode-lms] LM Studio plugin initialized");

  let client: LMSClient | null = null;
  let lifecycle: ModelLifecycle | null = null;
  let resolvedBaseURL: string | null = null;
  let disableAutoLoad = false;
  let autoDownload = false;
  let downloadTimeout: number | undefined;

  function normalizeBaseURL(url: string | undefined): string | undefined {
    if (!url) return undefined;
    return String(url).replace(/\/+$/, "").replace(/\/v1$/, "");
  }

  function readUserConfig(raw: Record<string, unknown> | undefined): LMSProviderConfig | null {
    if (!raw) return null;
    // OpenCode's ProviderConfig schema only carries `options` as an open
    // bucket — top-level fields it doesn't recognize (baseURL, apiKey,
    // autoDownload, etc.) get stripped on load. Read from `options` first;
    // fall back to top-level for tolerance of hand-written configs.
    const options = (raw.options as Record<string, unknown> | undefined) ?? {};
    const pick = <T>(key: string): T | undefined =>
      (options[key] as T | undefined) ?? (raw[key] as T | undefined);
    return {
      name: pick<string>("name") ?? (raw.name as string | undefined),
      baseURL: normalizeBaseURL(pick<string>("baseURL")),
      apiKey: pick<string>("apiKey"),
      autoDetect: pick<boolean>("autoDetect"),
      disableAutoLoad: pick<boolean>("disableAutoLoad"),
      autoDownload: pick<boolean>("autoDownload"),
      loadTimeout: pick<number>("loadTimeout"),
      downloadTimeout: pick<number>("downloadTimeout"),
      models: (raw.models as LMSProviderConfig["models"]) ?? (options.models as LMSProviderConfig["models"]),
    };
  }

  /**
   * LM Studio's `/v1/chat/completions` accepts `reasoning_effort` values from
   * `none | minimal | low | medium | high | xhigh` and rejects anything else
   * with HTTP 400. OpenCode's picker may emit `"max"` (used by certain
   * OpenAI models like `5.1-codex-max`), which isn't in LMS's accepted set.
   * Demote it to the closest accepted value before the AI SDK serializes
   * the request. We probe a few conventional locations because the AI SDK
   * may put reasoningEffort top-level or under providerOptions.
   */
  function demoteUnsupportedReasoningEffort(
    output: { options: Record<string, unknown> } | undefined,
  ): void {
    if (!output?.options) return;
    const opts = output.options as Record<string, unknown>;
    const providerOpts = (opts.providerOptions as Record<string, Record<string, unknown>> | undefined) ?? {};
    const oaiCompat = providerOpts.openaiCompatible;
    const oai = providerOpts.openai;

    let demoted = false;
    const demote = (target: Record<string, unknown> | undefined) => {
      if (target && target.reasoningEffort === "max") {
        target.reasoningEffort = "xhigh";
        demoted = true;
      }
    };
    demote(opts);
    demote(oaiCompat);
    demote(oai);

    if (demoted) {
      console.log(
        `[opencode-lms] Reasoning effort "max" demoted to "xhigh" ` +
          `(LM Studio's /v1/chat/completions accepts: none, minimal, low, medium, high, xhigh)`,
      );
    }
  }

  async function ensureLoadedWithLogging(modelId: string, model: LMSModelInfo): Promise<void> {
    if (!lifecycle || !resolvedBaseURL) return;
    console.log(`[opencode-lms] Auto-loading model ${modelId}`);
    let lastReportedPct = -1;
    await lifecycle.ensureModelLoaded(resolvedBaseURL, model, (event) => {
      if (isModelLoadStart(event)) {
        console.log(`[opencode-lms] Load started (${event.model_instance_id})`);
      } else if (isModelLoadProgress(event)) {
        const pct = Math.floor(event.progress * 100);
        if (pct >= lastReportedPct + 10) {
          console.log(`[opencode-lms] Loading ${modelId}: ${pct}%`);
          lastReportedPct = pct;
        }
      } else if (isModelLoadEnd(event)) {
        console.log(`[opencode-lms] Model loaded in ${event.load_time_seconds.toFixed(1)}s`);
      } else if (isError(event)) {
        console.warn(`[opencode-lms] Stream error: ${event.error.message}`);
      }
    });
  }

  return {
    config: async (config) => {
      const providers = (config as { provider?: Record<string, Record<string, unknown>> }).provider ?? {};
      const userConfig: LMSProviderConfig | null = providers[PROVIDER_ID]
        ? readUserConfig(providers[PROVIDER_ID])
        : null;

      const result = await buildProviderConfig(userConfig);
      if (!result) return;

      const cfg = config as { provider?: Record<string, unknown> };
      if (!cfg.provider) cfg.provider = {};
      cfg.provider[PROVIDER_ID] = result.providerConfig;

      if (result.health?.healthy && result.health.baseURL) {
        resolvedBaseURL = result.health.baseURL;
        client = new LMSClient({
          baseURL: resolvedBaseURL,
          apiKey: userConfig?.apiKey,
          loadTimeout: userConfig?.loadTimeout,
        });
        lifecycle = new ModelLifecycle(client);
        disableAutoLoad = Boolean(userConfig?.disableAutoLoad);
        autoDownload = Boolean(userConfig?.autoDownload);
        downloadTimeout = userConfig?.downloadTimeout;

        const modelCount = Object.keys(result.models).length;
        console.log(
          `[opencode-lms] Discovered ${modelCount} model(s) at ${resolvedBaseURL}` +
            (autoDownload ? " (autoDownload on)" : ""),
        );
      } else {
        console.warn("[opencode-lms] LM Studio server not reachable — provider registered with no models");
      }
    },

    "chat.params": async (input, output) => {
      const providerID = input?.provider?.info?.id;
      if (providerID !== PROVIDER_ID) return;

      // Always run the reasoning-effort demotion — it's independent of
      // whether discovery is healthy and shouldn't be gated by it.
      demoteUnsupportedReasoningEffort(output);

      if (!lifecycle || !resolvedBaseURL) return;

      const modelId = input?.model?.id;
      if (!modelId) return;

      try {
        let models = await lifecycle.getAvailableModels(resolvedBaseURL);
        let match = models.find((m) => m.key === modelId);

        // Not on disk — download first if the user opted in.
        if (!match) {
          if (!autoDownload) return; // Let the AI SDK surface its own error.

          console.log(`[opencode-lms] Model ${modelId} not on disk — starting download`);
          let lastReportedPct = -1;
          await lifecycle.downloadModelAndWait(
            modelId,
            (status) => {
              const pct = status.progress != null ? Math.floor(status.progress * 100) : null;
              if (pct != null && pct >= lastReportedPct + 10) {
                console.log(`[opencode-lms] Downloading ${modelId}: ${pct}% (${status.status})`);
                lastReportedPct = pct;
              } else if (pct == null) {
                console.log(`[opencode-lms] Downloading ${modelId}: ${status.status}`);
              }
            },
            { timeoutMs: downloadTimeout },
          );
          console.log(`[opencode-lms] Download complete: ${modelId}`);

          // Re-discover; the model should now be on disk
          models = await lifecycle.getAvailableModels(resolvedBaseURL);
          match = models.find((m) => m.key === modelId);
          if (!match) {
            console.warn(`[opencode-lms] Download completed but ${modelId} not visible in discovery`);
            return;
          }
        }

        if (disableAutoLoad) return;
        if (match.loaded_instances.length > 0) return;

        await ensureLoadedWithLogging(modelId, match);
      } catch (err) {
        console.warn(`[opencode-lms] chat.params hook failed for ${modelId}: ${(err as Error).message}`);
      }
    },
  };
};

export default LMSPlugin;
