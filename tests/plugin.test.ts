import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import plugin from "../src/index.js";
import type { LMSModelInfo } from "../src/types.js";
import { builtinModel, fakeContext, lmsModel, sseBody, type FakeContext } from "./fake-context.js";

// Drives the real setup() through a fake OpenCode 2 plugin context, with
// LM Studio's REST API stubbed at fetch. Covers the wiring of all four kept
// behaviours: what each hook is registered on and what it does on the wire.

const BASE = "http://lms.test:1234";

interface Call {
  url: string;
  body?: Record<string, unknown>;
}

function stubLMStudio(models: LMSModelInfo[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
    if (url === `${BASE}/api/v1/models`) {
      return new Response(JSON.stringify({ models }), { status: 200 });
    }
    if (url === `${BASE}/api/v1/chat`) {
      return new Response(
        sseBody([
          { type: "model_load.start", model_instance_id: "i" },
          { type: "model_load.end", model_instance_id: "i", load_time_seconds: 1.5 },
        ]),
        { status: 200 },
      );
    }
    if (url === `${BASE}/api/v1/models/unload`) {
      return new Response(JSON.stringify({ instance_id: "i" }), { status: 200 });
    }
    throw new TypeError(`unstubbed url: ${url}`);
  });
  return calls;
}

async function start(options: Record<string, unknown> = {}): Promise<FakeContext & { cleanup: () => void }> {
  const fake = fakeContext(options);
  const cleanup = (await plugin.setup(fake.ctx)) as () => void;
  return { ...fake, cleanup };
}

const modelRequest = (id: string) => ({
  sessionID: "ses_1",
  agent: "build",
  model: { providerID: "lmstudio", id },
  kind: "primary",
  baseURL: `${BASE}/v1`,
  headers: {},
});

describe("plugin setup", () => {
  let running: Array<() => void> = [];
  beforeEach(() => {
    vi.restoreAllMocks();
    running = [];
  });
  afterEach(() => {
    running.forEach((cleanup) => cleanup());
    vi.unstubAllGlobals();
  });

  async function started(options: Record<string, unknown> = {}) {
    const fake = await start(options);
    running.push(fake.cleanup);
    return fake;
  }

  it("scopes both session hooks to the lmstudio provider", async () => {
    const { hooks } = await started();
    expect(hooks.get("model.request")?.options).toEqual({ providerID: "lmstudio" });
    expect(hooks.get("http.request")?.options).toEqual({ providerID: "lmstudio" });
  });

  describe("auto-load (model.request)", () => {
    it("loads a cold model at the capped context before the request goes out", async () => {
      const calls = stubLMStudio([lmsModel("qwen/qwen3-8b")]);
      const { hooks } = await started();

      await hooks.get("model.request")!.callback(modelRequest("qwen/qwen3-8b"));

      const load = calls.find((c) => c.url === `${BASE}/api/v1/chat`);
      expect(load?.body).toMatchObject({ model: "qwen/qwen3-8b", context_length: 32768 });
    });

    it("unloads and reloads a resident instance loaded too small", async () => {
      const calls = stubLMStudio([
        lmsModel("m", { loaded_instances: [{ id: "m-small", config: { context_length: 4096 } }] }),
      ]);
      const { hooks } = await started({ contextLength: 16384 });

      await hooks.get("model.request")!.callback(modelRequest("m"));

      expect(calls.find((c) => c.url.endsWith("/unload"))?.body).toEqual({ instance_id: "m-small" });
      expect(calls.find((c) => c.url.endsWith("/api/v1/chat"))?.body).toMatchObject({ context_length: 16384 });
    });

    it("keeps a resident instance whose window already covers the cap", async () => {
      const calls = stubLMStudio([
        lmsModel("m", { loaded_instances: [{ id: "m", config: { context_length: 32768 } }] }),
      ]);
      const { hooks } = await started();

      await hooks.get("model.request")!.callback(modelRequest("m"));

      expect(calls.map((c) => c.url)).toEqual([`${BASE}/api/v1/models`]);
    });

    it("does nothing with disableAutoLoad", async () => {
      const calls = stubLMStudio([lmsModel("m")]);
      const { hooks } = await started({ disableAutoLoad: true });

      await hooks.get("model.request")!.callback(modelRequest("m"));

      expect(calls).toEqual([]);
    });

    it("never fails the request when LM Studio is unreachable", async () => {
      vi.stubGlobal("fetch", async () => {
        throw new TypeError("fetch failed");
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { hooks } = await started();

      await expect(hooks.get("model.request")!.callback(modelRequest("m"))).resolves.toBeUndefined();
    });
  });

  describe("model transform (tools, ttl, reasoning, window)", () => {
    const graded = lmsModel("graded", {
      capabilities: {
        vision: false,
        trained_for_tool_use: false,
        reasoning: { allowed_options: ["off", "low", "medium", "high"], default: "low" },
      },
    });

    it("forces tools and sets ttl from the first rebuild, before LM Studio is read", async () => {
      const fake = await started({ ttl: 120 });
      const [model] = fake.runTransform([builtinModel("graded")]);
      expect(model.capabilities.tools).toBe(true);
      expect(model.body).toEqual({ ttl: 120 });
      expect(model.variants).toEqual([]);
    });

    it("re-reads LM Studio on model.updated and replays the transform with reasoning + window", async () => {
      stubLMStudio([graded]);
      const fake = await started();
      // A rebuild captures where LM Studio lives from the built-in provider.
      fake.runTransform([builtinModel("graded")], { baseURL: `${BASE}/v1` });

      fake.emit({ type: "model.updated" });
      await vi.waitFor(() => expect(fake.reload).toHaveBeenCalledTimes(1));

      const [model] = fake.runTransform([builtinModel("graded")], { baseURL: `${BASE}/v1` });
      expect(model.variants.map((v) => v.id)).toEqual(["low", "medium", "high"]);
      expect(model.limit).toEqual({ context: 32768, output: 8192 });
    });

    it("does not reload again when the catalog is unchanged", async () => {
      stubLMStudio([graded]);
      const fake = await started();
      fake.runTransform([builtinModel("graded")], { baseURL: `${BASE}/v1` });

      fake.emit({ type: "model.updated" });
      await vi.waitFor(() => expect(fake.reload).toHaveBeenCalledTimes(1));
      fake.emit({ type: "model.updated" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(fake.reload).toHaveBeenCalledTimes(1);
    });
  });

  describe("reasoning effort (http.request)", () => {
    it('swaps in a request with "max" demoted to "xhigh"', async () => {
      const { hooks } = await started();
      const event = {
        request: new Request(`${BASE}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "m", reasoning_effort: "max" }),
        }),
      };

      await hooks.get("http.request")!.callback(event);

      expect((await event.request.json()).reasoning_effort).toBe("xhigh");
    });
  });
});
