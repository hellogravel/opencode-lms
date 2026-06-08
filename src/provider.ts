import { LMSClient } from "./api-client.js";
import type { LMSProviderConfig, MappedModelConfig, HealthCheckResult } from "./types.js";
import { discoverAndMapModels } from "./model-discovery.js";
import { ModelLifecycle } from "./model-lifecycle.js";
import { detectLMStudio, validateServer } from "./health.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:1234";
const DEFAULT_NAME = "LM Studio";
const PROVIDER_ID = "lms";

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

/**
 * Build the OpenCode ProviderConfig for the LM Studio provider.
 * This is what gets injected into OpenCode's config.
 */
export async function buildProviderConfig(
  userConfig: LMSProviderConfig | null | undefined,
): Promise<{
  providerConfig: Record<string, unknown>;
  models: Record<string, MappedModelConfig>;
  health: Awaited<ReturnType<typeof validateServer>> | null;
} | null> {
  const config = await resolveProviderConfig(userConfig);

  // Validate server health
  let health: HealthCheckResult | null = null;
  if (config.baseURL) {
    try {
      health = await validateServer(config.baseURL, config.apiKey);
    } catch {
      // Server not reachable — still return config, models will be empty
    }
  }

  if (!health?.healthy) {
    return {
      providerConfig: buildMinimalProviderConfig(config),
      models: {},
      health,
    };
  }

  // Create client and discover models
  const client = new LMSClient({
    baseURL: config.baseURL!,
    apiKey: config.apiKey,
  });

  const lifecycle = new ModelLifecycle(client);
  const discoveredModels = await lifecycle.getAvailableModels(config.baseURL!);

  // Map to OpenCode format
  const models = discoverAndMapModels(discoveredModels, config.models);

  // Build provider config
  const providerConfig = buildProviderConfigFull(config, models);

  return { providerConfig, models, health };
}

/**
 * Build the minimal provider config (no models).
 */
function buildMinimalProviderConfig(config: LMSProviderConfig): Record<string, unknown> {
  return {
    id: PROVIDER_ID,
    name: config.name,
    npm: "@ai-sdk/openai-compatible",
    options: {
      baseURL: `${config.baseURL}/v1`,
      apiKey: config.apiKey || "lm-studio",
      timeout: 600000,
      chunkTimeout: 120000,
    },
    models: {},
  };
}

/**
 * Build the full provider config with discovered models. Emits every field
 * OpenCode's provider parser accepts (verified at packages/opencode/src/
 * provider/provider.ts:1405-1455 in v1.16.2). Internal fields like
 * quantization, format, size_bytes stay in MappedModelConfig and don't
 * cross into the user-visible config.
 */
function buildProviderConfigFull(
  config: LMSProviderConfig,
  models: Record<string, MappedModelConfig>,
): Record<string, unknown> {
  const openCodeModels: Record<string, unknown> = {};
  for (const [key, model] of Object.entries(models)) {
    const entry: Record<string, unknown> = {
      id: model.id,
      name: model.name,
      family: model.family,
      temperature: model.temperature,
      reasoning: model.reasoning,
      attachment: model.attachment,
      tool_call: model.tool_call,
      cost: model.cost,
      modalities: model.modalities,
      limit: model.limit,
    };
    // OpenCode's config schema only accepts `true | {field}` for interleaved
    // — explicit `false` and `undefined` are both rejected by the validator
    // even though the runtime parser handles them. Omit the key entirely
    // unless we have a positive value to send.
    if (model.interleaved) entry.interleaved = model.interleaved;
    if (model.variants) entry.variants = model.variants;
    openCodeModels[key] = entry;
  }

  return {
    id: PROVIDER_ID,
    name: config.name,
    npm: "@ai-sdk/openai-compatible",
    options: {
      baseURL: `${config.baseURL}/v1`,
      apiKey: config.apiKey || "lm-studio",
      timeout: 600000,
      chunkTimeout: 120000,
    },
    models: openCodeModels,
  };
}

