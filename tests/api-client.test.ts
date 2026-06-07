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

describe("LMSClient.checkHealth", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns healthy/v1 when /api/v1/models responds 200", async () => {
    installFetchMock([
      { url: /\/api\/v1\/models$/, ok: true, status: 200, body: { models: [] } },
    ]);
    const client = new LMSClient({ baseURL: "http://localhost:1234" });
    const result = await client.checkHealth();
    expect(result.healthy).toBe(true);
    expect(result.apiVersion).toBe("v1");
  });

  it("falls back to v0 when v1 errors but v0 responds", async () => {
    installFetchMock([
      { url: /\/api\/v1\/models$/, ok: false, status: 404, body: {} },
      { url: /\/api\/v0\/models$/, ok: true, status: 200, body: { data: [] } },
    ]);
    const client = new LMSClient({ baseURL: "http://localhost:1234" });
    const result = await client.checkHealth();
    expect(result.healthy).toBe(true);
    expect(result.apiVersion).toBe("v0");
  });

  it("falls all the way back to OpenAI-compatible /v1/models", async () => {
    installFetchMock([
      { url: /\/api\/v1\/models$/, ok: false, status: 404, body: {} },
      { url: /\/api\/v0\/models$/, ok: false, status: 404, body: {} },
      { url: /\/v1\/models$/, ok: true, status: 200, body: { data: [] } },
    ]);
    const client = new LMSClient({ baseURL: "http://localhost:1234" });
    const result = await client.checkHealth();
    expect(result.healthy).toBe(true);
    expect(result.apiVersion).toBe("openai");
  });

  it("returns healthy:false when nothing answers", async () => {
    installFetchMock([
      { url: /\/api\/v1\/models$/, ok: false, status: 401, body: {} },
      { url: /\/api\/v0\/models$/, ok: false, status: 401, body: {} },
      { url: /\/v1\/models$/, ok: false, status: 401, body: {} },
    ]);
    const client = new LMSClient({ baseURL: "http://localhost:1234" });
    const result = await client.checkHealth();
    expect(result.healthy).toBe(false);
  });

  it("sends Authorization: Bearer <apiKey> when apiKey is set", async () => {
    const { calls } = installFetchMock([
      { url: /\/api\/v1\/models$/, ok: true, status: 200, body: { models: [] } },
    ]);
    const client = new LMSClient({ baseURL: "http://localhost:1234", apiKey: "sk-test" });
    await client.checkHealth();
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });
});

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

  it("converts v0 'embeddings' type to 'embedding' (the fix surfaced by live testing)", async () => {
    installFetchMock([
      { url: /\/api\/v1\/models$/, ok: false, status: 404, body: {} },
      {
        url: /\/api\/v0\/models$/,
        ok: true,
        status: 200,
        body: {
          data: [
            {
              id: "embed-1",
              type: "embeddings",
              publisher: "p",
              arch: "a",
              compatibility_type: "gguf",
              quantization: "Q4",
              state: "not-loaded",
              max_context_length: 512,
            },
            {
              id: "llm-1",
              type: "llm",
              publisher: "p",
              arch: "a",
              compatibility_type: "gguf",
              quantization: "Q4",
              state: "not-loaded",
              max_context_length: 4096,
            },
            {
              id: "vlm-1",
              type: "vlm",
              publisher: "p",
              arch: "a",
              compatibility_type: "gguf",
              quantization: "Q4",
              state: "not-loaded",
              max_context_length: 4096,
            },
          ],
        },
      },
    ]);
    const client = new LMSClient({ baseURL: "http://localhost:1234" });
    const result = await client.getModels();
    expect(result.find((m) => m.key === "embed-1")?.type).toBe("embedding");
    expect(result.find((m) => m.key === "llm-1")?.type).toBe("llm");
    expect(result.find((m) => m.key === "vlm-1")?.type).toBe("llm");
    expect(result.find((m) => m.key === "vlm-1")?.capabilities?.vision).toBe(true);
  });

  it("uses categorizeModel heuristic for the OpenAI-compat fallback", async () => {
    installFetchMock([
      { url: /\/api\/v1\/models$/, ok: false, status: 404, body: {} },
      { url: /\/api\/v0\/models$/, ok: false, status: 404, body: {} },
      {
        url: /\/v1\/models$/,
        ok: true,
        status: 200,
        body: {
          data: [
            { id: "text-embedding-nomic", object: "model", created: 0, owned_by: "p" },
            { id: "qwen-7b", object: "model", created: 0, owned_by: "p" },
          ],
        },
      },
    ]);
    const client = new LMSClient({ baseURL: "http://localhost:1234" });
    const result = await client.getModels();
    expect(result.find((m) => m.key === "text-embedding-nomic")?.type).toBe("embedding");
    expect(result.find((m) => m.key === "qwen-7b")?.type).toBe("llm");
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

describe("LMSClient.loadModel / unloadModel / downloadModel", () => {
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

  it("downloadModel returns the job_id from the server", async () => {
    installFetchMock([
      {
        url: /\/api\/v1\/models\/download$/,
        ok: true,
        status: 200,
        body: { job_id: "job-abc" },
      },
    ]);
    const client = new LMSClient({ baseURL: "http://localhost:1234" });
    const result = await client.downloadModel("model-x");
    expect(result.job_id).toBe("job-abc");
  });
});
