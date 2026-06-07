import { describe, it, expect } from "vitest";
import { migrateLmstudioToLms } from "../src/migrate.js";

describe("migrateLmstudioToLms", () => {
  it("extracts baseURL and apiKey from nested .options (the real lmstudio shape)", () => {
    const result = migrateLmstudioToLms({
      name: "LM Studio (Custom)",
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: "http://192.168.12.166:1234/v1",
        apiKey: "sk-test",
        timeout: 6000000,
      },
    });
    expect(result.baseURL).toBe("http://192.168.12.166:1234");
    expect(result.apiKey).toBe("sk-test");
    expect(result.name).toBe("LM Studio (Custom)");
    expect(result.autoDetect).toBe(false);
  });

  it("strips trailing /v1 from baseURL", () => {
    expect(migrateLmstudioToLms({ options: { baseURL: "http://host:1234/v1" } }).baseURL)
      .toBe("http://host:1234");
    expect(migrateLmstudioToLms({ options: { baseURL: "http://host:1234/v1/" } }).baseURL)
      .toBe("http://host:1234");
  });

  it("falls back to top-level baseURL/apiKey if options is absent", () => {
    const result = migrateLmstudioToLms({
      baseURL: "http://host:1234/v1",
      apiKey: "sk-top",
    });
    expect(result.baseURL).toBe("http://host:1234");
    expect(result.apiKey).toBe("sk-top");
  });

  it("defaults name to 'LM Studio' when missing", () => {
    expect(migrateLmstudioToLms({}).name).toBe("LM Studio");
  });

  it("sets autoDetect=true when no baseURL anywhere", () => {
    expect(migrateLmstudioToLms({}).autoDetect).toBe(true);
  });

  it("preserves model overrides with key→id mapping", () => {
    const result = migrateLmstudioToLms({
      models: {
        "gemma4-4b": { id: "google/gemma-4-e4b", name: "Gemma 4 4B" },
        "qwen3.6-35b": {
          id: "qwen/qwen3.6-35b-a3b",
          name: "Qwen 3.6 35B",
          reasoning: true,
          tool_call: true,
        },
      },
    });
    expect(result.models?.["gemma4-4b"]).toMatchObject({
      id: "google/gemma-4-e4b",
      name: "Gemma 4 4B",
    });
    expect(result.models?.["qwen3.6-35b"]).toMatchObject({
      reasoning: true,
      tool_call: true,
    });
  });

  it("uses the map key as the model id when id is missing", () => {
    const result = migrateLmstudioToLms({
      models: { "my-model": { name: "My Model" } },
    });
    expect(result.models?.["my-model"]?.id).toBe("my-model");
  });

  it("skips non-object model entries", () => {
    const result = migrateLmstudioToLms({
      models: { good: { id: "x", name: "x" }, bad: null, also_bad: "string" },
    });
    expect(Object.keys(result.models ?? {})).toEqual(["good"]);
  });

  it("preserves disableAutoLoad when set", () => {
    expect(migrateLmstudioToLms({ disableAutoLoad: true }).disableAutoLoad).toBe(true);
    expect(migrateLmstudioToLms({ disableAutoLoad: false }).disableAutoLoad).toBe(false);
  });
});
