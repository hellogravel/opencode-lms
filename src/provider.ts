import { LMSClient } from "./api-client.js";
import type { LMSProviderConfig, MappedModelConfig, HealthCheckResult, ModelV2 } from "./types.js";
import { discoverAndMapModels } from "./model-discovery.js";
import { ModelLifecycle } from "./model-lifecycle.js";
import { detectLMStudio, validateServer } from "./health.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:1234";
const DEFAULT_NAME = "LM Studio";

// Must match the models.dev catalog id. OpenCode only fires the
// `provider.models` hook for a provider that already exists in that catalog
// (provider.ts: `database[providerID]` / `if (!provider) continue`), so the
// id has to be "lmstudio", not a custom alias.
const PROVIDER_ID = "lmstudio";
const NPM = "@ai-sdk/openai-compatible";

/**
 * Resolve the effective config for the LM Studio provider.
 * Handles auto-detection and defaults.
 */
export async function resolveProviderConfig(
  userConfig: LMSProviderConfig | null | undefined,
): Promise<LMSProviderConfig> {
  let config: LMSProviderConfig;

  if (userConfig) {
    config = { ...userConfig };
  } else {
    config = { autoDetect: true, name: DEFAULT_NAME };
  }

  // If no baseURL set and auto-detect enabled, try to find LM Studio
  if (!config.baseURL && config.autoDetect !== false) {
    const detected = await detectLMStudio(undefined, config.apiKey);
    if (detected) {
      config.baseURL = detected.baseURL;
    }
  }

  config.name = config.name || DEFAULT_NAME;
  config.baseURL = config.baseURL || DEFAULT_BASE_URL;

  return config;
}

export interface BuiltProvider {
  /**
   * The value to assign to `config.provider.lmstudio`. It *enables* the
   * provider (a catalog provider only shows up once a config/env/auth entry
   * promotes it) and carries the full model list in OpenCode's config-dict
   * shape — see the catalog-independence note on `buildProvider`.
   */
  providerEntry: Record<string, unknown>;
  /** The ModelV2 map returned from the `provider.models` hook. */
  models: Record<string, ModelV2>;
  health: HealthCheckResult | null;
  client: LMSClient | null;
  lifecycle: ModelLifecycle | null;
  resolvedBaseURL: string | null;
}

/**
 * Resolve config, health-check the server, discover models, and shape the
 * results for OpenCode's v2 provider system.
 *
 * We deliver the same discovered models two ways on purpose:
 *
 *   1. `models` (ModelV2) via the `provider.models` hook — the clean, primary
 *      path. But it only fires for a provider already in the models.dev
 *      catalog (`if (!provider) continue`), and that catalog entry is actively
 *      proposed for removal (anomalyco/models.dev#794).
 *   2. `providerEntry.models` (config-dict shape) via the config entry — the
 *      fallback. The config-merge path builds models even when the provider
 *      isn't in the catalog, so the plugin keeps working if `lmstudio` is
 *      dropped from models.dev. When the catalog entry *is* present, the hook
 *      and the config rebuild describe the same models, so there's no conflict.
 *
 * Reasoning-variant suppression rides in `providerEntry.models[*].variants`:
 * OpenCode auto-generates low/medium/high effort variants for reasoning models
 * whose variants come back empty (provider.ts:1576 → transform.ts variants()),
 * and the only place it filters `disabled` variants is the config-merge path
 * (provider.ts:1580-1587). So suppression has to live in the config entry, not
 * the hook — which the config-dict models already carry.
 */
