# @hellogravel/opencode-lms

An [LM Studio](https://lmstudio.ai) provider plugin for [OpenCode](https://opencode.ai) — dynamic model discovery, streaming auto-load, and full integration with LM Studio's REST API.

## Features

- **Dynamic model discovery** — Automatically discovers all models on disk via LM Studio's REST v1 API, with fallback to v0 and OpenAI-compatible `/v1/models` for older servers
- **Zero config** — Auto-detects LM Studio on common ports (1234, 8080, 11434)
- **Streaming auto-load** — On first use, unloaded LLMs are loaded through LM Studio's `/api/v1/chat` SSE endpoint; `model_load.start/progress/end` events surface in the OpenCode server log. The stream aborts the moment the load completes so no inference tokens are wasted
- **Embedding-aware** — Embedding models bypass the chat endpoint (which is LLM-only) and use `/api/v1/models/load` directly
- **Auto-migration** — Existing `lmstudio` provider configs (with `options.baseURL` / `options.apiKey` nesting) are seamlessly migrated to `lms` on startup
- **Multi-API support** — Uses both OpenAI-compatible endpoints for inference and LM Studio REST v1 for lifecycle
- **API token auth** — Supports LM Studio's `Authorization: Bearer …` setup; health checks and discovery respect it

## Quick Start

### 1. Install

```bash
npm install @hellogravel/opencode-lms
```

(OpenCode auto-installs plugins listed in `config.plugin` on first run, so
manual `npm install` is optional — but if you want to install
explicitly, or pin the version, that's the command.)

### 2. Add to your OpenCode config

In `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "disabled_providers": ["lmstudio"],
  "provider": {
    "lms": {
      "name": "LM Studio",
      "options": {
        "baseURL": "http://127.0.0.1:1234"
      }
    }
  },
  "model": "lms/google/gemma-4-26b-a4b",
  "plugin": ["@hellogravel/opencode-lms"]
}
```

Or use auto-detection (zero config):

```jsonc
{
  "model": "lms/google/gemma-4-26b-a4b",
  "plugin": ["@hellogravel/opencode-lms"]
}
```

### 3. Start LM Studio server

```bash
lms server start
```

That's it. The plugin will auto-discover all available models.

## Configuration

### Auto-detect (default)

```jsonc
{
  "provider": {
    "lms": {
      "options": {
        "autoDetect": true
      }
    }
  }
}
```

### Custom server

```jsonc
{
  "provider": {
    "lms": {
      "options": {
        "baseURL": "http://192.168.12.166:1234",
        "apiKey": "your-api-token"
      }
    }
  }
}
```

### Hybrid (auto-discover + manual overrides)

```jsonc
{
  "provider": {
    "lms": {
      "options": {
        "baseURL": "http://127.0.0.1:1234"
      },
      "models": {
        "my-custom": {
          "id": "my-model@gguf",
          "name": "My Custom Model",
          "reasoning": true
        }
      }
    }
  }
}
```

### Disable auto-detect (config-only)

```jsonc
{
  "provider": {
    "lms": {
      "options": {
        "autoDetect": false
      },
      "models": {
        "qwen/qwen3.6-35b-a3b": {
          "id": "qwen/qwen3.6-35b-a3b",
          "name": "Qwen 3.6 35B",
          "reasoning": true
        }
      }
    }
  }
}
```

## Migration from `lmstudio`

If you have an existing `lmstudio` provider in your config:

```jsonc
{
  "provider": {
    "lmstudio": {
      "name": "LM Studio (Custom)",
      "options": {
        "baseURL": "http://192.168.12.166:1234/v1",
        "apiKey": "your-key"
      },
      "models": { ... }
    }
  }
}
```

The plugin will pick it up on startup and present it as `lms`. The config below is the equivalent native form:

```jsonc
{
  "provider": {
    "lms": {
      "name": "LM Studio (Custom)",
      "options": {
        "baseURL": "http://192.168.12.166:1234",
        "apiKey": "your-key"
      }
    }
  }
}
```

During migration the plugin also adds `"lmstudio"` to `disabled_providers`,
so OpenCode's built-in `lmstudio` provider doesn't re-register on subsequent
starts and shadow the `lms` provider this plugin manages.

## API Reference

### Provider config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | `"LM Studio"` | Display name for the provider |
| `baseURL` | `string` | `"http://127.0.0.1:1234"` | LM Studio server URL (without `/v1` suffix) |
| `apiKey` | `string` | (none) | API token sent as `Authorization: Bearer …`. Required when LM Studio's auth is enabled |
| `autoDetect` | `boolean` | `true` | Probe localhost ports 1234/8080/11434 when no `baseURL` is set |
| `models` | `object` | `{}` | Manual model overrides; merged on top of discovered models |
| `disableAutoLoad` | `boolean` | `false` | Skip the streaming auto-load on first reference |
| `autoDownload` | `boolean` | `false` | When the referenced model isn't on disk, download it before loading. **Off by default** — a typo in a model id could trigger a multi-GB download |
| `loadTimeout` | `number` | `600000` | Timeout (ms) for load/unload operations |
| `downloadTimeout` | `number` | `1800000` | Timeout (ms) for downloads. Bump for very large models on slow networks |

### Model override options

| Option | Type | Description |
|--------|------|-------------|
| `id` | `string` | Model identifier used in LM Studio API calls (e.g. `google/gemma-4-e4b`) |
| `name` | `string` | Display name |
| `reasoning` | `boolean` | Mark the model as reasoning-capable |
| `tool_call` | `boolean` | Mark the model as supporting tool calls |
| `modalities` | `object` | Input/output modalities, e.g. `{ input: ["text","image"], output: ["text"] }` |
| `limit` | `object` | Context / output token limits |

## How It Works

1. **Startup**: The plugin reads the user's `lms` provider config, or maps an existing `lmstudio` provider config into `lms` in-place
2. **Auto-detect**: If no `baseURL`, scans ports 1234, 8080, 11434 on localhost
3. **Model discovery**: Fetches `GET /api/v1/models`, with fallbacks to `/api/v0/models` and the OpenAI-compatible `/v1/models`
4. **Config injection**: Maps discovered models into OpenCode's `ProviderConfig` shape (id, name, reasoning, tool_call, modalities, limit)
5. **Auto-load on first use**: At `chat.params` time, if the requested LLM isn't loaded, opens an SSE stream against `/api/v1/chat` to trigger a load and observe progress. Aborts the stream once `model_load.end` fires so no inference runs. Embedding models go through the synchronous `/api/v1/models/load` endpoint since `/api/v1/chat` is LLM-only

### API Strategy

| API Surface | Endpoint | Used For |
|-------------|----------|----------|
| OpenAI-compatible | `/v1/*` | Inference (chat, embeddings, responses) |
| LM REST v1 | `/api/v1/*` | Model discovery, lifecycle, streaming events |
| LM REST v0 | `/api/v0/*` | Fallback for older LM Studio versions |

## Development

```bash
cd opencode-lms
npm install
npm run build       # Compile TypeScript → dist/
npm run typecheck   # Type-check only
npm run test:run    # Run vitest once
npm run test        # Watch mode
```

### Live integration probe

`test-live.mjs` exercises the full plugin path against a running LM Studio
instance — discovery, migration, streaming auto-load, idempotency, cleanup.
Configuration is via env vars:

```bash
npm run build
LMS_BASE_URL=http://192.168.1.10:1234 \
LMS_API_KEY=sk-lm-... \
  node test-live.mjs
```

The script unloads anything it loaded before exiting, so it's safe to run
against a working server.

### Live in a real OpenCode runtime (`docker/`)

For a full end-to-end run through actual OpenCode — same code path users
hit, no host config pollution — see [`docker/`](./docker/). One
`docker compose up --build` and you have a running OpenCode server with
this plugin loaded, talking to LM Studio on the Docker host (or anywhere
else via `LMS_BASE_URL`). The harness pre-stages the plugin into
OpenCode's cache so first-boot is fast and works offline.

## What's not yet delivered

- **Reasoning content / tool-call streaming surfaced to the TUI.** Inference
  flows through `@ai-sdk/openai-compatible` to `/v1/chat/completions`. The
  plugin's SSE parser handles those event types — we just don't intercept the
  AI SDK's response stream to surface them. A custom transport would be
  needed.

## License

MIT
