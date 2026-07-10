import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BuiltProvider } from "../src/provider.js";

// Self-heal path for a late-starting LM Studio: if the server was down when
// the `config` hook ran, chat.params and provider.models retry discovery
// (throttled, single-flight) instead of staying dead until an OpenCode reload.
// buildProvider is mocked so tests control when the "server" comes up.

const buildProviderMock = vi.hoisted(() => vi.fn());
vi.mock("../src/provider.js", () => ({ buildProvider: buildProviderMock }));

import { LMSPlugin } from "../src/index.js";

function unhealthy(): BuiltProvider {
  return {
    providerEntry: { name: "LM Studio", options: {}, models: {} },
    models: {},
    health: { healthy: false, baseURL: "http://x:1234", apiVersion: "v1", latency: 1 },
    client: null,
    lifecycle: null,
    resolvedBaseURL: null,
  };
}

// A healthy result whose lifecycle is a spy — loaded_instances is non-empty so
// chat.params stops after the discovery lookup (no load event stream needed).
function healthy() {
  const model = {
    type: "llm",
    key: "m",
    loaded_instances: [{ id: "i1", config: { context_length: 32768 } }],
    max_context_length: 32768,
  };
  const lifecycle = {
    getAvailableModels: vi.fn().mockResolvedValue([model]),
    ensureModelLoaded: vi.fn(),
  };
  return {
    providerEntry: { name: "LM Studio", options: {}, models: {} },
    models: { m: { id: "m" } },
    health: { healthy: true, baseURL: "http://x:1234", apiVersion: "v1", latency: 1 },
    client: {},
    lifecycle,
    resolvedBaseURL: "http://x:1234",
  } as unknown as BuiltProvider & { lifecycle: typeof lifecycle };
}

async function armedHooks() {
  buildProviderMock.mockResolvedValueOnce(unhealthy());
  const hooks = await LMSPlugin({} as any);
  await hooks.config!({ provider: {} } as any);
  expect(buildProviderMock).toHaveBeenCalledTimes(1);
  return hooks;
}

const chatInput = { provider: { id: "lmstudio" }, model: { id: "m" } } as any;
const freshOutput = () => ({ options: {} as Record<string, any> }) as any;

describe("late server discovery", () => {
  beforeEach(() => {
    buildProviderMock.mockReset();
  });

  it("chat.params retries discovery once the server comes up, then auto-load works", async () => {
    const hooks = await armedHooks();

    const built = healthy();
    buildProviderMock.mockResolvedValue(built);
    await hooks["chat.params"]!(chatInput, freshOutput());

    expect(buildProviderMock).toHaveBeenCalledTimes(2);
    // The rebuilt lifecycle served the auto-load path for this same request.
    expect(built.lifecycle.getAvailableModels).toHaveBeenCalled();
  });

  it("provider.models retries discovery when config-time discovery failed", async () => {
    const hooks = await armedHooks();

    buildProviderMock.mockResolvedValue(healthy());
    const models = await hooks.provider!.models!({} as any, {} as any);

    expect(Object.keys(models)).toEqual(["m"]);
  });

  it("throttles rediscovery while the server stays down", async () => {
    const hooks = await armedHooks();
    buildProviderMock.mockResolvedValue(unhealthy());

    await hooks["chat.params"]!(chatInput, freshOutput()); // attempt #2
    await hooks["chat.params"]!(chatInput, freshOutput()); // throttled
    await hooks.provider!.models!({} as any, {} as any); // also throttled

    expect(buildProviderMock).toHaveBeenCalledTimes(2);
  });

  it("does not rediscover once healthy state is adopted", async () => {
    const hooks = await armedHooks();

    buildProviderMock.mockResolvedValue(healthy());
    await hooks["chat.params"]!(chatInput, freshOutput()); // adopts (call #2)
    await hooks["chat.params"]!(chatInput, freshOutput()); // already healthy

    expect(buildProviderMock).toHaveBeenCalledTimes(2);
  });
});
