# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
