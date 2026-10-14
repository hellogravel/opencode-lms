import type { Model } from "@opencode/plugin";
import type { ModelEditor } from "@opencode/plugin/promise/model";
import type { DeepMutable } from "@opencode/plugin/promise/types";
import type { LMSModelInfo } from "./types.js";
import { resolveContextLength, type ModelLoadPolicy } from "./model-lifecycle.js";

// OpenCode's built-in LM Studio provider registers under this id. The plugin
// only edits that provider's models; it never registers a provider of its own.
export const PROVIDER_ID = "lmstudio";

// The OpenAI-scale effort levels LM Studio's reasoning options can include.
// `"off"` / `"on"` are its binary switch and have no effort meaning.
const EFFORT_LEVELS = ["low", "medium", "high"] as const;

/**
 * What the plugin needs to know about one LM Studio model beyond what the
 * built-in provider keeps: the loaded instances (for the advertised window)
 * and the reasoning options (which the built-in's schema drops entirely).
 */
export interface CatalogEntry {
  key: string;
  max_context_length: number;
  /** Context windows of the resident instances; empty when cold. */
  loaded_contexts: number[];
  /**
   * `undefined` = not a reasoning model. `[]` = reasoning that LM Studio only
   * switches on/off. Otherwise the effort levels LM Studio accepts.
   */
  reasoning_efforts?: string[];
}

export type Catalog = ReadonlyMap<string, CatalogEntry>;

/** Distill `/api/v1/models` into the per-model facts the policy reads. */
export function buildCatalog(models: LMSModelInfo[]): Map<string, CatalogEntry> {
  const catalog = new Map<string, CatalogEntry>();
  for (const model of models) {
    // Embedding models never reach the picker (the built-in drops them).
    if (model.type !== "llm") continue;
    const reasoning = model.capabilities?.reasoning;
    catalog.set(model.key, {
      key: model.key,
      max_context_length: model.max_context_length,
      loaded_contexts: model.loaded_instances.map((inst) => inst.config.context_length),
      reasoning_efforts: reasoning
        ? EFFORT_LEVELS.filter((level) => reasoning.allowed_options.includes(level))
        : undefined,
    });
  }
  return catalog;
}

export interface ModelPolicyInput {
  catalog: Catalog;
  /** Idle TTL in seconds; `<= 0` = resident (no `ttl` sent). */
  ttlSeconds: number;
  /**
   * The load policy auto-load enforces, or `undefined` when auto-load is off —
   * then the plugin never (re)loads, so it says nothing about the real window
   * and the built-in's advertised context stands.
   */
  loadPolicy?: ModelLoadPolicy;
}

/**
 * The model transform: edit every model the built-in LM Studio provider
 * discovered. Synchronous and replayable — it reads only the captured catalog,
 * so OpenCode can rerun it on every registry rebuild.
 */
export function applyModelPolicy(editor: ModelEditor, input: ModelPolicyInput): void {
  for (const model of editor.list(PROVIDER_ID)) {
    // The editor's DeepMutable turns branded id strings into object types;
    // they are plain strings at runtime.
    editor.update(PROVIDER_ID, String(model.id), (draft) => {
      forceToolCalling(draft);
      applyTtl(draft, input.ttlSeconds);
      const entry = input.catalog.get(String(draft.modelID ?? draft.id));
      if (!entry) return;
      if (entry.reasoning_efforts) applyReasoningVariants(draft, entry.reasoning_efforts);
      if (input.loadPolicy) applyContextLimit(draft, entry, input.loadPolicy);
    });
  }
}

/**
 * Tools are always on. The built-in derives `capabilities.tools` from LM
 * Studio's `trained_for_tool_use`, which is unreliable as a gate (many capable
 * models report false), and OpenCode sends no tools to a model without it.
 */
export function forceToolCalling(draft: DeepMutable<Model.Info>): void {
  draft.capabilities.tools = true;
}

/**
 * Apply LM Studio's idle `ttl` to every chat completion. LM Studio's REST
 * load/chat endpoints reject a `ttl` key, but its OpenAI-compat
 * `/v1/chat/completions` (where OpenCode's inference goes) accepts it and
 * resets the idle countdown on every request — so the model stays resident
 * under active use and evicts after `ttl` idle seconds. The model's `body`
 * overlay is merged into the JSON request body after protocol lowering.
 */
export function applyTtl(draft: DeepMutable<Model.Info>, ttlSeconds: number): void {
  if (!(ttlSeconds > 0)) return;
  draft.body = { ...draft.body, ttl: ttlSeconds };
}

/**
 * Mark a reasoning model by the only means OpenCode 2 has: its effort
 * variants, which drive the picker. A graduated model gets one variant per
 * level LM Studio accepts (the built-in gives LM Studio models none). An
 * on/off-only model gets no effort picker: every level would route to the same
 * "on" inside LM Studio, so any effort variant already present is dropped.
 * Variants that don't set an effort (and user-configured ones, which OpenCode
 * applies after plugin transforms) are left alone.
 */
export function applyReasoningVariants(draft: DeepMutable<Model.Info>, efforts: readonly string[]): void {
  const setsEffort = (variant: { settings?: Record<string, unknown> }) =>
    variant.settings?.reasoningEffort !== undefined;
  if (efforts.length === 0) {
    draft.variants = draft.variants.filter((variant) => !setsEffort(variant));
    return;
  }
  if (draft.variants.some(setsEffort)) return;
  for (const effort of efforts) {
    draft.variants.push({ id: effort as Model.VariantID, settings: { reasoningEffort: effort } });
  }
}

/**
 * limit.context must describe the window requests will actually get —
 * OpenCode budgets prompt/compaction against it, and the built-in advertises
 * max_context_length for a cold model, which auto-load caps. Cold models load
 * at resolveContextLength and undersized resident instances are reloaded to
 * it (see ensureModelLoaded), while a larger resident instance is kept and
 * used. LMS has no separate output cap (output is bounded by remaining
 * context), so reserve a quarter of the window for output, capped at 8192.
 */
export function applyContextLimit(
  draft: DeepMutable<Model.Info>,
  entry: CatalogEntry,
  policy: ModelLoadPolicy,
): void {
  const loaded = entry.loaded_contexts.length
    ? Math.min(...entry.loaded_contexts, entry.max_context_length)
    : 0;
  const context = Math.max(resolveContextLength(policy, entry), loaded);
  draft.limit.context = context;
  draft.limit.output = Math.min(Math.floor(context / 4), 8192);
}
