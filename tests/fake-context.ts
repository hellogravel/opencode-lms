import { vi } from "vitest";
import type { Plugin } from "@opencode/plugin";
import type { ModelEditor } from "@opencode/plugin/promise/model";
import type { LMSModelInfo } from "../src/types.js";

// Test doubles for the slice of OpenCode 2's plugin context this plugin uses:
// the model transform/reload, the session hooks, and the event stream.

export interface FakeModel {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  variants: Array<{ id: string; settings?: Record<string, unknown> }>;
  limit: { context: number; output: number };
  body?: Record<string, unknown>;
}

/** A model as OpenCode's built-in LM Studio provider registers it. */
export function builtinModel(id: string, overrides: Partial<FakeModel> = {}): FakeModel {
  return {
    id,
    modelID: id,
    providerID: "lmstudio",
    name: id,
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    variants: [],
    limit: { context: 131072, output: 32000 },
    ...overrides,
  };
}

/** An in-memory ModelEditor over a model list and one provider's settings. */
export function fakeEditor(
  models: FakeModel[],
  settings: Record<string, unknown> = { baseURL: "http://lms.test:1234/v1" },
): ModelEditor {
  const editor = {
    list: (providerID?: string) => models.filter((m) => !providerID || m.providerID === providerID),
    get: (providerID: string, modelID: string) =>
      models.find((m) => m.providerID === providerID && m.id === modelID),
    update: (providerID: string, modelID: string, update: (model: FakeModel) => void) => {
      const model = models.find((m) => m.providerID === providerID && m.id === modelID);
      if (model) update(model);
    },
    remove: () => {},
    default: { get: () => undefined, set: () => {} },
    provider: {
      list: () => [],
      get: (providerID: string) =>
        providerID === "lmstudio" ? { provider: { id: "lmstudio", settings }, models: new Map() } : undefined,
    },
  };
  return editor as unknown as ModelEditor;
}

type HookCallback = (event: any) => Promise<void> | void;

export interface FakeContext {
  ctx: Plugin.Context;
  hooks: Map<string, { callback: HookCallback; options?: { providerID?: string } }>;
  /** Replay the registered model transform over `models`, as a registry rebuild would. */
  runTransform: (models: FakeModel[], settings?: Record<string, unknown>) => FakeModel[];
  /** Push an event onto the plugin's `ctx.event.subscribe()` stream. */
  emit: (event: { type: string }) => void;
  reload: ReturnType<typeof vi.fn>;
}

export function fakeContext(options: Record<string, unknown> = {}): FakeContext {
  const hooks = new Map<string, { callback: HookCallback; options?: { providerID?: string } }>();
  let transform: ((editor: ModelEditor) => void) | undefined;
  const queue: Array<{ type: string }> = [];
  let wake: (() => void) | undefined;
  const registration = { dispose: async () => {} };
  const reload = vi.fn(async () => {});

  const ctx = {
    options,
    model: {
      transform: async (callback: (editor: ModelEditor) => void) => {
        transform = callback;
        return registration;
      },
      reload,
    },
    session: {
      hook: async (name: string, callback: HookCallback, opts?: { providerID?: string }) => {
        hooks.set(name, { callback, options: opts });
        return registration;
      },
    },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal } = {}) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal?.aborted) {
            const next = queue.shift();
            if (next) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        },
      }),
    },
  };

  return {
    ctx: ctx as unknown as Plugin.Context,
    hooks,
    runTransform: (models, settings) => {
      transform?.(fakeEditor(models, settings));
      return models;
    },
    emit: (event) => {
      queue.push(event);
      wake?.();
    },
    reload,
  };
}

export const lmsModel = (key: string, overrides: Partial<LMSModelInfo> = {}): LMSModelInfo => ({
  type: "llm",
  publisher: "test",
  key,
  display_name: key,
  architecture: null,
  quantization: null,
  size_bytes: 0,
  params_string: null,
  loaded_instances: [],
  max_context_length: 131072,
  format: null,
  capabilities: { vision: false, trained_for_tool_use: false },
  description: null,
  ...overrides,
});

/** Encode LM Studio /api/v1/chat SSE events as a response body. */
export function sseBody(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}
