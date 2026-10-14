# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - Unreleased

A slim port to OpenCode 2. OpenCode 2's built-in `lmstudio` provider now does
discovery, embedding filtering, periodic refresh, and provider registration, so
this release deletes all of that and keeps only what the built-in lacks.
**0.4.x remains the version for OpenCode 1.**

### Changed (breaking)

- **OpenCode 2 only.** Rewritten against `@opencode/plugin` (exact-pinned to
  `2.0.29`; was `@opencode-ai/plugin` `1.17.15`). The entry module
  default-exports a V2 definition, `{ id: "opencode-lms", setup }`, and nothing
  else; there is no V1 `server()`.
- **No longer a provider.** The plugin registers nothing; it edits the built-in
  provider's models with a model transform and hooks its requests:
  - auto-load at the capped `contextLength` (and reload of an undersized
    resident instance) runs in the `model.request` session hook, awaited before
    the completion goes out;
  - idle `ttl` rides each model's request-body overlay;
  - tools are forced on (the built-in gates them on `trained_for_tool_use`);
  - graduated reasoning models get low/medium/high effort variants, on/off-only
    ones get none, and `reasoning_effort: "max"` is demoted to `"xhigh"` in the
    `http.request` hook.
- **Config moved.** `plugin` → `plugins`, with options in the object form
  (`{ "package": "@hellogravel/opencode-lms", "options": { ... } }`). LM
  Studio's address and key are the built-in provider's
  `providers.lmstudio.settings.baseURL` / `apiKey`, and request timeouts are its
  `timeout` / `chunkTimeout` settings. Plugin options are now `contextLength`,
  `models.<key>.contextLength`, `ttl`, `disableAutoLoad`, and `loadTimeout`.
- **Advertised window follows the load cap.** With auto-load on, each model's
  `limit.context` is the window it will be loaded with (or a larger resident
  one), and `limit.output` is `min(⌊context/4⌋, 8192)`; the built-in alone would
  advertise the full `max_context_length` with a 32k output reserve.

### Fixed

- **Undersized resident instances are now actually reloaded.** 0.4.x returned
  from `chat.params` whenever any instance was resident, so the reload path in
  `ensureModelLoaded` was only reachable from tests. Auto-load now always runs
  it.

### Removed

- Model discovery and mapping, health checks and port auto-detection, the
  self-heal re-discovery, provider registration (and its config-entry
  fallback), the v0 and OpenAI-compat listing fallbacks, and the tool-use
  discovery diagnostic — all covered by the built-in provider.
- `autoDownload` / `downloadTimeout`, per-model metadata overrides (use
  `providers.lmstudio.models` in OpenCode's config), and the `name`,
  `baseURL`, `apiKey`, `autoDetect`, `timeout`, and `chunkTimeout` plugin
  options.
- `test-live.mjs` (it drove the removed discovery modules).

## [0.4.0] - 2026-07-10

### Fixed

- **`chat.params` was silently dead on OpenCode 1.17.x** — every behavior it
  carries (per-completion `ttl` injection, reasoning-effort demotion, cold-model
  auto-load) no-op'd. OpenCode ≤1.16 passed the hook a `ProviderContext`
  (`{source, info, options}`); 1.17 passes `Provider.Info` directly, so the
  `input.provider.info.id` gate read `undefined` and returned early — invisible
  live (no logging on the early return) and invisible to tests (stubs used the
  old shape). The gate now reads both shapes, with a hook-level regression test
  driving each (`tests/chat-params-gate.test.ts`). Verified live on OpenCode
  1.17.15: cold model auto-loads at the capped context (8192) with progress
  logs.

### Notes

- **TTL reach on LM Studio ≤0.4.19 (verified live):** a completion's `ttl`
  applies only when that completion JIT-loads the model; it is ignored for
  already-loaded instances, and REST loads reject `ttl` (400). Because the
  plugin auto-loads cold models via REST (to apply `contextLength`),
  plugin-loaded models evict on LM Studio's *server-default* idle TTL rather
  than `options.ttl`; the configured `ttl` fully governs only JIT loads
  (`disableAutoLoad`). Documented in the README.

## [0.3.0] - 2026-07-09

### Added

- **Idle TTL / auto-evict (`ttl`).** Each chat completion now carries LM
  Studio's `ttl` (idle seconds), so the model auto-unloads after `ttl` idle
  seconds and frees VRAM without a client-side unload loop. LM Studio resets the
  countdown on every request, so a model stays resident under active use.
  Default `3600` (1h); `0` = resident (no `ttl` sent). Set under
  `provider.lmstudio.options`. TTL rides the OpenAI-compat
  `/v1/chat/completions` path — where OpenCode's inference already goes —
  because LM Studio 0.4.19's REST `/api/v1/models/load` and `/api/v1/chat`
  endpoints both **reject** a `ttl` key (HTTP 400). It's injected via the
  `chat.params` hook as `providerOptions.openaiCompatible.ttl`, which
  `@ai-sdk/openai-compatible` merges into the request body.
- **Load-time context cap (`contextLength`).** A global default cap (**8192**)
  for the context window a model is *loaded* with — distinct from the UI-facing
  `limit.context`. LM Studio previously loaded every model at its full
  `max_context_length`, which dominates VRAM on large-window models. A model
  whose max is below the cap loads at its max. A per-model `contextLength` under
  `provider.lmstudio.models[<id>]` raises (or lowers) it toward that model's max.
- **agustif discovery-mapping decisions.** `limit.context` now reflects the
  smallest loaded instance's context for a loaded model (and the full
  `max_context_length` for a cold, JIT-loadable one); `limit.output` is
  `min(⌊context/4⌋, 8192)` unless a per-model `limit.output` override wins.