export async function buildProvider(
  userConfig: LMSProviderConfig | null | undefined,
): Promise<BuiltProvider> {
  const config = await resolveProviderConfig(userConfig);

  const options = {
    baseURL: `${config.baseURL}/v1`,
    apiKey: config.apiKey || "lm-studio",
    timeout: 600000,
    chunkTimeout: 120000,
  };

  // Validate server health
  let health: HealthCheckResult | null = null;
  if (config.baseURL) {
    try {
      health = await validateServer(config.baseURL, config.apiKey);
    } catch {
      // Server not reachable — still register the (model-less) provider.
    }
  }

  if (!health?.healthy) {
    return {
      providerEntry: { name: config.name, options, models: {} },
      models: {},
      health,
      client: null,
      lifecycle: null,
      resolvedBaseURL: null,
    };
  }

  const client = new LMSClient({ baseURL: config.baseURL!, apiKey: config.apiKey });
  const lifecycle = new ModelLifecycle(client);
  const discovered = await lifecycle.getAvailableModels(config.baseURL!);
  const mapped = discoverAndMapModels(discovered, config.models);

  const models: Record<string, ModelV2> = {};
  const configModels: Record<string, Record<string, unknown>> = {};
  for (const [key, model] of Object.entries(mapped)) {
    models[key] = mappedToModelV2(model, config.baseURL!);
    configModels[key] = mappedToConfigModel(model);
  }

  return {
    providerEntry: { name: config.name, options, models: configModels },
    models,
    health,
    client,
    lifecycle,
    resolvedBaseURL: config.baseURL!,
  };
}

/**
 * Project a MappedModelConfig into OpenCode's config-dict model shape (the
 * `config.provider.<id>.models[*]` form). This is the catalog-independent
 * fallback. OpenCode's config parser rejects `interleaved: false` and bare
 * `undefined`, so the key is omitted unless we have a positive value; same for
 * `variants`.
 */
function mappedToConfigModel(m: MappedModelConfig): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: m.id,
    name: m.name,
    family: m.family,
    temperature: m.temperature,
    reasoning: m.reasoning,
    attachment: m.attachment,
    tool_call: m.tool_call,
    cost: m.cost,
    modalities: m.modalities,
    limit: m.limit,
  };
  if (m.interleaved) entry.interleaved = m.interleaved;
  if (m.variants) entry.variants = m.variants;
  return entry;
}

/**
 * Convert our intermediate MappedModelConfig into OpenCode's strict ModelV2
 * shape (the `provider.models` hook return type). Note interleaved can now be
 * a plain `false` — ModelV2's schema accepts booleans, unlike the old config
 * path which rejected `interleaved: false`.
 */
function mappedToModelV2(m: MappedModelConfig, baseURL: string): ModelV2 {
  const inputMods = m.modalities?.input;
  const outputMods = m.modalities?.output;
  const has = (mods: readonly string[] | undefined, name: string, fallback: boolean) =>
    mods ? mods.includes(name) : fallback;

  return {
    id: m.id,
    providerID: PROVIDER_ID,
    api: { id: m.id, url: `${baseURL}/v1`, npm: NPM },
    name: m.name,
    family: m.family ?? "",
    capabilities: {
      temperature: m.temperature ?? false,
      reasoning: m.reasoning ?? false,
      attachment: m.attachment ?? false,
      toolcall: m.tool_call ?? true,
      input: {
        text: has(inputMods, "text", true),
        audio: has(inputMods, "audio", false),
        image: has(inputMods, "image", false),
        video: has(inputMods, "video", false),
        pdf: has(inputMods, "pdf", false),
      },
      output: {
        text: has(outputMods, "text", true),
        audio: has(outputMods, "audio", false),
        image: has(outputMods, "image", false),
        video: has(outputMods, "video", false),
        pdf: has(outputMods, "pdf", false),
      },
      interleaved: m.interleaved ?? false,
    },
    cost: {
      input: m.cost?.input ?? 0,
      output: m.cost?.output ?? 0,
      cache: { read: m.cost?.cache_read ?? 0, write: m.cost?.cache_write ?? 0 },
    },
    limit: {
      context: m.limit?.context ?? 0,
      output: m.limit?.output ?? 0,
      ...(m.limit?.input != null ? { input: m.limit.input } : {}),
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
  };
}

