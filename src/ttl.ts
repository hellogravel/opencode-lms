/**
 * Apply LM Studio's idle `ttl` to an outgoing chat completion. LM Studio's REST
 * load/chat endpoints reject a `ttl` key, but its OpenAI-compat
 * `/v1/chat/completions` (where OpenCode's inference actually goes) accepts it,
 * and resets the idle countdown on every request — so setting it per-completion
 * keeps the model resident under active use and evicts it after `ttl` idle
 * seconds. `@ai-sdk/openai-compatible` merges custom fields from
 * `providerOptions.<providerName>` into the request body; the provider name is
 * `openaiCompatible` (proven by the reasoning-effort path), mirrored to `openai`
 * for robustness. `ttlSeconds <= 0` = resident → no-op.
 *
 * Lives in its own module, NOT index.ts: OpenCode's legacy plugin loader calls
 * every function export of the entry module as a plugin and pushes the return
 * value into its hooks array unchecked — a helper export there breaks provider
 * listing (see tests/plugin-exports.test.ts).
 */
export function applyCompletionTtl(
  output: { options?: Record<string, unknown> } | undefined,
  ttlSeconds: number | undefined,
): void {
  if (!output) return;
  if (ttlSeconds === undefined || ttlSeconds <= 0) return;
  if (!output.options) output.options = {};
  const opts = output.options as Record<string, unknown>;
  const providerOpts =
    (opts.providerOptions as Record<string, Record<string, unknown>> | undefined) ?? {};
  opts.providerOptions = providerOpts;
  for (const ns of ["openaiCompatible", "openai"]) {
    providerOpts[ns] = { ...(providerOpts[ns] ?? {}), ttl: ttlSeconds };
  }
}
