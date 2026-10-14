import type { LMSPluginOptions } from "./types.js";
import type { ModelLoadPolicy } from "./model-lifecycle.js";

// Default idle TTL (seconds) applied to each completion so LM Studio auto-evicts
// the model after this many idle seconds. `0` = resident (no ttl sent).
const DEFAULT_TTL_SECONDS = 3600;

export interface ResolvedOptions {
  ttlSeconds: number;
  disableAutoLoad: boolean;
  loadTimeout?: number;
  loadPolicy: ModelLoadPolicy;
}

/**
 * Normalize the plugin's `options` (from the object form of its `plugins`
 * entry). Unknown or mistyped values fall back to defaults rather than
 * failing the plugin's setup.
 */
export function resolveOptions(raw: Readonly<Record<string, unknown>> | undefined): ResolvedOptions {
  const options = (raw ?? {}) as LMSPluginOptions;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  const perModel: Record<string, { contextLength?: number }> = {};
  for (const [key, override] of Object.entries(options.models ?? {})) {
    const contextLength = num(override?.contextLength);
    if (contextLength !== undefined) perModel[key] = { contextLength };
  }

  return {
    // `?? default` keeps an explicit `0` (resident) distinct from "unset".
    ttlSeconds: num(options.ttl) ?? DEFAULT_TTL_SECONDS,
    disableAutoLoad: options.disableAutoLoad === true,
    loadTimeout: num(options.loadTimeout),
    loadPolicy: {
      contextLength: num(options.contextLength),
      perModel: Object.keys(perModel).length > 0 ? perModel : undefined,
    },
  };
}

/**
 * LM Studio's server root from an OpenAI-compat base URL: the built-in
 * provider's `settings.baseURL` is `http://host:1234/v1`, while the native
 * REST API lives at `/api/v1/*` off the root.
 */
export function serverRoot(baseURL: string | undefined): string | undefined {
  if (!baseURL) return undefined;
  return String(baseURL).replace(/\/+$/, "").replace(/\/(?:api\/)?v1$/, "");
}
