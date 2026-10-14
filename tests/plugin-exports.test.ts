import { describe, it, expect } from "vitest";
import * as mod from "../src/index.js";

// Export contract for the plugin ENTRY MODULE. OpenCode 2 resolves a package
// plugin to its `server` subpath or its root export, decodes the module, and
// reads only `default`: an object with a string `id` and a `setup` function
// (packages/core/src/plugin/module.ts @ v2.0.29). Anything else fails the load
// with "Plugin must export a default definition with an id and an effect or
// setup function." Keep helpers in their own modules.

describe("plugin entry-module export contract", () => {
  it("exports only default", () => {
    expect(Object.keys(mod)).toEqual(["default"]);
  });

  it("default is a V2 plugin definition", () => {
    expect(mod.default.id).toBe("opencode-lms");
    expect(typeof mod.default.setup).toBe("function");
    // No V1 `server()` — 1.x is OpenCode 2 only; 0.4.x serves OpenCode 1.
    expect("server" in mod.default).toBe(false);
  });
});
