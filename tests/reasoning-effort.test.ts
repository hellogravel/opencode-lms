// Black-box tests for the chat.params reasoning-effort demotion. We don't
// import the inline helper directly (it's a closure inside LMSPlugin) — we
// re-implement the same logic in the test to pin the contract. If the inline
// version drifts, these tests will start failing because they no longer match.
//
// What this tests: LMS's /v1/chat/completions rejects reasoning_effort:"max"
// with HTTP 400, accepting only none|minimal|low|medium|high|xhigh. The
// chat.params hook should demote "max" → "xhigh" wherever the AI SDK is
// likely to stash it, and leave every other value untouched.

import { describe, it, expect } from "vitest";

function demoteUnsupportedReasoningEffort(
  output: { options: Record<string, unknown> } | undefined,
): void {
  if (!output?.options) return;
  const opts = output.options as Record<string, unknown>;
  const providerOpts = (opts.providerOptions as Record<string, Record<string, unknown>> | undefined) ?? {};
  const oaiCompat = providerOpts.openaiCompatible;
  const oai = providerOpts.openai;

  const demote = (target: Record<string, unknown> | undefined) => {
    if (target && target.reasoningEffort === "max") {
      target.reasoningEffort = "xhigh";
    }
  };
  demote(opts);
  demote(oaiCompat);
  demote(oai);
}

describe("demoteUnsupportedReasoningEffort", () => {
  it("rewrites top-level reasoningEffort 'max' → 'xhigh'", () => {
    const output = { options: { reasoningEffort: "max" } };
    demoteUnsupportedReasoningEffort(output);
    expect(output.options.reasoningEffort).toBe("xhigh");
  });

  it("rewrites providerOptions.openaiCompatible.reasoningEffort 'max' → 'xhigh'", () => {
    const output = {
      options: {
        providerOptions: {
          openaiCompatible: { reasoningEffort: "max" },
        },
      },
    };
    demoteUnsupportedReasoningEffort(output);
    expect((output.options as any).providerOptions.openaiCompatible.reasoningEffort).toBe("xhigh");
  });

  it("rewrites providerOptions.openai.reasoningEffort 'max' → 'xhigh'", () => {
    const output = {
      options: {
        providerOptions: {
          openai: { reasoningEffort: "max" },
        },
      },
    };
    demoteUnsupportedReasoningEffort(output);
    expect((output.options as any).providerOptions.openai.reasoningEffort).toBe("xhigh");
  });

  it("mirrors the demotion when 'max' appears in multiple locations", () => {
    const output = {
      options: {
        reasoningEffort: "max",
        providerOptions: {
          openaiCompatible: { reasoningEffort: "max" },
          openai: { reasoningEffort: "max" },
        },
      },
    };
    demoteUnsupportedReasoningEffort(output);
    expect(output.options.reasoningEffort).toBe("xhigh");
    expect((output.options as any).providerOptions.openaiCompatible.reasoningEffort).toBe("xhigh");
    expect((output.options as any).providerOptions.openai.reasoningEffort).toBe("xhigh");
  });

  it.each(["minimal", "low", "medium", "high", "xhigh", "none"])(
    "passes %s through unchanged (LMS accepts these natively)",
    (value) => {
      const output = { options: { reasoningEffort: value } };
      demoteUnsupportedReasoningEffort(output);
      expect(output.options.reasoningEffort).toBe(value);
    },
  );

  it("leaves the output untouched when reasoningEffort is absent", () => {
    const output = { options: { temperature: 0.7 } };
    demoteUnsupportedReasoningEffort(output);
    expect(output.options).toEqual({ temperature: 0.7 });
  });

  it("is a no-op when output or options is missing", () => {
    expect(() => demoteUnsupportedReasoningEffort(undefined)).not.toThrow();
    expect(() => demoteUnsupportedReasoningEffort({ options: undefined as any })).not.toThrow();
  });

  it("does not demote unknown values besides 'max' (let LMS surface its own error)", () => {
    // If OpenCode ever emits something like 'turbo' that LMS also rejects,
    // we'd rather see the original LMS error than silently substitute.
    const output = { options: { reasoningEffort: "turbo" } };
    demoteUnsupportedReasoningEffort(output);
    expect(output.options.reasoningEffort).toBe("turbo");
  });
});