### Fixed

- **Helper export on the entry module broke OpenCode provider listing.** During
  0.3.0 development, `applyCompletionTtl` was exported from `src/index.ts`.
  OpenCode's legacy plugin loader calls **every** function export of a plugin
  module as a plugin and pushes the return value into its hooks array unchecked,
  so the helper's `undefined` return crashed the Provider state build —
  `GET /config/providers` 500'd and the whole instance (attach, web UI) became
  unusable. Affects all OpenCode versions (1.16.2 and 1.17.x behave
  identically); it was never in a release. Fixed by moving the helper to
  `src/ttl.ts` and adopting the v1 plugin-module shape
  (`export default { id, server }`), which makes OpenCode ignore named exports
  entirely. Guards added: an export-contract unit test
  (`tests/plugin-exports.test.ts`) and a loader smoke test (`docker/smoke.sh`).

### Changed

- **Default load context is capped at 8k** (was each model's
  `max_context_length`). Raise it globally with `options.contextLength` or
  per-model with `models[<id>].contextLength`.
- **Tools are always advertised as available** for discovered LLMs. LM Studio's
  `trained_for_tool_use` flag is unreliable as a gate, so it no longer sets
  `tool_call`; it now feeds a discovery-log diagnostic bucket
  (native / default / unknown) only.
- **`@opencode-ai/plugin` exact-pinned to `1.17.15`** (was `^1.15.0`).

### Notes

- Idle unload is delegated to LM Studio's **per-completion `ttl`**; the plugin
  does not run a client-side idle-unload loop. `unloadModel` remains as an
  explicit, un-wired method for callers that want to force-evict.

## [0.2.2] - 2026-06-11

### Added

- **Configurable `timeout` and `chunkTimeout`.** Both were previously hardcoded
  (`600000` / `120000` ms) and unreachable from user config. They now flow
  through `provider.lmstudio.options` like the other timeouts. Defaults are
  unchanged.

### Fixed

- **SWA prompt-reprocessing retry loop.** Sliding-window-attention models
  (e.g. Gemma) can't reuse llama.cpp's prompt cache, so every turn reprocesses
  the entire prompt from scratch. No SSE chunks are emitted during that
  prompt-processing phase, so a large prompt could exceed the 2-minute
  `chunkTimeout` before the first token — aborting and retrying, reprocessing
  from 0% again, looping indefinitely. Raising `chunkTimeout` (e.g. to match
  `timeout`) now lets prompt processing finish. See the README note for the
  full explanation and mitigation.

## [0.2.1] - 2026-06-10

### Fixed

- **Catalog-independent fallback.** 0.2.0 delivered models solely through the
  `provider.models` hook, which OpenCode only fires for a provider already in
  the models.dev catalog. Since the `lmstudio` catalog entry is proposed for
  removal upstream ([anomalyco/models.dev#794](https://github.com/anomalyco/models.dev/pull/794)),
  the plugin now also emits the full model list in the config-entry shape. If
  `lmstudio` is dropped from the catalog, the hook stops firing but the config
  fallback still registers every discovered model (verified end-to-end against
  OpenCode 1.16.2 with `lmstudio` removed from the catalog). Reasoning-variant
  suppression is preserved on both paths.

## [0.2.0] - 2026-06-10

### Changed (breaking)

- **Provider id renamed `lms` → `lmstudio`.** The plugin now extends OpenCode's
  built-in `lmstudio` provider in place instead of registering a separate one.
  Update your config: rename the `provider.lms` key to `provider.lmstudio`,
  change any `"model": "lms/…"` reference to `"lmstudio/…"`, and **remove**
  `"disabled_providers": ["lmstudio"]` (it would now disable this plugin).
- Models are now delivered through OpenCode's sanctioned `provider.models` hook
  and emitted in the strict `ModelV2` shape, rather than by hand-building a
  provider config dict. This drops the reverse-engineered config schema the
  plugin previously had to track per OpenCode version.

### Notes

- Reasoning-effort picker suppression for on/off-only models is preserved: the
  rich model definitions flow through the hook while the per-model
  variant-disable overrides ride in the config entry (the only path where
  OpenCode filters disabled variants).
- Verified end-to-end against OpenCode 1.16.2 + a live LM Studio server: the
  `lmstudio` provider enables, discovered models list under `lmstudio/…`, and
  on/off-only reasoning models report no low/medium/high variants.
