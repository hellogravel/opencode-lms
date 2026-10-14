import { describe, it, expect } from "vitest";
import { resolveOptions, serverRoot } from "../src/options.js";

describe("resolveOptions", () => {
  it("defaults: 1h ttl, auto-load on, default context cap", () => {
    expect(resolveOptions(undefined)).toEqual({
      ttlSeconds: 3600,
      disableAutoLoad: false,
      loadTimeout: undefined,
      loadPolicy: { contextLength: undefined, perModel: undefined },
    });
  });

  it("keeps an explicit ttl of 0 (resident) distinct from unset", () => {
    expect(resolveOptions({ ttl: 0 }).ttlSeconds).toBe(0);
  });

  it("threads contextLength and per-model overrides into the load policy", () => {
    const resolved = resolveOptions({
      contextLength: 16384,
      models: { "qwen/qwen3-8b": { contextLength: 65536 }, ignored: {} },
    });
    expect(resolved.loadPolicy).toEqual({
      contextLength: 16384,
      perModel: { "qwen/qwen3-8b": { contextLength: 65536 } },
    });
  });

  it("falls back to defaults for mistyped values", () => {
    const resolved = resolveOptions({ ttl: "60", contextLength: null, disableAutoLoad: "yes" });
    expect(resolved.ttlSeconds).toBe(3600);
    expect(resolved.loadPolicy.contextLength).toBeUndefined();
    expect(resolved.disableAutoLoad).toBe(false);
  });
});

describe("serverRoot", () => {
  it.each([
    ["http://127.0.0.1:1234/v1", "http://127.0.0.1:1234"],
    ["http://127.0.0.1:1234/v1/", "http://127.0.0.1:1234"],
    ["http://host:1234/api/v1", "http://host:1234"],
    ["http://host:1234", "http://host:1234"],
  ])("%s → %s", (input, expected) => {
    expect(serverRoot(input)).toBe(expected);
  });

  it("is undefined without a base URL", () => {
    expect(serverRoot(undefined)).toBeUndefined();
  });
});
