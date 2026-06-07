import type { LMSProviderConfig, LMSModelOverride } from "./types.js";

export function migrateLmstudioToLms(
  lmstudioConfig: Record<string, unknown>,
): LMSProviderConfig {
  const result: LMSProviderConfig = {};
  const options = (lmstudioConfig.options as Record<string, unknown> | undefined) ?? {};

  result.name = lmstudioConfig.name ? String(lmstudioConfig.name) : "LM Studio";

  const baseURL = options.baseURL ?? lmstudioConfig.baseURL;
  if (baseURL) {
    result.baseURL = String(baseURL).replace(/\/v1\/?$/, "");
  }

  const apiKey = options.apiKey ?? lmstudioConfig.apiKey;
  if (apiKey) {
    result.apiKey = String(apiKey);
  }

  if (lmstudioConfig.models) {
    result.models = migrateModels(lmstudioConfig.models as Record<string, unknown>);
  }

  if (lmstudioConfig.disableAutoLoad !== undefined) {
    result.disableAutoLoad = Boolean(lmstudioConfig.disableAutoLoad);
  }

  result.autoDetect = !result.baseURL;

  return result;
}

function migrateModels(models: Record<string, unknown>): Record<string, LMSModelOverride> {
  const result: Record<string, LMSModelOverride> = {};

  for (const [key, modelConfig] of Object.entries(models)) {
    if (!modelConfig || typeof modelConfig !== "object") continue;

    const config = modelConfig as Record<string, unknown>;
    const override: LMSModelOverride = {
      id: config.id ? String(config.id) : key,
      name: config.name ? String(config.name) : key,
    };

    if (config.family) override.family = String(config.family);
    if (config.reasoning) override.reasoning = Boolean(config.reasoning);
    if (config.tool_call) override.tool_call = Boolean(config.tool_call);
    if (config.modalities) override.modalities = config.modalities as LMSModelOverride["modalities"];
    if (config.limit) override.limit = config.limit as LMSModelOverride["limit"];
    if (config.variants) override.variants = config.variants as LMSModelOverride["variants"];
    if (config.options) override.options = config.options as Record<string, unknown>;

    result[key] = override;
  }

  return result;
}
