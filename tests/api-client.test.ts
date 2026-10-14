import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LMSClient } from "../src/api-client.js";

type FetchCall = { url: string; init: RequestInit };
type MockResponse = {
  ok: boolean;
  status: number;
  url: RegExp | string;
  body?: unknown;
  text?: string;
};

function installFetchMock(responses: MockResponse[]): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const match = responses.find((r) =>
      typeof r.url === "string" ? r.url === url : r.url.test(url),
    );
    if (!match) {
      throw new TypeError(`unstubbed url: ${url}`);
    }
    return {
      ok: match.ok,
      status: match.status,
      json: async () => match.body,
      text: async () => match.text ?? (match.body ? JSON.stringify(match.body) : ""),
      body: null,
    } as unknown as Response;
  });
  return { calls };
}

describe("LMSClient.getModels", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns the v1 models array verbatim when v1 succeeds", async () => {
    const v1Models = [
      { type: "llm", key: "x", loaded_instances: [], max_context_length: 4096 },
    ];
    installFetchMock([
      { url: /\/api\/v1\/models$/, ok: true, status: 200, body: { models: v1Models } },
    ]);
    const client = new LMSClient({ baseURL: "http://localhost:1234" });
    const result = await client.getModels();
    expect(result).toEqual(v1Models);
  });

  it("throws when /api/v1/models fails, so callers keep their last catalog", async () => {
    installFetchMock([
      { url: /\/api\/v1\/models$/, ok: false, status: 401, text: "unauthorized" },
    ]);
    const client = new LMSClient({ baseURL: "http://localhost:1234" });
    await expect(client.getModels()).rejects.toThrow(/401/);
  });

  it("sends the bearer token when an apiKey is set", async () => {
    const { calls } = installFetchMock([
      { url: /\/api\/v1\/models$/, ok: true, status: 200, body: { models: [] } },
    ]);
    const client = new LMSClient({ baseURL: "http://localhost:1234", apiKey: "sk-lm-x" });
    await client.getModels();
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-lm-x");
  });
});

describe("LMSClient.streamChat", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("sends input as typed parts and does NOT set max_tokens (the LMS contract)", async () => {
    // The body the live LMS server rejected was {input:"ping",max_tokens:1}.
    // The body it accepted was {input:[{type:"text",content:"ping"}]}.
    // This test pins that contract.
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        body: new ReadableStream(),
      } as unknown as Response;
    });
    const client = new LMSClient({ baseURL: "http://localhost:1234" });
    await client.streamChat("model-x", [{ type: "text", content: "ping" }], {
      context_length: 4096,
    });

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.input).toEqual([{ type: "text", content: "ping" }]);
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body.context_length).toBe(4096);
  });

  it("never sends a ttl key on the native chat body (LM Studio 0.4.19 rejects it)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, body: new ReadableStream() } as unknown as Response;
    });
    const client = new LMSClient({ baseURL: "http://localhost:1234" });
    await client.streamChat("m", [{ type: "text", content: "ping" }], { context_length: 4096 });
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty("ttl");
  });

  it("passes the caller's AbortSignal to fetch", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        body: new ReadableStream(),
      } as unknown as Response;
    });
    const controller = new AbortController();
    const client = new LMSClient({ baseURL: "http://localhost:1234" });
    await client.streamChat("model-x", [{ type: "text", content: "ping" }], {
      signal: controller.signal,
    });

    expect(calls[0].init.signal).toBe(controller.signal);
  });

  it("throws a useful error when LMS returns 400 with a JSON body", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"Unrecognized key"}}',
    } as unknown as Response));
    const client = new LMSClient({ baseURL: "http://localhost:1234" });

    await expect(
      client.streamChat("m", [{ type: "text", content: "ping" }]),
    ).rejects.toThrow(/Unrecognized key/);
  });
});

describe("LMSClient.loadModel / unloadModel", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to /api/v1/models/load with model + context_length + echo_load_config", async () => {
    const { calls } = installFetchMock([
      {
        url: /\/api\/v1\/models\/load$/,
        ok: true,
        status: 200,
        body: { instance_id: "inst-1", type: "llm", load_time_seconds: 1, status: "loaded" },
      },
    ]);
    const client = new LMSClient({ baseURL: "http://localhost:1234" });
    await client.loadModel("model-x", { context_length: 8192, echo_load_config: true });

    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({ model: "model-x", context_length: 8192, echo_load_config: true });
  });

  it("never sends a ttl key on the load body (LM Studio 0.4.19 rejects it)", async () => {
    const { calls } = installFetchMock([
      {
        url: /\/api\/v1\/models\/load$/,
        ok: true,
        status: 200,
        body: { instance_id: "inst-1", type: "llm", load_time_seconds: 1, status: "loaded" },
      },
    ]);
    const client = new LMSClient({ baseURL: "http://localhost:1234" });
    await client.loadModel("model-x", { context_length: 8192 });
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty("ttl");
  });

  it("POSTs to /api/v1/models/unload with instance_id", async () => {
    const { calls } = installFetchMock([
      {
        url: /\/api\/v1\/models\/unload$/,
        ok: true,
        status: 200,
        body: { instance_id: "inst-1" },
      },
    ]);
    const client = new LMSClient({ baseURL: "http://localhost:1234" });
    await client.unloadModel("inst-1");

    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({ instance_id: "inst-1" });
  });
});
