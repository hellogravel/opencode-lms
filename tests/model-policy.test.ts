import { describe, it, expect } from "vitest";
import {
  applyContextLimit,
  applyModelPolicy,
  applyReasoningVariants,
  applyTtl,
  buildCatalog,
  forceToolCalling,
  type CatalogEntry,
} from "../src/model-policy.js";
import { builtinModel, fakeEditor, lmsModel, type FakeModel } from "./fake-context.js";

// The functions take OpenCode's DeepMutable<Model.Info>; the fakes carry the
// fields the policy touches.
const draft = (model: FakeModel) => model as unknown as Parameters<typeof applyTtl>[0];

const entry = (overrides: Partial<CatalogEntry> = {}): CatalogEntry => ({
  key: "m",
  max_context_length: 131072,
  loaded_contexts: [],
  ...overrides,
});

describe("buildCatalog", () => {
  it("records loaded windows and drops embedding models", () => {
    const catalog = buildCatalog([
      lmsModel("chat", {
        loaded_instances: [{ id: "chat", config: { context_length: 8192 } }],
      }),
      lmsModel("embed", { type: "embedding" }),
    ]);
    expect([...catalog.keys()]).toEqual(["chat"]);
    expect(catalog.get("chat")?.loaded_contexts).toEqual([8192]);
  });

  it("classifies reasoning: none, on/off only, and graduated levels", () => {
    const catalog = buildCatalog([
      lmsModel("plain"),
      lmsModel("toggle", {
        capabilities: {
          vision: false,
          trained_for_tool_use: false,
          reasoning: { allowed_options: ["off", "on"], default: "on" },
        },
      }),
      lmsModel("graded", {
        capabilities: {
          vision: false,
          trained_for_tool_use: false,
          reasoning: { allowed_options: ["off", "low", "medium", "high"], default: "medium" },
        },
      }),
    ]);
    expect(catalog.get("plain")?.reasoning_efforts).toBeUndefined();
    expect(catalog.get("toggle")?.reasoning_efforts).toEqual([]);
    expect(catalog.get("graded")?.reasoning_efforts).toEqual(["low", "medium", "high"]);
  });
});

describe("tool calling (forced on)", () => {
  it("turns tools on even when the built-in derived false from trained_for_tool_use", () => {
    const model = builtinModel("m");
    expect(model.capabilities.tools).toBe(false);
    forceToolCalling(draft(model));
    expect(model.capabilities.tools).toBe(true);
  });
});

describe("idle ttl (body overlay)", () => {
  it("adds ttl to the request body overlay, preserving other overlay keys", () => {
    const model = builtinModel("m", { body: { keep: 1 } });
    applyTtl(draft(model), 3600);
    expect(model.body).toEqual({ keep: 1, ttl: 3600 });
  });

  it("sends nothing for ttl 0 (resident)", () => {
    const model = builtinModel("m");
    applyTtl(draft(model), 0);
    expect(model.body).toBeUndefined();
  });
});

describe("reasoning variants", () => {
  it("gives a graduated model one effort variant per accepted level", () => {
    const model = builtinModel("m");
    applyReasoningVariants(draft(model), ["low", "high"]);
    expect(model.variants).toEqual([
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ]);
  });

  it("leaves existing effort variants alone on a graduated model", () => {
    const existing = [{ id: "high", settings: { reasoningEffort: "high" } }];
    const model = builtinModel("m", { variants: [...existing] });
    applyReasoningVariants(draft(model), ["low", "medium", "high"]);
    expect(model.variants).toEqual(existing);
  });

  it("suppresses the effort picker on an on/off-only model, keeping non-effort variants", () => {
    const model = builtinModel("m", {
      variants: [
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "medium", settings: { reasoningEffort: "medium" } },
        { id: "fast", settings: { temperature: 0 } },
      ],
    });
    applyReasoningVariants(draft(model), []);
    expect(model.variants).toEqual([{ id: "fast", settings: { temperature: 0 } }]);
  });
});

describe("advertised window (auto-load cap)", () => {
  it("advertises the capped load window for a cold large-window model", () => {
    const model = builtinModel("m");
    applyContextLimit(draft(model), entry(), {});
    expect(model.limit).toEqual({ context: 32768, output: 8192 });
  });

  it("advertises a larger resident window when one is loaded", () => {
    const model = builtinModel("m");
    applyContextLimit(draft(model), entry({ loaded_contexts: [65536] }), {});
    expect(model.limit.context).toBe(65536);
  });

  it("follows per-model overrides and clamps to the model's max", () => {
    const model = builtinModel("m");
    applyContextLimit(draft(model), entry({ max_context_length: 16384 }), {
      perModel: { m: { contextLength: 65536 } },
    });
    expect(model.limit).toEqual({ context: 16384, output: 4096 });
  });
});

describe("applyModelPolicy", () => {
  const catalog = buildCatalog([
    lmsModel("graded", {
      capabilities: {
        vision: false,
        trained_for_tool_use: false,
        reasoning: { allowed_options: ["low", "medium", "high"], default: "low" },
      },
    }),
  ]);

  it("edits only LM Studio models", () => {
    const other = builtinModel("gpt", { providerID: "openai" });
    const models = [builtinModel("graded"), other];
    applyModelPolicy(fakeEditor(models), { catalog, ttlSeconds: 60, loadPolicy: {} });

    expect(models[0].capabilities.tools).toBe(true);
    expect(models[0].body).toEqual({ ttl: 60 });
    expect(models[0].variants.map((v) => v.id)).toEqual(["low", "medium", "high"]);
    expect(models[0].limit.context).toBe(32768);
    expect(other).toEqual(builtinModel("gpt", { providerID: "openai" }));
  });

  it("leaves the built-in's window alone when auto-load is off", () => {
    const models = [builtinModel("graded")];
    applyModelPolicy(fakeEditor(models), { catalog, ttlSeconds: 60 });
    expect(models[0].limit).toEqual({ context: 131072, output: 32000 });
  });

  it("still forces tools and ttl for a model not yet in the catalog", () => {
    const models = [builtinModel("unknown")];
    applyModelPolicy(fakeEditor(models), { catalog, ttlSeconds: 60, loadPolicy: {} });
    expect(models[0].capabilities.tools).toBe(true);
    expect(models[0].body).toEqual({ ttl: 60 });
    expect(models[0].limit.context).toBe(131072);
  });
});
