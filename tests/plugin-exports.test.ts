import { describe, it, expect } from "vitest";
import * as mod from "../src/index.js";

// Export contract for the plugin ENTRY MODULE. This is load-bearing, not style:
// OpenCode's legacy plugin loader calls every function export of a plugin
// module as a plugin and pushes the return value into its hooks array
// unchecked (packages/opencode/src/plugin/index.ts:95-119 @ v1.17.15). A stray
// helper export (e.g. `applyCompletionTtl`, the 0.3.0-dev incident) returns
// `undefined`, which lands in the hooks array and crashes the Provider state
// build — `GET /config/providers` 500s and the whole OpenCode instance becomes
// unusable. The v1 default export ({ id, server }) makes OpenCode ignore named
// exports, but only as long as `default` keeps that object shape.
//
// If this test fails because you added an export to src/index.ts: don't.
// Put helpers in their own module (see src/ttl.ts) and import them.

describe("plugin entry-module export contract", () => {
  it("exports exactly LMSPlugin and default", () => {
    expect(Object.keys(mod).sort()).toEqual(["LMSPlugin", "default"]);
  });

  it("default is a v1 PluginModule wrapping LMSPlugin", () => {
    expect(typeof mod.default).toBe("object");
    expect(mod.default.id).toBe("opencode-lms");
    expect(mod.default.server).toBe(mod.LMSPlugin);
  });

  it("LMSPlugin is a function (the Plugin implementation)", () => {
    expect(typeof mod.LMSPlugin).toBe("function");
  });
});
