import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectLMStudio, validateServer } from "../src/health.js";

function installFetchMock(handler: (url: string, init: RequestInit) => { ok: boolean; status: number; body?: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body ?? {},
      text: async () => (r.body ? JSON.stringify(r.body) : ""),
      body: null,
    } as unknown as Response;
  });
  return calls;
}

describe("validateServer", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns healthy:true when /api/v1/models responds 200", async () => {
    installFetchMock(() => ({ ok: true, status: 200, body: { models: [] } }));
    const result = await validateServer("http://192.168.1.10:1234");
    expect(result.healthy).toBe(true);
    expect(result.apiVersion).toBe("v1");
  });

  it("returns healthy:false when /api/v1/models is 401 without apiKey", async () => {
    installFetchMock(() => ({ ok: false, status: 401 }));
    const result = await validateServer("http://host:1234");
    expect(result.healthy).toBe(false);
  });

  it("returns healthy:true when apiKey unlocks 401 → 200", async () => {
    const calls = installFetchMock((_url, init) => {
      const headers = init.headers as Record<string, string>;
      return headers.Authorization === "Bearer sk-good"
        ? { ok: true, status: 200, body: { models: [] } }
        : { ok: false, status: 401 };
    });
    const result = await validateServer("http://host:1234", "sk-good");
    expect(result.healthy).toBe(true);
    expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer sk-good" });
  });
});

describe("detectLMStudio", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns the first port that responds healthy", async () => {
    installFetchMock((url) => {
      if (url.includes("127.0.0.1:8080")) {
        return { ok: true, status: 200, body: { models: [] } };
      }
      return { ok: false, status: 0 };
    });
    const result = await detectLMStudio([1234, 8080, 11434]);
    expect(result?.baseURL).toBe("http://127.0.0.1:8080");
    expect(result?.healthy).toBe(true);
  });

  it("returns null when no port responds", async () => {
    installFetchMock(() => ({ ok: false, status: 0 }));
    const result = await detectLMStudio([1234, 8080]);
    expect(result).toBeNull();
  });

  it("forwards apiKey to the probe", async () => {
    const calls = installFetchMock(() => ({ ok: true, status: 200, body: { models: [] } }));
    await detectLMStudio([1234], "sk-test");
    expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer sk-test" });
  });
});
