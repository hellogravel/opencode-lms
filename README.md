# @hellogravel/opencode-lms

An [LM Studio](https://lmstudio.ai) provider plugin for [OpenCode](https://opencode.ai).

## What it does

- Discovers the chat models your LM Studio server is hosting and exposes them in OpenCode. Embedding models are filtered out by default (OpenCode has no slot that consumes them); list one in `provider.lms.models` to opt it back in.
- Loads an unloaded LLM on first reference; load progress is logged to the OpenCode server log.
- Forwards an `Authorization: Bearer …` header to LM Studio when `apiKey` is set.
- Demotes `reasoning_effort: "max"` to `"xhigh"` before requests leave OpenCode, since LM Studio rejects `max`.
- Sets each model's OpenCode capability flags from what LM Studio reports — `reasoning`, `tool_call`, `attachment` (vision models), `temperature`, `family`, etc. — and marks reasoning-capable models with `interleaved: { field: "reasoning_content" }` so OpenCode renders the streaming reasoning trace live in the TUI.
- Suppresses OpenCode's auto-generated reasoning-effort picker (low/medium/high) for models that only support binary on/off reasoning, since every choice would route to "on" inside LM Studio anyway. Graduated reasoning models keep the picker.

## Set up

Add the plugin and provider to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "disabled_providers": ["lmstudio"],
  "provider": {
    "lms": {
      "name": "LM Studio",
      "options": {
        "baseURL": "http://127.0.0.1:1234",
        "apiKey": "sk-lm-..."
      }
    }
  },
  "model": "lms/google/gemma-4-26b-a4b",
  "plugin": ["@hellogravel/opencode-lms"]
}
```

Start LM Studio's server (`lms server start`) and restart OpenCode.

- `disabled_providers: ["lmstudio"]` turns off OpenCode's built-in `lmstudio` provider so it doesn't compete with this plugin's `lms` provider.
- `apiKey` is only needed when LM Studio has API token auth enabled.
- `baseURL` should not include a `/v1` suffix — the plugin appends it.

## Options

Under `provider.lms.options`:

| Option | Type | Default | Description |
|---|---|---|---|
| `baseURL` | `string` | `"http://127.0.0.1:1234"` | LM Studio server URL |
| `apiKey` | `string` | — | Bearer token sent in the `Authorization` header |
| `autoDetect` | `boolean` | `true` | When `baseURL` is not set, probe localhost ports 1234, 8080, 11434 |
| `disableAutoLoad` | `boolean` | `false` | Skip the auto-load step on first model reference |
| `autoDownload` | `boolean` | `false` | Download a missing model on first reference (off by default — a typo could trigger a multi-GB download) |
| `loadTimeout` | `number` | `600000` | Load/unload timeout in ms |
| `downloadTimeout` | `number` | `1800000` | Download timeout in ms |

## Model overrides

Override per-model metadata under `provider.lms.models[<id>]`:

```jsonc
"models": {
  "google/gemma-4-e4b": {
    "name": "Gemma 4 E4B",
    "reasoning": true,
    "limit": { "context": 131072, "output": 131072 }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | LM Studio model identifier (e.g. `google/gemma-4-e4b`) |
| `name` | `string` | Display name |
| `reasoning` | `boolean` | Mark the model as reasoning-capable |
| `tool_call` | `boolean` | Mark the model as supporting tool calls |
| `modalities` | `object` | e.g. `{ input: ["text","image"], output: ["text"] }` |
| `limit` | `object` | `{ context: <ctx>, output: <out> }` |

Overrides merge on top of discovered models.

## Development

```bash
git clone https://github.com/hellogravel/opencode-lms
cd opencode-lms
npm install
npm run build       # Compile TypeScript → dist/
npm run typecheck
npm run test:run
```

For a containerized OpenCode runtime with this plugin loaded, see [`docker/`](./docker/).

`test-live.mjs` exercises the plugin against a live LM Studio server:

```bash
npm run build
LMS_BASE_URL=http://192.168.1.10:1234 \
LMS_API_KEY=sk-lm-... \
  node test-live.mjs
```

## License

MIT
