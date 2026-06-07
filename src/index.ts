import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import type { LMSModelInfo, LMSProviderConfig } from "./types.js";
import { buildProviderConfig } from "./provider.js";
import { LMSClient } from "./api-client.js";
import { ModelLifecycle } from "./model-lifecycle.js";
import { migrateLmstudioToLms } from "./migrate.js";
import {
  isModelLoadStart,
  isModelLoadProgress,
  isModelLoadEnd,
  isError,
} from "./streaming.js";

const PROVIDER_ID = "lms";
const LEGACY_PROVIDER_ID = "lmstudio";

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
    const options = (raw.options as Record<string, unknown> | undefined) ?? {};
    return {
      name: (raw.name as string | undefined) ?? undefined,
      baseURL: normalizeBaseURL((raw.baseURL as string | undefined) ?? (options.baseURL as string | undefined)),
      apiKey: (raw.apiKey as string | undefined) ?? (options.apiKey as string | undefined),
      autoDetect: raw.autoDetect as boolean | undefined,
      disableAutoLoad: raw.disableAutoLoad as boolean | undefined,
      autoDownload: raw.autoDownload as boolean | undefined,
      loadTimeout: raw.loadTimeout as number | undefined,
      downloadTimeout: raw.downloadTimeout as number | undefined,
      models: raw.models as LMSProviderConfig["models"],
    };
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
      let userConfig: LMSProviderConfig | null = null;
      let migrated = false;

      if (providers[PROVIDER_ID]) {
        userConfig = readUserConfig(providers[PROVIDER_ID]);
      } else if (providers[LEGACY_PROVIDER_ID]) {
        console.log("[opencode-lms] Migrating lmstudio → lms");
        userConfig = migrateLmstudioToLms(providers[LEGACY_PROVIDER_ID]);
        migrated = true;
      }

      const result = await buildProviderConfig(userConfig);
      if (!result) return;

      const cfg = config as { provider?: Record<string, unknown> };
      if (!cfg.provider) cfg.provider = {};
      cfg.provider[PROVIDER_ID] = result.providerConfig;

      if (migrated) {
        delete (cfg.provider as Record<string, unknown>)[LEGACY_PROVIDER_ID];
      }

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

    "chat.params": async (input, _output) => {
      const providerID = input?.provider?.info?.id;
      if (providerID !== PROVIDER_ID) return;
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
